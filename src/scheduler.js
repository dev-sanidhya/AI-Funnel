'use strict';
// Background timers: follow-up nudges for leads who went quiet, nurture
// check-ins, outbox retries and CRM webhook delivery. `force` ignores the
// waiting periods so the admin "Run follow-ups now" button can fast-forward time
// during a demo (each press moves silent leads one step along the sequence).

const { deliverWebhooks } = require('./crm');
const { windowOpen: windowIsOpen } = require('./attention');

class Scheduler {
  constructor({ engine, store, settings, log = console, tickMs = 15000 }) {
    Object.assign(this, { engine, store, settings, log, tickMs });
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error('[scheduler]', e)), this.tickMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }

  async tick({ force = false, includeSim = false } = {}) {
    if (this.busy) return { skipped: true };
    this.busy = true;
    const result = { followups: 0, drips: 0, stalled: 0, outbox: 0, webhooks: 0, reminders: 0, manual: 0 };
    try {
      result.outbox = await this.engine.sweepOutbox();
      const f = this.settings.get().followups;
      const now = Date.now();
      const MIN = 60000;
      const q = this.settings.get().qualification;
      // Call reminders: the assistant reminds the customer itself while it still can;
      // when it cannot (messaging window closed), the owner is told to do it by hand.
      for (const l of this.store.listLeads({ limit: 2000 })) {
        if (l.channel === 'sim' && !includeSim) continue;
        const fu = l.meta.fu || {};
        if (!l.callback_at || l.callback_status !== 'scheduled' || fu.done_at || fu.reminded_at || fu.manual_needed_at) continue;
        if (l.opted_out || l.stage === 'disqualified') continue;
        const due = force || (now >= l.callback_at - f.reminder_before_min * MIN && now < l.callback_at + f.overdue_after_min * MIN);
        if (!due) continue;
        if (l.chat_id && !l.ai_paused && windowIsOpen(l, now)) { await this.engine.nudge(l.id, 'reminder'); result.reminders++; }
        else {
          const why = !l.chat_id ? 'They have not opened the chat, so the assistant cannot message them.' : l.ai_paused ? 'The assistant is paused on this chat.' : "Their Instagram 24-hour messaging window has closed, so the assistant can no longer message them.";
          this.engine.markManual(l.id, `${why} Call or message them about the booked call.`);
          result.manual++;
        }
      }
      if (f.enabled) {
        const leads = this.store.listLeads({ limit: 2000 });
        for (const l of leads) {
          if (l.channel === 'sim' && !includeSim) continue;
          if (!l.chat_id || l.ai_paused || l.opted_out || l.stage_locked || !l.last_outbound_at) continue;
          const awaiting = (l.last_inbound_at || 0) < l.last_outbound_at;
          // Instagram only lets the AI message within 24h of the customer's last message.
          const windowOpen = l.channel !== 'instagram' || now - (l.last_inbound_at || 0) < 23 * 3600000;
          const sent = l.meta.followups_sent || 0;
          if ((l.stage === 'new' || l.stage === 'qualifying') && awaiting) {
            if (sent < f.max && windowOpen) {
              const wait = (sent === 0 ? f.first_after_min : f.second_after_min) * MIN;
              if (force || now - l.last_outbound_at >= wait) { await this.engine.nudge(l.id, 'followup'); result.followups++; }
            } else if (!(l.meta.flags && l.meta.flags.stalled) && (force || now - l.last_outbound_at >= f.second_after_min * MIN)) {
              const valuable = (l.budget_amount == null || l.budget_amount >= q.min_budget) && l.score >= 30;
              if (!windowIsOpen(l, now) && valuable && sent < f.max) { this.engine.markManual(l.id, 'They went quiet and the Instagram 24-hour window closed before the assistant could follow up. Message or call them yourself.'); result.manual++; }
              this.engine.markStalled(l.id);
              result.stalled++;
            }
          } else if (l.stage === 'nurture' && !l.opted_out) {
            const drips = l.meta.drips_sent || 0;
            if (windowOpen && drips < f.nurture_max && (force || now - l.last_outbound_at >= f.nurture_every_days * 86400000)) {
              await this.engine.nudge(l.id, 'drip');
              result.drips++;
            }
          }
        }
      }
      const hook = await deliverWebhooks(this.store, this.settings, { log: this.log });
      result.webhooks = hook.sent;
    } finally {
      this.busy = false;
    }
    return result;
  }
}

module.exports = { Scheduler };
