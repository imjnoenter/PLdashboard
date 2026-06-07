/**
 * Mulan P&L — Google Apps Script backend
 *
 * Deploy this bound to your "Mulan" Google Sheet as a Web App
 * ("Execute as: Me", "Who has access: Anyone"). The deployed
 * URL goes into CONFIG.APPS_SCRIPT_URL in app.js.
 *
 * Sheet layout (created automatically on first run if missing):
 *   "Entries" tab: Date (YYYY-MM-DD) | DailyPnL   — one row per day, USD
 *   "Goals"   tab: Month (YYYY-MM)   | Goal       — one row per month, USD
 */

// Set this to whatever secret PIN you want to gate the app with.
// The app's PIN screen must match this value exactly.
const PIN = 'CHANGE_ME';

const ENTRIES_SHEET = 'Entries';
const GOALS_SHEET = 'Goals';

function doGet(e) {
  try {
    const action = e.parameter.action;
    checkPin(e.parameter.pin);

    if (action === 'getData') {
      return jsonResponse({ ok: true, entries: readEntries(), goals: readGoals() });
    }
    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkPin(body.pin);

    if (body.action === 'upsertEntry') {
      upsertEntry(body.payload.date, body.payload.pnl);
      return jsonResponse({ ok: true });
    }
    if (body.action === 'upsertGoal') {
      upsertGoal(body.payload.month, body.payload.goal);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) });
  }
}

function checkPin(pin) {
  if (pin !== PIN) throw new Error('Invalid PIN');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ===== Sheet access ===== */

function getSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    // Keep column A as plain text so Sheets never auto-converts our
    // "yyyy-MM-dd"/"yyyy-MM" strings into Date values (which round-trip
    // through a timezone and can shift to the wrong calendar day).
    sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  }
  return sheet;
}

function entriesSheet() { return getSheet(ENTRIES_SHEET, ['Date', 'DailyPnL']); }
function goalsSheet() { return getSheet(GOALS_SHEET, ['Month', 'Goal']); }

function readEntries() {
  const sheet = entriesSheet();
  const rows = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const date = formatCellDate(rows[i][0]);
    const pnl = rows[i][1];
    if (date && pnl !== '' && pnl !== null) out.push({ date: date, pnl: Number(pnl) });
  }
  return out;
}

function readGoals() {
  const sheet = goalsSheet();
  const rows = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const month = formatCellMonth(rows[i][0]);
    const goal = rows[i][1];
    if (month && goal !== '' && goal !== null) out.push({ month: month, goal: Number(goal) });
  }
  return out;
}

function upsertEntry(date, pnl) {
  const sheet = entriesSheet();
  const rows = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (formatCellDate(rows[i][0]) === date) { rowIndex = i + 1; break; }
  }
  if (pnl === null || pnl === undefined) {
    if (rowIndex > 0) sheet.deleteRow(rowIndex);
    return;
  }
  if (rowIndex > 0) {
    writeDateCell(sheet, rowIndex, 1, date);
    sheet.getRange(rowIndex, 2).setValue(pnl);
  } else {
    const newRow = sheet.getLastRow() + 1;
    writeDateCell(sheet, newRow, 1, date);
    sheet.getRange(newRow, 2).setValue(pnl);
  }
}

function upsertGoal(month, goal) {
  const sheet = goalsSheet();
  const rows = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (formatCellMonth(rows[i][0]) === month) { rowIndex = i + 1; break; }
  }
  if (goal === null || goal === undefined) {
    if (rowIndex > 0) sheet.deleteRow(rowIndex);
    return;
  }
  if (rowIndex > 0) {
    writeDateCell(sheet, rowIndex, 1, month);
    sheet.getRange(rowIndex, 2).setValue(goal);
  } else {
    const newRow = sheet.getLastRow() + 1;
    writeDateCell(sheet, newRow, 1, month);
    sheet.getRange(newRow, 2).setValue(goal);
  }
}

/**
 * Writes a date/month KEY into a cell as PLAIN TEXT so Google Sheets never
 * auto-converts the "yyyy-MM-dd" / "yyyy-MM" string into an internal Date
 * value. A Date value would round-trip through a timezone on the next read
 * (getValues + Utilities.formatDate) and can land on the wrong calendar day,
 * which makes the re-read key no longer match the client's isoDate() lookup
 * key — so the saved row silently fails to render after a reload. Setting the
 * cell format to '@' (plain text) BEFORE writing keeps the literal string.
 */
function writeDateCell(sheet, row, col, text) {
  const cell = sheet.getRange(row, col);
  cell.setNumberFormat('@');
  cell.setValue(text);
}

/* ===== Cell formatting helpers (handles both text and Date-typed cells) ===== */

function formatCellDate(value) {
  if (value instanceof Date) {
    // Use the SPREADSHEET's timezone, not the script project's — Sheets
    // auto-converts a typed-in "yyyy-MM-dd" string into a Date using its own
    // timezone, and reformatting with a different timezone can shift the
    // calendar day by one, breaking the lookup key the app expects.
    return Utilities.formatDate(value, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

function formatCellMonth(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM');
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
  return null;
}
