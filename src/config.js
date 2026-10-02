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
  llm: {
    apiKey: env.LLM_API_KEY || env.GROQ_API_KEY || '',
    baseUrl: (env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    model: env.LLM_MODEL || 'openai/gpt-oss-120b',
    fallbackModel: env.LLM_FALLBACK_MODEL || 'openai/gpt-oss-20b',
    maxRpm: num(env.LLM_MAX_RPM, 120),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 25000),
  },
};
