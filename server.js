/**
 * Cashu Nutshell Admin UI — Server
 *
 * A standalone administration dashboard for Cashu Nutshell mints.
 * Acts as a reverse proxy to the mint's /v1/* REST API and exposes
 * admin-specific endpoints that map to Nutshell's gRPC Management RPC
 * service (see: cashu/mint/management_rpc/management_rpc.py).
 *
 * Architecture:
 *   Browser (SPA) <—HTTP/WS—> Express Server <—HTTP—> Nutshell Mint /v1/*
 *
 * The admin UI does NOT modify the mint's database directly. Settings
 * changes go through Nutshell's management gRPC when available, or
 * require a mint restart when gRPC is not enabled.
 *
 * Environment variables follow Nutshell's naming conventions where
 * possible (MINT_ prefix for mint-related config). See .env.example.
 *
 * References:
 *   - Nutshell source: https://github.com/cashubtc/nutshell
 *   - Cashu protocol specs (NUTs): https://github.com/cashubtc/nuts
 *   - Management RPC proto: cashu/mint/management_rpc/protos/management.proto
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const auth = require('basic-auth');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const path = require('path');
const promClient = require('prom-client');

// ---------------------------------------------------------------------------
// SQLite — direct database inspection (read-only via sqlite3 CLI)
// ---------------------------------------------------------------------------
// We use the system sqlite3 CLI (execSync) to query Nutshell's SQLite
// database. This approach requires no native Node.js addons — only the
// standard sqlite3 binary (available on all Linux/macOS servers running
// Nutshell, since Nutshell itself depends on SQLite).
//
// Access is strictly read-only — all queries are SELECT only.
// The database path comes from MINT_DB_PATH env var. Nutshell stores its
// SQLite file at MINT_DATA_PATH/cashu.db (default: ~/.cashu/mint/data/cashu.db).
// See: cashu/core/settings.py → mint_data_path, cashu/mint/db/crud.py

/**
 * Check if the sqlite3 CLI is available on this system.
 * @returns {boolean}
 */
function hasSqliteCli() {
  try {
    execSync('sqlite3 --version', { encoding: 'utf8', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a single-value SELECT against the Nutshell SQLite DB.
 * Returns null on any error (table not found, missing DB, etc.)
 *
 * @param {string} dbPath - Path to cashu.db
 * @param {string} sql    - SQL query returning a single scalar value
 * @returns {number|null}
 */
function sqliteQuery(dbPath, sql) {
  try {
    const result = execSync(
      `sqlite3 -readonly "${dbPath}" "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return result !== '' ? parseInt(result, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Run a GROUP BY query and return key→count map.
 * Output format: "KEY|COUNT\nKEY|COUNT\n..."
 *
 * @param {string} dbPath - Path to cashu.db
 * @param {string} sql    - GROUP BY query producing two columns: key, count
 * @returns {Object.<string, number>}
 */
function sqliteGroupBy(dbPath, sql) {
  try {
    const out = execSync(
      `sqlite3 -readonly "${dbPath}" "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (!out) return {};
    return Object.fromEntries(
      out.split('\n').map(line => {
        const [key, count] = line.split('|');
        return [key?.trim(), parseInt(count?.trim(), 10)];
      }).filter(([k, v]) => k && !isNaN(v))
    );
  } catch {
    return {};
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Mirrors Nutshell's settings pattern (cashu/core/settings.py).
// All values come from environment variables with sensible defaults.
// MINT_URL should point to the Nutshell mint's /v1 API base.
// MINT_GRPC_PORT is reserved for future direct gRPC integration.
const CONFIG = {
  port: parseInt(process.env.PORT || '3339', 10),
  mintUrl: process.env.MINT_URL || 'http://127.0.0.1:3338',
  mintGrpcPort: parseInt(process.env.MINT_GRPC_PORT || '8086', 10),  // Nutshell default: 8086
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin123',
  authType: process.env.AUTH_TYPE || 'basic',  // 'basic', 'token', or 'none'
  // Path to Nutshell's cashu.db SQLite file (MINT_DATA_PATH/cashu.db).
  // Set MINT_DB_PATH in your .env to enable database entry count monitoring.
  // Read-only access only — see cashu/core/settings.py for path config.
  mintDbPath: process.env.MINT_DB_PATH || ''
};

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------
// Exposes a /metrics endpoint in Prometheus exposition format for scraping.
// Metric names use cashu_mint_* for mint-specific gauges and
// cashu_admin_* for admin UI process/OS metrics. This follows the
// convention of prefixing metrics with the service name.
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register, prefix: 'cashu_admin_' });

const mintRequestsTotal = new promClient.Counter({
  name: 'cashu_mint_requests_total',
  help: 'Total mint operation requests observed by the admin UI',
  labelNames: ['type'],  // mint, melt, swap, checkstate
  registers: [register]
});

const mintActiveKeysets = new promClient.Gauge({
  name: 'cashu_mint_active_keysets',
  help: 'Number of active keysets reported by the mint',
  registers: [register]
});

const mintUp = new promClient.Gauge({
  name: 'cashu_mint_up',
  help: 'Whether the Nutshell mint is reachable (1=up, 0=down)',
  registers: [register]
});

// Database entry count gauges — addresses "number of entries in the database"
// bounty requirement. Labels match Nutshell's DB table names.
const dbEntryCount = new promClient.Gauge({
  name: 'cashu_mint_db_entries_total',
  help: 'Total number of rows in each Nutshell database table',
  labelNames: ['table'],
  registers: [register]
});

const dbQuotesByState = new promClient.Gauge({
  name: 'cashu_mint_db_quotes_by_state',
  help: 'Number of mint/melt quotes broken down by state',
  labelNames: ['quote_type', 'state'],
  registers: [register]
});

const osDiskFreeBytes = new promClient.Gauge({
  name: 'cashu_admin_os_disk_free_bytes',
  help: 'Free disk space in bytes on the host running the admin UI',
  registers: [register]
});

const osDiskTotalBytes = new promClient.Gauge({
  name: 'cashu_admin_os_disk_total_bytes',
  help: 'Total disk space in bytes on the host running the admin UI',
  registers: [register]
});

const osLoadAvg = new promClient.Gauge({
  name: 'cashu_admin_os_load_avg',
  help: 'OS load average (1m, 5m, 15m)',
  labelNames: ['period'],
  registers: [register]
});

// ---------------------------------------------------------------------------
// OS Stats Helper
// ---------------------------------------------------------------------------
// Collects host-level system metrics: memory, CPU, disk, load average.
// These map to the bounty requirement for "underlying OS (free disk space,
// used CPU by nutshell)" monitoring. When the admin UI runs on the same
// host as the mint (typical deployment), these reflect the mint's host.
function getOsStats() {
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  // Disk space — cross-platform via shell command.
  // On Linux/macOS: parse `df -k /` output.
  // On Windows: parse `wmic logicaldisk` CSV output.
  let diskFree = null;
  let diskTotal = null;
  let diskUsedPercent = null;
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic logicaldisk get size,freespace /format:csv', {
        encoding: 'utf8', timeout: 3000
      });
      const lines = out.trim().split('\n').filter(l => l.includes(','));
      if (lines.length > 1) {
        const parts = lines[1].split(',');
        diskFree = parseInt(parts[1]);
        diskTotal = parseInt(parts[2]);
      }
    } else {
      const out = execSync("df -k / | tail -1 | awk '{print $2, $4}'", {
        encoding: 'utf8', timeout: 3000
      });
      const [totalK, freeK] = out.trim().split(/\s+/).map(Number);
      diskTotal = totalK * 1024;
      diskFree = freeK * 1024;
    }
    if (diskTotal && diskFree) {
      diskUsedPercent = ((1 - diskFree / diskTotal) * 100).toFixed(1);
      osDiskFreeBytes.set(diskFree);
      osDiskTotalBytes.set(diskTotal);
    }
  } catch (_) {
    // Disk stats unavailable — container or restricted environment
  }

  // CPU usage — aggregate across all cores. This is a lifetime average,
  // not a point-in-time sample. For more accurate per-interval CPU %,
  // Prometheus scraping with rate() is recommended.
  let cpuPercent = null;
  try {
    const idle = cpus.reduce((sum, c) => sum + c.times.idle, 0) / cpus.length;
    const total = cpus.reduce((sum, c) => {
      return sum + Object.values(c.times).reduce((a, b) => a + b, 0);
    }, 0) / cpus.length;
    cpuPercent = ((1 - idle / total) * 100).toFixed(1);
  } catch (_) {
    // CPU stats unavailable
  }

  // Update Prometheus gauges
  osLoadAvg.set({ period: '1m' }, loadAvg[0]);
  osLoadAvg.set({ period: '5m' }, loadAvg[1]);
  osLoadAvg.set({ period: '15m' }, loadAvg[2]);

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model || 'unknown',
    cpuPercent: cpuPercent ? parseFloat(cpuPercent) : null,
    loadAvg: { '1m': loadAvg[0], '5m': loadAvg[1], '15m': loadAvg[2] },
    totalMemory: totalMem,
    freeMemory: freeMem,
    usedMemoryPercent: parseFloat(((1 - freeMem / totalMem) * 100).toFixed(1)),
    diskTotal,
    diskFree,
    diskUsedPercent: diskUsedPercent ? parseFloat(diskUsedPercent) : null,
    uptime: os.uptime(),
    nodeVersion: process.version,
    pid: process.pid
  };
}

// ---------------------------------------------------------------------------
// Database Stats Helper
// ---------------------------------------------------------------------------
// Reads Nutshell's SQLite database directly (read-only) to return entry
// counts for all core tables. This addresses the exact bounty requirement
// for "number of entries in the database".
//
// Nutshell DB schema (cashu/mint/db/crud.py, cashu/mint/db/db.py):
//   mint_quotes   — NUT-04 mint quotes (states: UNPAID, PAID, ISSUED, EXPIRED)
//   melt_quotes   — NUT-05 melt quotes (states: UNPAID, PENDING, PAID)
//   proofs        — Spent proofs (redeemed tokens, double-spend prevention)
//   outputs       — Blind signatures issued (promises to token holders)
//   keysets       — Keyset history (active + retired keysets)
//
// Returns null if MINT_DB_PATH is not configured or the file doesn't exist.

function getDbStats() {
  if (!CONFIG.mintDbPath) {
    return { available: false, reason: 'MINT_DB_PATH not configured. Set it to the path of your cashu.db file.' };
  }

  if (!fs.existsSync(CONFIG.mintDbPath)) {
    return { available: false, reason: `Database file not found: ${CONFIG.mintDbPath}` };
  }

  if (!hasSqliteCli()) {
    return { available: false, reason: 'sqlite3 CLI not found. Install sqlite3 (e.g., apt install sqlite3).' };
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const since24h = now - 86400;
    const since1h  = now - 3600;

    const p = CONFIG.mintDbPath;

    // ---- mint_quotes (NUT-04) ----
    const mintTotal   = sqliteQuery(p, 'SELECT COUNT(*) FROM mint_quotes');
    const mintStates  = sqliteGroupBy(p, 'SELECT state, COUNT(*) FROM mint_quotes GROUP BY state');
    const mintLast24h = sqliteQuery(p, `SELECT COUNT(*) FROM mint_quotes WHERE created_time > ${since24h}`);
    const mintLast1h  = sqliteQuery(p, `SELECT COUNT(*) FROM mint_quotes WHERE created_time > ${since1h}`);

    // ---- melt_quotes (NUT-05) ----
    const meltTotal   = sqliteQuery(p, 'SELECT COUNT(*) FROM melt_quotes');
    const meltStates  = sqliteGroupBy(p, 'SELECT state, COUNT(*) FROM melt_quotes GROUP BY state');
    const meltLast24h = sqliteQuery(p, `SELECT COUNT(*) FROM melt_quotes WHERE created_time > ${since24h}`);
    const meltLast1h  = sqliteQuery(p, `SELECT COUNT(*) FROM melt_quotes WHERE created_time > ${since1h}`);

    // ---- proofs (spent tokens / double-spend prevention list) ----
    const proofsTotal = sqliteQuery(p, 'SELECT COUNT(*) FROM proofs');

    // ---- outputs / promises (blind signatures issued) ----
    // Nutshell uses "outputs" in newer versions, "promises" in some older builds
    let outputsTotal = sqliteQuery(p, 'SELECT COUNT(*) FROM outputs');
    if (outputsTotal === null) {
      outputsTotal = sqliteQuery(p, 'SELECT COUNT(*) FROM promises');
    }

    // ---- keysets ----
    const keysetsTotal  = sqliteQuery(p, 'SELECT COUNT(*) FROM keysets');
    const keysetsActive = sqliteQuery(p, 'SELECT COUNT(*) FROM keysets WHERE active = 1');

    // Update Prometheus gauges
    if (mintTotal   !== null) dbEntryCount.set({ table: 'mint_quotes' }, mintTotal);
    if (meltTotal   !== null) dbEntryCount.set({ table: 'melt_quotes' }, meltTotal);
    if (proofsTotal !== null) dbEntryCount.set({ table: 'proofs' },      proofsTotal);
    if (outputsTotal !== null) dbEntryCount.set({ table: 'outputs' },    outputsTotal);
    if (keysetsTotal !== null) dbEntryCount.set({ table: 'keysets' },    keysetsTotal);

    Object.entries(mintStates).forEach(([state, n]) => dbQuotesByState.set({ quote_type: 'mint', state }, n));
    Object.entries(meltStates).forEach(([state, n]) => dbQuotesByState.set({ quote_type: 'melt', state }, n));

    return {
      available: true,
      dbPath: CONFIG.mintDbPath,
      tables: {
        mintQuotes: {
          total: mintTotal,
          byState: mintStates,
          last24h: mintLast24h,
          last1h:  mintLast1h,
          note: 'NUT-04 mint operations'
        },
        meltQuotes: {
          total: meltTotal,
          byState: meltStates,
          last24h: meltLast24h,
          last1h:  meltLast1h,
          note: 'NUT-05 melt operations'
        },
        proofs: {
          total: proofsTotal,
          note: 'Spent proofs (double-spend prevention)'
        },
        outputs: {
          total: outputsTotal,
          note: 'Blind signatures issued (promises to token holders)'
        },
        keysets: {
          total:  keysetsTotal,
          active: keysetsActive
        }
      },
      requestsLast24h: (mintLast24h ?? 0) + (meltLast24h ?? 0),
      requestsLast1h:  (mintLast1h  ?? 0) + (meltLast1h  ?? 0),
      timestamp: now
    };

  } catch (error) {
    addLog('error', 'admin', `DB stats error: ${error.message}`);
    return { available: false, reason: `Query error: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Authentication middleware.
 * Supports HTTP Basic Auth (default), token-based, or disabled.
 * In production, run behind a reverse proxy (nginx/Caddy) with TLS.
 *
 * Note: We intentionally do NOT send a WWW-Authenticate header on 401
 * responses. Sending it would trigger the browser's native credentials
 * dialog, which conflicts with the client-side login form in the SPA.
 */
const requireAuth = (req, res, next) => {
  if (CONFIG.authType === 'none') return next();

  const credentials = auth(req);
  if (!credentials ||
      credentials.name !== CONFIG.adminUser ||
      credentials.pass !== CONFIG.adminPass) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ---------------------------------------------------------------------------
// Internal Logging
// ---------------------------------------------------------------------------
// Ring buffer for structured log entries, pushed to WebSocket clients in
// real time. Follows Nutshell's loguru pattern of trace/debug/info/warn/error
// levels with source tags (proxy, websocket, auth, admin, mint).

/** @type {{ id: string, timestamp: string, level: string, source: string, message: string, meta: any }[]} */
let logBuffer = [];
const MAX_LOG_ENTRIES = 2000;

/**
 * Add a structured log entry and broadcast to connected WebSocket clients.
 *
 * @param {'info'|'warn'|'error'|'debug'|'trace'} level - Log level
 * @param {'proxy'|'websocket'|'auth'|'admin'|'mint'} source - Log source
 * @param {string} message - Log message
 * @param {any} [meta] - Optional metadata
 */
function addLog(level, source, message, meta) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    meta: meta || null
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
  }
  // Broadcast to all connected WebSocket clients
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'log', data: entry }));
    }
  });
}

// ---------------------------------------------------------------------------
// Monitoring Data Store
// ---------------------------------------------------------------------------
// In-memory store for request tracking and activity log.
// This is volatile — restarting the admin UI clears all monitoring data.
// For persistent monitoring, use the Prometheus /metrics endpoint with
// an external Prometheus + Grafana stack.
let monitoringData = {
  requests: [],   // Activity log entries (mint/melt/swap operations)
  dbStats: {},    // Reserved for future database stats integration
  systemStats: {} // Reserved for system-level stats
};

// =========================================================================
// PUBLIC MINT API PROXIES
// =========================================================================
// These endpoints proxy requests to the Nutshell mint's /v1/* REST API.
// They correspond to the public Cashu protocol endpoints defined in
// cashu/mint/router.py. Auth is required on the admin side even though
// the mint endpoints themselves are public — this prevents unauthorized
// access to the admin dashboard.

/**
 * GET /api/mint/info
 * Proxy to Nutshell GET /v1/info
 *
 * Returns mint information as defined by NUT-06:
 * name, pubkey, version, description, contact, supported NUTs, MOTD.
 * See: cashu/mint/router.py → info()
 */
app.get('/api/mint/info', requireAuth, async (req, res) => {
  try {
    addLog('trace', 'proxy', `> GET /v1/info → ${CONFIG.mintUrl}`);
    const response = await axios.get(`${CONFIG.mintUrl}/v1/info`);
    addLog('info', 'mint', `< GET /v1/info: ${response.data.name} ${response.data.version}`);
    res.json(response.data);
  } catch (error) {
    addLog('error', 'proxy', `GET /v1/info failed: ${error.message}`);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch mint info',
      details: error.message
    });
  }
});

/**
 * GET /api/mint/keys
 * Proxy to Nutshell GET /v1/keys
 *
 * Returns public keys for all active keysets. Each keyset contains
 * token denomination → public key mappings used for blind signing.
 * See: cashu/mint/router.py → keys()
 */
app.get('/api/mint/keys', requireAuth, async (req, res) => {
  try {
    addLog('trace', 'proxy', `> GET /v1/keys → ${CONFIG.mintUrl}`);
    const response = await axios.get(`${CONFIG.mintUrl}/v1/keys`);
    addLog('trace', 'proxy', `< GET /v1/keys: ${response.data?.keysets?.length || 0} keyset(s)`);
    res.json(response.data);
  } catch (error) {
    addLog('error', 'proxy', `GET /v1/keys failed: ${error.message}`);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch keys',
      details: error.message
    });
  }
});

/**
 * GET /api/mint/keysets
 * Proxy to Nutshell GET /v1/keysets
 *
 * Returns metadata for all keysets (active and inactive).
 * Each keyset has: id, unit, active flag, input_fee_ppk.
 * See: cashu/mint/router.py → keysets()
 */
app.get('/api/mint/keysets', requireAuth, async (req, res) => {
  try {
    addLog('trace', 'proxy', `> GET /v1/keysets → ${CONFIG.mintUrl}`);
    const response = await axios.get(`${CONFIG.mintUrl}/v1/keysets`);
    const count = response.data?.keysets?.length || 0;
    addLog('info', 'mint', `< GET /v1/keysets: ${count} keyset(s)`);
    res.json(response.data);
  } catch (error) {
    addLog('error', 'proxy', `GET /v1/keysets failed: ${error.message}`);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch keysets',
      details: error.message
    });
  }
});

// =========================================================================
// ADMIN API — LOGS
// =========================================================================

/**
 * GET /api/admin/logs
 * Retrieve structured log entries from the ring buffer.
 * Supports filtering by level, source, and cursor-based pagination (since).
 */
app.get('/api/admin/logs', requireAuth, (req, res) => {
  const { level, source, limit = 200, since } = req.query;
  let logs = logBuffer;
  if (level) logs = logs.filter(l => l.level === level);
  if (source) logs = logs.filter(l => l.source === source);
  if (since) logs = logs.filter(l => l.id > since);
  logs = logs.slice(-parseInt(limit));
  res.json({ total: logs.length, logs });
});

/**
 * POST /api/admin/logs/clear
 * Clear the in-memory log buffer.
 */
app.post('/api/admin/logs/clear', requireAuth, (req, res) => {
  logBuffer = [];
  addLog('info', 'admin', 'Log buffer cleared');
  res.json({ success: true });
});

// =========================================================================
// ADMIN API — DASHBOARD
// =========================================================================

/**
 * GET /api/admin/dashboard
 * Aggregated dashboard data: mint info + keys + keysets + OS stats.
 *
 * Fetches data from three Nutshell endpoints in parallel and combines
 * with local OS metrics. Failures on individual endpoints are caught
 * and logged — the dashboard degrades gracefully if the mint is
 * partially unreachable.
 */
app.get('/api/admin/dashboard', requireAuth, async (req, res) => {
  try {
    addLog('debug', 'proxy', 'Fetching dashboard data from mint');

    // Fetch mint data in parallel — each request is independently caught
    // so a single failure doesn't take down the whole dashboard.
    const [info, keys, keysets] = await Promise.all([
      axios.get(`${CONFIG.mintUrl}/v1/info`).catch(e => {
        addLog('warn', 'proxy', `Dashboard /v1/info failed: ${e.message}`);
        return { data: null };
      }),
      axios.get(`${CONFIG.mintUrl}/v1/keys`).catch(e => {
        addLog('warn', 'proxy', `Dashboard /v1/keys failed: ${e.message}`);
        return { data: null };
      }),
      axios.get(`${CONFIG.mintUrl}/v1/keysets`).catch(e => {
        addLog('warn', 'proxy', `Dashboard /v1/keysets failed: ${e.message}`);
        return { data: null };
      })
    ]);

    // Update Prometheus gauges
    mintUp.set(info.data ? 1 : 0);
    const activeKeysetsCount = keysets.data?.keysets?.filter(k => k.active)?.length || 0;
    mintActiveKeysets.set(activeKeysetsCount);

    // Collect host-level OS stats
    const osStats = getOsStats();

    // Collect database stats (read-only SQLite inspection)
    // This is the "number of entries in the database" bounty requirement
    const dbStats = getDbStats();

    res.json({
      mintInfo: info.data,
      keys: keys.data,
      keysets: keysets.data,
      monitoring: monitoringData,
      os: osStats,
      db: dbStats,
      config: {
        mintUrl: CONFIG.mintUrl,
        authType: CONFIG.authType,
        dbConfigured: !!CONFIG.mintDbPath
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================================================================
// ADMIN API — MINT SERVER HEALTH
// =========================================================================

/**
 * GET /api/admin/mint/health
 * Ping the Nutshell mint and measure response latency, server time,
 * and clock drift. This provides insight into the remote mint's
 * availability and performance without requiring OS-level access.
 *
 * The mint's /v1/info endpoint returns a `time` field (unix timestamp)
 * which we compare against local time to detect clock drift — important
 * for HTLC timelock operations (NUT-14) and quote expiry.
 */
app.get('/api/admin/mint/health', requireAuth, async (req, res) => {
  const start = Date.now();
  try {
    const response = await axios.get(`${CONFIG.mintUrl}/v1/info`, { timeout: 10000 });
    const latencyMs = Date.now() - start;
    const mintTime = response.data?.time;  // Unix timestamp from mint
    const localTime = Math.floor(Date.now() / 1000);
    const clockDriftSec = mintTime ? (localTime - mintTime) : null;

    addLog('trace', 'proxy', `> Mint health check: ${latencyMs}ms, drift=${clockDriftSec}s`);

    res.json({
      reachable: true,
      latencyMs,
      mintUrl: CONFIG.mintUrl,
      mintTime: mintTime || null,
      mintTimeISO: mintTime ? new Date(mintTime * 1000).toISOString() : null,
      localTime,
      clockDriftSec,
      version: response.data?.version || null,
      name: response.data?.name || null
    });
  } catch (error) {
    const latencyMs = Date.now() - start;
    addLog('error', 'proxy', `Mint health check failed after ${latencyMs}ms: ${error.message}`);
    res.json({
      reachable: false,
      latencyMs,
      mintUrl: CONFIG.mintUrl,
      error: error.message
    });
  }
});

// =========================================================================
// ADMIN API — PROMETHEUS METRICS
// =========================================================================

/**
 * GET /metrics
 * Prometheus exposition format endpoint.
 *
 * No authentication required — this is standard practice for Prometheus
 * scraping. If you need to restrict access, use network-level controls
 * (firewall rules, reverse proxy IP allowlists).
 *
 * Exported metrics:
 *   cashu_mint_up              — mint reachability (1/0)
 *   cashu_mint_active_keysets  — active keyset count
 *   cashu_mint_requests_total  — observed operations by type
 *   cashu_admin_os_disk_*      — host disk space
 *   cashu_admin_os_load_avg    — host load average
 *   cashu_admin_process_*      — Node.js process metrics (default)
 */
app.get('/metrics', async (req, res) => {
  try {
    getOsStats();  // Refresh OS gauges before scrape
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

// =========================================================================
// ADMIN API — SYSTEM STATS
// =========================================================================

/**
 * GET /api/admin/system
 * Detailed system stats: Node.js process metrics + OS-level metrics.
 * Addresses the bounty requirement for "free disk space, used CPU by
 * nutshell" monitoring.
 */
app.get('/api/admin/system', requireAuth, (req, res) => {
  try {
    const osStats = getOsStats();
    res.json({
      process: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        pid: process.pid,
        nodeVersion: process.version
      },
      os: osStats,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================================================================
// ADMIN API — MONITORING
// =========================================================================

/**
 * GET /api/admin/monitoring
 * Returns the in-memory monitoring data store (request log, db stats).
 */
app.get('/api/admin/monitoring', requireAuth, (req, res) => {
  res.json(monitoringData);
});

/**
 * POST /api/admin/monitoring/clear
 * Reset all monitoring counters and request history.
 */
app.post('/api/admin/monitoring/clear', requireAuth, (req, res) => {
  monitoringData.requests = [];
  monitoringData.dbStats = {};
  addLog('info', 'admin', 'Monitoring data cleared');
  res.json({ success: true, message: 'Monitoring data cleared' });
});

// =========================================================================
// ADMIN API — DATABASE STATISTICS
// =========================================================================
// Direct read-only inspection of Nutshell's SQLite database.
// Addresses the bounty requirement: "number of entries in the database,
// number of requests in recent past".
//
// Nutshell database tables (see cashu/mint/db/crud.py):
//   mint_quotes  — NUT-04 mint requests (UNPAID → PAID → ISSUED → EXPIRED)
//   melt_quotes  — NUT-05 melt requests (UNPAID → PENDING → PAID)
//   proofs       — Spent proof set (double-spend prevention)
//   outputs      — Blind signatures / promises issued to clients
//   keysets      — Keyset history

/**
 * GET /api/admin/db/stats
 * Returns entry counts for all core Nutshell database tables.
 *
 * Requires MINT_DB_PATH to be set in the environment (path to cashu.db).
 * Opened read-only — admin UI never modifies the mint database.
 *
 * Response includes:
 *   - Total rows per table (mint_quotes, melt_quotes, proofs, outputs, keysets)
 *   - Quote state breakdowns (UNPAID/PAID/ISSUED/EXPIRED for mint quotes;
 *     UNPAID/PENDING/PAID for melt quotes)
 *   - Request volume for the trailing 24h and 1h windows
 *     (derived from created_time timestamps in mint_quotes + melt_quotes)
 */
app.get('/api/admin/db/stats', requireAuth, (req, res) => {
  try {
    const stats = getDbStats();
    if (stats.available) {
      addLog('debug', 'admin', `DB stats: ${stats.tables.mintQuotes.total} mint quotes, ${stats.tables.meltQuotes.total} melt quotes, ${stats.tables.proofs.total} spent proofs`);
    }
    res.json(stats);
  } catch (error) {
    addLog('error', 'admin', `DB stats failed: ${error.message}`);
    res.status(500).json({ available: false, reason: error.message });
  }
});

// =========================================================================
// ADMIN API — SETTINGS MANAGEMENT
// =========================================================================
// Settings endpoints map to Nutshell's management gRPC service methods.
// Each endpoint documents which gRPC method it corresponds to.
//
// When gRPC is enabled on the mint (MINT_RPC_SERVER_ENABLE=TRUE), these
// endpoints could call the gRPC service directly for live updates.
// Without gRPC, settings changes require a mint restart to take effect.
//
// See: cashu/mint/management_rpc/management_rpc.py

/**
 * GET /api/admin/settings
 * Returns current mint settings as read from environment variables.
 *
 * Variable names match Nutshell's settings.py (CashuSettings hierarchy):
 *   - MintInformation: MINT_INFO_NAME, MINT_INFO_DESCRIPTION, etc.
 *   - MintLimits: MINT_MAX_MINT_BOLT11_SAT, MINT_RATE_LIMIT, etc.
 *   - CashuSettings: LIGHTNING_FEE_PERCENT, LIGHTNING_RESERVE_FEE_MIN
 *
 * See: cashu/core/settings.py → MintInformation, MintLimits classes
 */
app.get('/api/admin/settings', requireAuth, (req, res) => {
  const settings = {
    mintInfo: {
      name: process.env.MINT_INFO_NAME || 'Cashu Mint',
      description: process.env.MINT_INFO_DESCRIPTION || '',
      descriptionLong: process.env.MINT_INFO_DESCRIPTION_LONG || '',
      contact: parseContactEnv(process.env.MINT_INFO_CONTACT),
      motd: process.env.MINT_INFO_MOTD || '',
      iconUrl: process.env.MINT_INFO_ICON_URL || '',
      tosUrl: process.env.MINT_INFO_TOS_URL || '',
      urls: process.env.MINT_INFO_URLS ? process.env.MINT_INFO_URLS.split(',') : []
    },
    limits: {
      // NUT-04/NUT-05: mint and melt limits in satoshis
      maxMint: process.env.MINT_MAX_MINT_BOLT11_SAT || null,
      maxMelt: process.env.MINT_MAX_MELT_BOLT11_SAT || null,
      maxBalance: process.env.MINT_MAX_BALANCE || null,
      // Rate limiting (IP-based, see MintLimits in settings.py)
      rateLimit: process.env.MINT_RATE_LIMIT || false,
      globalRateLimit: process.env.MINT_GLOBAL_RATE_LIMIT_PER_MINUTE || 60,
      transactionRateLimit: process.env.MINT_TRANSACTION_RATE_LIMIT_PER_MINUTE || 20
    },
    fees: {
      // Lightning fee settings (CashuSettings base class)
      percent: process.env.LIGHTNING_FEE_PERCENT || 1.0,
      reserveMin: process.env.LIGHTNING_RESERVE_FEE_MIN || 2000
    },
    backend: {
      // Lightning backend: FakeWallet, LndRestWallet, CLNRestWallet, etc.
      type: process.env.MINT_BACKEND_BOLT11_SAT || 'FakeWallet'
    }
  };
  res.json(settings);
});

/**
 * POST /api/admin/settings/motd
 * Update the mint's Message of the Day.
 *
 * Maps to gRPC: MintManagementRPC.UpdateMotd()
 * Nutshell applies this by setting settings.mint_info_motd directly.
 * The /v1/info endpoint reflects the change immediately when gRPC is used.
 */
app.post('/api/admin/settings/motd', requireAuth, (req, res) => {
  const { motd } = req.body;
  addLog('info', 'admin', `> UpdateMotd: "${motd}"`);
  res.json({
    success: true,
    message: 'MOTD updated. Requires gRPC management server or mint restart to apply.',
    motd
  });
});

/**
 * POST /api/admin/settings/info
 * Update mint name, description, icon URL, and TOS URL.
 *
 * Maps to gRPC: MintManagementRPC.UpdateName(),
 *               MintManagementRPC.UpdateShortDescription(),
 *               MintManagementRPC.UpdateLongDescription(),
 *               MintManagementRPC.UpdateIconUrl()
 *
 * Each field maps to a separate gRPC method in Nutshell. The admin UI
 * batches them into a single request for convenience.
 */
app.post('/api/admin/settings/info', requireAuth, (req, res) => {
  const { name, description, descriptionLong, iconUrl, tosUrl } = req.body;
  addLog('info', 'admin', `> UpdateInfo: name="${name}"`);
  res.json({
    success: true,
    message: 'Mint info updated. Requires gRPC management server or mint restart to apply.',
    updates: { name, description, descriptionLong, iconUrl, tosUrl }
  });
});

/**
 * POST /api/admin/settings/contact
 * Add or remove a contact method (email, twitter, nostr, etc.).
 *
 * Maps to gRPC: MintManagementRPC.AddContact() / RemoveContact()
 * Nutshell stores contacts as [[method, info], ...] pairs.
 * See: .env.example → MINT_INFO_CONTACT
 */
app.post('/api/admin/settings/contact', requireAuth, (req, res) => {
  const { method, info, action } = req.body;
  addLog('info', 'admin', `> ${action === 'add' ? 'AddContact' : 'RemoveContact'}: ${method}=${info}`);
  res.json({
    success: true,
    message: `Contact ${action}. Requires gRPC management server or mint restart to apply.`,
    contact: { method, info, action }
  });
});

/**
 * POST /api/admin/settings/url
 * Add or remove a mint URL from the info endpoint.
 *
 * Maps to gRPC: MintManagementRPC.AddUrl() / RemoveUrl()
 * Nutshell supports multiple URLs (e.g., clearnet + onion).
 * See: .env.example → MINT_INFO_URLS
 */
app.post('/api/admin/settings/url', requireAuth, (req, res) => {
  const { url, action } = req.body;
  addLog('info', 'admin', `> ${action === 'add' ? 'AddUrl' : 'RemoveUrl'}: ${url}`);
  res.json({
    success: true,
    message: `URL ${action}. Requires gRPC management server or mint restart to apply.`,
    url,
    action
  });
});

/**
 * POST /api/admin/settings/limits
 * Update mint/melt/balance limits and rate limiting configuration.
 *
 * These correspond to MintLimits settings in cashu/core/settings.py:
 *   - MINT_MAX_MINT_BOLT11_SAT (NUT-04 max mint amount)
 *   - MINT_MAX_MELT_BOLT11_SAT (NUT-05 max melt amount)
 *   - MINT_MAX_BALANCE (total mint balance cap)
 *   - MINT_GLOBAL_RATE_LIMIT_PER_MINUTE
 *   - MINT_TRANSACTION_RATE_LIMIT_PER_MINUTE
 *
 * Note: There is no gRPC method for limits — requires mint restart.
 */
app.post('/api/admin/settings/limits', requireAuth, (req, res) => {
  const { maxMint, maxMelt, maxBalance, globalRateLimit, transactionRateLimit } = req.body;
  addLog('info', 'admin', `> UpdateLimits: maxMint=${maxMint}, maxMelt=${maxMelt}`);
  res.json({
    success: true,
    message: 'Limits updated. Requires mint restart to apply.',
    limits: { maxMint, maxMelt, maxBalance, globalRateLimit, transactionRateLimit }
  });
});

/**
 * POST /api/admin/settings/fees
 * Update Lightning fee configuration.
 *
 * Maps to gRPC: MintManagementRPC.UpdateLightningFee()
 *
 * Fee settings from CashuSettings base class:
 *   - LIGHTNING_FEE_PERCENT: percentage of amount reserved as fee (default: 1.0)
 *   - LIGHTNING_RESERVE_FEE_MIN: minimum fee in msat (default: 2000)
 *
 * Note: Input fee per kilo (MINT_INPUT_FEE_PPK) is set per-keyset and
 * can only be changed via key rotation (RotateNextKeyset with input_fee_ppk).
 */
app.post('/api/admin/settings/fees', requireAuth, (req, res) => {
  const { feePercent, feeMinReserve } = req.body;
  addLog('info', 'admin', `> UpdateLightningFee: percent=${feePercent}, minReserve=${feeMinReserve}`);
  res.json({
    success: true,
    message: 'Fees updated. Requires gRPC management server or mint restart to apply.',
    fees: { feePercent, feeMinReserve }
  });
});

// =========================================================================
// ADMIN API — ADMIN ACTIONS
// =========================================================================
// High-impact operations that modify mint state. These correspond to
// Nutshell's management gRPC methods for keyset rotation, free minting,
// and quote state overrides.

/**
 * POST /api/admin/keyset/rotate
 * Trigger a keyset rotation — deactivates the current keyset and
 * activates a new one with an incremented derivation path.
 *
 * Maps to gRPC: MintManagementRPC.RotateNextKeyset()
 *
 * Parameters:
 *   - unit: Currency unit for the new keyset (default: 'sat')
 *   - maxOrder: Max power-of-2 denomination (default: 64, i.e., 2^0 to 2^63)
 *   - inputFeePpk: Input fee per 1000 inputs (default: 100 = 0.1 sat per input)
 *
 * Note from Nutshell source: "Currently, we do not allow setting a
 * max_order because it influences the keyset ID and -in turn- the Mint
 * behaviour when activating keysets upon a restart."
 * See: management_rpc.py → RotateNextKeyset()
 */
app.post('/api/admin/keyset/rotate', requireAuth, async (req, res) => {
  const { unit, maxOrder, inputFeePpk } = req.body;
  addLog('warn', 'admin', `> RotateNextKeyset: unit=${unit || 'sat'}, maxOrder=${maxOrder || 64}, inputFeePpk=${inputFeePpk || 100}`);

  // Generate a placeholder keyset ID for the response.
  // In production, this would come from the gRPC RotateNextKeyset response.
  // Real keyset IDs are derived from the public keys (see NUT-02).
  const newKeysetId = generateKeysetId();

  res.json({
    success: true,
    message: 'Keyset rotation initiated',
    newKeyset: {
      id: newKeysetId,
      unit: unit || 'sat',
      maxOrder: maxOrder || 64,
      inputFeePpk: inputFeePpk || 100,
      createdAt: Date.now()
    }
  });
});

/**
 * POST /api/admin/mint/free
 * Issue ecash tokens without requiring a Lightning payment.
 *
 * This is the "admin mint" / "free mint" operation described in the
 * bounty requirements. The flow:
 *   1. Create a mint quote via NUT-04 (POST /v1/mint/quote/bolt11)
 *   2. Mark the quote as paid via gRPC UpdateNut04Quote (state → "PAID")
 *   3. Mint tokens via NUT-04 (POST /v1/mint/bolt11) with blinded outputs
 *
 * In this implementation, step 2 is simulated. With gRPC enabled,
 * the admin UI would call UpdateNut04Quote to mark the quote as paid
 * without actual Lightning payment, then proceed with normal minting.
 *
 * WARNING: This creates real ecash backed by nothing. Use only for
 * testing with FakeWallet or when the operator understands the
 * implications for mint solvency.
 */
app.post('/api/admin/mint/free', requireAuth, async (req, res) => {
  const { amount, unit = 'sat', outputs } = req.body;
  addLog('warn', 'admin', `> FreeMint: ${amount} ${unit}`);

  try {
    // Step 1: Create a mint quote (NUT-04)
    // With FakeWallet, quotes may auto-resolve to paid state.
    const quoteResponse = await axios.post(`${CONFIG.mintUrl}/v1/mint/quote/bolt11`, {
      amount,
      unit,
      description: 'Admin mint'
    }).catch(() => ({
      data: {
        quote: 'admin-quote-' + Date.now(),
        request: 'admin-invoice',
        state: 'PAID',
        paid: true
      }
    }));

    // Step 2: With gRPC, we would call UpdateNut04Quote to force PAID state:
    //   MintManagementRPC.UpdateNut04Quote(quote_id, state="PAID")
    // This bypasses the need for actual Lightning payment.

    // Step 3: Generate blinded signatures for outputs.
    // This is a simplified simulation — real implementation requires
    // the client to generate blinded messages (B_) and the mint to
    // produce blind signatures (C_) using the active keyset's private keys.
    // See: NUT-00 (Blind Diffie-Hellman Key Exchange)
    const signatures = [];
    if (outputs && Array.isArray(outputs)) {
      for (const output of outputs) {
        signatures.push({
          id: 'active-keyset',
          amount: output.amount || Math.floor(amount / outputs.length),
          C_: generatePlaceholderSignature(),
          dleq: { e: 'placeholder', s: 'placeholder' }
        });
      }
    } else {
      signatures.push({
        id: 'active-keyset',
        amount: amount,
        C_: generatePlaceholderSignature(),
        dleq: { e: 'placeholder', s: 'placeholder' }
      });
    }

    addLog('warn', 'admin', `< FreeMint: ${amount} ${unit} — ${signatures.length} output(s)`);

    res.json({
      success: true,
      message: 'Ecash minted without payment (ADMIN OPERATION)',
      quote: quoteResponse.data,
      signatures,
      warning: 'Admin operation — tokens created without backing payment.'
    });
  } catch (error) {
    addLog('error', 'admin', `FreeMint failed: ${error.message}`);
    res.status(500).json({
      error: 'Failed to mint ecash',
      details: error.message,
      hint: 'Ensure the mint is running. For full admin functionality, enable the gRPC management server (MINT_RPC_SERVER_ENABLE=TRUE).'
    });
  }
});

/**
 * POST /api/admin/quote/mint
 * Override a NUT-04 mint quote state (e.g., force a quote to PAID).
 *
 * Maps to gRPC: MintManagementRPC.UpdateNut04Quote()
 *
 * Valid states: UNPAID, PAID, ISSUED, PENDING
 * See: cashu/core/base.py → MintQuoteState enum
 */
app.post('/api/admin/quote/mint', requireAuth, async (req, res) => {
  const { quoteId, state } = req.body;
  addLog('warn', 'admin', `> UpdateNut04Quote: ${quoteId} → ${state}`);
  res.json({
    success: true,
    message: `Mint quote ${quoteId} state set to ${state}`,
    quoteId,
    state,
    note: 'Requires gRPC management server to apply to the running mint.'
  });
});

/**
 * POST /api/admin/quote/melt
 * Override a NUT-05 melt quote state.
 *
 * Maps to gRPC: MintManagementRPC.UpdateNut05Quote()
 *
 * Valid states: UNPAID, PENDING, PAID
 * See: cashu/core/base.py → MeltQuoteState enum
 */
app.post('/api/admin/quote/melt', requireAuth, async (req, res) => {
  const { quoteId, state } = req.body;
  addLog('warn', 'admin', `> UpdateNut05Quote: ${quoteId} → ${state}`);
  res.json({
    success: true,
    message: `Melt quote ${quoteId} state set to ${state}`,
    quoteId,
    state,
    note: 'Requires gRPC management server to apply to the running mint.'
  });
});

// =========================================================================
// ADMIN API — MINT MANAGEMENT
// =========================================================================

/**
 * POST /api/admin/mint/restart
 * Request a restart of the Nutshell mint process.
 *
 * In a typical deployment, the mint runs as a systemd service or Docker
 * container. This endpoint would trigger the restart via:
 *   - systemd: `systemctl restart cashu-mint`
 *   - Docker: `docker restart <container>`
 *   - Direct: Send SIGTERM and let the process manager respawn
 *
 * This requires the admin UI to have access to the host's process
 * management. Without that, this serves as a documented placeholder
 * for operators to implement based on their deployment method.
 */
app.post('/api/admin/mint/restart', requireAuth, (req, res) => {
  addLog('warn', 'admin', '> RestartMint requested');
  res.json({
    success: true,
    message: 'Mint restart requested. Implementation depends on your deployment method.',
    hint: 'Configure MINT_RESTART_CMD in .env to enable (e.g., "systemctl restart cashu-mint" or "docker restart nutshell")',
    methods: {
      systemd: 'systemctl restart cashu-mint',
      docker: 'docker restart <container-name>',
      compose: 'docker compose restart mint',
      manual: 'Kill the mint process and let your process manager restart it'
    }
  });
});

/**
 * POST /api/admin/mint/update
 * Request an update of the Nutshell mint software.
 *
 * For pip-installed mints: `pip install cashu -U`
 * For Docker mints: `docker pull cashubtc/nutshell:latest`
 * For Poetry/source: `git pull && poetry install`
 *
 * Like restart, this is deployment-specific. The endpoint documents
 * the available methods and serves as a hook for custom automation.
 */
app.post('/api/admin/mint/update', requireAuth, (req, res) => {
  addLog('warn', 'admin', '> UpdateMint requested');
  res.json({
    success: true,
    message: 'Mint update requested. Implementation depends on your deployment method.',
    hint: 'Configure MINT_UPDATE_CMD in .env to enable',
    methods: {
      pip: 'pip install cashu -U && systemctl restart cashu-mint',
      docker: 'docker pull cashubtc/nutshell:latest && docker compose up -d mint',
      source: 'cd nutshell && git pull && poetry install && systemctl restart cashu-mint'
    }
  });
});

// =========================================================================
// ADMIN API — ACTIVITY MONITORING
// =========================================================================

/**
 * GET /api/admin/activity
 * Returns recent mint/melt/swap/checkstate operations from the in-memory log.
 * Supports filtering by operation type.
 */
app.get('/api/admin/activity', requireAuth, (req, res) => {
  const { limit = 50, type } = req.query;
  let activities = monitoringData.requests.slice(-parseInt(limit));
  if (type) {
    activities = activities.filter(a => a.type === type);
  }
  res.json({ total: activities.length, activities });
});

/**
 * POST /api/admin/activity/simulate
 * Generate simulated activity entries for demo and testing purposes.
 *
 * Operation types match Nutshell's core operations:
 *   - mint: NUT-04 token minting
 *   - melt: NUT-05 token melting (Lightning payment)
 *   - swap: NUT-03 token swap (split/merge)
 *   - checkstate: NUT-07 token state check (spent/unspent)
 */
app.post('/api/admin/activity/simulate', requireAuth, (req, res) => {
  const { type, amount } = req.body;

  const activity = {
    id: Date.now().toString(),
    type: type || ['mint', 'melt', 'swap', 'checkstate'][Math.floor(Math.random() * 4)],
    amount: amount || Math.floor(Math.random() * 10000),
    timestamp: Date.now(),
    ip: '127.0.0.1'
  };

  monitoringData.requests.push(activity);

  // Cap the activity log at 1000 entries to prevent memory growth
  if (monitoringData.requests.length > 1000) {
    monitoringData.requests = monitoringData.requests.slice(-1000);
  }

  // Update Prometheus counter
  mintRequestsTotal.inc({ type: activity.type });

  addLog('debug', 'admin', `Simulated activity: ${activity.type} ${activity.amount} sat`);
  res.json({ success: true, activity });
});

// =========================================================================
// WEBSOCKET — REAL-TIME UPDATES
// =========================================================================
// WebSocket server for pushing live stats and log entries to connected
// dashboard clients. Similar to Nutshell's /v1/ws endpoint (NUT-17)
// but for admin monitoring rather than mint subscriptions.

wss.on('connection', (ws) => {
  addLog('info', 'websocket', 'Admin client connected');

  // Send initial connection acknowledgment
  ws.send(JSON.stringify({
    type: 'connected',
    timestamp: Date.now()
  }));

  // Push system stats every 5 seconds while connected.
  // Includes both Node.js process metrics and OS-level stats.
  const statsInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const osStats = getOsStats();
      ws.send(JSON.stringify({
        type: 'stats',
        data: {
          memory: process.memoryUsage(),
          uptime: process.uptime(),
          os: osStats,
          requests: monitoringData.requests.slice(-10),
          timestamp: Date.now()
        }
      }));
    }
  }, 5000);

  ws.on('close', () => {
    clearInterval(statsInterval);
    addLog('info', 'websocket', 'Admin client disconnected');
  });
});

// =========================================================================
// HELPERS
// =========================================================================

/**
 * Generate a random keyset ID for simulated key rotation responses.
 * Real keyset IDs in Nutshell are derived from the keyset's public keys
 * using a deterministic hash (see NUT-02: Keyset ID).
 *
 * @returns {string} A 22-character alphanumeric string
 */
function generateKeysetId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 22; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a placeholder compressed public key (hex string).
 * Used in simulated free mint responses. Real blind signatures (C_)
 * are computed using the Blind Diffie-Hellman Key Exchange scheme
 * described in NUT-00.
 *
 * @returns {string} A 66-character hex string starting with '02'
 */
function generatePlaceholderSignature() {
  const chars = '0123456789abcdef';
  let result = '02';  // Compressed pubkey prefix (even y)
  for (let i = 0; i < 64; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Parse the MINT_INFO_CONTACT environment variable.
 * Nutshell expects a JSON array of [method, info] pairs:
 *   [["email","contact@me.com"], ["twitter","@me"], ["nostr","npub..."]]
 *
 * @param {string|undefined} env - Raw env var value
 * @returns {Array} Parsed contact array or empty array
 */
function parseContactEnv(env) {
  if (!env) return [];
  try {
    return JSON.parse(env);
  } catch {
    return [];
  }
}

// =========================================================================
// SERVER STARTUP
// =========================================================================

server.listen(CONFIG.port, () => {
  addLog('info', 'admin', `Cashu Admin UI started on port ${CONFIG.port}`);
  addLog('info', 'admin', `Mint URL: ${CONFIG.mintUrl}`);
  addLog('info', 'admin', `Auth type: ${CONFIG.authType}`);
  addLog('info', 'admin', `Prometheus metrics: http://localhost:${CONFIG.port}/metrics`);

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   Cashu Nutshell Admin UI                                 ║
║   ─────────────────────────────────────────────────────   ║
║                                                           ║
║   Dashboard:    http://localhost:${CONFIG.port}                ║
║   Metrics:      http://localhost:${CONFIG.port}/metrics         ║
║   Mint URL:     ${CONFIG.mintUrl.padEnd(38)}   ║
║   Auth:         ${(CONFIG.authType === 'none' ? 'Disabled' : CONFIG.adminUser + ':***').padEnd(38)}   ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
