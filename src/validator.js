'use strict';
// Last line of defence between the model's draft and the customer. Prompts ask
// nicely; this enforces: no re-asking for known facts, at most one question, no
// em dashes, no leaked instructions, bounded length. An empty return means "use
// the deterministic fallback".

const DASHES = /\s*[‒–—―]\s*/g;
const LEAK = /(system prompt|my instructions|directive|mandatory|as an ai language model|<\/?json>|stage_reason|internal categor)/i;

const ASKS = {
  name: /\b(your name|may i (?:get|have|know) your name|what'?s your name|who am i (?:speaking|talking) (?:with|to))\b/i,
  contact: /\b(phone( number)?|contact (number|info)|email( address)?|whatsapp number|reach you)\b/i,
  city: /\b(which (city|area|location)|what (city|area|location)|where (is|are) (the|your) (project|property|home|site|space)|location of)\b/i,
  budget: /\b(budget|how much (are you|do you)|spend)\b/i,
  timeline: /\b(when (are|do|would) you|timeline|how soon|move[- ]in|start date)\b/i,
  project_type: /\b(what (kind|type) of (space|project)|which (space|room|type)|type of (space|project))\b/i,
};

function splitSentences(text) {
  return String(text).match(/[^.!?\n]+[.!?]*(?:\s+|$)|\n+/g)?.map((s) => s.trim()).filter(Boolean) || [];
}

function isQuestion(s) { return /\?\s*$/.test(s) || /\b(please (share|tell|let me know)|could you (share|tell)|can you (share|tell))\b/i.test(s); }

function reasksKnown(sentence, lead) {
  if (!isQuestion(sentence)) return false;
  if (lead.name && ASKS.name.test(sentence)) return true;
  if ((lead.phone || lead.email) && ASKS.contact.test(sentence) && !/\b(best time|good time|call you)\b/i.test(sentence)) return true;
  if (lead.city && ASKS.city.test(sentence)) return true;
  if (lead.budget_amount != null && ASKS.budget.test(sentence)) return true;
  if (lead.timeline_months != null && ASKS.timeline.test(sentence)) return true;
  if (lead.project_type && ASKS.project_type.test(sentence)) return true;
  return false;
}

// opts.maxQuestions: 1 for qualification turns, 0 for closings.
function sanitizeReply(text, lead, { maxQuestions = 1, maxChars = 650 } = {}) {
  if (!text) return '';
  let t = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/,?\s*(?:…|\.\.\.)\s*([)\]])/g, '$1')
    .replace(DASHES, ', ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/,\s*([)\].!?])/g, '$1')
    .replace(/\(\s*,\s*/g, '(')
    .replace(/[ \t]{2,}/g, ' ');
  if (LEAK.test(t)) return '';
  const kept = [];
  let questions = 0;
  for (const s of splitSentences(t)) {
    if (reasksKnown(s, lead)) continue;
    if (isQuestion(s)) {
      if (questions >= maxQuestions) continue;
      questions++;
    }
    kept.push(s);
  }
  let out = kept.join(' ').replace(/\s+\n/g, '\n').trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const last = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    out = last > 120 ? cut.slice(0, last + 1) : cut;
  }
  return out.trim();
}

module.exports = { sanitizeReply, reasksKnown };
