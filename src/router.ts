import { config } from './config.js';
import { getKeyState, getDailyUsage, setCooldown, setExhausted, clearKeyError, hashKey, setDisabled } from './db.js';

export interface SelectedKey {
  key: string;
  hash: string;
  type: 'free' | 'master';
}

let lastFreeKeyIndex = -1;

function getNextUtcMidnight(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.getTime();
}

export function selectNextKey(): SelectedKey {
  const freeKeys = config.openaiSharedKeys;
  const now = Date.now();

  // 1. Try to select a healthy, non-exhausted key from the Free Pool
  if (freeKeys.length > 0) {
    const startIndex = (lastFreeKeyIndex + 1) % freeKeys.length;
    
    for (let i = 0; i < freeKeys.length; i++) {
      const index = (startIndex + i) % freeKeys.length;
      const key = freeKeys[index];
      const hash = hashKey(key);
      
      const state = getKeyState(hash, 'free');
      const usage = getDailyUsage(hash);

      // Check health and cooldown
      const isCooldown = state.cooldownUntil > now;
      const isExhausted = state.exhaustedUntil > now;
      const isDisabled = state.isDisabled;

      if (isDisabled) {
        continue; // Skip this key, try the next one
      }

      // Check daily limits
      const isTokenExceeded = usage.tokensEstimated >= config.keyDailyTokenLimit;
      const isReqExceeded = usage.requestsCount >= config.keyDailyReqLimit;

      if (isTokenExceeded || isReqExceeded) {
        if (!isExhausted) {
          // Key just hit the limit, mark it exhausted until next UTC midnight
          const resetTime = getNextUtcMidnight();
          const cooldownDuration = resetTime - now;
          console.log(`⚠️ Key ${hash.substring(0, 8)} daily limit hit (${usage.tokensEstimated} tokens, ${usage.requestsCount} reqs). Marking exhausted.`);
          setExhausted(hash, 'free', cooldownDuration);
        }
        continue; // Skip this key, try the next one
      }

      if (isCooldown || isExhausted) {
        continue; // Skip this key, try the next one
      }

      // Found a valid key! Update the index and return it
      lastFreeKeyIndex = index;
      return {
        key,
        hash,
        type: 'free',
      };
    }
  }

  // 2. If no free key is available, check and fall back to the Paid Master Key
  if (config.openaiMasterKey) {
    const key = config.openaiMasterKey;
    const hash = hashKey(key);
    const state = getKeyState(hash, 'master');

    const isCooldown = state.cooldownUntil > now;
    const isDisabled = state.isDisabled;

    if (isDisabled) {
      console.error(`❌ Paid Master Key is permanently disabled.`);
    } else if (!isCooldown) {
      console.log(`ℹ️ All free keys exhausted or cooling down. Falling back to Paid Master Key.`);
      return {
        key,
        hash,
        type: 'master',
      };
    } else {
      console.error(`❌ Paid Master Key is also on cooldown until ${new Date(state.cooldownUntil).toISOString()}.`);
    }
  }

  // 3. If absolutely no key is available
  throw new Error('upstream_quota_exhausted');
}

export function handleKeyFailure(keyHash: string, keyType: 'free' | 'master', errorStatus: number, errorMessage: string) {
  const isAuthError = errorStatus === 401;
  const formattedMsg = isAuthError 
    ? `Invalid Credentials (401): ${errorMessage}` 
    : `HTTP ${errorStatus}: ${errorMessage}`;

  if (isAuthError) {
    console.error(`❌ CRITICAL: Key ${keyHash.substring(0, 8)} failed due to invalid credentials (401). Disabling key permanently.`);
    setDisabled(keyHash, keyType, formattedMsg);
  } else {
    const cooldownDuration = config.keyCooldownMs; // Standard cooldown
    console.warn(`⚠️ Key ${keyHash.substring(0, 8)} failed. Action: Cooldown for ${cooldownDuration / 1000}s. Error: ${formattedMsg}`);
    setCooldown(keyHash, keyType, cooldownDuration, formattedMsg);
  }
}

export function handleKeySuccess(keyHash: string, keyType: 'free' | 'master') {
  clearKeyError(keyHash, keyType);
}
