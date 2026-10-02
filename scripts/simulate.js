'use strict';
// CLI: run the persona simulator against the live LLM using a throwaway DB.
//   node scripts/simulate.js [personaId ...] [--show] [--min=500000]
const config = require('../src/config');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const { formatMoney } = require('../src/budget');

const args = process.argv.slice(2);
const show = args.includes('--show');
const minArg = args.find((a) => a.startsWith('--min='));
const ids = args.filter((a) => !a.startsWith('--'));

(async () => {
  const app = createApp(config, { store: new Store(':memory:'), debounceMs: 0 });
  if (!app.llm.enabled) { console.error('No LLM key configured (set LLM_API_KEY or GROQ_API_KEY).'); process.exit(1); }
  if (minArg) app.settings.update({ qualification: { min_budget: Number(minArg.split('=')[1]) } });
  const t0 = Date.now();
  await app.simulator.run({ personaIds: ids, concurrency: 3 });
  while (app.simulator.state.running) await new Promise((r) => setTimeout(r, 500));
  const cur = app.settings.get().qualification.currency;
  for (const r of app.simulator.state.runs) {
    const lead = app.store.getLead(r.leadId);
    console.log(`\n${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(24)} -> ${String(r.stage).padEnd(13)} (expected ${r.expected})  turns=${r.turns}  budget=${lead.budget_amount != null ? formatMoney(lead.budget_amount, cur) : '-'}  city=${lead.city || '-'}  timeline=${lead.timeline_text || lead.timeline_months || '-'}`);
    console.log(`      why: ${lead.stage_reason}${r.error ? `  ERROR: ${r.error}` : ''}`);
    if (show) for (const m of app.store.getMessages(r.leadId)) console.log(`      ${m.direction === 'in' ? 'USER' : ' BOT'}: ${m.text}`);
  }
  const pass = app.simulator.state.runs.filter((r) => r.ok).length;
  console.log(`\n${pass}/${app.simulator.state.runs.length} matched expectations in ${((Date.now() - t0) / 1000).toFixed(1)}s | llm calls=${app.llm.stats.calls} failures=${app.llm.stats.failures} fallbacks=${app.llm.stats.fallbacks}`);
  process.exit(0);
})();
