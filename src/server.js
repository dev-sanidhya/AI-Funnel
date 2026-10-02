'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { toCsv } = require('./crm');
const { STAGES, STAGE_LABELS, evaluate } = require('./qualify');
const { normalizePhone } = require('./db');
const { attentionFor, briefFor, windowOpen, windowHoursLeft } = require('./attention');
const { isoLocalToEpoch } = require('./when');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const MAX_BODY = 200 * 1024;
const MINUTES_SAVED_PER_SCREENED_OUT = 12; // an unqualified lead a human would have phoned

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createServer(app) {
  const { config, store, settings, engine, telegram, instagram, scheduler, simulator, llm } = app;
  const sessionKey = crypto.createHmac('sha256', `${config.adminPassword}|${config.intakeSecret}`).update('session-v1').digest('hex');
  const sse = new Set();
  const hits = new Map();
  const started = Date.now();

  // ---------- helpers ----------
  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const isAdmin = (req) => {
    const c = cookies(req).fsid || '';
    return c.length === sessionKey.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(sessionKey));
  };
  const safeEqual = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      try {
        if (ct.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
        resolve(JSON.parse(raw));
      } catch { reject(new HttpError(400, 'Invalid body')); }
    });
    req.on('error', reject);
  });
  const readRaw = (req, max = 1024 * 1024) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  // Which channel the form sends people to: the admin's choice, else Instagram when it is set up.
  const primaryChannel = () => {
    const pref = settings.get().channels.primary;
    const igOk = instagram.enabled && !!instagram.handle;
    const tgOk = telegram.enabled && !!telegram.botUsername;
    if (pref === 'instagram' && igOk) return 'instagram';
    if (pref === 'telegram' && tgOk) return 'telegram';
    return igOk ? 'instagram' : tgOk ? 'telegram' : null;
  };
  const chatLinks = (lead) => {
    const instagramUrl = instagram.handle ? instagram.chatLink(lead.start_token) : null;
    const telegramUrl = telegram.deepLink(lead.start_token);
    const primary = primaryChannel();
    return { primary, chat_url: primary === 'instagram' ? instagramUrl : primary === 'telegram' ? telegramUrl : null, instagram_url: instagramUrl, telegram_url: telegramUrl };
  };
  const limit = (req, key, max, windowMs = 60000) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const k = `${key}:${ip}`;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(k, arr);
    if (arr.length > max) throw new HttpError(429, 'Too many requests, slow down');
  };

  const needNum = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const first = (s) => String(s || '').trim();

  function leadCard(l, designers) {
    const last = store.get('SELECT text, direction, role, created_at FROM messages WHERE lead_id=? ORDER BY id DESC LIMIT 1', l.id);
    const d = l.designer_id ? designers.find((x) => x.id === l.designer_id) : null;
    return {
      id: l.id, name: l.name, phone: l.phone, email: l.email, tg_username: l.tg_username,
      stage: l.stage, stage_reason: l.stage_reason, stage_locked: !!l.stage_locked, score: l.score,
      project_type: l.project_type, city: l.city, budget_amount: l.budget_amount, budget_text: l.budget_text,
      timeline_months: l.timeline_months, timeline_text: l.timeline_text, notes: l.notes, summary: l.summary,
      source: l.source, campaign: l.campaign, channel: l.channel, has_chat: !!l.chat_id,
      ai_paused: !!l.ai_paused, opted_out: !!l.opted_out, designer: d ? d.name : null, designer_id: l.designer_id,
      turns: l.meta.turns || 0,
      property: l.property, scope: l.scope, style: l.style, contact_pref: l.contact_pref,
      callback_at: l.callback_at, callback_text: l.callback_text, callback_status: l.callback_status, callback_kind: l.callback_kind,
      brief: briefFor(l, settings.get()),
      attention: attentionFor(l, settings.get()),
      window_hours_left: windowHoursLeft(l), can_ai_message: windowOpen(l, Date.now(), 0),
      last_message: last ? { text: last.text.slice(0, 140), direction: last.direction, role: last.role, at: last.created_at } : null,
      created_at: l.created_at, updated_at: l.updated_at, qualified_at: l.qualified_at,
    };
  }

  function stats(includeSim) {
    const leads = store.listLeads({ limit: 10000 }).filter((l) => includeSim || l.channel !== 'sim');
    const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
    let scoreSum = 0;
    let scoreN = 0;
    for (const l of leads) {
      byStage[l.stage] = (byStage[l.stage] || 0) + 1;
      if (l.score) { scoreSum += l.score; scoreN++; }
    }
    const total = leads.length;
    const engaged = leads.filter((l) => (l.meta.turns || 0) > 0).length;
    const decided = byStage.active + byStage.nurture + byStage.disqualified;
    const screenedOut = byStage.disqualified + byStage.nurture;
    const waiting = leads.filter((l) => l.stage === 'new' && !l.chat_id).length;
    return {
      total, byStage, engaged, decided, waiting_for_telegram: waiting,
      qualified_rate: decided ? Math.round((byStage.active / decided) * 100) : null,
      avg_score: scoreN ? Math.round(scoreSum / scoreN) : null,
      hours_saved: Math.round((screenedOut * MINUTES_SAVED_PER_SCREENED_OUT) / 6) / 10,
      minutes_per_screened_out: MINUTES_SAVED_PER_SCREENED_OUT,
    };
  }

  function status() {
    const q = (sql) => store.get(sql).c;
    return {
      uptime_s: Math.round((Date.now() - started) / 1000),
      telegram: { ...telegram.status, username: telegram.botUsername },
      instagram: { ...instagram.status, username: instagram.handle, token: instagram.tokenInfo(), primary: primaryChannel() },
      llm: { enabled: llm.enabled, model: config.llm.model, fallback_model: config.llm.fallbackModel, ...llm.stats },
      engine: engine.stats,
      outbox: {
        pending_messages: q("SELECT COUNT(*) c FROM messages WHERE direction='out' AND status='pending'"),
        failed_messages: q("SELECT COUNT(*) c FROM messages WHERE direction='out' AND status='failed'"),
        pending_webhooks: q("SELECT COUNT(*) c FROM webhook_outbox WHERE status='pending'"),
        dead_webhooks: q("SELECT COUNT(*) c FROM webhook_outbox WHERE status='dead'"),
      },
      public_url: config.publicUrl,
      demo_mode: config.demoMode,
    };
  }

  function createIntake(body, source) {
    const name = first(body.name).slice(0, 80);
    const phone = first(body.phone).slice(0, 30);
    const email = first(body.email).slice(0, 120);
    if (!name) throw new HttpError(400, 'Name is required');
    if (normalizePhone(phone).length < 7 && !/.+@.+\..+/.test(email)) throw new HttpError(400, 'A valid phone number or email is required');
    const existing = normalizePhone(phone) ? store.findLeadByPhone(phone) : null;
    if (existing && existing.channel !== 'sim' && Date.now() - existing.created_at < 24 * 3600 * 1000 && !existing.chat_id) {
      return { lead: existing, duplicate: true };
    }
    const lead = engine.createLeadFromIntake({
      name, phone: phone || null, email: email || null,
      city: first(body.city).slice(0, 60) || null,
      project_type: first(body.project_type).slice(0, 60) || null,
      notes: first(body.notes).slice(0, 300) || null,
      campaign: first(body.campaign).slice(0, 60) || null,
      source: source,
      raw: { city: first(body.city), project_type: first(body.project_type) },
    });
    return { lead, duplicate: false };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, rx, keys, handler, public: !!opts.public });
  };

  // Pages
  const page = (file) => () => fs.readFileSync(path.join(PUBLIC, file));
  route('GET', '/', { public: true }, (req, res) => { res.writeHead(302, { Location: '/admin' }); res.end(); });
  route('GET', '/form', { public: true }, (req, res) => send(res, 200, page('form.html')()));
  route('GET', '/admin', { public: true }, (req, res) => send(res, 200, page('admin.html')()));
  route('GET', '/privacy', { public: true }, (req, res) => send(res, 200, page('privacy.html')()));

  // Public API
  route('GET', '/api/health', { public: true }, (req, res) => {
    send(res, 200, { ok: true, telegram: telegram.status.connected, llm: llm.enabled, uptime_s: Math.round((Date.now() - started) / 1000) });
  });
  route('GET', '/api/public-config', { public: true }, (req, res) => {
    const s = settings.get();
    send(res, 200, { business: s.business.name, tagline: s.business.tagline, project_types: s.qualification.project_types, bot: telegram.botUsername, telegram_enabled: telegram.enabled, instagram: instagram.handle, primary: primaryChannel() });
  });
  route('POST', '/api/intake', { public: true }, async (req, res) => {
    limit(req, 'intake', 20);
    const body = await readBody(req);
    const { lead, duplicate } = createIntake(body, 'form');
    send(res, 200, { ok: true, duplicate, bot: telegram.botUsername, ...chatLinks(lead) });
  });
  route('POST', '/api/intake/gform', { public: true }, async (req, res) => {
    limit(req, 'gform', 60);
    const body = await readBody(req);
    if (!safeEqual(body.secret || req.headers['x-intake-secret'] || '', config.intakeSecret)) throw new HttpError(401, 'Bad secret');
    const { lead, duplicate } = createIntake(body, 'google-form');
    send(res, 200, { ok: true, duplicate, lead_id: lead.id });
  });
  // Instagram webhook (public, but every POST must carry a valid Meta signature)
  route('GET', '/webhook/instagram', { public: true }, (req, res, { query }) => {
    const challenge = instagram.verifyChallenge(query);
    if (challenge === null) return send(res, 403, { error: 'Verification failed' });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge);
  });
  route('POST', '/webhook/instagram', { public: true }, async (req, res) => {
    const raw = await readRaw(req);
    if (!instagram.validSignature(raw, req.headers['x-hub-signature-256'])) {
      console.warn(`[instagram] webhook REJECTED (bad or missing signature, ${raw.length} bytes). Check INSTAGRAM_APP_SECRET.`);
      return send(res, 401, { error: 'Bad signature' });
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Bad JSON' }); }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    console.log(`[instagram] webhook received: ${JSON.stringify(payload).slice(0, 300)}`);
    res.end('EVENT_RECEIVED'); // acknowledge fast, process after
    instagram.handleWebhook(payload).catch((e) => console.error('[instagram] webhook failed', e));
  });
  route('POST', '/api/login', { public: true }, async (req, res) => {
    limit(req, 'login', 10);
    const body = await readBody(req);
    if (!safeEqual(body.password || '', config.adminPassword)) throw new HttpError(401, 'Wrong password');
    send(res, 200, { ok: true }, { 'Set-Cookie': `fsid=${sessionKey}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}` });
  });
  route('POST', '/api/logout', { public: true }, (req, res) => {
    send(res, 200, { ok: true }, { 'Set-Cookie': 'fsid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  });
  route('GET', '/api/me', { public: true }, (req, res) => send(res, 200, { admin: isAdmin(req) }));

  // Admin API
  route('GET', '/api/bootstrap', (req, res) => {
    send(res, 200, {
      settings: settings.get(), designers: store.listDesigners(), personas: simulator.personas(),
      stages: STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s] })), status: status(),
      telegram_link: telegram.deepLink('gform'), instagram_link: instagram.chatLink(), public_url: config.publicUrl,
      webhook_url: `${config.publicUrl}/webhook/instagram`, verify_token_set: !!config.instagram.verifyToken,
    });
  });
  route('GET', '/api/status', (req, res) => send(res, 200, status()));
  route('GET', '/api/stats', (req, res, { query }) => send(res, 200, stats(query.get('sim') !== '0')));

  route('GET', '/api/leads', (req, res, { query }) => {
    const designers = store.listDesigners();
    const leads = store.listLeads({
      stage: query.get('stage') || undefined, q: query.get('q') || undefined,
      channel: query.get('sim') === '0' ? 'real' : undefined, limit: 1000,
    });
    send(res, 200, { leads: leads.map((l) => leadCard(l, designers)) });
  });
  route('POST', '/api/leads', async (req, res) => {
    const body = await readBody(req);
    const { lead } = createIntake(body, first(body.source) || 'admin');
    send(res, 200, { ok: true, id: lead.id, ...chatLinks(lead) });
  });
  route('GET', '/api/leads/:id', (req, res, { params }) => {
    const lead = store.getLead(Number(params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    const designers = store.listDesigners();
    send(res, 200, {
      lead: leadCard(lead, designers),
      messages: store.getMessages(lead.id),
      events: store.getEvents(lead.id),
      telegram_url: lead.chat_id ? null : chatLinks(lead).chat_url,
      meta: { fu: lead.meta.fu || {}, declined: lead.meta.declined || {}, flags: lead.meta.flags || {}, asked: lead.meta.asked || {}, followups_sent: lead.meta.followups_sent || 0, drips_sent: lead.meta.drips_sent || 0 },
    });
  });
  route('PATCH', '/api/leads/:id', async (req, res, { params }) => {
    const id = Number(params.id);
    const lead = store.getLead(id);
    if (!lead) throw new HttpError(404, 'Lead not found');
    const b = await readBody(req);
    const patch = {};
    for (const k of ['name', 'phone', 'email', 'project_type', 'city', 'notes', 'timeline_text', 'property', 'scope', 'style', 'contact_pref']) if (k in b) patch[k] = first(b[k]).slice(0, 300) || null;
    if ('callback_at' in b) {
      const tz = settings.get().business.timezone;
      const raw = b.callback_at;
      const at = raw === null || raw === '' ? null : typeof raw === 'number' ? raw : (isoLocalToEpoch(String(raw), tz) ?? (Number.isNaN(Date.parse(raw)) ? undefined : Date.parse(raw)));
      if (at === undefined) throw new HttpError(400, 'That date and time is not valid');
      engine.setCallback(id, at, 'callback_text' in b ? first(b.callback_text) : undefined);
    }
    if ('budget_amount' in b) {
      const n = needNum(b.budget_amount);
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, 'Invalid budget');
      patch.budget_amount = n;
    }
    if ('timeline_months' in b) {
      const n = needNum(b.timeline_months);
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, 'Invalid timeline');
      patch.timeline_months = n;
    }
    if ('designer_id' in b) patch.designer_id = b.designer_id ? Number(b.designer_id) : null;
    if (Object.keys(patch).length) {
      store.updateLead(id, patch);
      store.addEvent(id, 'edited_by_admin', { fields: Object.keys(patch) });
    }
    if ('ai_paused' in b) engine.setPaused(id, !!b.ai_paused);
    if (b.unlock) engine.unlockStage(id);
    else if (b.stage) {
      if (!STAGES.includes(b.stage)) throw new HttpError(400, 'Unknown stage');
      engine.setStage(id, b.stage, first(b.reason) || undefined);
    } else if (Object.keys(patch).length) engine.reevaluateLead(id);
    engine.changed('lead', id);
    send(res, 200, { ok: true });
  });
  route('DELETE', '/api/leads/:id', (req, res, { params }) => {
    store.deleteLead(Number(params.id));
    engine.changed('lead', Number(params.id));
    send(res, 200, { ok: true });
  });
  route('POST', '/api/leads/:id/message', async (req, res, { params }) => {
    const b = await readBody(req);
    const text = first(b.text);
    if (!text) throw new HttpError(400, 'Message is empty');
    const lead = store.getLead(Number(params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (!lead.chat_id) throw new HttpError(400, 'This lead has not opened the chat yet, so there is nowhere to send to');
    engine.sendManual(lead.id, text, { pause: b.pause !== false });
    send(res, 200, { ok: true });
  });
  route('POST', '/api/leads/:id/reset', (req, res, { params }) => { engine.resetLead(Number(params.id)); send(res, 200, { ok: true }); });
  route('POST', '/api/leads/:id/start', (req, res, { params }) => { engine.start(Number(params.id)); send(res, 200, { ok: true }); });
  route('POST', '/api/leads/:id/nudge', async (req, res, { params }) => {
    const b = await readBody(req);
    await engine.nudge(Number(params.id), b.kind === 'drip' ? 'drip' : 'followup');
    send(res, 200, { ok: true });
  });

  // Follow-ups: mark done, snooze, or reschedule
  route('POST', '/api/leads/:id/followup', async (req, res, { params }) => {
    const b = await readBody(req);
    const id = Number(params.id);
    if (!store.getLead(id)) throw new HttpError(404, 'Lead not found');
    if (b.action === 'reschedule') {
      const at = isoLocalToEpoch(String(b.at || ''), settings.get().business.timezone);
      if (at === null) throw new HttpError(400, 'Pick a date and time');
      engine.setCallback(id, at);
    } else engine.completeFollowup(id, { action: b.action === 'snooze' ? 'snooze' : 'done', note: first(b.note), hours: b.hours });
    send(res, 200, { ok: true });
  });
  route('GET', '/api/activity', (req, res) => {
    const rows = store.all("SELECT e.id, e.lead_id, e.type, e.data, e.created_at, l.name FROM events e JOIN leads l ON l.id=e.lead_id WHERE e.type IN ('stage_changed','lead_created','designer_assigned','call_rescheduled','followup_done','reminder_sent','manual_followup_needed','facts_updated','followup_sent') AND l.channel!='sim' ORDER BY e.id DESC LIMIT 25");
    send(res, 200, { items: rows.map((r) => ({ ...r, data: JSON.parse(r.data || '{}') })) });
  });

  // Test chat (acts as the customer, in the browser, through the same pipeline)
  route('POST', '/api/chat/test', async (req, res) => {
    const b = await readBody(req);
    let lead = b.leadId ? store.getLead(Number(b.leadId)) : null;
    if (!lead || lead.channel !== 'sim') {
      lead = store.createLead({
        channel: 'sim', chat_id: `sim:${crypto.randomBytes(6).toString('hex')}`, name: first(b.name) || 'Test Customer',
        phone: first(b.phone) || null, source: 'admin-test', start_token: engine.newToken(),
      });
      store.addEvent(lead.id, 'lead_created', { source: 'admin-test' });
      engine.changed('lead', lead.id);
      if (!first(b.text)) engine.start(lead.id);
    }
    if (first(b.text)) engine.receive({ channel: 'sim', chatId: lead.chat_id, text: first(b.text) });
    send(res, 200, { ok: true, leadId: lead.id });
  });

  // Settings
  route('GET', '/api/settings', (req, res) => send(res, 200, settings.get()));
  route('PUT', '/api/settings', async (req, res) => {
    const b = await readBody(req);
    const prev = settings.get().qualification;
    const next = settings.update(b);
    const changedBar = ['min_budget', 'borderline_pct', 'active_within_months', 'required', 'service_cities'].some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next.qualification[k]));
    send(res, 200, { ok: true, settings: next, reclassify_suggested: changedBar });
  });
  route('POST', '/api/settings/preview', async (req, res) => {
    const b = await readBody(req);
    send(res, 200, engine.preview(b.patch || {}, { includeSim: b.includeSim !== false }));
  });
  route('POST', '/api/settings/reevaluate', (req, res) => send(res, 200, { ok: true, moved: engine.reevaluateAll() }));

  // Designers
  route('GET', '/api/designers', (req, res) => send(res, 200, { designers: store.listDesigners() }));
  route('POST', '/api/designers', async (req, res) => {
    const b = await readBody(req);
    if (!first(b.name)) throw new HttpError(400, 'Name is required');
    send(res, 200, { designer: store.saveDesigner({ ...b, name: first(b.name) }) });
  });
  route('PUT', '/api/designers/:id', async (req, res, { params }) => {
    const b = await readBody(req);
    if (!first(b.name)) throw new HttpError(400, 'Name is required');
    send(res, 200, { designer: store.saveDesigner({ ...b, id: Number(params.id), name: first(b.name) }) });
  });
  route('DELETE', '/api/designers/:id', (req, res, { params }) => {
    store.run('UPDATE leads SET designer_id=NULL WHERE designer_id=?', Number(params.id));
    store.deleteDesigner(Number(params.id));
    send(res, 200, { ok: true });
  });

  // Instagram admin actions. Graph API errors become 400s (a Graph 401 must not look like a lost admin session).
  const ig = async (fn) => { try { return await fn(); } catch (e) { throw new HttpError(400, e.message || 'Instagram request failed'); } };
  route('POST', '/api/instagram/subscribe', async (req, res) => { send(res, 200, { ok: true, result: await ig(() => instagram.subscribe()) }); });
  route('POST', '/api/instagram/refresh-token', async (req, res) => { send(res, 200, { ok: true, result: await ig(() => instagram.refreshToken({ force: true })) }); });
  route('POST', '/api/instagram/ice-breakers', async (req, res) => {
    const b = await readBody(req);
    if (Array.isArray(b.questions)) settings.update({ channels: { ice_breakers: b.questions } });
    send(res, 200, { ok: true, result: await ig(() => instagram.setIceBreakers(settings.get().channels.ice_breakers)) });
  });

  // Simulator, scheduler, integrations
  route('POST', '/api/sim/run', async (req, res) => {
    const b = await readBody(req);
    if (!llm.enabled) throw new HttpError(400, 'No LLM key configured');
    send(res, 200, await simulator.run({ personaIds: b.personas, concurrency: Number(b.concurrency) || 3, repeat: Number(b.repeat) || 1 }));
  });
  route('GET', '/api/sim/state', (req, res) => send(res, 200, simulator.state));
  route('POST', '/api/sim/clear', (req, res) => send(res, 200, { ok: true, removed: simulator.clear() }));
  route('POST', '/api/scheduler/run', async (req, res) => {
    const b = await readBody(req);
    send(res, 200, await scheduler.tick({ force: !!b.force, includeSim: b.includeSim !== false }));
  });
  route('POST', '/api/test-alert', async (req, res) => {
    const chat = settings.get().handoff.notify_chat_id;
    if (!chat) throw new HttpError(400, 'No alert chat set. Send /setup <admin password> to the bot from the chat you want alerts in.');
    await telegram.transport.sendRaw(chat, 'Test alert from your lead funnel. Alerts for new active leads will arrive here.');
    send(res, 200, { ok: true });
  });
  route('POST', '/api/test-webhook', async (req, res) => {
    const url = settings.get().handoff.webhook_url;
    if (!url) throw new HttpError(400, 'No webhook URL configured');
    store.enqueueWebhook('test.ping', { message: 'Test event from lead funnel', at: new Date().toISOString() });
    const r = await scheduler.tick();
    send(res, 200, { ok: true, delivered: r.webhooks });
  });
  route('POST', '/api/demo/wipe', async (req, res) => {
    const b = await readBody(req);
    if (b.confirm !== 'WIPE') throw new HttpError(400, 'Type WIPE to confirm');
    const ids = store.all('SELECT id FROM leads').map((r) => r.id);
    for (const id of ids) store.deleteLead(id);
    engine.changed('lead');
    send(res, 200, { ok: true, removed: ids.length });
  });
  route('GET', '/api/export.csv', (req, res) => {
    const s = settings.get();
    const csv = toCsv(store.listLeads({ limit: 20000 }), s.qualification.currency, store.listDesigners(), s.business.timezone);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' });
    res.end(csv);
  });
  route('GET', '/api/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    sse.add(res);
    req.on('close', () => sse.delete(res));
  });

  engine.on('change', (ev) => {
    const payload = `data: ${JSON.stringify(ev)}\n\n`;
    for (const r of sse) { try { r.write(payload); } catch { sse.delete(r); } }
  });
  const hb = setInterval(() => { for (const r of sse) { try { r.write(': ping\n\n'); } catch { sse.delete(r); } } }, 20000);
  hb.unref?.();

  // ---------- dispatch ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type, X-Intake-Secret' });
        return res.end();
      }
      if (url.pathname === '/api/intake' || url.pathname === '/api/public-config') res.setHeader('Access-Control-Allow-Origin', '*');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.rx);
        if (!m) continue;
        if (!r.public && !isAdmin(req)) return send(res, 401, { error: 'Not signed in' });
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return await r.handler(req, res, { params, query: url.searchParams });
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[http]', req.method, url.pathname, e);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Internal error' : e.message });
      else res.end();
    }
  });
  return server;
}

module.exports = { createServer };
