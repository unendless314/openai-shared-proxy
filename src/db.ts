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
  keyType: 'free' | 'master';
}

export interface KeyState {
  keyHash: string;
  keyType: 'free' | 'master';
  cooldownUntil: number;
  exhaustedUntil: number;
  lastError: string | null;
  lastSuccessAt: string | null;
}

export interface DailyUsage {
  dateUtc: string;
  upstreamKeyHash: string;
  requestsCount: number;
  tokensEstimated: number;
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

  // Create Tables
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
      key_type TEXT
    );

    CREATE TABLE IF NOT EXISTS upstream_key_state (
      key_hash TEXT PRIMARY KEY,
      key_type TEXT,
      cooldown_until INTEGER DEFAULT 0,
      exhausted_until INTEGER DEFAULT 0,
      last_error TEXT,
      last_success_at TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_usage_estimate (
      date_utc TEXT,
      upstream_key_hash TEXT,
      requests_count INTEGER DEFAULT 0,
      tokens_estimated INTEGER DEFAULT 0,
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
        estimated_input_tokens, estimated_output_tokens, key_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      log.upstreamKeyHash,
      log.model,
      log.statusCode,
      log.latencyMs,
      log.estimatedInputTokens,
      log.estimatedOutputTokens,
      log.keyType
    );
  } catch (error) {
    console.error('❌ Failed to log request in SQLite:', error);
  }
}

export function updateDailyUsage(keyHash: string, tokens: number) {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD in UTC
    const stmt = db.prepare(`
      INSERT INTO daily_usage_estimate (date_utc, upstream_key_hash, requests_count, tokens_estimated)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(date_utc, upstream_key_hash) DO UPDATE SET
        requests_count = requests_count + 1,
        tokens_estimated = tokens_estimated + ?
    `);
    stmt.run(today, keyHash, tokens, tokens);
  } catch (error) {
    console.error('❌ Failed to update daily usage in SQLite:', error);
  }
}

export function getDailyUsage(keyHash: string): DailyUsage {
  try {
    const today = new Date().toISOString().split('T')[0];
    const stmt = db.prepare(`
      SELECT date_utc, upstream_key_hash, requests_count, tokens_estimated
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
      };
    }
  } catch (error) {
    console.error('❌ Failed to query daily usage:', error);
  }
  return { dateUtc: '', upstreamKeyHash: keyHash, requestsCount: 0, tokensEstimated: 0 };
}

export function getKeyState(keyHash: string, defaultType: 'free' | 'master'): KeyState {
  try {
    const stmt = db.prepare(`
      SELECT key_hash, key_type, cooldown_until, exhausted_until, last_error, last_success_at
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

export function clearKeyError(keyHash: string, keyType: 'free' | 'master') {
  try {
    const nowStr = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO upstream_key_state (key_hash, key_type, cooldown_until, exhausted_until, last_error, last_success_at)
      VALUES (?, ?, 0, 0, NULL, ?)
      ON CONFLICT(key_hash) DO UPDATE SET
        cooldown_until = 0,
        exhausted_until = CASE 
          WHEN exhausted_until > ? THEN exhausted_until 
          ELSE 0 
        END,
        last_error = NULL,
        last_success_at = ?
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
  usageEstimate: { dateUtc: string; requests: number; tokens: number };
} {
  const today = new Date().toISOString().split('T')[0];
  const keysInfo: any[] = [];
  let totalRequests = 0;
  let totalTokens = 0;

  // Process free keys
  for (const k of freeKeys) {
    const hash = hashKey(k);
    const label = getShortHashLabel(k);
    const state = getKeyState(hash, 'free');
    const usage = getDailyUsage(hash);

    totalRequests += usage.requestsCount;
    totalTokens += usage.tokensEstimated;

    const now = Date.now();
    const isCooldown = state.cooldownUntil > now;
    const isExhausted = state.exhaustedUntil > now;

    keysInfo.push({
      label,
      hash,
      keyType: 'free',
      healthy: !isCooldown && !isExhausted && state.lastError === null,
      cooldownUntil: isCooldown ? new Date(state.cooldownUntil).toISOString() : null,
      exhaustedUntil: isExhausted ? new Date(state.exhaustedUntil).toISOString() : null,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt,
      usageToday: {
        requests: usage.requestsCount,
        tokens: usage.tokensEstimated,
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

    const now = Date.now();
    const isCooldown = state.cooldownUntil > now;

    keysInfo.push({
      label,
      hash,
      keyType: 'master',
      healthy: !isCooldown && state.lastError === null,
      cooldownUntil: isCooldown ? new Date(state.cooldownUntil).toISOString() : null,
      exhaustedUntil: null,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt,
      usageToday: {
        requests: usage.requestsCount,
        tokens: usage.tokensEstimated,
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
    },
  };
}
