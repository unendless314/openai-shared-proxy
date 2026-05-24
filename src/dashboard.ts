import { config } from './config.js';

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

interface UsageToday {
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface UpstreamKeyInfo {
  label: string;
  hash: string;
  keyType: 'free' | 'master';
  healthy: boolean;
  cooldownUntil: string | null;
  exhaustedUntil: string | null;
  isDisabled: boolean;
  lastError: string | null;
  lastSuccessAt: string | null;
  usageToday: UsageToday;
}

interface StatusDetails {
  service: { ok: boolean; uptimeSec: number };
  upstreamKeys: UpstreamKeyInfo[];
  usageEstimate: { dateUtc: string; requests: number; tokens: number; inputTokens: number; outputTokens: number; cachedTokens: number };
}

// Helper to format uptime into human-readable string
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

export function renderDashboard(details: StatusDetails): string {
  const tokenLimit = config.keyDailyTokenLimit;
  const reqLimit = config.keyDailyReqLimit;
  const systemStatus = details.service.ok ? 'Operational' : 'Degraded';
  const systemStatusClass = details.service.ok ? 'status-ok' : 'status-error';

  // Build the list of upstream key cards
  const keysHtml = details.upstreamKeys.map(key => {
    const isFree = key.keyType === 'free';
    const typeLabel = isFree ? 'Free Pool' : 'Paid Master';
    const typeClass = isFree ? 'badge-free' : 'badge-master';
    
    // Status text & class
    let statusLabel = 'Healthy';
    let statusClass = 'badge-success';
    let pulseClass = 'pulse-green';
    let alertDetails = '';

    if (key.isDisabled) {
      statusLabel = 'Disabled';
      statusClass = 'badge-danger';
      pulseClass = 'pulse-red';
      const safeError = key.lastError ? escapeHtml(key.lastError) : 'Permanently disabled due to invalid credentials (401)';
      alertDetails = `<div class="key-alert danger">Disabled: ${safeError}</div>`;
    } else if (key.exhaustedUntil) {
      statusLabel = 'Exhausted';
      statusClass = 'badge-exhausted';
      pulseClass = 'pulse-orange';
      const timeRemaining = Math.max(0, Math.round((new Date(key.exhaustedUntil).getTime() - Date.now()) / 1000 / 60));
      alertDetails = `<div class="key-alert">Quota exhausted. Resets in ${timeRemaining}m (midnight UTC).</div>`;
    } else if (key.cooldownUntil) {
      statusLabel = 'Cooldown';
      statusClass = 'badge-cooldown';
      pulseClass = 'pulse-yellow';
      const timeRemaining = Math.max(0, Math.round((new Date(key.cooldownUntil).getTime() - Date.now()) / 1000));
      const safeError = key.lastError ? escapeHtml(key.lastError) : '';
      alertDetails = `<div class="key-alert warning">Temp cooldown: ${timeRemaining}s remaining.<br><span class="error-msg">${safeError}</span></div>`;
    } else if (!key.healthy) {
      statusLabel = 'Unhealthy';
      statusClass = 'badge-danger';
      pulseClass = 'pulse-red';
      const safeError = key.lastError ? escapeHtml(key.lastError) : 'Unknown key error';
      alertDetails = `<div class="key-alert danger">Error: ${safeError}</div>`;
    }

    // Token Progress Bar calculations
    const tokenCap = isFree ? tokenLimit : Infinity;
    const tokenVal = key.usageToday.tokens || 0;
    const tokenPercent = tokenCap === Infinity ? 0 : Math.min(100, (tokenVal / tokenCap) * 100);
    const tokenDisplay = tokenCap === Infinity ? `${tokenVal.toLocaleString()} (No Cap)` : `${tokenVal.toLocaleString()} / ${tokenCap.toLocaleString()}`;
    const tokenProgressClass = tokenPercent > 80 ? 'progress-danger' : tokenPercent > 50 ? 'progress-warning' : 'progress-success';

    // Request Progress Bar calculations
    const reqCap = isFree ? reqLimit : Infinity;
    const reqVal = key.usageToday.requests || 0;
    const reqPercent = reqCap === Infinity ? 0 : Math.min(100, (reqVal / reqCap) * 100);
    const reqDisplay = reqCap === Infinity ? `${reqVal.toLocaleString()} (No Cap)` : `${reqVal.toLocaleString()} / ${reqCap.toLocaleString()}`;
    const reqProgressClass = reqPercent > 80 ? 'progress-danger' : reqPercent > 50 ? 'progress-warning' : 'progress-success';

    // Cache hit ratio for this key
    const keyInputTokens = key.usageToday.inputTokens || 0;
    const keyCachedTokens = key.usageToday.cachedTokens || 0;
    const keyHitRatio = keyInputTokens > 0 ? ((keyCachedTokens / keyInputTokens) * 100).toFixed(1) : '0.0';

    return `
      <div class="key-card" data-key-hash="${key.hash}">
        <div class="key-card-header">
          <div class="key-identity">
            <span class="key-label" title="${key.hash}">${key.label}</span>
            <span class="badge ${typeClass}">${typeLabel}</span>
          </div>
          <div class="key-status-wrapper">
            <span class="pulse-indicator ${pulseClass}"></span>
            <span class="badge ${statusClass}">${statusLabel}</span>
          </div>
        </div>

        <div class="key-metrics">
          <!-- Token Meter -->
          <div class="metric-group">
            <div class="metric-label-row">
              <span>Tokens Today</span>
              <span class="metric-value-text token-value">${tokenDisplay}</span>
            </div>
            <div class="progress-container">
              <div class="progress-bar ${tokenProgressClass} token-bar" style="width: ${isFree ? tokenPercent : 0}%"></div>
            </div>
          </div>

          <!-- Request Meter -->
          <div class="metric-group">
            <div class="metric-label-row">
              <span>Requests Today</span>
              <span class="metric-value-text req-value">${reqDisplay}</span>
            </div>
            <div class="progress-container">
              <div class="progress-bar ${reqProgressClass} req-bar" style="width: ${isFree ? reqPercent : 0}%"></div>
            </div>
          </div>

          <!-- Cached Tokens Meter -->
          <div class="metric-group">
            <div class="metric-label-row">
              <span>Cached Tokens</span>
              <span class="metric-value-text cached-value">${keyCachedTokens.toLocaleString()} (${keyHitRatio}%)</span>
            </div>
          </div>
        </div>

        ${alertDetails ? `<div class="alert-container">${alertDetails}</div>` : '<div class="alert-container"></div>'}

        <div class="key-meta-info">
          <span>Successes: ${key.lastSuccessAt ? new Date(key.lastSuccessAt).toLocaleTimeString() : 'Never'}</span>
        </div>
      </div>
    `;
  }).join('');

  const globalInputTokens = details.usageEstimate.inputTokens || 0;
  const globalCachedTokens = details.usageEstimate.cachedTokens || 0;
  const globalHitRatio = globalInputTokens > 0 ? ((globalCachedTokens / globalInputTokens) * 100).toFixed(1) : '0.0';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenAI Shared Proxy Administrative Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0b0f19;
      --bg-gradient-start: #0a0e1a;
      --bg-gradient-end: #121026;
      --card-bg: rgba(20, 27, 48, 0.4);
      --card-border: rgba(255, 255, 255, 0.05);
      --card-glow: rgba(99, 102, 241, 0.03);
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --text-muted: #6b7280;
      
      --color-primary: #6366f1;
      --color-primary-glow: rgba(99, 102, 241, 0.15);
      --color-success: #10b981;
      --color-success-glow: rgba(16, 185, 129, 0.2);
      --color-warning: #f59e0b;
      --color-warning-glow: rgba(245, 158, 11, 0.2);
      --color-danger: #ef4444;
      --color-danger-glow: rgba(239, 68, 68, 0.2);
      --color-exhausted: #d97706;
      
      --font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-family);
      background-color: var(--bg-color);
      background-image: radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.05) 0%, transparent 40%),
                        radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.03) 0%, transparent 45%),
                        linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-end) 100%);
      background-attachment: fixed;
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
      padding: 2rem 1.5rem;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    /* Header Styling */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2.5rem;
      flex-wrap: wrap;
      gap: 1.5rem;
    }

    .brand {
      display: flex;
      flex-direction: column;
    }

    .brand h1 {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, #fff 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.25rem;
    }

    .brand p {
      color: var(--text-secondary);
      font-size: 0.95rem;
      font-weight: 300;
    }

    /* Actions and Refresh */
    .controls {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .btn {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--card-border);
      color: var(--text-primary);
      padding: 0.6rem 1.2rem;
      border-radius: 8px;
      font-family: var(--font-family);
      font-size: 0.9rem;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      backdrop-filter: blur(8px);
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-1px);
    }

    .btn:active {
      transform: translateY(0);
    }

    .btn-primary {
      background: var(--color-primary);
      border-color: rgba(255, 255, 255, 0.1);
    }

    .btn-primary:hover {
      background: #4f46e5;
      box-shadow: 0 0 15px rgba(99, 102, 241, 0.4);
    }

    .refresh-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-right-color: currentColor;
      border-radius: 50%;
      display: inline-block;
    }

    .spinning {
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Grid of Key metrics summary */
    .stats-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2.5rem;
    }

    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 12px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
      transition: border-color 0.3s ease;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: radial-gradient(100px circle at top left, var(--card-glow), transparent);
      pointer-events: none;
    }

    .stat-label {
      color: var(--text-secondary);
      font-size: 0.85rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }

    .stat-value {
      font-size: 1.8rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .stat-card.status-ok {
      border-left: 3px solid var(--color-success);
    }
    .stat-card.status-error {
      border-left: 3px solid var(--color-danger);
    }

    .status-badge-container {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-top: 0.25rem;
    }

    /* Pulsar Indicator */
    .pulse-indicator {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
      position: relative;
    }

    .pulse-green { background-color: var(--color-success); }
    .pulse-green::after {
      content: '';
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background-color: var(--color-success);
      opacity: 0.6;
      animation: pulse 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
    }

    .pulse-yellow { background-color: var(--color-warning); }
    .pulse-yellow::after {
      content: '';
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background-color: var(--color-warning);
      opacity: 0.6;
      animation: pulse 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
    }

    .pulse-orange { background-color: var(--color-exhausted); }
    .pulse-orange::after {
      content: '';
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background-color: var(--color-exhausted);
      opacity: 0.6;
      animation: pulse 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
    }

    .pulse-red { background-color: var(--color-danger); }
    .pulse-red::after {
      content: '';
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background-color: var(--color-danger);
      opacity: 0.6;
      animation: pulse 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
    }

    @keyframes pulse {
      0% { transform: scale(1); opacity: 0.8; }
      100% { transform: scale(2.8); opacity: 0; }
    }

    /* Section Headers */
    .section-title {
      font-size: 1.3rem;
      font-weight: 600;
      margin-bottom: 1.25rem;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    /* Upstream Keys Cards Grid */
    .keys-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2.5rem;
    }

    @media (max-width: 480px) {
      .keys-grid {
        grid-template-columns: 1fr;
      }
    }

    .key-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.2);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 12px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .key-card:hover {
      border-color: rgba(99, 102, 241, 0.2);
      transform: translateY(-2px);
      box-shadow: 0 12px 40px 0 rgba(99, 102, 241, 0.05);
    }

    .key-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .key-identity {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .key-label {
      font-weight: 600;
      font-size: 1rem;
      letter-spacing: -0.01em;
      color: var(--text-primary);
    }

    /* Badges */
    .badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .badge-free {
      background: rgba(99, 102, 241, 0.1);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.2);
    }

    .badge-master {
      background: rgba(245, 158, 11, 0.1);
      color: #fcd34d;
      border: 1px solid rgba(245, 158, 11, 0.2);
    }

    .badge-success {
      background: rgba(16, 185, 129, 0.12);
      color: #34d399;
    }

    .badge-cooldown {
      background: rgba(245, 158, 11, 0.12);
      color: #fbbf24;
    }

    .badge-exhausted {
      background: rgba(217, 119, 6, 0.12);
      color: #f59e0b;
    }

    .badge-danger {
      background: rgba(239, 68, 68, 0.12);
      color: #f87171;
    }

    .key-status-wrapper {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    /* Meters and Progress Bars */
    .key-metrics {
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
    }

    .metric-group {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .metric-label-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.85rem;
      color: var(--text-secondary);
    }

    .metric-value-text {
      font-weight: 500;
      color: var(--text-primary);
    }

    .progress-container {
      height: 6px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 3px;
      overflow: hidden;
      width: 100%;
    }

    .progress-bar {
      height: 100%;
      border-radius: 3px;
      width: 0%;
      transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .progress-success {
      background: linear-gradient(90deg, #10b981, #34d399);
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.3);
    }

    .progress-warning {
      background: linear-gradient(90deg, #f59e0b, #fbbf24);
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.3);
    }

    .progress-danger {
      background: linear-gradient(90deg, #ef4444, #f87171);
      box-shadow: 0 0 8px rgba(239, 68, 68, 0.3);
    }

    /* Key Alerts */
    .alert-container {
      min-height: 0px;
    }

    .key-alert {
      background: rgba(245, 158, 11, 0.05);
      border: 1px solid rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border-radius: 8px;
      padding: 0.75rem;
      font-size: 0.82rem;
      line-height: 1.4;
    }

    .key-alert.warning {
      background: rgba(245, 158, 11, 0.05);
      border: 1px solid rgba(245, 158, 11, 0.15);
      color: #fbbf24;
    }

    .key-alert.danger {
      background: rgba(239, 68, 68, 0.05);
      border: 1px solid rgba(239, 68, 68, 0.15);
      color: #f87171;
    }

    .error-msg {
      font-family: monospace;
      color: var(--text-muted);
      display: block;
      margin-top: 0.25rem;
      word-break: break-all;
    }

    .key-meta-info {
      font-size: 0.8rem;
      color: var(--text-muted);
      border-top: 1px solid rgba(255, 255, 255, 0.03);
      padding-top: 0.75rem;
      display: flex;
      justify-content: space-between;
    }

    /* Configuration Panel */
    .config-panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(12px);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }

    .config-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.25rem;
    }

    .config-item {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .config-item-label {
      font-size: 0.8rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 500;
      letter-spacing: 0.03em;
    }

    .config-item-value {
      font-size: 0.95rem;
      color: var(--text-primary);
      font-family: monospace;
      word-break: break-all;
    }

    footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.8rem;
      margin-top: 3rem;
      border-top: 1px solid rgba(255, 255, 255, 0.03);
      padding-top: 1.5rem;
    }

    footer a {
      color: var(--color-primary);
      text-decoration: none;
    }
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>OpenAI Shared Proxy</h1>
        <p>Cost-optimized aggregation & smart routing backend dashboard</p>
      </div>
      <div class="controls">
        <button id="refresh-btn" class="btn" onclick="triggerManualRefresh()">
          <span id="refresh-icon" class="refresh-spinner"></span>
          <span>Refresh</span>
        </button>
      </div>
    </header>

    <!-- Global Stats Overview -->
    <div class="stats-summary-grid">
      <div class="stat-card ${systemStatusClass}" id="card-system-status">
        <div class="stat-label">System Health</div>
        <div class="status-badge-container">
          <span class="pulse-indicator id-system-pulse ${details.service.ok ? 'pulse-green' : 'pulse-red'}"></span>
          <span class="stat-value" id="val-system-status">${systemStatus}</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Proxy Uptime</div>
        <div class="stat-value" id="val-uptime">${formatUptime(details.service.uptimeSec)}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Global Requests Today</div>
        <div class="stat-value" id="val-global-requests">${details.usageEstimate.requests.toLocaleString()}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Global Tokens Estimated</div>
        <div class="stat-value" id="val-global-tokens">${details.usageEstimate.tokens.toLocaleString()}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Global Cached Tokens</div>
        <div class="stat-value" id="val-global-cached">${globalCachedTokens.toLocaleString()}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Global Cache Hit Ratio</div>
        <div class="stat-value" id="val-cache-hit-ratio">${globalHitRatio}%</div>
      </div>
    </div>

    <!-- Active Upstream Keys -->
    <h2 class="section-title">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-key-round"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>
      Upstream Routing Pool
    </h2>
    <div class="keys-grid" id="keys-container">
      ${keysHtml}
    </div>

    <!-- System Configuration -->
    <h2 class="section-title">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
      Proxy Configuration
    </h2>
    <div class="config-panel">
      <div class="config-grid">
        <div class="config-item">
          <span class="config-item-label">Upstream Endpoint</span>
          <span class="config-item-value">${escapeHtml(config.openaiBaseUrl)}</span>
        </div>
        <div class="config-item">
          <span class="config-item-label">Default Target Model</span>
          <span class="config-item-value">${escapeHtml(config.openaiDefaultModel)}</span>
        </div>
        <div class="config-item">
          <span class="config-item-label">Free Key Token Limit</span>
          <span class="config-item-value">${tokenLimit.toLocaleString()} tokens/day</span>
        </div>
        <div class="config-item">
          <span class="config-item-label">Free Key Request Limit</span>
          <span class="config-item-value">${reqLimit.toLocaleString()} reqs/day</span>
        </div>
        <div class="config-item">
          <span class="config-item-label">Key Cooldown Time</span>
          <span class="config-item-value">${config.keyCooldownMs / 1000}s</span>
        </div>
        <div class="config-item">
          <span class="config-item-label">Upstream Timeout</span>
          <span class="config-item-value">${config.requestTimeoutMs / 1000}s</span>
        </div>
        <div class="config-item">
          <span class="config-item-label">Max Failover Retries</span>
          <span class="config-item-value">${config.maxRetries} times</span>
        </div>
        <div class="config-item">
          <span class="config-item-label">SQLite Database Path</span>
          <span class="config-item-value">${escapeHtml(config.sqlitePath)}</span>
        </div>
        <div class="config-item">
          <span class="config-item-label">Pruning Policy</span>
          <span class="config-item-value">30-Day TTL (Auto cleanup)</span>
        </div>
      </div>
    </div>

    <footer>
      <p>Powered by 🚀 <a href="https://github.com/linchunchiao/openai-shared-proxy" target="_blank">OpenAI Shared Proxy</a> &bull; Antigravity Engine v1.0.0</p>
    </footer>
  </div>

  <script>
    // Constants injected from Express backend configurations
    const tokenLimit = ${tokenLimit};
    const reqLimit = ${reqLimit};

    // Client-side HTML escaping helper to prevent XSS
    function escapeHtml(unsafe) {
      if (!unsafe) return '';
      return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Helper to format seconds to human readable
    function formatUptime(seconds) {
      const d = Math.floor(seconds / (3600 * 24));
      const h = Math.floor((seconds % (3600 * 24)) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;

      const parts = [];
      if (d > 0) parts.push(d + 'd');
      if (h > 0 || d > 0) parts.push(h + 'h');
      if (m > 0 || h > 0 || d > 0) parts.push(m + 'm');
      parts.push(s + 's');
      return parts.join(' ');
    }

    // Dynamic asynchronous poll and DOM updates without reloading
    async function updateDashboardData() {
      const refreshIcon = document.getElementById('refresh-icon');
      if (refreshIcon) refreshIcon.classList.add('spinning');

      try {
        const response = await fetch('/api/status');
        if (!response.ok) {
          throw new Error('Failed to fetch operational stats: ' + response.statusText);
        }
        
        const data = await response.json();
        
        // 1. Update system stats overview card
        const cardSystemStatus = document.getElementById('card-system-status');
        const valSystemStatus = document.getElementById('val-system-status');
        const pulseSystem = cardSystemStatus.querySelector('.id-system-pulse');
        
        const systemStatus = data.service.ok ? 'Operational' : 'Degraded';
        valSystemStatus.textContent = systemStatus;
        
        if (data.service.ok) {
          cardSystemStatus.className = 'stat-card status-ok';
          pulseSystem.className = 'pulse-indicator id-system-pulse pulse-green';
        } else {
          cardSystemStatus.className = 'stat-card status-error';
          pulseSystem.className = 'pulse-indicator id-system-pulse pulse-red';
        }

        // 2. Update uptime, requests, and tokens
        document.getElementById('val-uptime').textContent = formatUptime(data.service.uptimeSec);
        document.getElementById('val-global-requests').textContent = data.usageEstimate.requests.toLocaleString();
        document.getElementById('val-global-tokens').textContent = data.usageEstimate.tokens.toLocaleString();
        document.getElementById('val-global-cached').textContent = (data.usageEstimate.cachedTokens || 0).toLocaleString();
        
        const globalInputTokens = data.usageEstimate.inputTokens || 0;
        const globalCachedTokens = data.usageEstimate.cachedTokens || 0;
        const globalHitRatio = globalInputTokens > 0 ? ((globalCachedTokens / globalInputTokens) * 100).toFixed(1) : '0.0';
        document.getElementById('val-cache-hit-ratio').textContent = globalHitRatio + '%';

        // 3. Update upstream keys cards
        const container = document.getElementById('keys-container');
        const now = Date.now();
        
        data.upstreamKeys.forEach(key => {
          // Find matching key element in DOM
          const keyCard = container.querySelector('[data-key-hash="' + key.hash + '"]');
          if (keyCard) {
            const isFree = key.keyType === 'free';
            
            // Update pulse indicators and badges
            const pulse = keyCard.querySelector('.pulse-indicator');
            const statusBadge = keyCard.querySelector('.key-status-wrapper .badge:last-child');
            const alertContainer = keyCard.querySelector('.alert-container');
            
            let statusLabel = 'Healthy';
            let statusClass = 'badge badge-success';
            let pulseClass = 'pulse-indicator pulse-green';
            let alertHtml = '';

            if (key.isDisabled) {
              statusLabel = 'Disabled';
              statusClass = 'badge badge-danger';
              pulseClass = 'pulse-indicator pulse-red';
              alertHtml = '<div class="key-alert danger">Disabled: ' + escapeHtml(key.lastError || 'Permanently disabled due to invalid credentials (401)') + '</div>';
            } else if (key.exhaustedUntil) {
              const resTime = new Date(key.exhaustedUntil).getTime();
              const timeRemaining = Math.max(0, Math.round((resTime - now) / 1000 / 60));
              statusLabel = 'Exhausted';
              statusClass = 'badge badge-exhausted';
              pulseClass = 'pulse-indicator pulse-orange';
              alertHtml = '<div class="key-alert">Quota exhausted. Resets in ' + timeRemaining + 'm (midnight UTC).</div>';
            } else if (key.cooldownUntil) {
              const coolTime = new Date(key.cooldownUntil).getTime();
              const timeRemaining = Math.max(0, Math.round((coolTime - now) / 1000));
              statusLabel = 'Cooldown';
              statusClass = 'badge badge-cooldown';
              pulseClass = 'pulse-indicator pulse-yellow';
              alertHtml = '<div class="key-alert warning">Temp cooldown: ' + timeRemaining + 's remaining.<br><span class="error-msg">' + escapeHtml(key.lastError || '') + '</span></div>';
            } else if (!key.healthy) {
              statusLabel = 'Unhealthy';
              statusClass = 'badge badge-danger';
              pulseClass = 'pulse-indicator pulse-red';
              alertHtml = '<div class="key-alert danger">Error: ' + escapeHtml(key.lastError || 'Unknown key error') + '</div>';
            }

            pulse.className = pulseClass;
            statusBadge.className = statusClass;
            statusBadge.textContent = statusLabel;
            alertContainer.innerHTML = alertHtml;

            // Update Progress bars
            const tokenCap = isFree ? tokenLimit : Infinity;
            const tokenVal = key.usageToday.tokens;
            const tokenPercent = tokenCap === Infinity ? 0 : Math.min(100, (tokenVal / tokenCap) * 100);
            
            const tokenValText = keyCard.querySelector('.token-value');
            tokenValText.textContent = tokenCap === Infinity ? tokenVal.toLocaleString() + ' (No Cap)' : tokenVal.toLocaleString() + ' / ' + tokenCap.toLocaleString();
            
            const tokenBar = keyCard.querySelector('.token-bar');
            tokenBar.style.width = (isFree ? tokenPercent : 0) + '%';
            tokenBar.className = 'progress-bar token-bar ' + (tokenPercent > 80 ? 'progress-danger' : tokenPercent > 50 ? 'progress-warning' : 'progress-success');

            const reqCap = isFree ? reqLimit : Infinity;
            const reqVal = key.usageToday.requests;
            const reqPercent = reqCap === Infinity ? 0 : Math.min(100, (reqVal / reqCap) * 100);

            const reqValText = keyCard.querySelector('.req-value');
            reqValText.textContent = reqCap === Infinity ? reqVal.toLocaleString() + ' (No Cap)' : reqVal.toLocaleString() + ' / ' + reqCap.toLocaleString();
            
            const reqBar = keyCard.querySelector('.req-bar');
            reqBar.style.width = (isFree ? reqPercent : 0) + '%';
            reqBar.className = 'progress-bar req-bar ' + (reqPercent > 80 ? 'progress-danger' : reqPercent > 50 ? 'progress-warning' : 'progress-success');

            // Update Cached Tokens and Hit Ratio
            const keyInputTokens = key.usageToday.inputTokens || 0;
            const keyCachedTokens = key.usageToday.cachedTokens || 0;
            const keyHitRatio = keyInputTokens > 0 ? ((keyCachedTokens / keyInputTokens) * 100).toFixed(1) : '0.0';
            const cachedValText = keyCard.querySelector('.cached-value');
            if (cachedValText) {
              cachedValText.textContent = keyCachedTokens.toLocaleString() + ' (' + keyHitRatio + '%)';
            }

            // Success Time
            const successText = keyCard.querySelector('.key-meta-info span');
            successText.textContent = 'Successes: ' + (key.lastSuccessAt ? new Date(key.lastSuccessAt).toLocaleTimeString() : 'Never');
          }
        });
      } catch (err) {
        console.error('Dashboard refresh failed:', err);
      } finally {
        if (refreshIcon) {
          setTimeout(() => refreshIcon.classList.remove('spinning'), 300);
        }
      }
    }

    // Manual Refresh handler
    function triggerManualRefresh() {
      updateDashboardData();
    }

    // Automatic polling interval (10 seconds)
    setInterval(updateDashboardData, 10000);
  </script>
</body>
</html>
  `;
}
