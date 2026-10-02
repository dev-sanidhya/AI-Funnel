'use strict';
// Composition root: builds every service and wires them together. Used by the
// server entrypoint, the CLI simulator and the tests.

const { Store } = require('./db');
const { Settings } = require('./settings');
const { Llm } = require('./llm');
const { Agent } = require('./agent');
const { Engine } = require('./engine');
const { Telegram } = require('./telegram');
const { Instagram } = require('./instagram');
const { Scheduler } = require('./scheduler');
const { Simulator } = require('./simulator');

const SEED_DESIGNERS = [
  { name: 'Priya Sharma', title: 'Senior Residential Designer', specialties: 'Full home, Modular kitchen', cities: 'Pune', bio: '12 years of turnkey home interiors.' },
  { name: 'Arjun Nair', title: 'Principal Designer, Commercial', specialties: 'Office', cities: 'Pune, Mumbai', bio: 'Offices, clinics and retail fit-outs.' },
  { name: 'Meera Iyer', title: 'Renovation Specialist', specialties: 'Renovation, Other', cities: '', bio: 'Renovations and design-only consultations.' },
];

function createApp(config, { store, llmOverride, fetchImpl, debounceMs, log = console, seed = true } = {}) {
  store = store || new Store(config.dbPath);
  const settings = new Settings(store);
  const llm = new Llm(config.llm, { fetchImpl });
  if (llmOverride) llm.override = llmOverride;
  const agent = new Agent({ llm });
  const engine = new Engine({
    store, settings, agent, config, log,
    debounceMs: debounceMs === undefined ? 1200 : debounceMs,
    transports: { sim: { send: async () => ({}) } },
  });
  const telegram = new Telegram({ token: config.telegramToken, engine, store, settings, config, log, fetchImpl });
  engine.transports.telegram = telegram.transport;
  const instagram = new Instagram({ cfg: config.instagram, engine, store, config, log, fetchImpl });
  engine.transports.instagram = instagram.transport;
  const scheduler = new Scheduler({ engine, store, settings, log });
  const simulator = new Simulator({ engine, store, settings, llm, log });
  if (seed && !store.listDesigners().length) for (const d of SEED_DESIGNERS) store.saveDesigner(d);
  return { config, store, settings, llm, agent, engine, telegram, instagram, scheduler, simulator };
}

module.exports = { createApp };
