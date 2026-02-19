/**
 * Cashu Admin UI — Frontend Application
 *
 * Single-page application (SPA) for the Cashu Nutshell Admin UI.
 * No build step required — vanilla JavaScript, no framework dependencies.
 *
 * Architecture:
 *   - CashuAdmin class manages all state and API communication
 *   - HTTP Basic Auth credentials stored in localStorage (base64)
 *   - WebSocket connection for real-time stats and log streaming
 *   - Pages are show/hide sections (no client-side routing)
 *
 * API communication goes through fetchWithAuth() which injects the
 * Basic Auth header on every request. On 401 responses, the user is
 * automatically logged out and returned to the login screen.
 *
 * The admin API endpoints correspond to Nutshell's management gRPC
 * service. See server.js for detailed endpoint documentation and
 * gRPC method mappings.
 */

class CashuAdmin {
  constructor() {
    this.apiBase = '/api';
    this.authType = null;
    this.credentials = null;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    this.init();
  }

  init() {
    this.checkAuth();
    this.bindEvents();
  }
  
  // Authentication
  checkAuth() {
    const savedCreds = localStorage.getItem('cashu_admin_creds');
    if (savedCreds) {
      try {
        const [user, pass] = atob(savedCreds).split(':');
        this.credentials = { name: user, pass: pass };
        this.fetchWithAuth('/api/admin/dashboard')
          .then(() => {
            this.showMainApp();
          })
          .catch(() => {
            this.showLogin();
          });
      } catch {
        this.showLogin();
      }
    } else {
      this.showLogin();
    }
  }
  
  showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
  }
  
  showMainApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    this.loadDashboard();
    this.connectWebSocket();
    this.initLogs();
  }
  
  doLogin(user, pass) {
    this.credentials = { name: user, pass: pass };
    localStorage.setItem('cashu_admin_creds', btoa(`${user}:${pass}`));
    
    this.fetchWithAuth('/api/admin/dashboard')
      .then(() => {
        this.showMainApp();
        this.showToast('Login successful!', 'success');
      })
      .catch((err) => {
        localStorage.removeItem('cashu_admin_creds');
        this.credentials = null;
        const errorEl = document.getElementById('login-error');
        errorEl.textContent = 'Invalid credentials';
        errorEl.classList.remove('hidden');
      });
  }
  
  logout() {
    localStorage.removeItem('cashu_admin_creds');
    this.credentials = null;
    if (this.ws) {
      this.ws.close();
    }
    this.showLogin();
    this.showToast('Logged out', 'success');
  }
  
  // API Helper
  async fetchWithAuth(url, options = {}) {
    const headers = {
      ...options.headers,
      'Content-Type': 'application/json'
    };
    
    if (this.credentials) {
      headers['Authorization'] = 'Basic ' + btoa(`${this.credentials.name}:${this.credentials.pass}`);
    }
    
    const response = await fetch(url, { ...options, headers });
    
    if (response.status === 401) {
      this.logout();
      throw new Error('Unauthorized');
    }
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || error.details || 'Request failed');
    }
    
    return response.json();
  }
  
  // ---------------------------------------------------------------------------
  // WebSocket — Real-time Updates
  // ---------------------------------------------------------------------------
  // Connects to the admin UI's WebSocket server for live stats and log
  // streaming. Similar in concept to Nutshell's /v1/ws (NUT-17) but for
  // admin monitoring rather than mint subscriptions.
  // Implements exponential backoff reconnection (up to 30s delay).
  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.updateConnectionStatus(true);
      console.log('WebSocket connected');
    };
    
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'stats') {
        this.updateLiveStats(data.data);
      } else if (data.type === 'log') {
        this.appendLogEntry(data.data);
      }
    };
    
    this.ws.onclose = () => {
      this.updateConnectionStatus(false);
      this.scheduleReconnect();
    };
    
    this.ws.onerror = () => {
      this.updateConnectionStatus(false);
    };
  }
  
  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      setTimeout(() => this.connectWebSocket(), delay);
    }
  }
  
  updateConnectionStatus(online) {
    const statusEl = document.getElementById('connection-status');
    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('.status-text');
    
    if (online) {
      dot.classList.remove('offline');
      dot.classList.add('online');
      text.textContent = 'Connected';
    } else {
      dot.classList.remove('online');
      dot.classList.add('offline');
      text.textContent = 'Disconnected';
    }
  }
  
  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  // Fetches aggregated data from GET /api/admin/dashboard which proxies
  // to Nutshell's /v1/info, /v1/keys, and /v1/keysets endpoints.
  // Also loads OS-level stats (memory, CPU, disk) from the server.
  async loadDashboard() {
    try {
      const data = await this.fetchWithAuth('/api/admin/dashboard');
      
      // Mint status
      document.getElementById('mint-status').textContent = data.mintInfo ? 'Online' : 'Offline';
      document.getElementById('mint-status').style.color = data.mintInfo ? '#3fb950' : '#f85149';
      
      // Active keysets
      const keysetsCount = data.keysets?.keysets?.length || 0;
      document.getElementById('active-keysets').textContent = keysetsCount;
      
      // Version
      document.getElementById('mint-version').textContent = data.mintInfo?.version || '--';
      
      // Mint info
      if (data.mintInfo) {
        document.getElementById('info-name').textContent = data.mintInfo.name || '--';
        document.getElementById('info-pubkey').textContent = data.mintInfo.pubkey ? 
          data.mintInfo.pubkey.substring(0, 20) + '...' : '--';
        document.getElementById('info-version').textContent = data.mintInfo.version || '--';
        document.getElementById('info-motd').textContent = data.mintInfo.motd || '--';
      }
      
      // Load OS stats
      if (data.os) {
        this.updateOsStats(data.os);
      }

      // Start mint health polling (every 10 seconds)
      this.pollMintHealth();
      if (this._mintHealthInterval) clearInterval(this._mintHealthInterval);
      this._mintHealthInterval = setInterval(() => this.pollMintHealth(), 10000);
      
      // Load settings
      await this.loadSettings();
      
      // Load keysets
      await this.loadKeysets();
      
    } catch (error) {
      this.showToast('Failed to load dashboard: ' + error.message, 'error');
    }
  }
  
  async loadSettings() {
    try {
      const settings = await this.fetchWithAuth('/api/admin/settings');
      
      if (settings.mintInfo) {
        document.getElementById('setting-name').value = settings.mintInfo.name || '';
        document.getElementById('setting-description').value = settings.mintInfo.description || '';
        document.getElementById('setting-description-long').value = settings.mintInfo.descriptionLong || '';
        document.getElementById('setting-icon-url').value = settings.mintInfo.iconUrl || '';
        document.getElementById('setting-tos-url').value = settings.mintInfo.tosUrl || '';
        document.getElementById('setting-motd').value = settings.mintInfo.motd || '';
      }
      
      if (settings.limits) {
        document.getElementById('setting-max-mint').value = settings.limits.maxMint || '';
        document.getElementById('setting-max-melt').value = settings.limits.maxMelt || '';
        document.getElementById('setting-max-balance').value = settings.limits.maxBalance || '';
        document.getElementById('setting-global-rate').value = settings.limits.globalRateLimit || 60;
        document.getElementById('setting-tx-rate').value = settings.limits.transactionRateLimit || 20;
      }
      
      if (settings.fees) {
        document.getElementById('setting-fee-percent').value = settings.fees.percent || '';
        document.getElementById('setting-fee-reserve').value = settings.fees.reserveMin || '';
      }
      
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }
  
  async loadKeysets() {
    try {
      const keysets = await this.fetchWithAuth('/api/mint/keysets');
      const keys = await this.fetchWithAuth('/api/mint/keys');
      
      const tbody = document.getElementById('keysets-body');
      
      if (keysets.keysets && keysets.keysets.length > 0) {
        tbody.innerHTML = keysets.keysets.map(ks => `
          <tr>
            <td class="code">${ks.id}</td>
            <td>${ks.unit}</td>
            <td>${ks.active ? '✓' : '✗'}</td>
            <td>${ks.input_fee_ppk || 0}</td>
            <td>64</td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No active keysets</td></tr>';
      }
      
    } catch (error) {
      console.error('Failed to load keysets:', error);
    }
  }
  
  // ---------------------------------------------------------------------------
  // Live Stats (WebSocket-driven)
  // ---------------------------------------------------------------------------
  // Called on every WebSocket 'stats' message (every 5 seconds).
  // Updates the dashboard's resource bars and system info panel.
  updateLiveStats(data) {
    // Update uptime
    const uptime = data.uptime;
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    document.getElementById('admin-uptime').textContent = 
      hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    
    // Update OS stats if available
    if (data.os) {
      this.updateOsStats(data.os);
    }
  }
  
  /**
   * Update OS-level stats on the dashboard.
   * These metrics address the bounty requirement for monitoring
   * "free disk space, used CPU by nutshell" on the underlying OS.
   * Progress bars use color thresholds: green (<60%), yellow (60-80%), red (>80%).
   */
  updateOsStats(os) {
    // OS Memory
    if (os.totalMemory && os.freeMemory) {
      const used = (os.totalMemory - os.freeMemory) / 1024 / 1024 / 1024;
      const total = os.totalMemory / 1024 / 1024 / 1024;
      const percent = os.usedMemoryPercent || ((1 - os.freeMemory / os.totalMemory) * 100);
      const el = document.getElementById('os-mem-usage');
      if (el) el.textContent = `${used.toFixed(1)} / ${total.toFixed(1)} GB (${percent.toFixed(1)}%)`;
      const bar = document.getElementById('os-mem-bar');
      if (bar) {
        bar.style.width = `${percent}%`;
        bar.style.background = percent > 80 ? '#f85149' : percent > 60 ? '#d29922' : 'linear-gradient(90deg, var(--accent-primary), #9d6de6)';
      }
    }

    // CPU
    if (os.cpuPercent !== null && os.cpuPercent !== undefined) {
      const cpuEl = document.getElementById('cpu-usage');
      if (cpuEl) cpuEl.textContent = `${os.cpuPercent}%`;
      const cpuBar = document.getElementById('cpu-bar');
      if (cpuBar) {
        cpuBar.style.width = `${Math.min(os.cpuPercent, 100)}%`;
        cpuBar.style.background = os.cpuPercent > 80 ? '#f85149' : os.cpuPercent > 60 ? '#d29922' : 'linear-gradient(90deg, var(--accent-primary), #9d6de6)';
      }
    }

    // Disk
    if (os.diskTotal && os.diskFree) {
      const usedDisk = (os.diskTotal - os.diskFree) / 1024 / 1024 / 1024;
      const totalDisk = os.diskTotal / 1024 / 1024 / 1024;
      const diskPercent = os.diskUsedPercent || ((1 - os.diskFree / os.diskTotal) * 100);
      const diskEl = document.getElementById('disk-usage');
      if (diskEl) diskEl.textContent = `${usedDisk.toFixed(1)} / ${totalDisk.toFixed(1)} GB (${diskPercent}%)`;
      const diskBar = document.getElementById('disk-bar');
      if (diskBar) {
        diskBar.style.width = `${diskPercent}%`;
        diskBar.style.background = diskPercent > 90 ? '#f85149' : diskPercent > 75 ? '#d29922' : 'linear-gradient(90deg, var(--accent-primary), #9d6de6)';
      }
    }

    // System info
    const hostnameEl = document.getElementById('hostname-info');
    if (hostnameEl && os.hostname) hostnameEl.textContent = os.hostname;
    
    const platformEl = document.getElementById('platform-info');
    if (platformEl) platformEl.textContent = `${os.platform || '--'} ${os.arch || ''} (${os.release || ''})`;
    
    const cpuInfoEl = document.getElementById('cpu-info');
    if (cpuInfoEl && os.cpuCount) cpuInfoEl.textContent = `${os.cpuCount}x ${os.cpuModel || ''}`;
    
    const loadEl = document.getElementById('load-avg-info');
    if (loadEl && os.loadAvg) loadEl.textContent = `${os.loadAvg['1m']?.toFixed(2)} / ${os.loadAvg['5m']?.toFixed(2)} / ${os.loadAvg['15m']?.toFixed(2)}`;
    
    const nodeEl = document.getElementById('node-version');
    if (nodeEl && os.nodeVersion) nodeEl.textContent = os.nodeVersion;
    
    const osUptimeEl = document.getElementById('os-uptime');
    if (osUptimeEl && os.uptime) {
      const days = Math.floor(os.uptime / 86400);
      const hrs = Math.floor((os.uptime % 86400) / 3600);
      osUptimeEl.textContent = days > 0 ? `${days}d ${hrs}h` : `${hrs}h`;
    }
  }
  
  // ---------------------------------------------------------------------------
  // Mint Server Health
  // ---------------------------------------------------------------------------
  // Pings the remote mint via GET /api/admin/mint/health and displays
  // latency, server time, clock drift, and connection health.
  // Maintains a rolling window of latency samples for averaging.

  /** @type {number[]} Rolling window of latency measurements */
  _latencySamples = [];

  async pollMintHealth() {
    try {
      const health = await this.fetchWithAuth('/api/admin/mint/health');

      // Latency bar (scale: 0-2000ms, anything over 2s = 100%)
      const latencyEl = document.getElementById('mint-latency');
      if (latencyEl) latencyEl.textContent = `${health.latencyMs}ms`;
      const latencyBar = document.getElementById('mint-latency-bar');
      if (latencyBar) {
        const pct = Math.min((health.latencyMs / 2000) * 100, 100);
        latencyBar.style.width = `${pct}%`;
        latencyBar.style.background = health.latencyMs > 1000 ? '#f85149'
          : health.latencyMs > 500 ? '#d29922'
          : 'linear-gradient(90deg, var(--accent-primary), #9d6de6)';
      }

      // Mint URL
      const urlEl = document.getElementById('mint-url-info');
      if (urlEl) urlEl.textContent = health.mintUrl || '--';

      // Server time
      const timeEl = document.getElementById('mint-server-time');
      if (timeEl && health.mintTimeISO) {
        timeEl.textContent = new Date(health.mintTimeISO).toLocaleTimeString();
      }

      // Clock drift
      const driftEl = document.getElementById('mint-clock-drift');
      if (driftEl && health.clockDriftSec !== null) {
        const absDrift = Math.abs(health.clockDriftSec);
        const driftStr = absDrift < 2 ? 'in sync'
          : `${health.clockDriftSec > 0 ? '+' : ''}${health.clockDriftSec}s`;
        driftEl.textContent = driftStr;
        driftEl.style.color = absDrift > 30 ? '#f85149' : absDrift > 5 ? '#d29922' : '#3fb950';
      }

      // Rolling average latency
      this._latencySamples.push(health.latencyMs);
      if (this._latencySamples.length > 30) this._latencySamples.shift();
      const avgLatency = Math.round(
        this._latencySamples.reduce((a, b) => a + b, 0) / this._latencySamples.length
      );
      const avgEl = document.getElementById('mint-avg-latency');
      if (avgEl) avgEl.textContent = `${avgLatency}ms (${this._latencySamples.length} samples)`;

      // Health status
      const healthEl = document.getElementById('mint-health');
      if (healthEl) {
        if (health.reachable) {
          healthEl.textContent = health.latencyMs < 500 ? '● Healthy' : '● Degraded';
          healthEl.style.color = health.latencyMs < 500 ? '#3fb950' : '#d29922';
        } else {
          healthEl.textContent = '● Unreachable';
          healthEl.style.color = '#f85149';
        }
      }
    } catch (e) {
      const healthEl = document.getElementById('mint-health');
      if (healthEl) {
        healthEl.textContent = '● Error';
        healthEl.style.color = '#f85149';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Monitoring
  // ---------------------------------------------------------------------------
  // Displays request counts by operation type (mint/melt/swap/checkstate).
  // These correspond to Nutshell's core Cashu protocol operations:
  //   - mint: NUT-04 (create tokens via Lightning invoice)
  //   - melt: NUT-05 (redeem tokens to Lightning payment)
  //   - swap: NUT-03 (split/merge tokens)
  //   - checkstate: NUT-07 (check if tokens are spent)
  async loadMonitoring() {
    try {
      const data = await this.fetchWithAuth('/api/admin/monitoring');
      
      document.getElementById('total-requests').textContent = data.requests?.length || 0;
      
      const counts = { mint: 0, melt: 0, swap: 0, checkstate: 0 };
      data.requests?.forEach(r => {
        if (counts[r.type] !== undefined) counts[r.type]++;
      });
      
      document.getElementById('mint-ops').textContent = counts.mint;
      document.getElementById('melt-ops').textContent = counts.melt;
      document.getElementById('swap-ops').textContent = counts.swap;
      
      // Recent requests table
      const tbody = document.getElementById('recent-requests-body');
      if (data.requests && data.requests.length > 0) {
        const recent = data.requests.slice(-20).reverse();
        tbody.innerHTML = recent.map(r => `
          <tr>
            <td>${new Date(r.timestamp).toLocaleTimeString()}</td>
            <td>${r.type}</td>
            <td>${r.amount || '-'}</td>
            <td>${r.ip}</td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No requests recorded</td></tr>';
      }
      
    } catch (error) {
      this.showToast('Failed to load monitoring data', 'error');
    }
  }
  
  // Activity
  async loadActivity(filter = '') {
    try {
      const data = await this.fetchWithAuth('/api/admin/activity');
      
      let activities = data.activities || [];
      if (filter) {
        activities = activities.filter(a => a.type === filter);
      }
      
      const tbody = document.getElementById('activity-body');
      if (activities.length > 0) {
        const recent = activities.slice(-50).reverse();
        tbody.innerHTML = recent.map(a => `
          <tr>
            <td>${new Date(a.timestamp).toLocaleString()}</td>
            <td>${a.type}</td>
            <td>${a.amount || '-'}</td>
            <td>${a.ip}</td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No activity recorded</td></tr>';
      }
      
    } catch (error) {
      this.showToast('Failed to load activity', 'error');
    }
  }
  
  // ---------------------------------------------------------------------------
  // Admin Actions
  // ---------------------------------------------------------------------------
  // High-impact operations that map to Nutshell's management gRPC service.
  // Each action corresponds to a specific gRPC method — see server.js
  // for the full mapping documentation.

  /**
   * Trigger keyset rotation.
   * Maps to gRPC: MintManagementRPC.RotateNextKeyset()
   * Creates a new keyset with incremented derivation path and deactivates
   * the current one. Existing tokens on old keysets remain valid.
   */
  async rotateKeyset() {
    try {
      const unit = document.getElementById('rotate-unit').value;
      const maxOrder = document.getElementById('rotate-max-order').value;
      const fee = document.getElementById('rotate-fee').value;
      
      const result = await this.fetchWithAuth('/api/admin/keyset/rotate', {
        method: 'POST',
        body: JSON.stringify({ unit, maxOrder, inputFeePpk: fee })
      });
      
      this.showToast('Keyset rotated: ' + result.newKeyset.id, 'success');
      await this.loadKeysets();
    } catch (error) {
      this.showToast('Failed to rotate keyset: ' + error.message, 'error');
    }
  }
  
  /**
   * Issue ecash tokens without Lightning payment.
   * Maps to gRPC: MintManagementRPC.UpdateNut04Quote() (mark quote as paid)
   * followed by standard NUT-04 minting flow.
   * WARNING: Creates unbacked ecash — use only for testing.
   */
  async freeMint(amount, unit, outputs) {
    try {
      const result = await this.fetchWithAuth('/api/admin/mint/free', {
        method: 'POST',
        body: JSON.stringify({ amount, unit, outputs })
      });
      
      return result;
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * Override a mint (NUT-04) or melt (NUT-05) quote state.
   * Maps to gRPC: MintManagementRPC.UpdateNut04Quote() or UpdateNut05Quote()
   * Useful for recovering from stuck quotes or testing state transitions.
   */
  async updateQuote(quoteId, type, state) {
    try {
      const endpoint = type === 'mint' ? '/api/admin/quote/mint' : '/api/admin/quote/melt';
      const result = await this.fetchWithAuth(endpoint, {
        method: 'POST',
        body: JSON.stringify({ quoteId, state })
      });
      
      this.showToast('Quote updated successfully', 'success');
    } catch (error) {
      this.showToast('Failed to update quote: ' + error.message, 'error');
    }
  }
  
  async simulateActivity() {
    try {
      await this.fetchWithAuth('/api/admin/activity/simulate', {
        method: 'POST',
        body: JSON.stringify({})
      });
      await this.loadMonitoring();
    } catch (error) {
      console.error('Failed to simulate activity');
    }
  }
  
  async clearMonitoring() {
    try {
      await this.fetchWithAuth('/api/admin/monitoring/clear', { method: 'POST' });
      await this.loadMonitoring();
      this.showToast('Monitoring data cleared', 'success');
    } catch (error) {
      this.showToast('Failed to clear monitoring data', 'error');
    }
  }
  
  // Event Bindings
  bindEvents() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(`page-${page}`).classList.add('active');
        
        // Load page data
        if (page === 'monitoring') this.loadMonitoring();
        if (page === 'activity') this.loadActivity();
      });
    });
    
    // Login form
    document.getElementById('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const user = document.getElementById('login-user').value;
      const pass = document.getElementById('login-pass').value;
      this.doLogin(user, pass);
    });
    
    // Logout
    document.getElementById('logout-btn').addEventListener('click', () => this.logout());
    
    // Settings tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        
        btn.classList.add('active');
        document.getElementById(`tab-${tab}`).classList.add('active');
      });
    });
    
    // Settings forms
    document.getElementById('settings-info-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const updates = {
        name: document.getElementById('setting-name').value,
        description: document.getElementById('setting-description').value,
        descriptionLong: document.getElementById('setting-description-long').value,
        iconUrl: document.getElementById('setting-icon-url').value,
        tosUrl: document.getElementById('setting-tos-url').value
      };
      
      await this.fetchWithAuth('/api/admin/settings/info', {
        method: 'POST',
        body: JSON.stringify(updates)
      });
      
      this.showToast('Mint info updated (requires restart)', 'success');
    });
    
    document.getElementById('settings-limits-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const limits = {
        maxMint: document.getElementById('setting-max-mint').value || null,
        maxMelt: document.getElementById('setting-max-melt').value || null,
        maxBalance: document.getElementById('setting-max-balance').value || null,
        globalRateLimit: parseInt(document.getElementById('setting-global-rate').value),
        transactionRateLimit: parseInt(document.getElementById('setting-tx-rate').value)
      };
      
      await this.fetchWithAuth('/api/admin/settings/limits', {
        method: 'POST',
        body: JSON.stringify(limits)
      });
      
      this.showToast('Limits updated (requires restart)', 'success');
    });
    
    document.getElementById('settings-fees-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fees = {
        feePercent: parseFloat(document.getElementById('setting-fee-percent').value),
        feeMinReserve: parseInt(document.getElementById('setting-fee-reserve').value)
      };
      
      await this.fetchWithAuth('/api/admin/settings/fees', {
        method: 'POST',
        body: JSON.stringify(fees)
      });
      
      this.showToast('Fees updated (requires restart)', 'success');
    });
    
    document.getElementById('settings-contact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const method = document.getElementById('contact-method').value;
      const info = document.getElementById('contact-info').value;
      const motd = document.getElementById('setting-motd').value;
      
      await this.fetchWithAuth('/api/admin/settings/contact', {
        method: 'POST',
        body: JSON.stringify({ method, info, action: 'update' })
      });
      
      await this.fetchWithAuth('/api/admin/settings/motd', {
        method: 'POST',
        body: JSON.stringify({ motd })
      });
      
      this.showToast('Contact info updated', 'success');
    });
    
    // Keyset rotation
    document.getElementById('rotate-keyset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.rotateKeyset();
    });
    
    // Monitoring buttons
    document.getElementById('clear-monitoring').addEventListener('click', () => this.clearMonitoring());
    document.getElementById('simulate-activity').addEventListener('click', () => this.simulateActivity());
    
    // Activity filter
    document.getElementById('activity-filter').addEventListener('change', (e) => {
      this.loadActivity(e.target.value);
    });
    
    document.getElementById('refresh-activity').addEventListener('click', () => {
      const filter = document.getElementById('activity-filter').value;
      this.loadActivity(filter);
    });
    
    // Action buttons
    document.getElementById('action-rotate').addEventListener('click', async () => {
      if (confirm('Are you sure you want to rotate the keyset?')) {
        await this.rotateKeyset();
      }
    });
    
    document.getElementById('action-update-quote').addEventListener('click', async () => {
      const quoteId = document.getElementById('quote-id').value;
      const type = document.getElementById('quote-type').value;
      const state = document.getElementById('quote-state').value;
      
      if (!quoteId) {
        this.showToast('Please enter a quote ID', 'error');
        return;
      }
      
      await this.updateQuote(quoteId, type, state);
    });
    
    document.getElementById('action-clear-cache').addEventListener('click', async () => {
      if (confirm('Clear all cache and monitoring data?')) {
        await this.clearMonitoring();
      }
    });
    
    // Free mint modal
    const modal = document.getElementById('free-mint-modal');
    document.getElementById('action-free-mint').addEventListener('click', () => {
      modal.classList.remove('hidden');
      setTimeout(() => modal.classList.add('visible'), 10);
      document.getElementById('free-mint-result').classList.add('hidden');
    });
    
    modal.querySelector('.modal-close').addEventListener('click', () => {
      modal.classList.remove('visible');
      setTimeout(() => modal.classList.add('hidden'), 200);
    });
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('visible');
        setTimeout(() => modal.classList.add('hidden'), 200);
      }
    });
    
    document.getElementById('free-mint-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const amount = parseInt(document.getElementById('free-mint-amount').value);
      const unit = document.getElementById('free-mint-unit').value;
      const numOutputs = parseInt(document.getElementById('free-mint-outputs').value);
      
      const outputs = [];
      let remaining = amount;
      for (let i = 0; i < numOutputs; i++) {
        const outAmount = i === numOutputs - 1 ? remaining : Math.floor(amount / numOutputs);
        outputs.push({ amount: outAmount, id: 'active-keyset', B_: 'fake-blinded-message' });
        remaining -= outAmount;
      }
      
      try {
        const result = await this.freeMint(amount, unit, outputs);
        
        const resultEl = document.getElementById('free-mint-result');
        resultEl.innerHTML = `<strong>Success!</strong>\n\n${JSON.stringify(result, null, 2)}`;
        resultEl.classList.remove('hidden');
        
        this.showToast('Ecash minted successfully!', 'success');
      } catch (error) {
        const resultEl = document.getElementById('free-mint-result');
        resultEl.innerHTML = `<strong>Error:</strong> ${error.message}`;
        resultEl.classList.remove('hidden');
      }
    });
  }
  
  // ============ LOGS ============
  
  initLogs() {
    this.logEntries = [];
    this.logAutoScroll = true;
    
    document.getElementById('refresh-logs')?.addEventListener('click', () => this.fetchLogs());
    document.getElementById('clear-logs')?.addEventListener('click', () => this.clearLogs());
    document.getElementById('log-level-filter')?.addEventListener('change', () => this.renderLogs());
    document.getElementById('log-source-filter')?.addEventListener('change', () => this.renderLogs());
    document.getElementById('log-autoscroll')?.addEventListener('change', (e) => {
      this.logAutoScroll = e.target.checked;
    });
    
    this.fetchLogs();
  }
  
  async fetchLogs() {
    try {
      const result = await this.fetchWithAuth('/api/admin/logs?limit=500');
      this.logEntries = result.logs || [];
      this.renderLogs();
    } catch (e) {
      console.error('Failed to fetch logs:', e);
    }
  }
  
  async clearLogs() {
    try {
      await this.fetchWithAuth('/api/admin/logs/clear', { method: 'POST' });
      this.logEntries = [];
      this.renderLogs();
      this.showToast('Logs cleared', 'success');
    } catch (e) {
      this.showToast('Failed to clear logs', 'error');
    }
  }
  
  appendLogEntry(entry) {
    this.logEntries.push(entry);
    // Keep max 2000 client-side
    if (this.logEntries.length > 2000) {
      this.logEntries = this.logEntries.slice(-2000);
    }
    this.renderLogs();
  }
  
  renderLogs() {
    const viewer = document.getElementById('log-viewer');
    if (!viewer) return;
    
    const levelFilter = document.getElementById('log-level-filter')?.value || '';
    const sourceFilter = document.getElementById('log-source-filter')?.value || '';
    
    let filtered = this.logEntries;
    if (levelFilter) filtered = filtered.filter(l => l.level === levelFilter);
    if (sourceFilter) filtered = filtered.filter(l => l.source === sourceFilter);
    
    if (filtered.length === 0) {
      viewer.innerHTML = '<div class="log-empty">No logs to display</div>';
      return;
    }
    
    viewer.innerHTML = filtered.map(entry => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const msg = this.escapeHtml(entry.message);
      return `<div class="log-entry">` +
        `<span class="log-time">${time}</span>` +
        `<span class="log-level ${entry.level}">${entry.level}</span>` +
        `<span class="log-source">[${entry.source}]</span>` +
        `<span class="log-message">${msg}</span>` +
        `</div>`;
    }).join('');
    
    if (this.logAutoScroll) {
      viewer.scrollTop = viewer.scrollHeight;
    }
  }
  
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  
  showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = { success: '✓', error: '✗', warning: '!' };
    
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <span class="toast-message">${message}</span>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  window.cashuAdmin = new CashuAdmin();
});
