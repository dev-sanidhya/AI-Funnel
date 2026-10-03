'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency). Real environment variables win.
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(path.join(ROOT, '.env'));

const env = process.env;
const useCloudflare = !!(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  ROOT,
  port: num(env.PORT, 3000),
  dbPath: path.resolve(ROOT, env.DB_PATH || 'data/funnel.db'),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/$/, ''),
  adminPassword: env.ADMIN_PASSWORD || 'demo',
  intakeSecret: env.INTAKE_SECRET || 'change-me',
  demoMode: String(env.DEMO_MODE || 'true') !== 'false',
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  // Instagram messaging (Instagram API with Instagram Login). Needs a Professional account.
  instagram: {
    accessToken: env.INSTAGRAM_ACCESS_TOKEN || '',
    appSecret: env.INSTAGRAM_APP_SECRET || '',
    verifyToken: env.INSTAGRAM_VERIFY_TOKEN || '',
    handle: (env.INSTAGRAM_HANDLE || '').replace(/^@/, ''),
    apiVersion: env.INSTAGRAM_API_VERSION || 'v23.0',
  },
  // Cloudflare Workers AI (preferred when CF_* are set) via its OpenAI-compatible
  // endpoint; otherwise any OpenAI-compatible provider (defaults to Groq).
  llm: useCloudflare
    ? {
      apiKey: env.CF_API_TOKEN,
      baseUrl: (env.LLM_BASE_URL || `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`).replace(/\/$/, ''),
      model: env.LLM_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      fallbackModel: env.LLM_FALLBACK_MODEL || '@cf/openai/gpt-oss-120b',
      maxRpm: num(env.LLM_MAX_RPM, 240),
      tpm: num(env.LLM_TPM, 0),
      timeoutMs: num(env.LLM_TIMEOUT_MS, 30000),
    }
    : {
      apiKey: env.LLM_API_KEY || env.GROQ_API_KEY || '',
      baseUrl: (env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
      model: env.LLM_MODEL || 'openai/gpt-oss-120b',
      fallbackModel: env.LLM_FALLBACK_MODEL || 'openai/gpt-oss-20b',
      maxRpm: num(env.LLM_MAX_RPM, 120),
      // Soft tokens-per-minute budget PER MODEL (Groq free tier allows 8000). 0 = unlimited.
      tpm: num(env.LLM_TPM, 6000),
      timeoutMs: num(env.LLM_TIMEOUT_MS, 25000),
    },
};

// Providers in order of preference. The first is the main one; a backup (Groq, via
// GROQ_API_KEY or LLM_FALLBACK_API_KEY) takes over automatically if it runs out of quota.
{
  const L = module.exports.llm;
  L.providers = [{ name: useCloudflare ? 'cloudflare' : 'primary', baseUrl: L.baseUrl, apiKey: L.apiKey, models: [L.model, L.fallbackModel].filter(Boolean), tpm: L.tpm }];
  const backupKey = env.LLM_FALLBACK_API_KEY || (useCloudflare ? env.GROQ_API_KEY : '');
  if (backupKey) {
    L.providers.push({
      name: 'backup', baseUrl: (env.LLM_FALLBACK_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''), apiKey: backupKey,
      models: [env.LLM_FALLBACK_MODEL_NAME || 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'], tpm: num(env.LLM_FALLBACK_TPM, 6000),
    });
  }
}
