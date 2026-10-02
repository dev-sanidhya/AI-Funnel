'use strict';
// "Needs you now": the single place that decides which leads the owner must
// act on, and why. Used by the dashboard, the scheduler and the team alerts so
// they can never disagree.

const { formatWhen } = require('./when');

const HOUR = 3600000;
const MIN = 60000;

// Can the AI still message this lead? Instagram only allows replies within 24h of
// the customer's last message; the margin keeps us from racing the deadline.
function windowOpen(lead, now = Date.now(), marginMs = HOUR) {
  if (lead.channel !== 'instagram') return true;
  if (!lead.last_inbound_at) return false;
  return now - lead.last_inbound_at < 24 * HOUR - marginMs;
}

// Hours left in the messaging window (Instagram only), or null if there is no window.
function windowHoursLeft(lead, now = Date.now()) {
  if (lead.channel !== 'instagram' || !lead.last_inbound_at) return null;
  return Math.max(0, (24 * HOUR - (now - lead.last_inbound_at)) / HOUR);
}

// Returns a list of { level: 'urgent' | 'soon', kind, title, detail, due_at }, most important first.
function attentionFor(lead, settings, now = Date.now()) {
  const meta = lead.meta || {};
  const fu = meta.fu || {};
  const flags = meta.flags || {};
  const tz = settings.business.timezone || 'Asia/Kolkata';
  const f = settings.followups;
  const items = [];
  if (fu.snooze_until && fu.snooze_until > now) return items;
  if (lead.stage === 'disqualified' && !flags.wants_human) return items;
  const noPhone = !lead.phone && !lead.email;

  if (flags.wants_human && !fu.human_done_at) {
    items.push({ level: 'urgent', kind: 'human', title: 'Asked to talk to a person', detail: 'They want a human to take over this chat.', due_at: lead.last_inbound_at || null });
  } else if (lead.ai_paused && (lead.last_inbound_at || 0) > (lead.last_outbound_at || 0)) {
    items.push({ level: 'urgent', kind: 'reply', title: 'Waiting for your reply', detail: 'The assistant is paused on this chat and they have written back.', due_at: lead.last_inbound_at });
  }

  if (lead.callback_at && lead.callback_status === 'scheduled' && !fu.done_at) {
    const when = formatWhen(lead.callback_at, tz, now);
    const overdueAt = lead.callback_at + (f.overdue_after_min || 30) * MIN;
    if (now > overdueAt) {
      items.push({ level: 'urgent', kind: 'call_overdue', title: `Call was due ${when}`, detail: `Has this call happened? Mark it done, or reschedule.${noPhone ? ' No phone number yet, message them first.' : ''}`, due_at: lead.callback_at });
    } else if (now >= lead.callback_at - 2 * HOUR) {
      items.push({ level: 'soon', kind: 'call_soon', title: `Call ${when}`, detail: noPhone ? 'No phone number yet.' : 'Coming up shortly.', due_at: lead.callback_at });
    }
  }

  if (fu.manual_needed_at && !fu.manual_done_at && !fu.done_at) {
    items.push({ level: 'urgent', kind: 'manual', title: 'Follow up by hand', detail: fu.manual_reason || 'The assistant cannot message this person any more.', due_at: fu.manual_needed_at });
  }

  if (lead.stage === 'active' && !lead.callback_at && !fu.done_at && lead.qualified_at && now - lead.qualified_at > 2 * HOUR) {
    items.push({ level: 'soon', kind: 'no_time', title: 'No call time agreed yet', detail: lead.callback_text ? `They said: "${lead.callback_text}".` : 'Ask when they would like the call.', due_at: lead.qualified_at });
  }

  const order = { urgent: 0, soon: 1 };
  return items.sort((a, b) => order[a.level] - order[b.level] || (a.due_at || 0) - (b.due_at || 0));
}

// A plain-language brief for the designer, built only from what the customer said.
function briefFor(lead, settings, now = Date.now()) {
  const tz = settings.business.timezone || 'Asia/Kolkata';
  const cur = settings.qualification.currency;
  const { formatMoney } = require('./budget');
  const bits = [];
  const what = [lead.scope, lead.project_type].filter(Boolean)[0];
  if (what) bits.push(`Wants ${String(what).replace(/^wants /i, '')}`);
  if (lead.property) bits.push(`for a ${lead.property}`);
  if (lead.city) bits.push(`in ${lead.city}`);
  let s = bits.join(' ');
  const more = [];
  if (lead.budget_amount != null) more.push(`budget about ${formatMoney(lead.budget_amount, cur)}`);
  // "we want to start in 2 months" reads badly after "wants to start", so keep only the timing part.
  const when = String(lead.timeline_text || '').replace(/^(we |i )?(want|would like|plan|hope|aim)( to)? ?(start|begin|move in)?(ing)? ?/i, '').replace(/^to /i, '').trim();
  if (when || lead.timeline_months != null) more.push(`wants to start ${when || (lead.timeline_months === 0 ? 'right away' : `in ${lead.timeline_months} months`)}`);
  if (lead.style) more.push(`style: ${lead.style}`);
  if (more.length) s += `${s ? '. ' : ''}${more.join(', ').replace(/^./, (c) => c.toUpperCase())}`;
  const tail = [];
  if (lead.callback_at) tail.push(`Call booked ${formatWhen(lead.callback_at, tz, now)}.`);
  else if (lead.callback_text) tail.push(`Would like a call: "${lead.callback_text}" (no exact time yet).`);
  if (lead.contact_pref) tail.push(`Best time to reach: ${lead.contact_pref}.`);
  tail.push(lead.phone ? `Phone: ${lead.phone}.` : 'No phone number yet.');
  return `${s ? `${s}. ` : ''}${tail.join(' ')}`.replace(/\.\./g, '.').trim();
}

module.exports = { attentionFor, briefFor, windowOpen, windowHoursLeft };
