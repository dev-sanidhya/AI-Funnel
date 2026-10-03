'use strict';
// Choices shown on the public enquiry form, and how each answer maps onto a lead.
// A budget choice stores the UPPER end of its range as the lead's budget, so the
// minimum-budget rule treats a range the same way the chat does (benefit of the doubt).

const { formatMoney } = require('./budget');

const SCOPE_OPTIONS = [
  { label: 'Full home interiors', category: 'Full home' },
  { label: 'Modular kitchen', category: 'Modular kitchen' },
  { label: 'Wardrobes and storage', category: 'Modular kitchen' },
  { label: 'Living room', category: 'Full home' },
  { label: 'Bedrooms', category: 'Full home' },
  { label: 'Bathrooms', category: 'Renovation' },
  { label: 'Office or commercial', category: 'Office' },
  { label: 'Renovation', category: 'Renovation' },
  { label: 'Something else', category: 'Other' },
];

const PROPERTY_TYPES = ['Apartment', 'Villa', 'Independent house', 'Office', 'Shop or showroom', 'Other'];
const SIZES = ['1 BHK', '2 BHK', '3 BHK', '4 BHK', '5 BHK or larger', 'Not applicable'];
const CONTACT_TIMES = ['Morning', 'Afternoon', 'Evening', 'Any time'];

const TIMELINE_OPTIONS = [
  { label: 'As soon as possible', months: 0 },
  { label: 'Within a month', months: 1 },
  { label: 'In 1 to 3 months', months: 3 },
  { label: 'In 3 to 6 months', months: 6 },
  { label: 'More than 6 months away', months: 9 },
  { label: 'Just exploring', months: 12 },
];

function budgetOptions(currency = 'INR') {
  const ranges = currency === 'INR'
    ? [['Under ₹3 lakh', 300000], ['₹3 to 5 lakh', 500000], ['₹5 to 10 lakh', 1000000], ['₹10 to 20 lakh', 2000000], ['₹20 to 50 lakh', 5000000], ['Above ₹50 lakh', 7500000]]
    : [[`Under ${formatMoney(5000, currency)}`, 5000], [`${formatMoney(5000, currency)} to ${formatMoney(15000, currency)}`, 15000], [`${formatMoney(15000, currency)} to ${formatMoney(40000, currency)}`, 40000], [`${formatMoney(40000, currency)} to ${formatMoney(100000, currency)}`, 100000], [`Above ${formatMoney(100000, currency)}`, 250000]];
  return [...ranges.map(([label, amount]) => ({ label, amount })), { label: 'Not sure yet', amount: null }];
}

const clean = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

// Turns the raw form answers into lead fields.
function mapIntake(body, settings) {
  const q = settings.qualification;
  const scopeLabels = (Array.isArray(body.scope) ? body.scope : String(body.scope || '').split('|')).map((x) => clean(x, 60)).filter(Boolean).slice(0, 9);
  const cats = scopeLabels.map((l) => (SCOPE_OPTIONS.find((o) => o.label === l) || {}).category).filter(Boolean);
  const fallbackType = clean(body.project_type, 60);
  const pick = ['Full home', 'Modular kitchen', 'Office', 'Renovation'].find((c) => cats.includes(c)) || cats[0] || fallbackType || null;
  const project_type = pick && (q.project_types.includes(pick) ? pick : q.project_types.includes('Other') ? 'Other' : pick);

  const ptype = clean(body.property_type, 40);
  const size = clean(body.size, 40);
  const sqft = clean(body.sqft, 12).replace(/[^\d]/g, '');
  const bits = [];
  if (size && size !== 'Not applicable') bits.push(size.replace(' ', ''));
  if (ptype) bits.push(ptype.toLowerCase());
  const property = [bits.join(' '), sqft ? `${sqft} sq ft` : ''].filter(Boolean).join(', ') || null;

  const locality = clean(body.locality, 60);
  const city = clean(body.city, 60);
  const cityFull = [locality, city].filter(Boolean).join(', ') || null;

  let budget_amount = null;
  let budget_text = null;
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const budgetOpt = budgetOptions(q.currency).find((o) => norm(o.label) === norm(body.budget));
  if (budgetOpt && budgetOpt.amount) { budget_amount = budgetOpt.amount; budget_text = budgetOpt.label; }

  let timeline_months = null;
  let timeline_text = null;
  const tl = TIMELINE_OPTIONS.find((o) => o.label === clean(body.timeline, 60));
  if (tl) { timeline_months = tl.months; timeline_text = tl.label.charAt(0).toLowerCase() + tl.label.slice(1); }

  return {
    project_type, scope: scopeLabels.join(', ').toLowerCase() || null, property, city: cityFull,
    budget_amount, budget_text, timeline_months, timeline_text,
    contact_pref: clean(body.contact_pref, 40).toLowerCase() || null,
    notes: clean(body.notes, 400) || null,
  };
}

module.exports = { SCOPE_OPTIONS, PROPERTY_TYPES, SIZES, CONTACT_TIMES, TIMELINE_OPTIONS, budgetOptions, mapIntake };
