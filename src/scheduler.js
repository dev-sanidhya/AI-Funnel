'use strict';
// Background timers: follow-up nudges for leads who went quiet, nurture
// check-ins, outbox retries and CRM webhook delivery. `force` ignores the
// waiting periods so the admin "Run follow-ups now" button can fast-forward time
// during a demo (each press moves silent leads one step along the sequence).

const { deliverWebhooks } = require('./crm');

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
    const result = { followups: 0, drips: 0, stalled: 0, outbox: 0, webhooks: 0 };
    try {
      result.outbox = await this.engine.sweepOutbox();
      const f = this.settings.get().followups;
      const now = Date.now();
      const MIN = 60000;
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
