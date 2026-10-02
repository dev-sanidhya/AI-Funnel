'use strict';
// The funnel's decision logic. This is PURE CODE on purpose: the LLM extracts
// facts and writes words, but whether a lead is disqualified, nurtured or active
// is decided here, deterministically, from the stored facts and the admin's
// settings. That keeps the budget bar exact and every category explainable.

const STAGES = ['new', 'qualifying', 'active', 'nurture', 'disqualified', 'human'];
const STAGE_LABELS = {
  new: 'New',
  qualifying: 'Qualifying',
  active: 'Active',
  nurture: 'Nurtured',
  disqualified: 'Disqualified',
  human: 'Needs human',
};
const FIELD_LABELS = { project_type: 'project type', city: 'city', budget: 'budget', timeline: 'timeline' };
const FIELD_ORDER = ['project_type', 'city', 'budget', 'timeline'];

const { formatMoney } = require('./budget');

function fieldKnown(lead, field) {
  switch (field) {
    case 'project_type': return !!lead.project_type;
    case 'city': return !!lead.city;
    case 'budget': return lead.budget_amount !== null && lead.budget_amount !== undefined;
    case 'timeline': return lead.timeline_months !== null && lead.timeline_months !== undefined;
    default: return true;
  }
}

function cityAllowed(city, serviceCities) {
  if (!serviceCities.length || !city) return true;
  const c = city.toLowerCase();
  return serviceCities.some((s) => {
    const x = s.toLowerCase();
    return c.includes(x) || x.includes(c);
  });
}

function computeScore(lead, settings, missing) {
  const q = settings.qualification;
  let score = 0;
  const required = q.required.length || 1;
  score += Math.round(40 * (1 - missing.length / required));
  if (lead.budget_amount != null && q.min_budget > 0) {
    score += Math.round(25 * Math.min(1, lead.budget_amount / (q.min_budget * 3)));
  } else if (lead.budget_amount != null) score += 25;
  if (lead.timeline_months != null) {
    const m = lead.timeline_months;
    score += m <= 1 ? 25 : m <= 3 ? 20 : m <= 6 ? 10 : 5;
  }
  if (lead.phone || lead.email) score += 5;
  if (lead.meta && lead.meta.turns >= 3) score += 5;
  return Math.max(0, Math.min(100, score));
}

// Returns { stage, reason, score, missing, askable, nextField }.
//  - missing: required fields still unknown
//  - askable: missing and not already declined/exhausted
function evaluate(lead, settings, { hasInbound = true } = {}) {
  const q = settings.qualification;
  const flags = (lead.meta && lead.meta.flags) || {};
  const declined = (lead.meta && lead.meta.declined) || {};
  const money = (n) => formatMoney(n, q.currency);

  const missing = q.required.filter((f) => !fieldKnown(lead, f));
  const askable = FIELD_ORDER.filter((f) => missing.includes(f) && !declined[f]);
  const base = { missing, askable, nextField: askable[0] || null };
  const score = computeScore(lead, settings, missing);

  if (lead.stage_locked) {
    return { ...base, stage: lead.stage, reason: lead.stage_reason || 'Set manually', score };
  }
  if (lead.ai_paused || flags.wants_human) {
    return { ...base, stage: 'human', reason: flags.wants_human ? 'Asked for a human' : 'AI paused, a human has the conversation', score };
  }
  if (flags.not_interested) {
    return { ...base, stage: 'disqualified', reason: 'Said they are not interested', score: Math.min(score, 15) };
  }

  // The budget bar: checked as soon as a budget is known, even mid-conversation.
  if (fieldKnown(lead, 'budget') && q.min_budget > 0) {
    const floor = q.min_budget * (1 - q.borderline_pct / 100);
    if (lead.budget_amount < floor) {
      return { ...base, stage: 'disqualified', reason: `Budget ${money(lead.budget_amount)} is below the ${money(q.min_budget)} minimum`, score: Math.min(score, 20) };
    }
    if (lead.budget_amount < q.min_budget) {
      return { ...base, stage: 'nurture', reason: `Borderline budget ${money(lead.budget_amount)} (minimum ${money(q.min_budget)}), worth keeping warm`, score };
    }
  }
  if (lead.city && !cityAllowed(lead.city, q.service_cities)) {
    return { ...base, stage: 'disqualified', reason: `Outside service area (${lead.city})`, score: Math.min(score, 20) };
  }

  if (askable.length) {
    if (flags.stalled) return { ...base, stage: 'nurture', reason: 'Went quiet before finishing, follow-ups sent', score };
    return { ...base, stage: hasInbound ? 'qualifying' : 'new', reason: hasInbound ? `Still need: ${askable.map((f) => FIELD_LABELS[f]).join(', ')}` : 'Waiting for first reply', score };
  }

  // Everything required is answered (or politely declined).
  if (!fieldKnown(lead, 'budget') && q.required.includes('budget')) {
    return { ...base, stage: 'nurture', reason: 'Budget not shared, cannot confirm fit', score };
  }
  if (!fieldKnown(lead, 'timeline') && q.required.includes('timeline')) {
    return { ...base, stage: 'nurture', reason: 'Timeline unclear', score };
  }
  if (fieldKnown(lead, 'timeline') && lead.timeline_months > q.active_within_months) {
    return { ...base, stage: 'nurture', reason: `Qualified on budget but timeline is ${lead.timeline_text || `${lead.timeline_months} months`} (active means within ${q.active_within_months} months)`, score };
  }
  const bits = [];
  if (lead.budget_amount != null) bits.push(`budget ${money(lead.budget_amount)}`);
  if (lead.timeline_text || lead.timeline_months != null) bits.push(`timeline ${lead.timeline_text || `${lead.timeline_months} months`}`);
  return { ...base, stage: 'active', reason: `Qualified: ${bits.join(', ') || 'all required details received'}`, score: Math.max(score, 60) };
}

// Chooses the best-fit active designer for a lead; ties go to the lightest load.
function pickDesigner(designers, lead, loads = {}) {
  const has = (list, value) => {
    const items = String(list || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!items.length) return 0;
    const v = String(value || '').toLowerCase();
    return v && items.some((i) => v.includes(i) || i.includes(v)) ? 2 : -1;
  };
  const ranked = designers
    .filter((d) => d.active)
    .map((d) => {
      const s = has(d.specialties, lead.project_type);
      const c = has(d.cities, lead.city);
      const budgetOk = !d.min_budget || (lead.budget_amount ?? Infinity) >= d.min_budget;
      return { d, fit: s < 0 || c < 0 || !budgetOk ? -1 : Math.max(s, 0) + Math.max(c, 0) };
    })
    .filter((x) => x.fit >= 0)
    .sort((a, b) => b.fit - a.fit || (loads[a.d.id] || 0) - (loads[b.d.id] || 0));
  return ranked.length ? ranked[0].d : null;
}

module.exports = { evaluate, pickDesigner, fieldKnown, STAGES, STAGE_LABELS, FIELD_LABELS, FIELD_ORDER };
