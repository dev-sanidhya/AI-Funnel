'use strict';
// Instagram Messaging via "Instagram API with Instagram Login".
//
// Rules this module respects (Meta platform constraints):
//  - the customer must message first; after that we may reply freely for 24 hours
//  - after 24h only a human can reply, using the HUMAN_AGENT tag, for up to 7 days
//  - text messages are limited to 1000 characters
//  - webhooks are signed with the app secret (X-Hub-Signature-256)
//
// Lead identity: the enquiry form sends people to https://ig.me/m/<handle>?ref=<token>.
// Instagram echoes that ref back in a referral webhook, which ties the DM
// conversation to the lead created at form submit.

const crypto = require('node:crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WINDOW_MS = 24 * 3600 * 1000;
const HUMAN_AGENT_MS = 7 * 24 * 3600 * 1000;
const MAX_TEXT = 950; // under the 1000 character limit, with headroom for multibyte text

class InstagramError extends Error {
  constructor(msg, { permanent = false, status = 0, code = 0 } = {}) { super(msg); this.permanent = permanent; this.status = status; this.code = code; }
}

function chunk(text, size = MAX_TEXT) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = Math.max(rest.lastIndexOf('. ', size), rest.lastIndexOf('\n', size), rest.lastIndexOf(' ', size));
    if (cut < size * 0.4) cut = size;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

class Instagram {
  constructor({ cfg, engine, store, config, log = console, fetchImpl }) {
    this.cfg = cfg;
    this.engine = engine;
    this.store = store;
    this.config = config;
    this.log = log;
    this.fetch = fetchImpl || globalThis.fetch;
    this.me = null;
    this.status = { enabled: !!cfg.accessToken, connected: false, lastWebhookAt: null, lastError: null, webhookSigned: !!cfg.appSecret };
  }

  get enabled() { return !!this.token; }
  // A refreshed token (stored by refreshToken) wins over the one in .env.
  get token() { return this.store.kvGet('ig_token', null) || this.cfg.accessToken; }
  get handle() { return (this.me && this.me.username) || this.cfg.handle || null; }
  get base() { return `https://graph.instagram.com/${this.cfg.apiVersion}`; }
  chatLink(ref) { return this.handle ? `https://ig.me/m/${this.handle}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}` : null; }

  // ---------- Graph API ----------
  async api(method, path, { body, query } = {}, { retries = 3 } = {}) {
    if (!this.token) throw new InstagramError('Instagram is not configured', { permanent: true });
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await this.fetch(`${path.startsWith('http') ? path : this.base + path}${qs}`, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) return data;
        const e = data.error || {};
        const msg = e.message || `HTTP ${res.status}`;
        const code = e.code || 0;
        // 190 = token invalid/expired, 10/200 = permission, 100 = bad request, 551/2534014 = user unreachable, 613/4/17/32 = rate limits
        const rateLimited = [4, 17, 32, 613].includes(code) || res.status === 429;
        if (rateLimited) { lastErr = new InstagramError(msg, { status: res.status, code }); await sleep(1500 * 2 ** attempt); continue; }
        if (res.status >= 500) { lastErr = new InstagramError(msg, { status: res.status, code }); await sleep(500 * 2 ** attempt); continue; }
        throw new InstagramError(msg, { permanent: true, status: res.status, code });
      } catch (e) {
        if (e instanceof InstagramError && e.permanent) throw e;
        lastErr = e instanceof InstagramError ? e : new InstagramError(e.name === 'AbortError' ? 'Instagram request timed out' : e.message);
        await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new InstagramError('Instagram request failed');
  }

  async start() {
    if (!this.enabled) { this.log.warn('[instagram] no INSTAGRAM_ACCESS_TOKEN, Instagram channel disabled'); return; }
    try {
      this.me = await this.api('GET', '/me', { query: { fields: 'user_id,username,name' } }, { retries: 2 });
      this.status.connected = true;
      this.status.lastError = null;
      this.log.log(`[instagram] connected as @${this.me.username}`);
      this.refreshToken().catch(() => {});
      this.refreshTimer = setInterval(() => this.refreshToken().catch(() => {}), 24 * 3600 * 1000);
      this.refreshTimer.unref?.();
    } catch (e) {
      this.status.connected = false;
      this.status.lastError = e.message;
      this.log.error('[instagram] could not connect:', e.message);
    }
  }

  // Long-lived tokens last 60 days and can be refreshed once they are 24h old.
  async refreshToken({ force = false } = {}) {
    const info = this.store.kvGet('ig_token_info', {});
    if (!force && info.refreshedAt && Date.now() - info.refreshedAt < 7 * 24 * 3600 * 1000) return { skipped: true };
    const res = await this.fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: this.token })}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new InstagramError((data.error && data.error.message) || 'Token refresh failed', { permanent: true });
    this.store.kvSet('ig_token', data.access_token);
    this.store.kvSet('ig_token_info', { refreshedAt: Date.now(), expiresAt: Date.now() + (data.expires_in || 5184000) * 1000 });
    return { refreshed: true, expires_in: data.expires_in };
  }

  tokenInfo() { return this.store.kvGet('ig_token_info', {}); }

  // Subscribe this account to the webhook fields we handle.
  async subscribe() {
    const id = (this.me && this.me.user_id) || 'me';
    return this.api('POST', `/${id}/subscribed_apps`, { query: { subscribed_fields: 'messages,messaging_postbacks,messaging_referral' } });
  }

  // Tappable conversation starters shown when someone opens the DM thread.
  async setIceBreakers(questions) {
    const qs = (questions || []).map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
    if (!qs.length) throw new InstagramError('Add at least one conversation starter', { permanent: true });
    return this.api('POST', '/me/messenger_profile', {
      body: { platform: 'instagram', ice_breakers: [{ call_to_actions: qs.map((q) => ({ question: q.slice(0, 80), payload: q.slice(0, 80) })), locale: 'default' }] },
    });
  }

  async profile(igsid) {
    try { return await this.api('GET', `/${igsid}`, { query: { fields: 'name,username' } }, { retries: 1 }); } catch { return {}; }
  }

  // ---------- sending ----------
  igsid(lead) { return String(lead.chat_id).replace(/^ig:/, ''); }

  get transport() {
    return {
      send: (lead, text, opts = {}) => this.sendText(lead, text, opts),
      typing: (chatId) => this.api('POST', '/me/messages', { body: { recipient: { id: String(chatId).replace(/^ig:/, '') }, sender_action: 'typing_on' } }, { retries: 1 }).catch(() => {}),
      sendRaw: async () => {}, // team alerts go through Telegram or the webhook, not Instagram
    };
  }

  async sendText(lead, text, { role } = {}) {
    const age = Date.now() - (lead.last_inbound_at || 0);
    let extra = {};
    if (age > WINDOW_MS) {
      if (role === 'admin' && age <= HUMAN_AGENT_MS) extra = { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' };
      else {
        throw new InstagramError('Outside Instagram\'s 24 hour messaging window. Only a human can reply (up to 7 days after their last message) using Send from the lead view.', { permanent: true });
      }
    }
    let last;
    for (const part of chunk(text)) {
      last = await this.api('POST', '/me/messages', { body: { recipient: { id: this.igsid(lead) }, message: { text: part }, ...extra } });
    }
    return last && last.message_id;
  }

  // ---------- webhook ----------
  verifyChallenge(query) {
    if (query.get('hub.mode') === 'subscribe' && this.cfg.verifyToken && query.get('hub.verify_token') === this.cfg.verifyToken) return query.get('hub.challenge');
    return null;
  }

  validSignature(raw, header) {
    if (!this.cfg.appSecret) return false; // refuse unsigned webhooks: anyone could forge leads otherwise
    if (!header || !header.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', this.cfg.appSecret).update(raw).digest('hex');
    const got = header.slice(7);
    return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  }

  // Processes a verified webhook payload. Never throws: Meta retries on non-200,
  // and a poison event must not block the queue.
  async handleWebhook(payload) {
    this.status.lastWebhookAt = Date.now();
    const events = [];
    for (const entry of (payload && payload.entry) || []) {
      for (const ev of entry.messaging || []) events.push({ ev, igId: String(entry.id || (ev.recipient && ev.recipient.id) || '') });
    }
    // Referrals first, so a message in the same batch lands on the right lead.
    events.sort((a, b) => (b.ev.referral ? 1 : 0) - (a.ev.referral ? 1 : 0));
    for (const { ev, igId } of events) {
      try { await this.handleEvent(ev, igId); } catch (e) { this.log.error('[instagram] event failed', e); }
    }
  }

  async handleEvent(ev, igId) {
    const senderId = ev.sender && String(ev.sender.id);
    if (!senderId || senderId === igId) return; // our own account
    const chatId = `ig:${senderId}`;
    const ref = (ev.referral && ev.referral.ref) || (ev.postback && ev.postback.referral && ev.postback.referral.ref) || (ev.message && ev.message.referral && ev.message.referral.ref) || null;

    let profile = {};
    const known = this.store.getLeadByChat(chatId);
    if (!known) profile = await this.profile(senderId);
    const prof = { first_name: (profile.name || '').split(/\s+/)[0] || null, username: profile.username || null };

    if (ref) await this.engine.linkReferral(chatId, ref, prof, 'instagram');

    if (ev.message) {
      if (ev.message.is_echo) return; // messages sent from our own account/app
      const text = typeof ev.message.text === 'string' ? ev.message.text.trim() : '';
      if (!text) {
        const lead = this.store.getLeadByChat(chatId) || this.engine.bindChat(chatId, prof, { channel: 'instagram', source: 'instagram' }).lead;
        try { this.store.addMessage({ lead_id: lead.id, direction: 'in', role: 'user', text: '[sent a non-text message]', ext_id: ev.message.mid || null, processed: true }); } catch { return; }
        this.store.updateLead(lead.id, { last_inbound_at: Date.now() });
        await this.engine.transportFor(lead).send(lead, 'Thanks! I can only read text messages for now. Could you type that out for me?', { role: 'assistant' }).catch(() => {});
        return;
      }
      this.engine.receive({ channel: 'instagram', chatId, text, profile: prof, externalId: ev.message.mid || null, token: ref });
      return;
    }
    if (ev.postback) {
      // Ice breaker taps arrive as postbacks; treat the tapped question as the customer's message.
      const text = String(ev.postback.title || ev.postback.payload || '').trim();
      if (text) this.engine.receive({ channel: 'instagram', chatId, text, profile: prof, externalId: ev.postback.mid || null, token: ref });
    }
  }
}

module.exports = { Instagram, InstagramError, chunk, WINDOW_MS };
