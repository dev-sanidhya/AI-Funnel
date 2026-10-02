'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT UNIQUE,
  channel TEXT NOT NULL DEFAULT 'telegram',
  tg_username TEXT,
  name TEXT, phone TEXT, email TEXT,
  source TEXT, campaign TEXT,
  project_type TEXT, city TEXT,
  budget_amount REAL, budget_text TEXT,
  timeline_months REAL, timeline_text TEXT,
  notes TEXT,
  stage TEXT NOT NULL DEFAULT 'new',
  stage_reason TEXT,
  stage_locked INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  designer_id INTEGER,
  ai_paused INTEGER NOT NULL DEFAULT 0,
  opted_out INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  summary_upto INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  start_token TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  qualified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  tg_update_id INTEGER UNIQUE,
  status TEXT NOT NULL DEFAULT 'received',
  processed INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(status, processed);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id, id);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS designers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  title TEXT,
  phone TEXT,
  telegram_chat_id TEXT,
  specialties TEXT NOT NULL DEFAULT '',
  cities TEXT NOT NULL DEFAULT '',
  min_budget REAL NOT NULL DEFAULT 0,
  bio TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
`;

const LEAD_COLUMNS = new Set([
  'chat_id', 'channel', 'tg_username', 'name', 'phone', 'email', 'source', 'campaign',
  'project_type', 'city', 'budget_amount', 'budget_text', 'timeline_months', 'timeline_text',
  'notes', 'stage', 'stage_reason', 'stage_locked', 'score', 'designer_id', 'ai_paused',
  'opted_out', 'summary', 'summary_upto', 'meta', 'start_token', 'last_inbound_at',
  'last_outbound_at', 'qualified_at',
]);

const now = () => Date.now();

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // Additive migrations for databases created by earlier versions.
  migrate() {
    const cols = this.all('PRAGMA table_info(messages)').map((c) => c.name);
    if (!cols.includes('ext_id')) this.db.exec('ALTER TABLE messages ADD COLUMN ext_id TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_ext ON messages(ext_id)');
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  run(sql, ...p) { return this.db.prepare(sql).run(...p); }
  get(sql, ...p) { return this.db.prepare(sql).get(...p); }
  all(sql, ...p) { return this.db.prepare(sql).all(...p); }

  // ---- kv / settings ----
  kvGet(key, fallback = null) {
    const r = this.get('SELECT value FROM kv WHERE key=?', key);
    return r ? JSON.parse(r.value) : fallback;
  }
  kvSet(key, value) {
    this.run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }
  settingsRaw() {
    const out = {};
    for (const r of this.all('SELECT key,value FROM settings')) out[r.key] = JSON.parse(r.value);
    return out;
  }
  settingsSetRaw(key, value) {
    this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }

  // ---- leads ----
  hydrate(row) {
    if (!row) return null;
    let meta = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch { /* corrupt meta resets */ }
    return { ...row, meta };
  }
  createLead(fields = {}) {
    const t = now();
    const data = { channel: 'telegram', stage: 'new', ...fields };
    const meta = JSON.stringify(data.meta || {});
    const cols = Object.keys(data).filter((k) => LEAD_COLUMNS.has(k) && k !== 'meta');
    const all = [...cols, 'meta', 'created_at', 'updated_at'];
    const sql = `INSERT INTO leads(${all.join(',')}) VALUES(${all.map(() => '?').join(',')})`;
    const r = this.run(sql, ...cols.map((c) => data[c] ?? null), meta, t, t);
    return this.getLead(Number(r.lastInsertRowid));
  }
  getLead(id) { return this.hydrate(this.get('SELECT * FROM leads WHERE id=?', id)); }
  getLeadByChat(chatId) { return this.hydrate(this.get('SELECT * FROM leads WHERE chat_id=?', String(chatId))); }
  getLeadByToken(token) { return this.hydrate(this.get('SELECT * FROM leads WHERE start_token=?', token)); }
  updateLead(id, patch) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!LEAD_COLUMNS.has(k)) continue;
      sets.push(`${k}=?`);
      vals.push(k === 'meta' ? JSON.stringify(v) : v === undefined ? null : v);
    }
    if (!sets.length) return this.getLead(id);
    sets.push('updated_at=?');
    vals.push(now(), id);
    this.run(`UPDATE leads SET ${sets.join(',')} WHERE id=?`, ...vals);
    return this.getLead(id);
  }
  deleteLead(id) {
    this.tx(() => {
      this.run('DELETE FROM messages WHERE lead_id=?', id);
      this.run('DELETE FROM events WHERE lead_id=?', id);
      this.run('DELETE FROM leads WHERE id=?', id);
    });
  }
  listLeads({ stage, q, channel, limit = 500 } = {}) {
    const where = [];
    const p = [];
    if (stage) { where.push('stage=?'); p.push(stage); }
    if (channel === 'real') where.push("channel!='sim'");
    else if (channel) { where.push('channel=?'); p.push(channel); }
    if (q) {
      where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ? OR city LIKE ? OR tg_username LIKE ?)');
      const like = `%${q}%`;
      p.push(like, like, like, like, like);
    }
    const sql = `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`;
    return this.all(sql, ...p, limit).map((r) => this.hydrate(r));
  }
  findLeadByPhone(phone, { unboundOnly = false } = {}) {
    const digits = normalizePhone(phone);
    if (!digits) return null;
    const rows = this.all(`SELECT * FROM leads WHERE phone IS NOT NULL ${unboundOnly ? 'AND chat_id IS NULL' : ''} ORDER BY id DESC`);
    return this.hydrate(rows.find((r) => normalizePhone(r.phone) === digits));
  }

  // ---- messages ----
  addMessage(m) {
    const r = this.run(
      'INSERT INTO messages(lead_id,direction,role,text,tg_update_id,ext_id,status,processed,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      m.lead_id, m.direction, m.role, m.text, m.tg_update_id ?? null, m.ext_id ?? null,
      m.status || (m.direction === 'in' ? 'received' : 'pending'), m.processed ? 1 : 0, now(),
    );
    return Number(r.lastInsertRowid);
  }
  getMessages(leadId, { limit = 300, afterId = 0 } = {}) {
    return this.all('SELECT * FROM messages WHERE lead_id=? AND id>? ORDER BY id ASC LIMIT ?', leadId, afterId, limit);
  }
  recentMessages(leadId, n) {
    return this.all('SELECT * FROM messages WHERE lead_id=? ORDER BY id DESC LIMIT ?', leadId, n).reverse();
  }
  countMessages(leadId) { return this.get('SELECT COUNT(*) c FROM messages WHERE lead_id=?', leadId).c; }

  // ---- events ----
  addEvent(leadId, type, data = {}) {
    this.run('INSERT INTO events(lead_id,type,data,created_at) VALUES(?,?,?,?)', leadId, type, JSON.stringify(data), now());
  }
  getEvents(leadId, limit = 100) {
    return this.all('SELECT * FROM events WHERE lead_id=? ORDER BY id DESC LIMIT ?', leadId, limit)
      .map((e) => ({ ...e, data: safeJson(e.data) }));
  }

  // ---- designers ----
  listDesigners() { return this.all('SELECT * FROM designers ORDER BY active DESC, id ASC'); }
  getDesigner(id) { return this.get('SELECT * FROM designers WHERE id=?', id) || null; }
  saveDesigner(d) {
    const f = [d.name, d.title || '', d.phone || '', d.telegram_chat_id || '', d.specialties || '', d.cities || '',
      Number(d.min_budget) || 0, d.bio || '', d.active === false || d.active === 0 ? 0 : 1];
    if (d.id) {
      this.run('UPDATE designers SET name=?,title=?,phone=?,telegram_chat_id=?,specialties=?,cities=?,min_budget=?,bio=?,active=? WHERE id=?', ...f, d.id);
      return this.getDesigner(d.id);
    }
    const r = this.run('INSERT INTO designers(name,title,phone,telegram_chat_id,specialties,cities,min_budget,bio,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', ...f, now());
    return this.getDesigner(Number(r.lastInsertRowid));
  }
  deleteDesigner(id) { this.run('DELETE FROM designers WHERE id=?', id); }

  // ---- webhook outbox ----
  enqueueWebhook(event, payload) {
    this.run('INSERT INTO webhook_outbox(event,payload,next_at,created_at) VALUES(?,?,?,?)', event, JSON.stringify(payload), now(), now());
  }

  close() { this.db.close(); }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 7) return '';
  return d.slice(-10); // compare on the last 10 digits so +91 / 0 prefixes match
}

module.exports = { Store, normalizePhone, safeJson, now };
