/**
 * UTG Labs quiz-lead logger
 * =========================
 * Paste this whole file into the Apps Script editor of your lead-tracking
 * Google Sheet (Extensions -> Apps Script), then deploy as a web app so it
 * can be called from the Netlify function.
 *
 * How to deploy (one-time):
 *   1. Open the Google Sheet that will hold leads.
 *   2. Extensions -> Apps Script. Delete the default function, paste this file
 *      in, Save.
 *   3. Deploy -> New deployment -> type "Web app".
 *      - Execute as: "Me"
 *      - Who has access: "Anyone"   <- required, so the Netlify function can
 *        call it without a login. It only appends a row, it cannot read or
 *        delete, so the exposure is minimal.
 *   4. Copy the /exec web app URL. Put it in Netlify as the env var
 *      LEAD_SHEET_URL (see below).
 *
 * The web app URL must be created inside the Apps Script bound to the sheet
 * you want to receive leads.
 */

function doPost(e) {
  // Signature lets us tell a real attempt apart from a stray GET/OPTIONS.
  if (!e || !e.postData || !e.postData.contents) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'no body' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = getLeadSheet_();
  var data = JSON.parse(e.postData.contents);

  // Order must match the columns you set up in the sheet's first row.
  // Edit the column list here and update the spreadsheet header to match.
  var headers = [
    'timestamp',   // when the row was logged
    'first_name',
    'tier',
    'email',
    'business_type',
    'deals_per_month',
    'avg_deal_size',
    'reply_speed',
    'inbound_handling',
    'bottleneck',
    'value_anchor'
  ];

  if (sheet.getLastRow() === 0) {
    // First run: write the header row so the columns are labelled.
    sheet.appendRow(headers);
  }

  var row = headers.map(function (key) {
    if (key === 'timestamp') return new Date().toISOString();
    var v = data[key];
    // Everything from the page is a string; guard against anything else.
    return typeof v === 'string' ? v : (v == null ? '' : String(v));
  });

  sheet.appendRow(row);

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getLeadSheet_() {
  // Uses this spreadsheet's first sheet. Swap getSheets()[0] for a named one,
  // e.g. getSheetByName('Leads'), if you keep leads on a specific tab.
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

// Dry-run test: in the Apps Script editor pick this function and hit Run.
// It writes a row locally so you can confirm the sheet is wired correctly.
function testAppend() {
  var payload = {
    first_name: 'Test Lead',
    tier: 'SOLO',
    email: 'test@example.com',
    business_type: 'Cleaning',
    deals_per_month: '0-5',
    avg_deal_size: '$500-$2,000',
    reply_speed: 'Hours',
    inbound_handling: 'Me',
    bottleneck: 'Nights/weekends',
    value_anchor: '$1,000'
  };
  var fake = { postData: { contents: JSON.stringify(payload) } };
  var out = doPost(fake);
  Logger.log(out.getContent());
}
