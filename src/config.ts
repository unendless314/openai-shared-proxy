import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

export interface Config {
  host: string;
  port: number;
  proxyApiKey: string;
  adminUsername: string;
  adminPassword: string;
  openaiBaseUrl: string;
  openaiSharedKeys: string[];
  openaiMasterKey: string | null;
  keyDailyTokenLimit: number;
  keyDailyReqLimit: number;
  openaiDefaultModel: string;
  requestTimeoutMs: number;
  keyCooldownMs: number;
  maxRetries: number;
  sqlitePath: string;
}

function parseEnvString(key: string, defaultValue?: string): string {
  const val = process.env[key];
  if (val === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Configuration Error: Environment variable ${key} is required but missing.`);
  }
  return val.trim();
}

function parseEnvInt(key: string, defaultValue?: number): number {
  const val = process.env[key];
  if (val === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Configuration Error: Environment variable ${key} is required but missing.`);
  }
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) {
    throw new Error(`Configuration Error: Environment variable ${key} must be a valid integer. Got: "${val}"`);
  }
  return parsed;
}

function validateAndLoadConfig(): Config {
  try {
    const proxyApiKey = parseEnvString('PROXY_API_KEY');
    const adminUsername = parseEnvString('ADMIN_USERNAME');
    const adminPassword = parseEnvString('ADMIN_PASSWORD');

    const sharedKeysRaw = parseEnvString('OPENAI_SHARED_KEYS');
    const openaiSharedKeys = sharedKeysRaw
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0);

    if (openaiSharedKeys.length === 0) {
      throw new Error('OPENAI_SHARED_KEYS must contain at least one valid API key.');
    }

    const host = parseEnvString('HOST', '0.0.0.0');
    const port = parseEnvInt('PORT', 3001);
    const openaiBaseUrl = parseEnvString('OPENAI_BASE_URL', 'https://api.openai.com/v1');
    
    const masterKeyRaw = process.env.OPENAI_MASTER_KEY;
    const openaiMasterKey = masterKeyRaw && masterKeyRaw.trim().length > 0 ? masterKeyRaw.trim() : null;

    const keyDailyTokenLimit = parseEnvInt('KEY_DAILY_TOKEN_LIMIT', 950000);
    const keyDailyReqLimit = parseEnvInt('KEY_DAILY_REQ_LIMIT', 4800);
    const openaiDefaultModel = parseEnvString('OPENAI_DEFAULT_MODEL', 'gpt-4o-mini');
    
    const requestTimeoutMs = parseEnvInt('REQUEST_TIMEOUT_MS', 90000);
    const keyCooldownMs = parseEnvInt('KEY_COOLDOWN_MS', 60000);
    const maxRetries = parseEnvInt('MAX_RETRIES', 2);
    
    const sqlitePath = parseEnvString('SQLITE_PATH', './proxy.db');

    return {
      host,
      port,
      proxyApiKey,
      adminUsername,
      adminPassword,
      openaiBaseUrl,
      openaiSharedKeys,
      openaiMasterKey,
      keyDailyTokenLimit,
      keyDailyReqLimit,
      openaiDefaultModel,
      requestTimeoutMs,
      keyCooldownMs,
      maxRetries,
      sqlitePath
    };
  } catch (error: any) {
    console.error('❌ Failed to initialize configuration:', error.message);
    process.exit(1);
  }
}

export const config = validateAndLoadConfig();
