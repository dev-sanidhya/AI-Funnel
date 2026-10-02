'use strict';
// Admin-editable configuration. Everything the demo needs to "adjust and alter"
// lives here, stored as JSON in the DB and deep-merged over these defaults so a
// partially saved or older config can never leave a key undefined.

const DEFAULTS = {
  business: {
    name: 'Aperture Interiors',
    tagline: 'Design to execution, under one roof',
    timezone: 'Asia/Kolkata',
    description: 'A premium interior design and execution studio for homes, offices and commercial spaces. We design, build and hand over turnkey projects.',
    services: ['Full home interiors', 'Modular kitchens and wardrobes', 'Office interiors', 'Renovations', 'Design-only consultation'],
    pricing_note: 'Pricing depends on carpet area, material and scope. Never quote exact numbers; offer a free consultation for an accurate estimate.',
    areas: 'Pune and nearby, other cities case by case',
    extra_knowledge: 'A typical full-home project takes 8 to 12 weeks. Every project gets a dedicated designer, a 3D design preview and a site supervisor.',
  },
  agent: {
    name: 'Aria',
    title: 'virtual design consultant',
    tone: 'warm, concise and professional, like a friendly consultant on chat, not a form',
    languages: 'Reply in the language the person writes in (English, Hindi or Hinglish).',
    reveal_minimum: false,
    extra_instructions: '',
  },
  qualification: {
    currency: 'INR',
    min_budget: 500000,
    borderline_pct: 0,
    active_within_months: 3,
    required: ['project_type', 'city', 'budget', 'timeline'],
    service_cities: [],
    project_types: ['Full home', 'Modular kitchen', 'Office', 'Renovation', 'Other'],
  },
  followups: {
    enabled: true,
    first_after_min: 60,
    second_after_min: 1440,
    max: 2,
    nurture_every_days: 7,
    nurture_max: 3,
    reminder_before_min: 60,
    overdue_after_min: 30,
  },
  channels: {
    primary: 'auto',
    ice_breakers: ['Get a free design quote', 'Check if my project fits', 'Talk about my budget'],
  },
  handoff: {
    notify_chat_id: '',
    webhook_url: '',
    webhook_secret: '',
    alert_stages: ['active', 'human'],
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Deep merge restricted to keys that exist in `base`, so unknown keys sent by a
// client are dropped rather than persisted.
function merge(base, over) {
  if (!isObj(base)) return over === undefined ? base : over;
  const out = { ...base };
  if (!isObj(over)) return out;
  for (const k of Object.keys(base)) {
    if (k in over) out[k] = isObj(base[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

const listish = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);

// Coerce whatever the admin UI sends so the engine never sees junk.
function sanitize(s) {
  const q = s.qualification;
  q.min_budget = Math.max(0, Number(q.min_budget) || 0);
  q.borderline_pct = Math.min(50, Math.max(0, Number(q.borderline_pct) || 0));
  q.active_within_months = Math.max(0, Number(q.active_within_months) || 0);
  q.required = listish(q.required).filter((f) => ['project_type', 'city', 'budget', 'timeline'].includes(f));
  if (!q.required.length) q.required = ['budget'];
  q.service_cities = listish(q.service_cities);
  q.project_types = listish(q.project_types);
  q.currency = String(q.currency || 'INR').toUpperCase().slice(0, 4);
  s.business.services = listish(s.business.services);
  const f = s.followups;
  f.enabled = !!f.enabled;
  for (const k of ['first_after_min', 'second_after_min', 'max', 'nurture_every_days', 'nurture_max', 'reminder_before_min', 'overdue_after_min']) f[k] = Math.max(0, Number(f[k]) || 0);
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.business.timezone }); } catch { s.business.timezone = 'Asia/Kolkata'; }
  s.agent.reveal_minimum = !!s.agent.reveal_minimum;
  s.channels.primary = ['auto', 'instagram', 'telegram'].includes(s.channels.primary) ? s.channels.primary : 'auto';
  s.channels.ice_breakers = listish(s.channels.ice_breakers).slice(0, 4);
  s.handoff.alert_stages = listish(s.handoff.alert_stages);
  s.handoff.notify_chat_id = String(s.handoff.notify_chat_id || '').trim();
  return s;
}

class Settings {
  constructor(store) { this.store = store; this.cache = null; }
  get() {
    if (!this.cache) this.cache = sanitize(merge(DEFAULTS, this.store.settingsRaw()));
    return this.cache;
  }
  update(patch) {
    const next = sanitize(merge(this.get(), patch));
    for (const k of Object.keys(DEFAULTS)) this.store.settingsSetRaw(k, next[k]);
    this.cache = next;
    return next;
  }
}

module.exports = { Settings, DEFAULTS, merge, sanitize };
