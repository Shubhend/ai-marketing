const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  port: number(process.env.PORT, 5000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/quora_marketing',
  groqKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
  groqMaxCalls: number(process.env.GROQ_MAX_CALLS_PER_RUN, 2),
  groqTimeoutMs: number(process.env.GROQ_TIMEOUT_MS, 30000),
  sessionDir: path.resolve(root, process.env.SESSION_DIR || 'sessions'),
  proofDir: path.resolve(root, process.env.PROOF_DIR || 'proofs'),
  duplicateCooldownDays: number(process.env.DUPLICATE_COOLDOWN_DAYS, 30),
  headless: process.env.BROWSER_HEADLESS === 'true',
  serverBrowser: (process.env.SERVER_BROWSER || process.env.server_browser || process.env.BROWSER_SERVER_URL || '').trim(),
};

function safeMessage(error) {
  const text = String(error?.message || 'Request failed');
  const clean = config.groqKey ? text.replaceAll(config.groqKey, '[redacted]') : text;
  return clean.slice(0, 300);
}

module.exports = { ...config, safeMessage };
