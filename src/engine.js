'use strict';
// The conversation engine. Reliability design:
//  - INBOX: every inbound message is written to SQLite first (unique update id =
//    idempotent) and marked processed only in the same transaction that stores
//    the reply, so a crash re-runs the turn instead of losing it.
//  - SERIAL PER LEAD: one turn at a time per lead; messages that arrive while a
//    turn runs (or in a quick burst) are coalesced into the next turn.
//  - OUTBOX: replies are stored as pending, then delivered with retries; a
//    scheduler sweep re-sends anything still pending after a restart.
//  - DETERMINISTIC CORE: facts -> qualify.evaluate() -> directive. The LLM only
//    extracts and phrases; it never decides the category.
//  - GRACEFUL DEGRADATION: if the LLM is down, regex backstops still capture
//    contact/budget and templated replies keep the conversation moving.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { applyFacts } = require('./facts');
const { evaluate, pickDesigner, STAGE_LABELS } = require('./qualify');
const { fallbackReply } = require('./agent');
const { formatMoney } = require('./budget');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(['active', 'nurture', 'disqualified']);
const HISTORY_WINDOW = 14;
const SUMMARY_EVERY = 8;
const MAX_ASKS_PER_FIELD = 3;

class Engine extends EventEmitter {
  constructor({ store, settings, agent, config, transports = {}, debounceMs = 1200, log = console }) {
    super();
    this.store = store;
    this.settings = settings;
    this.agent = agent;
    this.config = config;
    this.transports = transports;
    this.debounceMs = debounceMs;
    this.log = log;
    this.locks = new Map();
    this.delivering = new Set();
    this.summarizing = new Set();
    this.stats = { turns: 0, llmFallbacks: 0, sendFailures: 0 };
  }

  // ---------- helpers ----------
  transportFor(lead) { return this.transports[lead.channel === 'sim' ? 'sim' : lead.channel] || this.transports.sim; }

  runExclusive(leadId, fn) {
    const prev = this.locks.get(leadId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(leadId, next);
    next.finally(() => { if (this.locks.get(leadId) === next) this.locks.delete(leadId); }).catch(() => {});
    return next;
  }

  idle(leadId) { return (this.locks.get(leadId) || Promise.resolve()).catch(() => {}); }
  changed(type, leadId, extra = {}) { this.emit('change', { type, leadId, ...extra }); }
  money(n) { return formatMoney(n, this.settings.get().qualification.currency); }
  hasInbound(lead) { return (lead.meta.turns || 0) > 0; }

  // ---------- lead lifecycle ----------
  newToken() { return crypto.randomBytes(9).toString('base64url'); }

  createLeadFromIntake(data) {
    const lead = this.store.createLead({
      channel: 'telegram',
      name: data.name || null,
      phone: data.phone || null,
      email: data.email || null,
      city: data.city || null,
      project_type: data.project_type || null,
      source: data.source || 'form',
      campaign: data.campaign || null,
      start_token: this.newToken(),
      notes: data.notes || null,
      meta: { form: data.raw || {} },
    });
    this.store.addEvent(lead.id, 'lead_created', { source: lead.source, campaign: lead.campaign });
    this.afterChange(lead, { created: true });
    return lead;
  }

  // Bind a Telegram chat to the lead created at form submit, or create an organic one.
  bindChat(chatId, profile, { token, source } = {}) {
    let lead = this.store.getLeadByChat(chatId);
    if (lead) return { lead, isNew: false };
    if (token) {
      const form = this.store.getLeadByToken(token);
      if (form && !form.chat_id) {
        lead = this.store.updateLead(form.id, { chat_id: String(chatId), tg_username: profile.username || null, name: form.name || profile.first_name || null });
        this.store.addEvent(lead.id, 'telegram_linked', { via: 'token' });
        this.changed('lead', lead.id);
        return { lead, isNew: false, linked: true };
      }
    }
    lead = this.store.createLead({
      channel: 'telegram',
      chat_id: String(chatId),
      tg_username: profile.username || null,
      name: profile.first_name || null,
      source: source || 'telegram',
      start_token: this.newToken(),
    });
    this.store.addEvent(lead.id, 'lead_created', { source: lead.source });
    this.afterChange(lead, { created: true });
    return { lead, isNew: true };
  }

  // Merge a placeholder organic lead into the form lead found by phone match.
  linkByPhone(chatId, phone) {
    const target = this.store.findLeadByPhone(phone, { unboundOnly: true });
    if (!target) return null;
    const current = this.store.getLeadByChat(chatId);
    if (current && current.id === target.id) return target;
    let username = null;
    let first = null;
    if (current) {
      username = current.tg_username;
      first = current.name;
      if (this.store.countMessages(current.id) <= 3) this.store.deleteLead(current.id);
      else this.store.updateLead(current.id, { chat_id: null });
    }
    const linked = this.store.updateLead(target.id, { chat_id: String(chatId), tg_username: username || target.tg_username, name: target.name || first });
    this.store.addEvent(linked.id, 'telegram_linked', { via: 'phone' });
    this.changed('lead', linked.id);
    return linked;
  }

  // ---------- inbound ----------
  receive({ channel = 'telegram', chatId, text, profile = {}, updateId = null }) {
    let lead = this.store.getLeadByChat(chatId);
    if (!lead) lead = this.bindChat(chatId, profile).lead;
    try {
      this.store.addMessage({ lead_id: lead.id, direction: 'in', role: 'user', text: String(text).slice(0, 4000), tg_update_id: updateId });
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return { leadId: lead.id, duplicate: true };
      throw e;
    }
    const meta = { ...lead.meta };
    if (meta.flags && meta.flags.stalled) { meta.flags = { ...meta.flags }; delete meta.flags.stalled; }
    this.store.updateLead(lead.id, { last_inbound_at: Date.now(), meta });
    this.changed('message', lead.id);
    this.drain(lead.id).catch((e) => this.log.error('[engine] drain failed', e));
    return { leadId: lead.id, duplicate: false };
  }

  drain(leadId) {
    return this.runExclusive(leadId, async () => {
      for (let guard = 0; guard < 8; guard++) {
        // Debounce: let a burst of messages settle into one turn.
        for (let i = 0; i < 4 && this.debounceMs; i++) {
          const lead = this.store.getLead(leadId);
          if (!lead || lead.channel === 'sim' || !lead.last_inbound_at || Date.now() - lead.last_inbound_at >= this.debounceMs) break;
          await sleep(this.debounceMs - (Date.now() - lead.last_inbound_at) + 20);
        }
        const rows = this.store.all("SELECT * FROM messages WHERE lead_id=? AND direction='in' AND processed=0 ORDER BY id", leadId);
        if (!rows.length) break;
        await this.turn(leadId, rows);
      }
    });
  }

  // Re-run anything left unprocessed (crash recovery on boot).
  recover() {
    const ids = this.store.all("SELECT DISTINCT lead_id FROM messages WHERE direction='in' AND processed=0").map((r) => r.lead_id);
    for (const id of ids) this.drain(id).catch((e) => this.log.error('[engine] recover failed', e));
    // Backfill owners for qualified leads created before any designer existed.
    for (const l of this.store.listLeads({ stage: 'active', limit: 2000 })) if (!l.designer_id) this.assignDesigner(l);
    return ids.length;
  }

  // ---------- the turn ----------
  async turn(leadId, rows) {
    const settings = this.settings.get();
    let lead = this.store.getLead(leadId);
    if (!lead) return;
    const rowIds = rows.map((r) => r.id);
    const markProcessed = () => this.store.run(`UPDATE messages SET processed=1 WHERE id IN (${rowIds.map(() => '?').join(',')})`, ...rowIds);
    const text = rows.map((r) => r.text).join('\n');

    if (lead.opted_out) { markProcessed(); return; }
    if (lead.ai_paused) {
      markProcessed();
      this.store.addEvent(lead.id, 'message_while_paused', {});
      this.alertPausedMessage(lead, text);
      this.changed('message', lead.id);
      return;
    }

    const stopTyping = this.keepTyping(lead);
    try {
      this.stats.turns++;
      const history = this.store.all('SELECT * FROM messages WHERE lead_id=? AND id<? ORDER BY id DESC LIMIT ?', leadId, rowIds[0], 20).reverse();
      const lastAsked = lead.meta.last_asked || null;

      // 1. Extract facts (LLM), tolerate failure.
      let facts = null;
      try {
        facts = await this.agent.extract(lead, history, text, settings, lastAsked);
      } catch (e) {
        this.stats.llmFallbacks++;
        this.store.addEvent(lead.id, 'llm_error', { step: 'extract', error: String(e.message).slice(0, 200) });
      }
      const applied = applyFacts(lead, facts || {}, text, { lastAsked, settings });
      applied.meta.turns = (lead.meta.turns || 0) + 1;
      const prevStage = lead.stage;
      lead = this.store.updateLead(leadId, { ...applied.patch, meta: applied.meta });

      // 2. Decide (pure code).
      const decision = this.decide(lead, settings, { changed: applied.changed });
      lead = decision.lead;

      // 3. Compose.
      const reply = await this.compose(lead, decision.directive, settings, history.concat(rows));

      // 4. Commit everything for this turn atomically.
      const out = this.commitTurn({ lead, decision, reply, rowIds, prevStage, changed: applied.changed });
      this.changed('lead', leadId);
      if (out.messageId) this.deliver(out.messageId).catch(() => {});
      this.sideEffects(out.lead, prevStage, decision);
      this.maybeSummarize(leadId);
    } finally {
      stopTyping();
    }
  }

  // Applies exhaustion rules, evaluates, and picks the directive for this turn.
  decide(lead, settings, { changed = [], greeting = false } = {}) {
    let meta = { ...lead.meta, declined: { ...(lead.meta.declined || {}) }, asked: { ...(lead.meta.asked || {}) } };
    let ev = evaluate({ ...lead, meta }, settings, { hasInbound: this.hasInbound(lead) });
    // A field asked repeatedly with no usable answer stops being asked.
    let guard = 0;
    while (ev.nextField && (meta.asked[ev.nextField] || 0) >= MAX_ASKS_PER_FIELD && guard++ < 4) {
      meta.declined[ev.nextField] = true;
      ev = evaluate({ ...lead, meta }, settings, { hasInbound: this.hasInbound(lead) });
    }
    lead = { ...lead, meta };
    const stage = ev.stage;
    const reasonText = ev.reason;
    let directive = null;

    if (stage === 'human') {
      directive = meta.closed_stage === 'human' ? null : { type: 'HANDOFF', reason: reasonText };
    } else if (FINAL.has(stage)) {
      directive = meta.closed_stage === stage ? { type: 'POST' } : { type: `CLOSE_${stage === 'active' ? 'ACTIVE' : stage === 'nurture' ? 'NURTURE' : 'DISQUALIFIED'}`, reason: reasonText };
    } else {
      const field = ev.nextField;
      const col = { budget: 'budget_amount', timeline: 'timeline_months' }[field] || field;
      const hesitated = !!(meta.refusals && meta.refusals[field] > 0) && !changed.includes(col);
      directive = greeting ? { type: 'GREET', field } : { type: 'ASK', field, hesitated };
    }
    return { ev, stage, reason: reasonText, directive, lead };
  }

  async compose(lead, directive, settings, history) {
    if (!directive) return null;
    const designer = directive.type === 'CLOSE_ACTIVE' ? this.previewDesigner(lead) : (lead.designer_id ? this.store.getDesigner(lead.designer_id) : null);
    const ctx = { lead, settings, designer, summary: lead.summary };
    try {
      const msg = await this.agent.reply(directive, ctx, history);
      if (msg) return msg;
      this.stats.llmFallbacks++;
      this.store.addEvent(lead.id, 'reply_fallback', { directive: directive.type, why: 'validator_or_empty' });
    } catch (e) {
      this.stats.llmFallbacks++;
      this.store.addEvent(lead.id, 'llm_error', { step: 'reply', error: String(e.message).slice(0, 200) });
    }
    return fallbackReply(directive, ctx);
  }

  previewDesigner(lead) {
    const designers = this.store.listDesigners();
    return pickDesigner(designers, lead, this.designerLoads());
  }
  designerLoads() {
    const loads = {};
    for (const r of this.store.all("SELECT designer_id, COUNT(*) c FROM leads WHERE stage='active' AND designer_id IS NOT NULL GROUP BY designer_id")) loads[r.designer_id] = r.c;
    return loads;
  }

  commitTurn({ lead, decision, reply, rowIds, prevStage, changed }) {
    const { ev, stage, directive } = decision;
    const meta = { ...lead.meta };
    if (directive && directive.type === 'ASK') {
      meta.last_asked = directive.field;
      meta.asked = { ...meta.asked, [directive.field]: (meta.asked[directive.field] || 0) + 1 };
    } else if (directive && directive.type === 'GREET') {
      meta.last_asked = directive.field;
      meta.asked = { ...meta.asked, [directive.field]: (meta.asked[directive.field] || 0) + 1 };
    } else if (directive) {
      meta.last_asked = null;
    }
    if (directive && /^CLOSE_|^HANDOFF$/.test(directive.type)) meta.closed_stage = stage;
    if (!FINAL.has(stage) && stage !== 'human') delete meta.closed_stage;

    return this.store.tx(() => {
      const patch = { meta, stage, stage_reason: ev.reason, score: ev.score };
      if (stage === 'human' && meta.flags && meta.flags.wants_human) patch.ai_paused = 1;
      if (stage === 'active' && !lead.qualified_at) patch.qualified_at = Date.now();
      let messageId = null;
      if (reply) {
        messageId = this.store.addMessage({ lead_id: lead.id, direction: 'out', role: 'assistant', text: reply, status: 'pending' });
      }
      if (rowIds.length) this.store.run(`UPDATE messages SET processed=1 WHERE id IN (${rowIds.map(() => '?').join(',')})`, ...rowIds);
      if (stage !== prevStage) {
        this.store.addEvent(lead.id, 'stage_changed', { from: prevStage, to: stage, reason: ev.reason, score: ev.score });
      }
      if (changed.length) this.store.addEvent(lead.id, 'facts_updated', { fields: changed });
      return { messageId, lead: this.store.updateLead(lead.id, patch) };
    });
  }

  sideEffects(lead, prevStage, decision) {
    const stageChanged = lead.stage !== prevStage;
    if (stageChanged && lead.stage === 'active' && !lead.designer_id) this.assignDesigner(lead);
    const fresh = this.store.getLead(lead.id);
    this.afterChange(fresh, { stageChanged, prevStage });
  }

  assignDesigner(lead) {
    const d = pickDesigner(this.store.listDesigners(), lead, this.designerLoads());
    if (!d) return null;
    this.store.updateLead(lead.id, { designer_id: d.id });
    this.store.addEvent(lead.id, 'designer_assigned', { designer: d.name });
    return d;
  }

  // Alerts + CRM webhook after any meaningful change.
  afterChange(lead, { created = false, stageChanged = false, prevStage = null } = {}) {
    const settings = this.settings.get();
    const h = settings.handoff;
    if (lead.channel === 'sim') { this.changed('lead', lead.id); return; }
    if (h.webhook_url) {
      this.store.enqueueWebhook(created ? 'lead.created' : stageChanged ? 'lead.stage_changed' : 'lead.updated', this.publicLead(lead, { prevStage }));
    }
    if (stageChanged && h.alert_stages.includes(lead.stage)) this.alertTeam(lead).catch(() => {});
    this.changed('lead', lead.id);
  }

  publicLead(lead, extra = {}) {
    const designer = lead.designer_id ? this.store.getDesigner(lead.designer_id) : null;
    return {
      id: lead.id, name: lead.name, phone: lead.phone, email: lead.email, telegram: lead.tg_username,
      source: lead.source, campaign: lead.campaign,
      project_type: lead.project_type, city: lead.city,
      budget_amount: lead.budget_amount, budget_text: lead.budget_text,
      timeline_months: lead.timeline_months, timeline_text: lead.timeline_text,
      stage: lead.stage, stage_reason: lead.stage_reason, score: lead.score,
      designer: designer ? designer.name : null, notes: lead.notes, summary: lead.summary,
      created_at: lead.created_at, updated_at: lead.updated_at, ...extra,
    };
  }

  async alertTeam(lead) {
    const s = this.settings.get();
    const lines = [
      `${lead.stage === 'active' ? 'ACTIVE LEAD' : STAGE_LABELS[lead.stage].toUpperCase()}: ${lead.name || 'Unknown'}`,
      [lead.project_type, lead.city].filter(Boolean).join(' in ') || 'Project details pending',
      `Budget ${lead.budget_amount != null ? this.money(lead.budget_amount) : 'n/a'} | Timeline ${lead.timeline_text || (lead.timeline_months != null ? `${lead.timeline_months} months` : 'n/a')}`,
      `Score ${lead.score}/100`,
      lead.stage_reason ? `Why: ${lead.stage_reason}` : '',
      lead.summary ? `Notes: ${lead.summary}` : (lead.notes ? `Notes: ${lead.notes}` : ''),
      lead.tg_username ? `Telegram: @${lead.tg_username}` : '',
      lead.phone ? `Phone: ${lead.phone}` : '',
      `Open: ${this.config.publicUrl}/admin#lead=${lead.id}`,
    ].filter(Boolean).join('\n');
    const targets = new Set();
    if (s.handoff.notify_chat_id) targets.add(s.handoff.notify_chat_id);
    const d = lead.designer_id ? this.store.getDesigner(lead.designer_id) : null;
    if (d && d.telegram_chat_id) targets.add(d.telegram_chat_id);
    for (const chat of targets) {
      try { await this.transports.telegram?.sendRaw(chat, lines); } catch (e) { this.log.warn('[engine] alert failed', e.message); }
    }
  }

  alertPausedMessage(lead, text) {
    const meta = { ...lead.meta };
    if (meta.last_pause_alert && Date.now() - meta.last_pause_alert < 5 * 60 * 1000) return;
    meta.last_pause_alert = Date.now();
    this.store.updateLead(lead.id, { meta });
    const chat = this.settings.get().handoff.notify_chat_id;
    if (chat && lead.channel !== 'sim') {
      this.transports.telegram?.sendRaw(chat, `${lead.name || 'A lead'} wrote while the AI is paused: "${text.slice(0, 200)}"\n${this.config.publicUrl}/admin#lead=${lead.id}`).catch(() => {});
    }
  }

  keepTyping(lead) {
    const t = this.transportFor(lead);
    if (!t || !t.typing || !lead.chat_id) return () => {};
    const ping = () => t.typing(lead.chat_id).catch(() => {});
    ping();
    const iv = setInterval(ping, 4000);
    return () => clearInterval(iv);
  }

  // ---------- greeting / bot-initiated ----------
  start(leadId) {
    return this.runExclusive(leadId, async () => {
      const settings = this.settings.get();
      let lead = this.store.getLead(leadId);
      if (!lead || lead.ai_paused || lead.opted_out) return;
      if (this.store.countMessages(leadId) > 0) return;
      const stop = this.keepTyping(lead);
      try {
        const decision = this.decide(lead, settings, { greeting: true });
        lead = decision.lead;
        const reply = await this.compose(lead, decision.directive, settings, []);
        const out = this.commitTurn({ lead, decision, reply, rowIds: [], prevStage: lead.stage, changed: [] });
        if (out.messageId) this.deliver(out.messageId).catch(() => {});
        this.changed('lead', leadId);
      } finally { stop(); }
    });
  }

  // Scheduler-driven nudges: kind is 'followup' or 'drip'.
  nudge(leadId, kind) {
    return this.runExclusive(leadId, async () => {
      const settings = this.settings.get();
      let lead = this.store.getLead(leadId);
      if (!lead || lead.ai_paused || lead.opted_out || !lead.chat_id) return null;
      const meta = { ...lead.meta };
      let directive;
      if (kind === 'followup') {
        meta.followups_sent = (meta.followups_sent || 0) + 1;
        const ev = evaluate(lead, settings, { hasInbound: this.hasInbound(lead) });
        directive = { type: 'FOLLOWUP', n: meta.followups_sent, field: ev.nextField };
      } else {
        meta.drips_sent = (meta.drips_sent || 0) + 1;
        directive = { type: 'DRIP' };
      }
      const history = this.store.recentMessages(leadId, HISTORY_WINDOW);
      const reply = await this.compose({ ...lead, meta }, directive, settings, history);
      const id = this.store.tx(() => {
        this.store.updateLead(leadId, { meta });
        const mid = this.store.addMessage({ lead_id: leadId, direction: 'out', role: 'assistant', text: reply, status: 'pending' });
        this.store.addEvent(leadId, kind === 'followup' ? 'followup_sent' : 'drip_sent', { n: kind === 'followup' ? meta.followups_sent : meta.drips_sent });
        return mid;
      });
      this.deliver(id).catch(() => {});
      this.changed('lead', leadId);
      return id;
    });
  }

  // Marks silent leads whose follow-ups are exhausted so the funnel can nurture them.
  markStalled(leadId) {
    const lead = this.store.getLead(leadId);
    if (!lead) return;
    const meta = { ...lead.meta, flags: { ...(lead.meta.flags || {}), stalled: true } };
    const settings = this.settings.get();
    const ev = evaluate({ ...lead, meta }, settings, { hasInbound: this.hasInbound(lead) });
    const prev = lead.stage;
    const upd = this.store.updateLead(leadId, { meta, stage: ev.stage, stage_reason: ev.reason, score: ev.score });
    if (ev.stage !== prev) this.store.addEvent(leadId, 'stage_changed', { from: prev, to: ev.stage, reason: ev.reason, score: ev.score });
    this.afterChange(upd, { stageChanged: ev.stage !== prev, prevStage: prev });
  }

  // ---------- admin actions ----------
  sendManual(leadId, text, { pause = true } = {}) {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error('lead not found');
    const id = this.store.addMessage({ lead_id: leadId, direction: 'out', role: 'admin', text: String(text).slice(0, 4000), status: 'pending' });
    if (pause && !lead.ai_paused) {
      this.store.updateLead(leadId, { ai_paused: 1 });
      this.store.addEvent(leadId, 'ai_paused', { by: 'admin', auto: true });
    }
    this.store.addEvent(leadId, 'manual_message', {});
    this.reevaluateLead(leadId);
    this.deliver(id).catch(() => {});
    this.changed('lead', leadId);
    return id;
  }

  setPaused(leadId, paused) {
    this.store.updateLead(leadId, { ai_paused: paused ? 1 : 0 });
    if (!paused) {
      const lead = this.store.getLead(leadId);
      const meta = { ...lead.meta, flags: { ...(lead.meta.flags || {}) } };
      delete meta.flags.wants_human;
      delete meta.closed_stage;
      this.store.updateLead(leadId, { meta });
    }
    this.store.addEvent(leadId, paused ? 'ai_paused' : 'ai_resumed', { by: 'admin' });
    this.reevaluateLead(leadId);
  }

  setStage(leadId, stage, reason) {
    const lead = this.store.getLead(leadId);
    const prev = lead.stage;
    const upd = this.store.updateLead(leadId, { stage, stage_locked: 1, stage_reason: reason || 'Set manually by admin' });
    this.store.addEvent(leadId, 'stage_changed', { from: prev, to: stage, reason: 'Manual override', manual: true });
    if (stage === 'active' && !upd.designer_id) this.assignDesigner(upd);
    this.afterChange(this.store.getLead(leadId), { stageChanged: prev !== stage, prevStage: prev });
  }

  unlockStage(leadId) {
    this.store.updateLead(leadId, { stage_locked: 0 });
    this.reevaluateLead(leadId);
  }

  reevaluateLead(leadId, { apply = true } = {}) {
    const lead = this.store.getLead(leadId);
    const ev = evaluate(lead, this.settings.get(), { hasInbound: this.hasInbound(lead) });
    if (!apply) return ev;
    if (ev.stage !== lead.stage || ev.reason !== lead.stage_reason || ev.score !== lead.score) {
      const upd = this.store.updateLead(leadId, { stage: ev.stage, stage_reason: ev.reason, score: ev.score });
      if (ev.stage !== lead.stage) {
        this.store.addEvent(leadId, 'stage_changed', { from: lead.stage, to: ev.stage, reason: ev.reason, score: ev.score, reclassified: true });
        if (ev.stage === 'active' && !upd.designer_id) this.assignDesigner(upd);
      }
      this.afterChange(this.store.getLead(leadId), { stageChanged: ev.stage !== lead.stage, prevStage: lead.stage });
    }
    return ev;
  }

  // What-if: how would the funnel look under a different settings patch?
  preview(patch, { includeSim = true } = {}) {
    const { merge, sanitize } = require('./settings');
    const candidate = sanitize(merge(this.settings.get(), patch));
    const rows = this.store.listLeads({ limit: 5000 }).filter((l) => includeSim || l.channel !== 'sim');
    const before = {};
    const after = {};
    const moved = [];
    for (const l of rows) {
      const cur = l.stage;
      const next = l.stage_locked ? l.stage : evaluate(l, candidate, { hasInbound: this.hasInbound(l) }).stage;
      before[cur] = (before[cur] || 0) + 1;
      after[next] = (after[next] || 0) + 1;
      if (cur !== next) moved.push({ id: l.id, name: l.name || `Lead ${l.id}`, from: cur, to: next, budget: l.budget_amount });
    }
    return { total: rows.length, before, after, moved };
  }

  reevaluateAll() {
    let n = 0;
    for (const l of this.store.listLeads({ limit: 5000 })) {
      if (l.stage_locked) continue;
      const before = l.stage;
      const ev = this.reevaluateLead(l.id);
      if (ev.stage !== before) n++;
    }
    return n;
  }

  resetLead(leadId) {
    const lead = this.store.getLead(leadId);
    if (!lead) return;
    this.store.tx(() => {
      this.store.run('DELETE FROM messages WHERE lead_id=?', leadId);
      this.store.run('DELETE FROM events WHERE lead_id=?', leadId);
      const form = (lead.meta && lead.meta.form) || {};
      this.store.updateLead(leadId, {
        project_type: form.project_type || null, city: form.city || null,
        budget_amount: null, budget_text: null, timeline_months: null, timeline_text: null,
        notes: null, stage: 'new', stage_reason: null, stage_locked: 0, score: 0, designer_id: null,
        ai_paused: 0, opted_out: 0, summary: '', summary_upto: 0, qualified_at: null,
        last_inbound_at: null, last_outbound_at: null, meta: { form },
      });
      this.store.addEvent(leadId, 'lead_reset', {});
    });
    this.changed('lead', leadId);
  }

  // ---------- outbound delivery ----------
  async deliver(messageId) {
    if (this.delivering.has(messageId)) return;
    this.delivering.add(messageId);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const m = this.store.get('SELECT * FROM messages WHERE id=?', messageId);
        if (!m || m.status === 'sent') return;
        const lead = this.store.getLead(m.lead_id);
        if (!lead) return;
        try {
          await this.transportFor(lead).send(lead, m.text);
          this.store.run("UPDATE messages SET status='sent', error=NULL WHERE id=?", messageId);
          this.store.updateLead(lead.id, { last_outbound_at: Date.now() });
          this.changed('message', lead.id);
          return;
        } catch (e) {
          this.stats.sendFailures++;
          const attempts = m.attempts + 1;
          const permanent = e.permanent === true;
          this.store.run('UPDATE messages SET attempts=?, error=?, status=? WHERE id=?', attempts, String(e.message).slice(0, 300), permanent || attempts >= 6 ? 'failed' : 'pending', messageId);
          if (permanent) {
            this.store.addEvent(lead.id, 'send_failed', { error: e.message });
            if (/blocked|deactivated|chat not found/i.test(e.message)) this.store.updateLead(lead.id, { opted_out: 1 });
            this.changed('message', lead.id);
            return;
          }
          await sleep(500 * 2 ** attempt);
        }
      }
    } finally {
      this.delivering.delete(messageId);
    }
  }

  async sweepOutbox() {
    const rows = this.store.all("SELECT id FROM messages WHERE direction='out' AND status='pending' AND created_at<? ORDER BY id LIMIT 50", Date.now() - 8000);
    for (const r of rows) await this.deliver(r.id);
    return rows.length;
  }

  // ---------- context management ----------
  maybeSummarize(leadId) {
    if (this.summarizing.has(leadId)) return;
    const lead = this.store.getLead(leadId);
    if (!lead || lead.meta.turns % SUMMARY_EVERY !== 0) return;
    const total = this.store.countMessages(leadId);
    if (total <= HISTORY_WINDOW) return;
    this.summarizing.add(leadId);
    (async () => {
      try {
        // Fold everything that has fallen out of the live window into the summary.
        const old = this.store.all('SELECT * FROM messages WHERE lead_id=? AND id>? ORDER BY id DESC LIMIT 400 OFFSET ?', leadId, lead.summary_upto, HISTORY_WINDOW).reverse();
        if (!old.length) return;
        const summary = await this.agent.summarize(lead, lead.summary, old, this.settings.get());
        this.store.updateLead(leadId, { summary, summary_upto: old[old.length - 1].id });
        this.changed('lead', leadId);
      } catch (e) {
        this.log.warn('[engine] summarize failed', e.message);
      } finally {
        this.summarizing.delete(leadId);
      }
    })();
  }
}

module.exports = { Engine, FINAL };
