/**
 * Lead Funnel -> Google Sheet (optional CRM mirror)
 *
 * Deploy as a Web app (Deploy -> New deployment -> Web app, access: Anyone),
 * then paste the web app URL into the funnel console under
 * Settings -> Integrations -> CRM sync (webhook).
 *
 * Every lead create / update / category change appends or updates a row, keyed
 * by lead id, so the sheet always shows the current state of the pipeline.
 */
var HEADERS = ['id', 'name', 'phone', 'email', 'telegram', 'source', 'campaign', 'stage', 'stage_reason', 'score',
  'project_type', 'city', 'budget_amount', 'timeline', 'designer', 'notes', 'updated_at'];

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var d = body.data;
  if (!d || !d.id) return ContentService.createTextOutput('ignored');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  var row = [d.id, d.name, d.phone, d.email, d.telegram, d.source, d.campaign, d.stage, d.stage_reason, d.score,
    d.project_type, d.city, d.budget_amount, d.timeline_text || d.timeline_months, d.designer, d.notes,
    new Date(d.updated_at)];
  var ids = sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === d.id) {
      sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
      return ContentService.createTextOutput('updated');
    }
  }
  sheet.appendRow(row);
  return ContentService.createTextOutput('created');
}
