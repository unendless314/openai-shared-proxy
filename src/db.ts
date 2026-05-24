import Database from 'better-sqlite3';
import crypto from 'crypto';
import { config } from './config.js';

let db: Database.Database;

export interface RequestLog {
  upstreamKeyHash: string;
  model: string;
  statusCode: number;
  latencyMs: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cachedInputTokens: number;
  keyType: 'free' | 'master';
}

export interface KeyState {
  keyHash: string;
  keyType: 'free' | 'master';
  cooldownUntil: number;
  exhaustedUntil: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  isDisabled: boolean;
}

export interface DailyUsage {
  dateUtc: string;
  upstreamKeyHash: string;
  requestsCount: number;
  tokensEstimated: number;
  inputTokensEstimated: number;
  outputTokensEstimated: number;
  cachedTokensEstimated: number;
}

// Generate a safe hash for an API key to identify it without exposing it
export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function getShortHashLabel(key: string): string {
  const hash = hashKey(key);
  return `sha256:${hash.substring(0, 8)}`;
}

export function initDb() {
  db = new Database(config.sqlitePath);
  db.pragma('journal_mode = WAL');

  // Check if we need to reset schema because of missing cached columns in either table
  let needsReset = false;
  try {
    db.prepare("SELECT cached_input_tokens FROM request_log LIMIT 1").get();
    db.prepare("SELECT cached_tokens_estimated FROM daily_usage_estimate LIMIT 1").get();
  } catch (err: any) {
    if (err.message.includes('no such column') || err.message.includes('no such table')) {
      needsReset = true;
    }
  }

  if (needsReset) {
    console.log('🔄 Resetting SQLite schema to include cache tracking fields...');
    try {
      db.exec(`
        DROP TABLE IF EXISTS request_log;
        DROP TABLE IF EXISTS upstream_key_state;
        DROP TABLE IF EXISTS daily_usage_estimate;
      `);
    } catch (e) {
      console.warn('Failed to drop old tables:', e);
    }
  }

  // Create Tables with new columns directly
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      upstream_key_hash TEXT,
      model TEXT,
      status_code INTEGER,
      latency_ms INTEGER,
      estimated_input_tokens INTEGER,
      estimated_output_tokens INTEGER,
      cached_input_tokens INTEGER DEFAULT 0,
      key_type TEXT
    );

    CREATE TABLE IF NOT EXISTS upstream_key_state (
      key_hash TEXT PRIMARY KEY,
      key_type TEXT,
      cooldown_until INTEGER DEFAULT 0,
      exhausted_until INTEGER DEFAULT 0,
      last_error TEXT,
      last_success_at TEXT,
      is_disabled INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_usage_estimate (
      date_utc TEXT,
      upstream_key_hash TEXT,
      requests_count INTEGER DEFAULT 0,
      tokens_estimated INTEGER DEFAULT 0,
      input_tokens_estimated INTEGER DEFAULT 0,
      output_tokens_estimated INTEGER DEFAULT 0,
      cached_tokens_estimated INTEGER DEFAULT 0,
      PRIMARY KEY (date_utc, upstream_key_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_req_log_created ON request_log (created_at);
  `);

  console.log('✅ SQLite database initialized successfully.');

  // Run initial auto-pruning and schedule daily log pruning
  pruneLogs();
  setInterval(pruneLogs, 24 * 60 * 60 * 1000);
}

export function pruneLogs() {
  try {
    const pruneStmt = db.prepare(`
      DELETE FROM request_log 
      WHERE created_at < datetime('now', '-30 days')
    `);
    const result = pruneStmt.run();
    if (result.changes > 0) {
      console.log(`🧹 SQLite auto-pruned ${result.changes} old request log entries.`);
      db.exec('VACUUM');
    }
  } catch (error) {
    console.error('❌ Failed to prune database logs:', error);
  }
}

export function logRequest(log: RequestLog) {
  try {
    const stmt = db.prepare(`
      INSERT INTO request_log (
        upstream_key_hash, model, status_code, latency_ms, 
        estimated_input_tokens, estimated_output_tokens, cached_input_tokens, key_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      log.upstreamKeyHash,
      log.model,
      log.statusCode,
      log.latencyMs,
      log.estimatedInputTokens,
      log.estimatedOutputTokens,
      log.cachedInputTokens,
      log.keyType
    );
  } catch (error) {
    console.error('❌ Failed to log request in SQLite:', error);
  }
}

export function updateDailyUsage(keyHash: string, inputTokens: number, outputTokens: number, cachedTokens: number) {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD in UTC
    
    // Quota limits are evaluated 1:1 based on raw tokens, as upstream TPM/RPM limits count
    // all input tokens regardless of whether they are served from cache.
    const totalTokens = inputTokens + outputTokens;

    const stmt = db.prepare(`
      INSERT INTO daily_usage_estimate (
        date_utc, upstream_key_hash, requests_count, tokens_estimated,
        input_tokens_estimated, output_tokens_estimated, cached_tokens_estimated
      )
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(date_utc, upstream_key_hash) DO UPDATE SET
        requests_count = requests_count + 1,
        tokens_estimated = tokens_estimated + ?,
        input_tokens_estimated = input_tokens_estimated + ?,
        output_tokens_estimated = output_tokens_estimated + ?,
        cached_tokens_estimated = cached_tokens_estimated + ?
    `);
    stmt.run(
      today, keyHash, totalTokens, inputTokens, outputTokens, cachedTokens,
      totalTokens, inputTokens, outputTokens, cachedTokens
    );
  } catch (error) {
    console.error('❌ Failed to update daily usage in SQLite:', error);
  }
}

export function getDailyUsage(keyHash: string): DailyUsage {
  try {
    const today = new Date().toISOString().split('T')[0];
    const stmt = db.prepare(`
      SELECT date_utc, upstream_key_hash, requests_count, tokens_estimated,
             input_tokens_estimated, output_tokens_estimated, cached_tokens_estimated
      FROM daily_usage_estimate
      WHERE date_utc = ? AND upstream_key_hash = ?
    `);
    const row = stmt.get(today, keyHash) as any;
    if (row) {
      return {
        dateUtc: row.date_utc,
        upstreamKeyHash: row.upstream_key_hash,
        requestsCount: row.requests_count,
        tokensEstimated: row.tokens_estimated,
        inputTokensEstimated: row.input_tokens_estimated || 0,
        outputTokensEstimated: row.output_tokens_estimated || 0,
        cachedTokensEstimated: row.cached_tokens_estimated || 0,
      };
    }
  } catch (error) {
    console.error('❌ Failed to query daily usage:', error);
  }
  return { dateUtc: '', upstreamKeyHash: keyHash, requestsCount: 0, tokensEstimated: 0, inputTokensEstimated: 0, outputTokensEstimated: 0, cachedTokensEstimated: 0 };
}

export function getKeyState(keyHash: string, defaultType: 'free' | 'master'): KeyState {
  try {
    const stmt = db.prepare(`
      SELECT key_hash, key_type, cooldown_until, exhausted_until, last_error, last_success_at, is_disabled
      FROM upstream_key_state
      WHERE key_hash = ?
    `);
    const row = stmt.get(keyHash) as any;
    if (row) {
      return {
        keyHash: row.key_hash,
        keyType: row.key_type as 'free' | 'master',
        cooldownUntil: row.cooldown_until,
        exhaustedUntil: row.exhausted_until,
        lastError: row.last_error,
        lastSuccessAt: row.last_success_at,
        isDisabled: row.is_disabled === 1,
      };
    }
  } catch (error) {
    console.error('❌ Failed to get key state:', error);
  }
  return {
    keyHash,
    keyType: defaultType,
    cooldownUntil: 0,
    exhaustedUntil: 0,
    lastError: null,
    lastSuccessAt: null,
    isDisabled: false,
  };
}

export function setCooldown(keyHash: string, keyType: 'free' | 'master', durationMs: number, errorMsg: string) {
  try {
    const until = Date.now() + durationMs;
    const stmt = db.prepare(`
      INSERT INTO upstream_key_state (key_hash, key_type, cooldown_until, last_error)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key_hash) DO UPDATE SET
        cooldown_until = ?,
        last_error = ?
    `);
    stmt.run(keyHash, keyType, until, errorMsg, until, errorMsg);
  } catch (error) {
    console.error('❌ Failed to set cooldown in SQLite:', error);
  }
}

export function setExhausted(keyHash: string, keyType: 'free' | 'master', durationMs: number) {
  try {
    const until = Date.now() + durationMs;
    const stmt = db.prepare(`
      INSERT INTO upstream_key_state (key_hash, key_type, exhausted_until)
      VALUES (?, ?, ?)
      ON CONFLICT(key_hash) DO UPDATE SET
        exhausted_until = ?
    `);
    stmt.run(keyHash, keyType, until, until);
  } catch (error) {
    console.error('❌ Failed to set key exhausted status in SQLite:', error);
  }
}

export function setDisabled(keyHash: string, keyType: 'free' | 'master', errorMsg: string) {
  try {
    const stmt = db.prepare(`
      INSERT INTO upstream_key_state (key_hash, key_type, is_disabled, last_error)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(key_hash) DO UPDATE SET
        is_disabled = 1,
        last_error = ?
    `);
    stmt.run(keyHash, keyType, errorMsg, errorMsg);
  } catch (error) {
    console.error('❌ Failed to set key disabled in SQLite:', error);
  }
}

export function clearKeyError(keyHash: string, keyType: 'free' | 'master') {
  try {
    const nowStr = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO upstream_key_state (key_hash, key_type, cooldown_until, exhausted_until, last_error, last_success_at, is_disabled)
      VALUES (?, ?, 0, 0, NULL, ?, 0)
      ON CONFLICT(key_hash) DO UPDATE SET
        cooldown_until = 0,
        exhausted_until = CASE 
          WHEN exhausted_until > ? THEN exhausted_until 
          ELSE 0 
        END,
        last_error = NULL,
        last_success_at = ?,
        is_disabled = 0
    `);
    stmt.run(keyHash, keyType, nowStr, Date.now(), nowStr);
  } catch (error) {
    console.error('❌ Failed to clear key error status in SQLite:', error);
  }
}

export function getApiStatusDetails(
  freeKeys: string[],
  masterKey: string | null
): {
  service: { ok: boolean; uptimeSec: number };
  upstreamKeys: any[];
  usageEstimate: { dateUtc: string; requests: number; tokens: number; inputTokens: number; outputTokens: number; cachedTokens: number };
} {
  const today = new Date().toISOString().split('T')[0];
  const keysInfo: any[] = [];
  let totalRequests = 0;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;

  // Process free keys
  for (const k of freeKeys) {
    const hash = hashKey(k);
    const label = getShortHashLabel(k);
    const state = getKeyState(hash, 'free');
    const usage = getDailyUsage(hash);

    totalRequests += usage.requestsCount;
    totalTokens += usage.tokensEstimated;
    totalInputTokens += usage.inputTokensEstimated;
    totalOutputTokens += usage.outputTokensEstimated;
    totalCachedTokens += usage.cachedTokensEstimated;

    const now = Date.now();
    const isCooldown = state.cooldownUntil > now;
    const isExhausted = state.exhaustedUntil > now;
    const isDisabled = state.isDisabled;

    keysInfo.push({
      label,
      hash,
      keyType: 'free',
      healthy: !isDisabled && !isCooldown && !isExhausted && state.lastError === null,
      cooldownUntil: isCooldown ? new Date(state.cooldownUntil).toISOString() : null,
      exhaustedUntil: isExhausted ? new Date(state.exhaustedUntil).toISOString() : null,
      isDisabled,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt,
      usageToday: {
        requests: usage.requestsCount,
        tokens: usage.tokensEstimated,
        inputTokens: usage.inputTokensEstimated,
        outputTokens: usage.outputTokensEstimated,
        cachedTokens: usage.cachedTokensEstimated,
      },
    });
  }

  // Process master key
  if (masterKey) {
    const hash = hashKey(masterKey);
    const label = getShortHashLabel(masterKey);
    const state = getKeyState(hash, 'master');
    const usage = getDailyUsage(hash);

    totalRequests += usage.requestsCount;
    totalTokens += usage.tokensEstimated;
    totalInputTokens += usage.inputTokensEstimated;
    totalOutputTokens += usage.outputTokensEstimated;
    totalCachedTokens += usage.cachedTokensEstimated;

    const now = Date.now();
    const isCooldown = state.cooldownUntil > now;
    const isDisabled = state.isDisabled;

    keysInfo.push({
      label,
      hash,
      keyType: 'master',
      healthy: !isDisabled && !isCooldown && state.lastError === null,
      cooldownUntil: isCooldown ? new Date(state.cooldownUntil).toISOString() : null,
      exhaustedUntil: null,
      isDisabled,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt,
      usageToday: {
        requests: usage.requestsCount,
        tokens: usage.tokensEstimated,
        inputTokens: usage.inputTokensEstimated,
        outputTokens: usage.outputTokensEstimated,
        cachedTokens: usage.cachedTokensEstimated,
      },
    });
  }

  // Uptime
  const uptimeSec = Math.floor(process.uptime());

  // Check if at least one key is healthy
  const serviceOk = keysInfo.some(k => k.healthy);

  return {
    service: {
      ok: serviceOk,
      uptimeSec,
    },
    upstreamKeys: keysInfo,
    usageEstimate: {
      dateUtc: today,
      requests: totalRequests,
      tokens: totalTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedTokens: totalCachedTokens,
    },
  };
}
