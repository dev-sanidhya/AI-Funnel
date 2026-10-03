'use strict';
// Reliable LLM access across one or more providers (any OpenAI-compatible API):
// soft RPM limiter, per-call timeout, retry with backoff (honouring Retry-After),
// automatic model fallback, automatic PROVIDER fallback (with a cooldown when a
// provider is out of quota or unauthorised), and tolerant JSON parsing.
// Every failure mode ends in either a result or a thrown LlmError; callers
// always have a deterministic fallback, so a flaky provider never silences the bot.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LlmError extends Error {}

function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Daily free allocations and hard quotas do not recover by retrying in a few seconds.
const QUOTA_TEXT = /(daily free allocation|used up|quota|exceeded your current|insufficient_quota|billing|upgrade to)/i;

class Llm {
  constructor(cfg, { fetchImpl } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl || globalThis.fetch;
    this.providers = cfg.providers || [{
      name: 'primary', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey,
      models: [cfg.model, cfg.fallbackModel].filter(Boolean), tpm: cfg.tpm,
    }];
    this.stamps = [];
    this.tok = {};
    this.cool = {}; // provider name -> epoch ms until which it is skipped
    this.stats = { calls: 0, failures: 0, fallbacks: 0, lastOkAt: null, lastError: null, lastLatencyMs: null, lastProvider: null };
    this.override = null; // tests / offline mode: async ({system, messages, json}) => string
  }

  get enabled() { return !!(this.override || this.providers.some((p) => p.apiKey)); }

  providerStatus() {
    const now = Date.now();
    return this.providers.map((p) => ({ name: p.name, configured: !!p.apiKey, cooling: (this.cool[p.name] || 0) > now, until: this.cool[p.name] || null }));
  }

  async throttle() {
    const limit = this.cfg.maxRpm;
    if (!limit) return;
    for (;;) {
      const t = Date.now();
      this.stamps = this.stamps.filter((x) => t - x < 60000);
      if (this.stamps.length < limit) { this.stamps.push(t); return; }
      await sleep(Math.min(2000, 60000 - (t - this.stamps[0]) + 25));
    }
  }

  estimate(o) {
    const chars = (o.system || '').length + o.messages.reduce((n, m) => n + String(m.content).length, 0);
    return Math.ceil(chars / 3.6) + Math.min(o.maxTokens || 500, 350);
  }
  used(key) {
    const t = Date.now();
    const arr = (this.tok[key] || []).filter((x) => t - x.t < 60000);
    this.tok[key] = arr;
    return arr.reduce((n, x) => n + x.n, 0);
  }
  hasRoom(c, est) { return !c.provider.tpm || this.used(c.key) + est <= c.provider.tpm; }

  async rawCall(c, { system, messages, json, maxTokens, temperature }, { dropReasoning = false } = {}) {
    await this.throttle();
    const { provider, model } = c;
    const est = this.estimate({ system, messages, maxTokens });
    const entry = { t: Date.now(), n: est };
    (this.tok[c.key] = this.tok[c.key] || []).push(entry);
    const body = {
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      temperature,
      max_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };
    if (/gpt-oss/.test(model) && !dropReasoning) body.reasoning_effort = 'low';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await this.fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new LlmError(`LLM ${res.status}: ${errText.slice(0, 300)}`);
        err.status = res.status;
        err.quota = res.status === 429 && QUOTA_TEXT.test(errText);
        err.retryAfter = Number(res.headers.get('retry-after')) || Number((errText.match(/try again in ([\d.]+)s/i) || [])[1]) || 0;
        throw err;
      }
      const data = await res.json();
      if (data.usage && data.usage.total_tokens) entry.n = data.usage.total_tokens;
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text || !String(text).trim()) throw new LlmError('LLM returned empty content');
      this.stats.lastLatencyMs = Date.now() - t0;
      return String(text).trim();
    } catch (e) {
      if (e.name === 'AbortError') { const err = new LlmError('LLM timeout'); err.status = 408; throw err; }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  candidates(o) {
    const out = [];
    const now = Date.now();
    this.providers.forEach((p, pi) => {
      if (!p.apiKey || (this.cool[p.name] || 0) > now) return;
      const models = pi === 0 && o.model ? [o.model, ...p.models.filter((m) => m !== o.model)] : p.models;
      for (const model of models) out.push({ provider: p, model, key: `${p.name}:${model}`, rank: out.length });
    });
    return out;
  }

  // One logical call. Order of preference: provider 1's models, then provider 2's, and so on.
  // A 429 about quota puts the provider on cooldown and moves on at once; an ordinary
  // rate limit hops to the next candidate. Timeouts and 5xx get one quick retry each.
  async complete(opts) {
    this.stats.calls++;
    const o = { maxTokens: 700, temperature: 0.4, json: false, ...opts };
    if (this.override) return this.override(o);
    if (!this.enabled) throw new LlmError('No LLM API key configured');
    const est = this.estimate(o);
    const flags = {};
    let lastErr;
    for (let round = 0; round < 3; round++) {
      const cands = this.candidates(o);
      if (!cands.length) break; // every provider is cooling down: fail fast, callers have fallbacks
      for (let w = 0; w < 10 && !cands.some((c) => this.hasRoom(c, est)); w++) await sleep(1500);
      const ordered = [...cands.filter((c) => this.hasRoom(c, est)), ...cands.filter((c) => !this.hasRoom(c, est))];
      let wait = 0;
      for (const c of ordered) {
        if ((this.cool[c.provider.name] || 0) > Date.now()) continue;
        const fl = (flags[c.key] = flags[c.key] || { json: o.json, dropReasoning: false });
        for (let a = 0; a < 2; a++) {
          try {
            const text = await this.rawCall(c, { ...o, json: fl.json }, { dropReasoning: fl.dropReasoning });
            this.stats.lastOkAt = Date.now();
            this.stats.lastProvider = c.key;
            if (c.rank > 0) this.stats.fallbacks++;
            return text;
          } catch (e) {
            lastErr = e;
            this.stats.lastError = `${c.key}: ${e.message}`.slice(0, 300);
            if (e.status === 400) { // provider rejected an optional parameter: strip it, retry now
              if (fl.json) { fl.json = false; continue; }
              if (!fl.dropReasoning) { fl.dropReasoning = true; continue; }
              break;
            }
            if (e.quota) { this.cool[c.provider.name] = Date.now() + 30 * 60000; break; }
            if (e.status === 401 || e.status === 403) { this.cool[c.provider.name] = Date.now() + 10 * 60000; break; }
            if (e.status === 404) break;
            if (e.status === 429) { wait = wait ? Math.min(wait, e.retryAfter || 3) : (e.retryAfter || 3); break; }
            if (a === 0) await sleep(400);
          }
        }
      }
      if (round < 2) await sleep(Math.min(8000, Math.max(600, wait * 1000)));
    }
    this.stats.failures++;
    throw lastErr || new LlmError('LLM failed');
  }

  // JSON completion: asks for JSON, tolerates fences/prose, retries once if unparsable.
  async completeJson(opts) {
    let lastText = '';
    for (let i = 0; i < 2; i++) {
      lastText = await this.complete({ ...opts, json: true, temperature: 0.1, maxTokens: opts.maxTokens || 900 });
      if (typeof lastText === 'object') return lastText;
      const parsed = extractJson(lastText);
      if (parsed) return parsed;
    }
    throw new LlmError(`Unparsable JSON from model: ${String(lastText).slice(0, 120)}`);
  }
}

module.exports = { Llm, LlmError, extractJson };
