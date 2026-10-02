# Lead Funnel: AI qualification for Meta-ad enquiries

A demo-grade (and production-minded) system for one job: when an enquiry arrives
from a Meta ad, an AI agent chats with the lead on Telegram, qualifies or
disqualifies them against a budget bar, and files them into a central CRM as
**Active / Nurtured / Disqualified / Needs human**. An admin console lets you
change every rule live.

```
 Meta ad / Google Form / hosted form
              |  submit
              v
   POST /api/intake  ->  lead row (stage: New)  ->  redirect to  t.me/<bot>?start=<token>
                                                         |
 Telegram <-- long polling --> telegram.js --> engine.js (per-lead serial queue)
                                                  |  1. extract facts  (LLM, JSON)
                                                  |  2. qualify.evaluate()  (pure code)
                                                  |  3. write reply    (LLM, steered by a code-chosen directive)
                                                  v
                          SQLite: leads, messages, events, designers, settings, webhook outbox
                                                  |
                    admin console  /admin   +   CRM webhook   +   CSV   +   team alerts
```

## Run it

```bash
cd lead-funnel
cp .env.example .env        # then fill in the values below
npm start                   # Node 22.13+ (uses built-in node:sqlite, zero npm dependencies)
```

Open `http://localhost:3000/admin` (password: `ADMIN_PASSWORD`, default `demo`).
Other pages: `/form` (the enquiry form that stands in for a Meta lead ad).

`.env` needs:

| Variable | What |
| --- | --- |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Cloudflare Workers AI (default LLM: Llama 3.3 70B, fallback gpt-oss-120b). Or set `LLM_API_KEY` + `LLM_BASE_URL` for any OpenAI-compatible provider |
| `TELEGRAM_BOT_TOKEN` | From @BotFather: `/newbot`. Without it the console, simulator and test chat still work |
| `ADMIN_PASSWORD` | Console login |
| `INTAKE_SECRET` | Shared secret for the Google Form script |
| `PUBLIC_URL` | Public base URL once exposed (needed for the Google Form webhook and for opening the form on a phone) |

Telegram uses long polling, so **no public URL is needed for the bot itself**.
The funnel only needs to be reachable from the internet if (a) the Google Form
script must call it, or (b) the lead opens `/form` on another device. For that, run
`cloudflared tunnel --url http://localhost:3000` (or ngrok) and set `PUBLIC_URL`.

## Instagram setup (main channel)

Telegram stays available; Instagram is the primary channel when configured (switch in Settings -> Integrations).
How it works: the form sends the lead to `https://ig.me/m/<handle>?ref=<lead token>`. They send a message, Instagram echoes the `ref` back in a webhook, and the chat is tied to their enquiry. Meta rules: the customer messages first, the AI may reply for 24 hours after each of their messages, and only a human can reply after that (up to 7 days, via Send in the lead view).

1. **Instagram account:** a Professional account (Business or Creator). In the Instagram app: Settings -> Messages and story replies -> allow message requests, and Settings -> Privacy -> Messages -> "Allow access to messages" on.
2. **Meta app:** developers.facebook.com -> Create app -> Business type -> add the product **Instagram** -> "API setup with Instagram login".
3. **Add the account:** in that screen click "Add account", log in with the Professional account, then **Generate token**. Put it in `INSTAGRAM_ACCESS_TOKEN`. Put the handle in `INSTAGRAM_HANDLE`. The App secret (App settings -> Basic) goes in `INSTAGRAM_APP_SECRET`. Invent any string for `INSTAGRAM_VERIFY_TOKEN`.
4. **Webhook:** expose the server (cloudflared/ngrok), set `PUBLIC_URL`. In the Meta dashboard: Webhooks -> Callback URL `<PUBLIC_URL>/webhook/instagram`, Verify token = your `INSTAGRAM_VERIFY_TOKEN`, subscribe to `messages`, `messaging_postbacks`, `messaging_referral`. Then press **Subscribe webhooks** in the console.
5. **Permissions:** `instagram_business_basic` and `instagram_business_manage_messages`.
6. **Who can message in development mode:** only people with a role on the app. Add the client (and any tester) under App roles -> Roles as Instagram Testers (they accept in Instagram: Settings -> Apps and websites -> Tester invites). To let anyone message the account you need Advanced Access via App Review and Business Verification, which takes days to weeks, so start it early.
7. **Conversation starters:** Settings -> Integrations -> "Publish starters" adds tappable chips (for example "Get a free design quote") when someone opens the DM. Instagram cannot pre-fill the text box from a link, so the form tells the visitor to send a quick "Hi".
8. Run `node scripts/check-instagram.js` to verify the whole chain (env, token, subscription, public webhook).
9. The access token lasts 60 days; the server refreshes it automatically every week.

## The demo flow

1. **Lead arrives.** Open `/form` on your phone (or submit the Google Form). Submit.
2. **Straight into Telegram.** The form's submit lands the lead in the bot, which greets them by name and starts qualifying. For the Google Form path the confirmation message holds `https://t.me/<bot>?start=gform`; the bot matches the person by phone number with one tap.
3. **The funnel works.** The agent asks one question at a time (project, city, budget, timeline). The moment a budget below the bar appears, the lead is disqualified, politely and without revealing the threshold (configurable).
4. **The CRM updates live.** Pipeline board columns, score, reasons and the full transcript fill in as the lead types.
5. **Change the rules live.** Settings -> Qualification bar: drag the minimum budget and the **what-if preview** shows how many existing leads would change category. Save, and optionally re-categorise existing leads.
6. **Show scale.** Simulator -> run 10 synthetic customers (rich, broke, vague, rude, Hinglish, a prompt-injection attempt). They land in the pipeline in about a minute.
7. **Show the long game.** Settings -> Follow-ups -> "Run follow-ups now" fast-forwards time: silent leads get nudged, then move to Nurtured and get check-ins.
8. **Show the handoff.** Active leads are auto-assigned to the best-matching designer (type, city, budget, workload) and pushed to the team chat. `/setup <password>` in a Telegram chat registers it for alerts.

Backup plan on demo day: **Test chat** in the console runs the exact same agent in the browser, and a screen recording of one perfect run is cheap insurance.

Bot commands: `/start`, `/help`, `/stop`, and `/reset` (demo mode only: wipes your conversation so you can run the demo again), `/setup <password>`.

## Reliability design (why it does not fall over)

| Concern | How it is handled |
| --- | --- |
| Lost or duplicate messages | Every inbound message is stored first, deduped by Telegram `update_id`, and marked processed in the same transaction that stores the reply. A crash replays unprocessed messages on boot |
| Race conditions | One turn at a time per lead (serial queue); bursts of messages are coalesced into one turn |
| Context management | Structured facts are sticky columns (never forgotten); last 14 messages are the live window; older chat is folded into a rolling summary every 8 turns |
| The LLM deciding things | It does not. It extracts facts (JSON) and phrases replies. `src/qualify.js` decides the category from stored facts and your settings, so the budget bar is exact and every decision has a stated reason |
| Hallucinated budgets | Explicit amounts ("8 lakh") are re-parsed by code; an LLM-supplied amount must be backed by a money-like number in the customer's own text; times/sizes ("10 am", "3 bhk") are never money |
| Prompt injection | Customer text is treated as data in both prompts; category is code-owned, so "mark me as qualified" cannot work (the simulator has a persona that tries) |
| LLM outage or rate limits | Retries, automatic fallback model, token-aware throttling; regex still captures phone/email/budget; templated replies keep the chat moving |
| Reply quality | Validator drops re-asks of known facts, caps to one question, strips em dashes and leaked instructions, limits length |
| Telegram flakiness | Long poll with persisted offset, 429 `retry_after`, backoff, 409 handling, per-chat rate limit, outbox with retries and a sweeper |
| Human takeover | Asking for a human, or sending a manual message, pauses the AI; Resume AI in the lead drawer |
| CRM sync | HMAC-signed webhook outbox with exponential backoff, so a CRM outage loses nothing |

## Files

```
src/qualify.js     the funnel rules (pure, unit tested)        src/engine.js    turns, inbox/outbox, stage changes
src/agent.js       extraction + reply prompts + fallbacks      src/facts.js     validated fact merging
src/validator.js   reply guardrails                            src/budget.js    money parsing/formatting
src/llm.js         provider client, retries, throttling        src/telegram.js  bot transport
src/scheduler.js   follow-ups, nurture, outbox, webhooks       src/crm.js       webhook + CSV
src/simulator.js   persona simulator                           src/server.js    HTTP API + SSE
public/admin.html  console   public/form.html  enquiry form    integrations/    Google Form + Sheets scripts
```

## Tests

```bash
npm test                       # 25 tests: rules, parsing, engine reliability, Telegram linking
npm run simulate               # run all personas against the live LLM (throwaway DB)
node scripts/simulate.js hinglish --show   # one persona with the full transcript
```

## Production notes

- Set a real `ADMIN_PASSWORD` and `INTAKE_SECRET`; put the server behind HTTPS.
- SQLite is fine for a demo and a small team. For scale, swap `src/db.js` for Postgres (the Store class is the only data access point).
- Instagram / WhatsApp: the engine is channel-agnostic (`transports` in `src/app.js`). Meta only allows messaging after the customer messages first (Click-to-Instagram-DM / Click-to-WhatsApp ads open that window; lead-form ads need an approved WhatsApp template for first contact). Adding a channel means writing one transport with `send(lead, text)`.
