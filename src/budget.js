'use strict';
// Money parsing and formatting. Amounts are stored as plain numbers in whole
// currency units (e.g. 800000 for "8 lakh" INR) so the threshold comparison is
// one deterministic number check, never an LLM judgement.

const UNIT = {
  crore: 1e7, crores: 1e7, cr: 1e7,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5,
  k: 1e3, thousand: 1e3,
  m: 1e6, million: 1e6, mn: 1e6,
};

const BUDGETISH = /(lakh|lac|\bl\b|crore|\bcr\b|\bk\b|thousand|million|\bmn?\b|₹|\brs\b\.?|\binr\b|\$|\busd\b|budget)/i;

function looksLikeBudget(text) {
  return BUDGETISH.test(String(text || ''));
}

// Returns the UPPER bound of whatever the person stated, or null. A range like
// "8-10 lakh" resolves to 1,000,000: the benefit of the doubt goes to the lead.
// `bareUnit` is applied to unit-less numbers (a lone "8" when we just asked for
// a budget means 8 lakh in INR).
function parseAmount(text, { bareUnit = 1e5, allowBare = false } = {}) {
  let t = String(text || '').toLowerCase().replace(/(\d),(?=\d)/g, '$1');
  const re = /(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|thousand|million|mn|l|k|m)?(?![a-z])/g;
  const hasCurrency = /(₹|\brs\b|\binr\b|\$|\busd\b)/i.test(t);
  allowBare = allowBare || hasCurrency;
  const found = [];
  let m;
  while ((m = re.exec(t))) found.push({ n: parseFloat(m[1]), unit: m[2] || null });
  if (!found.length) return null;
  const trailingUnit = [...found].reverse().find((f) => f.unit);
  let best = null;
  for (const f of found) {
    let mult;
    if (f.unit) mult = UNIT[f.unit];
    else if (trailingUnit) mult = UNIT[trailingUnit.unit];
    else if (allowBare) mult = f.n < 1000 ? bareUnit : 1;
    else continue;
    const v = f.n * mult;
    if (best === null || v > best) best = v;
  }
  return best;
}

function formatMoney(amount, currency = 'INR') {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return 'unknown';
  const a = Number(amount);
  if (currency === 'INR') {
    if (a >= 1e7) return `₹${trim(a / 1e7)}Cr`;
    if (a >= 1e5) return `₹${trim(a / 1e5)}L`;
    if (a >= 1e3) return `₹${trim(a / 1e3)}k`;
    return `₹${a}`;
  }
  const sym = { USD: '$', EUR: '€', GBP: '£', AED: 'AED ' }[currency] || `${currency} `;
  if (a >= 1e6) return `${sym}${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sym}${trim(a / 1e3)}k`;
  return `${sym}${a}`;
}
const trim = (n) => String(Math.round(n * 100) / 100);

module.exports = { parseAmount, formatMoney, looksLikeBudget };
