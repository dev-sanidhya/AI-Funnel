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

// A number followed by one of these is a time, size or duration, never money.
const NOT_MONEY_NEXT = /^(am|pm|a\.m|p\.m|bhk|bhks|rk|sq|sqft|sqm|ft|feet|floors?|bedrooms?|rooms?|months?|weeks?|days?|years?|yrs?|hours?|hrs?|mins?|st|nd|rd|th|%)(?![a-z])/i;
const NUMBER_WORD = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|dedh|dhai|ek|do|teen|char|paanch|panch|chhe|saat|aath|nau|das)\b/i;
const UNIT_WORD = /\b(lakhs?|lacs?|crores?|thousand|million|k)\b/i;

const BUDGETISH = /(lakh|lac|\bl\b|crore|\bcr\b|\bk\b|thousand|million|\bmn?\b|₹|\brs\b\.?|\binr\b|\$|\busd\b|budget)/i;

function looksLikeBudget(text) {
  return BUDGETISH.test(String(text || ''));
}

// Returns the UPPER bound of whatever the person stated, or null. A range like
// "8-10 lakh" resolves to 1,000,000: the benefit of the doubt goes to the lead.
// `bareUnit` is applied to unit-less numbers (a lone "8" when we just asked for
// a budget means 8 lakh in INR).
function parseAmount(text, { bareUnit = 1e5, allowBare = false } = {}) {
  const t = String(text || '').toLowerCase().replace(/(\d),(?=\d)/g, '$1');
  const re = /(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|thousand|million|mn|l|k|m)?(?![a-z])/g;
  const hasCurrency = /(₹|\brs\b|\binr\b|\$|\busd\b)/i.test(t);
  const bare = allowBare || hasCurrency;
  const found = [];
  let m;
  while ((m = re.exec(t))) {
    const unit = m[2] || null;
    if (!unit && NOT_MONEY_NEXT.test(t.slice(re.lastIndex).trimStart())) continue;
    found.push({ n: parseFloat(m[1]), unit });
  }
  if (!found.length) return null;
  const trailingUnit = [...found].reverse().find((f) => f.unit);
  let best = null;
  for (const f of found) {
    let mult;
    if (f.unit) mult = UNIT[f.unit];
    else if (trailingUnit) mult = UNIT[trailingUnit.unit];
    else if (bare) mult = f.n < 1000 ? bareUnit : 1;
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

// Plain numbers in the text that could be money (excludes times, sizes, durations).
function moneyNumbers(text) {
  const t = String(text || '').toLowerCase().replace(/(\d),(?=\d)/g, '$1');
  const out = [];
  const re = /(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(t))) {
    if (NOT_MONEY_NEXT.test(t.slice(re.lastIndex).trimStart())) continue;
    out.push(parseFloat(m[1]));
  }
  return out;
}

// Guards against hallucinated budgets: an LLM-supplied amount is only trusted when
// the customer's own text contains a money-like number that explains it.
function amountSupportedByText(amount, text) {
  const nums = moneyNumbers(text);
  if (nums.length) {
    return nums.some((n) => [1, 1e3, 1e5, 1e6, 1e7].some((mult) => Math.abs(n * mult - amount) <= Math.max(1, amount * 0.011)));
  }
  return NUMBER_WORD.test(String(text)) && UNIT_WORD.test(String(text));
}

// True when the whole message is just a number or range ("8", "Rs 8,00,000", "8-10").
function isBareNumberAnswer(text) {
  return /^[\s₹$]*(?:rs\.?|inr)?\s*[\d.,]+(?:\s*(?:-|to)\s*[\d.,]+)?\s*(?:rs|inr|only|approx|ish|lakhs?|lacs?|l|cr|k)?[\s.!]*$/i.test(String(text || ''));
}

module.exports = { parseAmount, formatMoney, looksLikeBudget, amountSupportedByText, isBareNumberAnswer };
