'use strict';
// Reliable LLM access: soft RPM limiter, per-call timeout, retry with backoff
// (honouring Retry-After), automatic fallback model, and tolerant JSON parsing.
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

class Llm {
  constructor(cfg, { fetchImpl } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl || globalThis.fetch;
    this.stamps = [];
    this.tok = {};
    this.stats = { calls: 0, failures: 0, fallbacks: 0, lastOkAt: null, lastError: null, lastLatencyMs: null };
    this.override = null; // tests / offline mode: async ({system, messages, json}) => string
  }

  get enabled() { return !!(this.override || this.cfg.apiKey); }

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
  used(model) {
    const t = Date.now();
    const arr = (this.tok[model] || []).filter((x) => t - x.t < 60000);
    this.tok[model] = arr;
    return arr.reduce((n, x) => n + x.n, 0);
  }
  hasRoom(model, est) { return !this.cfg.tpm || this.used(model) + est <= this.cfg.tpm; }

  async rawCall(model, { system, messages, json, maxTokens, temperature }, { dropReasoning = false } = {}) {
    await this.throttle();
    const est = this.estimate({ system, messages, maxTokens });
    const entry = { t: Date.now(), n: est };
    (this.tok[model] = this.tok[model] || []).push(entry);
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
      const res = await this.fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new LlmError(`LLM ${res.status}: ${errText.slice(0, 300)}`);
        err.status = res.status;
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

  // One logical call. Rate limits (429) hop straight to the next model, which has
  // its own token bucket; if every model is limited we wait out the shortest
  // Retry-After and go round again. Timeouts and 5xx get one quick retry per model.
  async complete(opts) {
    this.stats.calls++;
    const o = { maxTokens: 700, temperature: 0.4, json: false, ...opts };
    if (this.override) return this.override(o);
    if (!this.cfg.apiKey) throw new LlmError('No LLM API key configured');
    const primary = o.model || this.cfg.model;
    const models = [primary, ...[this.cfg.fallbackModel, this.cfg.model].filter((m) => m && m !== primary)];
    const uniq = [...new Set(models)];
    const flags = Object.fromEntries(uniq.map((m) => [m, { json: o.json, dropReasoning: false }]));
    let lastErr;
    const est = this.estimate(o);
    for (let round = 0; round < 4; round++) {
      let wait = 0;
      let allAuth = true;
      // Prefer the first model that still has token headroom this minute; if none
      // does, wait (bounded) for the window to free up rather than burning a 429.
      for (let w = 0; w < 14 && !uniq.some((m) => this.hasRoom(m, est)); w++) await sleep(1500);
      const order = [...uniq.filter((m) => this.hasRoom(m, est)), ...uniq.filter((m) => !this.hasRoom(m, est))];
      for (let mi = 0; mi < order.length; mi++) {
        const model = order[mi];
        const fl = flags[model];
        for (let a = 0; a < 2; a++) {
          try {
            const text = await this.rawCall(model, { ...o, json: fl.json }, { dropReasoning: fl.dropReasoning });
            this.stats.lastOkAt = Date.now();
            if (model !== primary) this.stats.fallbacks++;
            return text;
          } catch (e) {
            lastErr = e;
            this.stats.lastError = `${model}: ${e.message}`.slice(0, 300);
            if (e.status === 400) { // provider rejected an optional parameter: strip it, retry now
              if (fl.json) { fl.json = false; continue; }
              if (!fl.dropReasoning) { fl.dropReasoning = true; continue; }
              break;
            }
            if (e.status === 401 || e.status === 403 || e.status === 404) break;
            allAuth = false;
            if (e.status === 429) { wait = wait ? Math.min(wait, e.retryAfter || 3) : (e.retryAfter || 3); break; }
            if (a === 0) await sleep(400);
          }
        }
      }
      if (allAuth) break;
      if (round < 3) await sleep(Math.min(10000, Math.max(800, wait * 1000)));
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
