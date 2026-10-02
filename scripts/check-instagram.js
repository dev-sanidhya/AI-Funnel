'use strict';
// Verifies the Instagram setup end to end:  node scripts/check-instagram.js
// Checks .env values, the access token, the webhook subscription, and that the
// public webhook URL answers Meta's verification handshake.
const config = require('../src/config');
const { Store } = require('../src/db');
const { Instagram } = require('../src/instagram');

const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); failed++; };
let failed = 0;

(async () => {
  const c = config.instagram;
  console.log('Instagram setup check\n');
  console.log('Environment');
  c.accessToken ? ok('INSTAGRAM_ACCESS_TOKEN is set') : bad('INSTAGRAM_ACCESS_TOKEN is missing');
  c.appSecret ? ok('INSTAGRAM_APP_SECRET is set') : bad('INSTAGRAM_APP_SECRET is missing (webhooks will be rejected)');
  c.verifyToken ? ok('INSTAGRAM_VERIFY_TOKEN is set') : bad('INSTAGRAM_VERIFY_TOKEN is missing');
  c.handle ? ok(`INSTAGRAM_HANDLE = @${c.handle}`) : bad('INSTAGRAM_HANDLE is missing');
  /^https:\/\//.test(config.publicUrl) ? ok(`PUBLIC_URL = ${config.publicUrl}`) : bad(`PUBLIC_URL is ${config.publicUrl}; Meta needs a public https URL`);

  const ig = new Instagram({ cfg: c, engine: null, store: new Store(':memory:'), config, log: { log() {}, warn() {}, error() {} } });
  if (c.accessToken) {
    console.log('\nAccess token');
    try {
      const me = await ig.api('GET', '/me', { query: { fields: 'user_id,username,account_type' } }, { retries: 1 });
      ok(`token works: @${me.username} (${me.account_type || 'account'}, id ${me.user_id})`);
      if (c.handle && me.username && me.username.toLowerCase() !== c.handle.toLowerCase()) bad(`token belongs to @${me.username} but INSTAGRAM_HANDLE is @${c.handle}`);
      if (me.account_type && !/BUSINESS|MEDIA_CREATOR/i.test(me.account_type)) bad('account is not a Professional (Business/Creator) account');
      console.log('\nWebhook subscription');
      try {
        const subs = await ig.api('GET', `/${me.user_id}/subscribed_apps`, {}, { retries: 1 });
        const fields = ((subs.data && subs.data[0] && subs.data[0].subscribed_fields) || []).join(', ');
        fields ? ok(`subscribed to: ${fields}`) : bad('no subscribed fields. Run "Subscribe webhooks" in the console (Settings -> Integrations)');
      } catch (e) { bad(`could not read subscriptions: ${e.message}`); }
    } catch (e) { bad(`token check failed: ${e.message}`); }
  }

  console.log('\nPublic webhook');
  try {
    const url = `${config.publicUrl}/webhook/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(c.verifyToken)}&hub.challenge=ping123`;
    const res = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' } });
    const text = await res.text();
    res.ok && text === 'ping123' ? ok('webhook URL answers the verification handshake') : bad(`webhook returned ${res.status}: ${text.slice(0, 80)} (is the server running with the same .env?)`);
  } catch (e) { bad(`could not reach ${config.publicUrl}: ${e.message}`); }

  console.log(failed ? `\n${failed} problem(s) to fix.` : '\nAll good: Instagram is ready.');
  process.exit(failed ? 1 : 0);
})();
