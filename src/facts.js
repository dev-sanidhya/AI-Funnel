'use strict';
// Turns the LLM's raw extraction into validated, sticky lead facts. The model
// proposes; this module disposes. Numbers are range-checked, contact details are
// regex-verified against what the person actually typed, and explicit budget
// phrases ("8 lakh", "50k") are re-parsed deterministically so a model slip
// cannot move a lead across the budget bar.

const { parseAmount, looksLikeBudget, amountSupportedByText, isBareNumberAnswer } = require('./budget');

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,17}\d)/;

const clip = (s, n) => String(s).trim().replace(/\s+/g, ' ').slice(0, n);
const validNum = (v) => typeof v === 'number' && Number.isFinite(v);

function extractContact(text) {
  const out = {};
  const email = String(text || '').match(EMAIL_RE);
  if (email) out.email = email[0].toLowerCase();
  const phone = String(text || '').match(PHONE_RE);
  if (phone) {
    const digits = phone[0].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) out.phone = phone[0].trim();
  }
  return out;
}

// Returns { patch, changed, meta } where patch holds column updates and meta is
// the updated lead.meta object (flags, refusal counters, declined fields).
function applyFacts(lead, f, userText, { lastAsked = null, settings }) {
  f = f && typeof f === 'object' ? f : {};
  const patch = {};
  const changed = [];
  const meta = JSON.parse(JSON.stringify(lead.meta || {}));
  meta.flags = meta.flags || {};
  meta.declined = meta.declined || {};
  meta.refusals = meta.refusals || {};
  const set = (col, val) => {
    if (val === null || val === undefined || val === '') return;
    if (lead[col] === val) return;
    patch[col] = val;
    changed.push(col);
  };

  if (!lead.name && typeof f.name === 'string' && f.name.trim()) set('name', clip(f.name, 60));

  const contact = extractContact(userText);
  if (contact.email) set('email', contact.email);
  else if (typeof f.email === 'string' && EMAIL_RE.test(f.email)) set('email', f.email.trim().toLowerCase());
  if (contact.phone) set('phone', contact.phone);

  if (typeof f.project_type === 'string' && f.project_type.trim()) set('project_type', clip(f.project_type, 60));
  if (typeof f.city === 'string' && f.city.trim()) set('city', clip(f.city, 60));

  // Budget: explicit units in the message are parsed by code and win over the model.
  const q = settings.qualification;
  let amount = null;
  const textHasBudget = looksLikeBudget(userText);
  if (textHasBudget || lastAsked === 'budget') {
    amount = parseAmount(userText, { allowBare: lastAsked === 'budget' && isBareNumberAnswer(userText) });
  }
  if (amount === null && validNum(f.budget_amount) && amountSupportedByText(f.budget_amount, userText)) amount = f.budget_amount;
  if (amount !== null && amount >= 1000 && amount <= 1e11) {
    set('budget_amount', Math.round(amount));
    if (typeof f.budget_text === 'string' && f.budget_text.trim()) set('budget_text', clip(f.budget_text, 60));
    else set('budget_text', clip(userText, 60));
  }

  if (validNum(f.timeline_months) && f.timeline_months >= 0 && f.timeline_months <= 120) {
    set('timeline_months', Math.round(f.timeline_months * 10) / 10);
    if (typeof f.timeline_text === 'string' && f.timeline_text.trim()) set('timeline_text', clip(f.timeline_text, 60));
  }

  if (typeof f.notes === 'string' && f.notes.trim() && f.notes.trim().toLowerCase() !== 'null') {
    const prev = lead.notes || '';
    const add = clip(f.notes, 160);
    if (!prev.toLowerCase().includes(add.toLowerCase())) set('notes', clip(prev ? `${prev}; ${add}` : add, 600));
  }

  // Flags and refusals.
  const known = { ...lead, ...patch };
  const fieldKnown = {
    project_type: !!known.project_type,
    city: !!known.city,
    budget: known.budget_amount != null,
    timeline: known.timeline_months != null,
  };
  if (f.wants_human === true) meta.flags.wants_human = true;
  if (f.not_interested === true) meta.flags.not_interested = true;
  else if (changed.length && meta.flags.not_interested) delete meta.flags.not_interested;
  if (Array.isArray(f.refused)) {
    for (const field of f.refused) {
      if (field in fieldKnown && !fieldKnown[field]) {
        meta.refusals[field] = (meta.refusals[field] || 0) + 1;
      }
    }
  }
  for (const field of Object.keys(fieldKnown)) {
    if (fieldKnown[field]) delete meta.declined[field];
    else if ((meta.refusals[field] || 0) >= 2) meta.declined[field] = true;
  }
  return { patch, changed, meta };
}

module.exports = { applyFacts, extractContact };
