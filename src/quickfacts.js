'use strict';
// Rule-based fact reader, used ONLY when no AI provider is reachable. It understands the
// common answers (what they want, home size, city, timing) and the message our own form
// writes, so a conversation keeps moving instead of looping on the same question.
// Budgets, phone numbers, emails and call times are handled elsewhere (facts.js).

const MONTH_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const NOT_A_PLACE = /^(yes|no|ok|okay|hi|hello|hey|thanks|thank you|sure|maybe|not sure|idk|a full home|full home|kitchen|office|renovation|home|house|flat|apartment|villa|asap|soon|tomorrow|today)$/i;

function titleCase(s) { return s.replace(/\b([a-z])([a-z]*)/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase()); }

function quickFacts(text, lastAsked, settings) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const out = { refused: [] };
  const types = settings.qualification.project_types;
  const pickType = (name) => (types.includes(name) ? name : types.includes('Other') ? 'Other' : name);

  // What they want
  const scope = [];
  if (/\b(full|whole|complete|entire)\b.{0,12}\b(home|house|flat|apartment|interior)/.test(lower) || /\bhome interiors?\b/.test(lower) || /\bfull\s*ho[a-z]{1,2}\b/.test(lower)) scope.push('full home interiors');
  if (/\bkitchen/.test(lower)) scope.push('modular kitchen');
  if (/\bwardrobe/.test(lower)) scope.push('wardrobes');
  if (/\bliving room/.test(lower)) scope.push('living room');
  if (/\bbedroom/.test(lower)) scope.push('bedrooms');
  if (/\bbathroom|\btoilet/.test(lower)) scope.push('bathrooms');
  if (scope.length) out.scope = scope.join(', ');
  if (/\b(full|whole|complete|entire)\b.{0,12}\b(home|house|flat|apartment|interior)|\bhome interiors?\b|\bfull\s*ho[a-z]{1,2}\b/.test(lower)) out.project_type = pickType('Full home');
  else if (/\bkitchen|\bwardrobe/.test(lower)) out.project_type = pickType('Modular kitchen');
  else if (/\boffice|\bcommercial|\bshop\b|\bshowroom|\bclinic/.test(lower)) out.project_type = pickType('Office');
  else if (/\brenovat|\bremodel|\brefresh|\bredo\b/.test(lower)) out.project_type = pickType('Renovation');
  else if (lastAsked === 'project_type' && /\b(home|house|flat|apartment|villa|interior)/.test(lower)) out.project_type = pickType('Full home');

  // Their home: "3BHK", "2 bhk apartment", "1450 sq ft"
  const bhk = lower.match(/\b(\d)\s*-?\s*bhk\b/);
  const sqft = lower.match(/\b(\d[\d,]{2,5})\s*(?:sq\.?\s*ft|sqft|square feet)/);
  const kind = (lower.match(/\b(apartment|flat|villa|independent house|bungalow|penthouse|office|shop)\b/) || [])[1];
  const prop = [bhk ? `${bhk[1]}BHK` : '', kind || ''].filter(Boolean).join(' ');
  if (prop || sqft) out.property = [prop, sqft ? `${sqft[1].replace(/,/g, '')} sq ft` : ''].filter(Boolean).join(', ');

  // City: "in Rohini, Delhi." as the form writes it, or a short bare answer when we just asked
  const inPlace = t.match(/\bin ([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?(?:, ?[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)?)(?=[.,!?]|\s+(?:and|my|with|for|budget|I)\b|$)/);
  if (inPlace) out.city = inPlace[1];
  else if (lastAsked === 'city') {
    const bare = t.trim().replace(/[.!]+$/, '');
    if (/^[A-Za-z][A-Za-z .,'-]{1,40}$/.test(bare) && bare.split(/\s+/).length <= 5 && !NOT_A_PLACE.test(bare)) out.city = titleCase(bare.replace(/^(?:it'?s |its |i(?:'m| am) |we(?:'re| are) |based )?(?:in |at |from )?/i, ''));
  }

  // When they want to start
  const setTl = (months, phrase) => { out.timeline_months = months; out.timeline_text = phrase; };
  let m;
  if ((m = lower.match(/\b(?:asap|as soon as possible|immediately|right away|right now|this week|urgent(?:ly)?)\b/))) setTl(0, m[0]);
  else if ((m = lower.match(/\b(?:within|in|after|by|about|around)?\s*(?:the next |next )?(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|\d+(?:\.\d+)?)\s*(months?|weeks?|days?)\b/))) {
    const n = MONTH_WORDS[m[1]] ?? parseFloat(m[1]);
    const months = /^week/.test(m[2]) ? n / 4.3 : /^day/.test(m[2]) ? n / 30 : n;
    if (Number.isFinite(months) && months <= 36) setTl(Math.round(months * 10) / 10, m[0].trim());
  } else if ((m = lower.match(/\b(?:this|next) month\b/))) setTl(1, m[0]);
  else if ((m = lower.match(/\bnext year\b/))) setTl(12, m[0]);
  else if ((m = lower.match(/\bjust (?:exploring|looking|browsing)\b/))) setTl(12, 'just exploring');
  else if (lastAsked === 'timeline' && (m = lower.match(/\b(soon|few months|couple of months)\b/))) setTl(/soon/.test(m[1]) ? 1 : 3, m[1]);

  const human = /\b(human|real person|talk to someone|speak to someone)\b/i.test(t);
  if (human) out.wants_human = true;
  return out;
}

module.exports = { quickFacts };
