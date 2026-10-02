/**
 * Google Form -> Lead Funnel
 *
 * Setup (2 minutes):
 *  1. Open your Google Form -> three dots -> Script editor. Paste this file.
 *  2. Set FUNNEL_URL to your public server, e.g. https://abc.trycloudflare.com
 *     and SECRET to INTAKE_SECRET from the funnel's .env.
 *  3. Triggers (clock icon) -> Add trigger -> function: onFormSubmit,
 *     event source: From form, event type: On form submit. Authorise when asked.
 *  4. In the form: Settings -> Presentation -> Confirmation message, and paste:
 *       Thanks! Tap here to continue on Telegram: https://t.me/YOUR_BOT_USERNAME?start=gform
 *     (the exact link is shown in the console under Settings -> Integrations).
 *
 * The form must contain questions titled (case-insensitive, any of these words):
 *   Name, Phone (or Mobile / WhatsApp), Email, City, Project type (or "looking for"), Notes.
 *
 * How the person is matched to the chat: when they open the bot via the
 * ?start=gform link, the bot asks them to share their number (one tap) or type
 * the phone they used on the form, and links the chat to this enquiry.
 */
var FUNNEL_URL = 'https://YOUR-PUBLIC-URL';
var SECRET = 'change-me';

function onFormSubmit(e) {
  var data = { secret: SECRET, source: 'google-form', campaign: 'google-form-demo' };
  var responses = e.response.getItemResponses();
  for (var i = 0; i < responses.length; i++) {
    var title = responses[i].getItem().getTitle().toLowerCase();
    var answer = String(responses[i].getResponse() || '').trim();
    if (!answer) continue;
    if (/name/.test(title)) data.name = answer;
    else if (/phone|mobile|whatsapp|contact number/.test(title)) data.phone = answer;
    else if (/e-?mail/.test(title)) data.email = answer;
    else if (/city|location|area/.test(title)) data.city = answer;
    else if (/project|looking for|type|service/.test(title)) data.project_type = answer;
    else if (/note|message|detail|comment/.test(title)) data.notes = answer;
  }
  var res = UrlFetchApp.fetch(FUNNEL_URL + '/api/intake/gform', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(data),
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
}
