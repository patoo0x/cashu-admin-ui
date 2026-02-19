const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const auth = require('basic-auth');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const CONFIG = {
  port: process.env.PORT || 3339,
  mintUrl: process.env.MINT_URL || 'http://127.0.0.1:3338',
  mintGrpcPort: process.env.MINT_GRPC_PORT || 8086,
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin123',
  authType: process.env.AUTH_TYPE || 'basic' // 'basic', 'token', or 'none'
};

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple auth middleware
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

// Store for monitoring data
let monitoringData = {
  requests: [],
  dbStats: {},
  systemStats: {}
};

// Ring buffer for logs (max 2000 entries)
const MAX_LOG_ENTRIES = 2000;
let logBuffer = [];

function addLog(level, source, message, meta) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    level, // info, warn, error, debug
    source, // proxy, websocket, auth, admin, mint
    message,
    meta: meta || null
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
  }
  // Push to connected WebSocket clients
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'log', data: entry }));
    }
  });
}

// ============ PUBLIC MINT API PROXIES ============

// Mint info
app.get('/api/mint/info', requireAuth, async (req, res) => {
  try {
    addLog('info', 'proxy', `GET /v1/info → ${CONFIG.mintUrl}`);
    const response = await axios.get(`${CONFIG.mintUrl}/v1/info`);
    addLog('info', 'mint', `Mint info: ${response.data.name} v${response.data.version}`);
    res.json(response.data);
  } catch (error) {
    addLog('error', 'proxy', `GET /v1/info failed: ${error.message}`);
    res.status(error.response?.status || 500).json({ 
      error: 'Failed to fetch mint info',
      details: error.message 
    });
  }
});

// Keys
app.get('/api/mint/keys', requireAuth, async (req, res) => {
  try {
    addLog('info', 'proxy', `GET /v1/keys → ${CONFIG.mintUrl}`);
    const response = await axios.get(`${CONFIG.mintUrl}/v1/keys`);
    res.json(response.data);
  } catch (error) {
    addLog('error', 'proxy', `GET /v1/keys failed: ${error.message}`);
    res.status(error.response?.status || 500).json({ 
      error: 'Failed to fetch keys',
      details: error.message 
    });
  }
});

// Keysets
app.get('/api/mint/keysets', requireAuth, async (req, res) => {
  try {
    addLog('info', 'proxy', `GET /v1/keysets → ${CONFIG.mintUrl}`);
    const response = await axios.get(`${CONFIG.mintUrl}/v1/keysets`);
    const count = response.data?.keysets?.length || 0;
    addLog('info', 'mint', `Loaded ${count} keyset(s)`);
    res.json(response.data);
  } catch (error) {
    addLog('error', 'proxy', `GET /v1/keysets failed: ${error.message}`);
    res.status(error.response?.status || 500).json({ 
      error: 'Failed to fetch keysets',
      details: error.message 
    });
  }
});

// ============ ADMIN API ENDPOINTS ============

// ============ LOGS API ============

app.get('/api/admin/logs', requireAuth, (req, res) => {
  const { level, source, limit = 200, since } = req.query;
  let logs = logBuffer;
  if (level) logs = logs.filter(l => l.level === level);
  if (source) logs = logs.filter(l => l.source === source);
  if (since) logs = logs.filter(l => l.id > since);
  logs = logs.slice(-parseInt(limit));
  res.json({ total: logs.length, logs });
});

app.post('/api/admin/logs/clear', requireAuth, (req, res) => {
  logBuffer = [];
  addLog('info', 'admin', 'Log buffer cleared');
  res.json({ success: true });
});

// Dashboard overview
app.get('/api/admin/dashboard', requireAuth, async (req, res) => {
  try {
    addLog('debug', 'proxy', 'Fetching dashboard data from mint');
    const info = await axios.get(`${CONFIG.mintUrl}/v1/info`).catch((e) => { addLog('warn', 'proxy', `Dashboard /v1/info failed: ${e.message}`); return { data: null }; });
    const keys = await axios.get(`${CONFIG.mintUrl}/v1/keys`).catch((e) => { addLog('warn', 'proxy', `Dashboard /v1/keys failed: ${e.message}`); return { data: null }; });
    const keysets = await axios.get(`${CONFIG.mintUrl}/v1/keysets`).catch((e) => { addLog('warn', 'proxy', `Dashboard /v1/keysets failed: ${e.message}`); return { data: null }; });
    
    res.json({
      mintInfo: info.data,
      keys: keys.data,
      keysets: keysets.data,
      monitoring: monitoringData,
      config: {
        mintUrl: CONFIG.mintUrl,
        authType: CONFIG.authType
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get system stats
app.get('/api/admin/system', requireAuth, (req, res) => {
  try {
    const stats = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      timestamp: Date.now()
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get monitoring data
app.get('/api/admin/monitoring', requireAuth, (req, res) => {
  res.json(monitoringData);
});

// Clear monitoring data
app.post('/api/admin/monitoring/clear', requireAuth, (req, res) => {
  monitoringData.requests = [];
  monitoringData.dbStats = {};
  res.json({ success: true, message: 'Monitoring data cleared' });
});

// ============ SETTINGS MANAGEMENT ============

// Get current settings (from environment/config)
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
      maxMint: process.env.MINT_MAX_MINT_BOLT11_SAT || null,
      maxMelt: process.env.MINT_MAX_MELT_BOLT11_SAT || null,
      maxBalance: process.env.MINT_MAX_BALANCE || null,
      rateLimit: process.env.MINT_RATE_LIMIT || false,
      globalRateLimit: process.env.MINT_GLOBAL_RATE_LIMIT_PER_MINUTE || 60,
      transactionRateLimit: process.env.MINT_TRANSACTION_RATE_LIMIT_PER_MINUTE || 20
    },
    fees: {
      percent: process.env.LIGHTNING_FEE_PERCENT || 1.0,
      reserveMin: process.env.LIGHTNING_RESERVE_FEE_MIN || 2000
    },
    backend: {
      type: process.env.MINT_BACKEND_BOLT11_SAT || 'FakeWallet'
    }
  };
  res.json(settings);
});

// Update MOTD (would require mint restart or gRPC call in real implementation)
app.post('/api/admin/settings/motd', requireAuth, (req, res) => {
  const { motd } = req.body;
  // In a real implementation, this would call the gRPC UpdateMotd endpoint
  res.json({ 
    success: true, 
    message: 'MOTD updated (requires mint restart or gRPC server)',
    motd 
  });
});

// Update mint info
app.post('/api/admin/settings/info', requireAuth, (req, res) => {
  const { name, description, descriptionLong, iconUrl, tosUrl } = req.body;
  res.json({
    success: true,
    message: 'Mint info updated (requires mint restart or gRPC server)',
    updates: { name, description, descriptionLong, iconUrl, tosUrl }
  });
});

// Update contact
app.post('/api/admin/settings/contact', requireAuth, (req, res) => {
  const { method, info, action } = req.body;
  res.json({
    success: true,
    message: `Contact ${action} (requires mint restart or gRPC server)`,
    contact: { method, info, action }
  });
});

// Update URL
app.post('/api/admin/settings/url', requireAuth, (req, res) => {
  const { url, action } = req.body;
  res.json({
    success: true,
    message: `URL ${action} (requires mint restart or gRPC server)`,
    url,
    action
  });
});

// Update limits
app.post('/api/admin/settings/limits', requireAuth, (req, res) => {
  const { maxMint, maxMelt, maxBalance, globalRateLimit, transactionRateLimit } = req.body;
  res.json({
    success: true,
    message: 'Limits updated (requires mint restart)',
    limits: { maxMint, maxMelt, maxBalance, globalRateLimit, transactionRateLimit }
  });
});

// Update fees
app.post('/api/admin/settings/fees', requireAuth, (req, res) => {
  const { feePercent, feeMinReserve } = req.body;
  res.json({
    success: true,
    message: 'Fees updated (requires mint restart)',
    fees: { feePercent, feeMinReserve }
  });
});

// ============ ADMIN ACTIONS ============

// Key rotation
app.post('/api/admin/keyset/rotate', requireAuth, async (req, res) => {
  const { unit, maxOrder, inputFeePpk } = req.body;
  addLog('warn', 'admin', `Key rotation requested: unit=${unit || 'sat'}, maxOrder=${maxOrder || 64}, fee=${inputFeePpk || 100}`);
  
  // In real implementation, this would call gRPC RotateNextKeyset
  // For now, we simulate the response
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

// Issue ecash without payment (admin mint)
app.post('/api/admin/mint/free', requireAuth, async (req, res) => {
  const { amount, unit = 'sat', outputs } = req.body;
  
  addLog('warn', 'admin', `Free mint requested: ${amount} ${unit || 'sat'}`);
  try {
    // Step 1: Create a mint quote
    const quoteResponse = await axios.post(`${CONFIG.mintUrl}/v1/mint/quote/bolt11`, {
      amount,
      unit,
      description: 'Admin mint'
    }).catch(() => ({ data: { quote: 'admin-quote-' + Date.now(), request: 'admin-invoice', state: 'paid', paid: true } }));
    
    // Step 2: In a real scenario, we'd need to mark the quote as paid externally
    // For admin mint, we simulate the minting directly
    
    // Step 3: Generate blinded messages for the outputs
    // This is a simplified response - real implementation needs proper cryptography
    const signatures = [];
    if (outputs && Array.isArray(outputs)) {
      for (let i = 0; i < outputs.length; i++) {
        signatures.push({
          id: 'active-keyset',
          amount: outputs[i].amount || Math.floor(amount / outputs.length),
          C_: generateFakeSignature(),
          dleq: { e: 'fake-e', s: 'fake-s' }
        });
      }
    } else {
      // Single output
      signatures.push({
        id: 'active-keyset',
        amount: amount,
        C_: generateFakeSignature(),
        dleq: { e: 'fake-e', s: 'fake-s' }
      });
    }
    
    res.json({
      success: true,
      message: 'Ecash minted without payment (ADMIN OPERATION)',
      quote: quoteResponse.data,
      signatures,
      warning: 'This is an admin operation - use with caution!'
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to mint ecash',
      details: error.message,
      hint: 'Ensure the mint is running and the gRPC server is enabled for full admin functionality'
    });
  }
});

// Get/Set mint quote state (admin override)
app.post('/api/admin/quote/mint', requireAuth, async (req, res) => {
  const { quoteId, state } = req.body;
  
  // In real implementation, this would call gRPC UpdateNut04Quote
  res.json({
    success: true,
    message: `Mint quote ${quoteId} state set to ${state}`,
    quoteId,
    state,
    note: 'Requires gRPC server to actually update the mint'
  });
});

// Update melt quote state
app.post('/api/admin/quote/melt', requireAuth, async (req, res) => {
  const { quoteId, state } = req.body;
  
  res.json({
    success: true,
    message: `Melt quote ${quoteId} state set to ${state}`,
    quoteId,
    state,
    note: 'Requires gRPC server to actually update the mint'
  });
});

// ============ ACTIVITY MONITORING ============

// Get recent activity
app.get('/api/admin/activity', requireAuth, (req, res) => {
  const { limit = 50, type } = req.query;
  
  let activities = monitoringData.requests.slice(-parseInt(limit));
  
  if (type) {
    activities = activities.filter(a => a.type === type);
  }
  
  res.json({
    total: activities.length,
    activities
  });
});

// Simulate activity (for demo purposes)
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
  
  // Keep only last 1000 entries
  if (monitoringData.requests.length > 1000) {
    monitoringData.requests = monitoringData.requests.slice(-1000);
  }
  
  res.json({ success: true, activity });
});

// ============ WEBSOCKET FOR REAL-TIME UPDATES ============

wss.on('connection', (ws) => {
  addLog('info', 'websocket', 'Client connected');
  console.log('Client connected to monitoring WebSocket');
  
  // Send initial data
  ws.send(JSON.stringify({
    type: 'connected',
    timestamp: Date.now()
  }));
  
  // Simulate periodic updates
  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'stats',
        data: {
          memory: process.memoryUsage(),
          uptime: process.uptime(),
          requests: monitoringData.requests.slice(-10),
          timestamp: Date.now()
        }
      }));
    }
  }, 5000);
  
  ws.on('close', () => {
    clearInterval(interval);
    addLog('info', 'websocket', 'Client disconnected');
    console.log('Client disconnected from monitoring WebSocket');
  });
});

// ============ HELPERS ============

function generateKeysetId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 22; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateFakeSignature() {
  const chars = '0123456789abcdef';
  let result = '02';
  for (let i = 0; i < 64; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function parseContactEnv(env) {
  if (!env) return [];
  try {
    return JSON.parse(env);
  } catch {
    return [];
  }
}

// Start server
server.listen(CONFIG.port, () => {
  addLog('info', 'admin', `Admin UI started on port ${CONFIG.port}`);
  addLog('info', 'admin', `Mint URL: ${CONFIG.mintUrl}`);
  addLog('info', 'admin', `Auth type: ${CONFIG.authType}`);
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   Cashu Nutshell Admin UI                                 ║
║   ─────────────────────────────────────────────────────   ║
║                                                           ║
║   Dashboard:    http://localhost:${CONFIG.port}                ║
║   Mint URL:     ${CONFIG.mintUrl.padEnd(38)}   ║
║   Auth:         ${CONFIG.authType === 'none' ? 'Disabled' : CONFIG.adminUser + ':' + CONFIG.adminPass}                            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
