'use strict';
// CRM integration surface:
//  - Webhook outbox: every lead create/update/stage change is queued and POSTed
//    (HMAC-signed, retried with backoff) to the URL configured in the admin, so
//    any CRM (HubSpot via Zapier/Make, Google Sheets via Apps Script, the client's
//    own system) stays in sync without losing events during an outage.
//  - CSV export of the centralized lead database.

const crypto = require('node:crypto');
const { formatMoney } = require('./budget');
const { STAGE_LABELS } = require('./qualify');

const MAX_ATTEMPTS = 8;

async function deliverWebhooks(store, settings, { fetchImpl = globalThis.fetch, log = console } = {}) {
  const { webhook_url: url, webhook_secret: secret } = settings.get().handoff;
  if (!url) return { sent: 0, failed: 0 };
  const rows = store.all("SELECT * FROM webhook_outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 25", Date.now());
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const body = JSON.stringify({ event: r.event, sent_at: new Date().toISOString(), data: JSON.parse(r.payload) });
    const headers = { 'Content-Type': 'application/json', 'X-Funnel-Event': r.event };
    if (secret) headers['X-Funnel-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetchImpl(url, { method: 'POST', headers, body, signal: ctrl.signal }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      store.run("UPDATE webhook_outbox SET status='sent', attempts=attempts+1, last_error=NULL WHERE id=?", r.id);
      sent++;
    } catch (e) {
      failed++;
      const attempts = r.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      store.run('UPDATE webhook_outbox SET attempts=?, status=?, next_at=?, last_error=? WHERE id=?',
        attempts, dead ? 'dead' : 'pending', Date.now() + Math.min(3600000, 30000 * 2 ** attempts), String(e.message).slice(0, 200), r.id);
      if (dead) log.warn('[crm] webhook gave up on event', r.id, e.message);
    }
  }
  return { sent, failed };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(leads, currency, designers = []) {
  const byId = Object.fromEntries(designers.map((d) => [d.id, d.name]));
  const head = ['id', 'name', 'phone', 'email', 'telegram', 'source', 'campaign', 'stage', 'stage_reason', 'score', 'project_type', 'city', 'budget', 'timeline', 'designer', 'notes', 'summary', 'created_at', 'updated_at'];
  const rows = leads.map((l) => [
    l.id, l.name, l.phone, l.email, l.tg_username, l.source, l.campaign, STAGE_LABELS[l.stage] || l.stage, l.stage_reason, l.score,
    l.project_type, l.city, l.budget_amount != null ? formatMoney(l.budget_amount, currency) : '',
    l.timeline_text || (l.timeline_months != null ? `${l.timeline_months} months` : ''),
    byId[l.designer_id] || '', l.notes, l.summary, new Date(l.created_at).toISOString(), new Date(l.updated_at).toISOString(),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

module.exports = { deliverWebhooks, toCsv };
