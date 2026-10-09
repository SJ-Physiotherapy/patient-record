/**
 * ==========================================================================
 *  SJ Physiotherapy - PATIENT ASSESSMENT & RECORDS SYSTEM
 *  Backend: Google Apps Script  (acts as the API + database layer)
 *  Database: Google Sheets (this bound spreadsheet)
 *  Sibling app: this reuses the exact architecture, security model, theme
 *  engine and visual language of the SJ Physiotherapy BILLING app - same
 *  clinic, same look, same login pattern - so anyone who already knows
 *  that app will find this one immediately familiar.
 * ==========================================================================
 *  HOW THIS FILE WORKS
 *  - doGet(e)  -> handles read-only requests  (?action=...)
 *  - doPost(e) -> handles normal app requests from the website
 *                 (JSON body: {action, payload, token})
 *  - Run setupDatabase() ONCE from the Apps Script editor to create all
 *    sheets, headers and default rows. See SETUP_GUIDE.md for full steps.
 * ==========================================================================
 *  KEY DESIGN NOTES (read before you touch schema/auth)
 *  - SECURITY: no password is ever cached client-side (not in localStorage,
 *    not in sessionStorage, not anywhere the browser dev-tools / view-source
 *    could read it back). Only an opaque, short-lived session token is kept
 *    in the browser tab's memory. Every sensitive write (saving/editing an
 *    assessment, admin changes) re-verifies real credentials against the
 *    Sheet on the SERVER for that one request only - see requireSession_,
 *    apiVerifyPhysio and requireSuperAdmin_.
 *  - BODY DIAGRAM: pain/radiating points are never saved as an image. They
 *    are saved as a tiny JSON array of {view, x%, y%, type, color}
 *    coordinates in PainMarksJSON, redrawn as dots on top of the clinic's
 *    own reference images wherever the record is shown.
 *  - ROM / MMT / Special Tests / Treatment Goals / Treatment Plan are all
 *    small structured sub-forms stored as one JSON string per cell.
 *  - EDIT AUDIT TRAIL (2026-10): every edit to an existing record must
 *    carry a Reason for Edit. The latest reason is kept in LastEditReason
 *    and the full history (who, when, why, which fields changed) in
 *    EditLog - both appended at the END of the visit sheet, so no existing
 *    column index ever moves.
 *  - SPEED (2026-10): the spreadsheet handle, settings and capacity are
 *    memoized per request and cached across requests; the visit sheet is
 *    read column-by-column (only what each screen needs - never the heavy
 *    ROM/MMT/notes JSON unless the full record is being opened); a single
 *    record is located with a TextFinder instead of scanning every row;
 *    and an edit is written back in ONE call instead of one call per field.
 * ==========================================================================
 */

// ---------------------------------------------------------------------------
// 0. CONFIG
// ---------------------------------------------------------------------------
const SHEET = {
  SETTINGS: 'Settings',
  PHYSIOS: 'Physiotherapists',
  ISSUES: 'IssuesList',
  PATIENTS: 'Patients',
  VISITS: 'Physiotherapy Assessment Form',   // the core data sheet - one row per visit
  CUSTOM_CHARTS: 'CustomCharts',
  UNIVERSAL_REPORT: 'UniversalReport',
  DAILY_REPORT: 'DailyReport',
  DASHBOARD: 'Dashboard'
};

// Bump this string every time you paste updated code into the Apps Script
// editor - the frontend compares it against its own expected value and
// shows an on-screen warning if they don't match, so you can always tell
// whether a NEW DEPLOYMENT actually picked up your latest code (saving the
// file alone does NOT update the live /exec URL - Deploy > Manage
// deployments > pencil icon > Version: New version > Deploy).
const BACKEND_BUILD = 'SJP-PAF-2026-10-09-01';

const REPORT_ROW_CAP = 5000; // sane ceiling so a huge sheet can never hang the Reports screen
const EDIT_REASON_MAX_LEN = 500;
const EDIT_LOG_MAX_ENTRIES = 50;

// Shown when no logo has been configured yet (the old placeholder service,
// via.placeholder.com, has been shut down and now just returns an error).
const DEFAULT_LOGO_URL = 'https://sjphysiotherapy.in/LOGO/favicon.png';

// Fixed set of referral-source options shown on the assessment form and
// used for the "How did they hear about us" donut chart.
const HOWKNOW_OPTIONS = ['Friends/Relatives', 'Instagram', 'Facebook', 'Google', 'LinkedIn', 'Another Hospital/Doctor', 'Others'];

const AMBULATION_OPTIONS = ['Independent', 'Assisted'];

// Theme customization - Super Admin only, applied live across the whole
// app (sidebar, buttons, charts, printed assessment header).
const THEME_SETTING_DEFAULTS = [
  ['ThemeButtonStyle', 'gradient-diagonal'],
  ['ThemeButtonFrom', '#a8d339'],
  ['ThemeButtonTo', '#2778b7'],
  ['ThemeButtonText', '#FFFFFF'],
  ['ThemeSidebarStyle', 'gradient-vertical'],
  ['ThemeSidebarFrom', '#a8d339'],
  ['ThemeSidebarTo', '#2778b7'],
  ['ThemeSidebarText', '#FFFFFF'],
  ['ThemeNavActiveBg', '#FFFFFF'],
  ['ThemeNavActiveText', '#a8d339'],
  ['ThemeDocHeaderColor', '#2778b7'],
  ['ThemeDocHeaderColorTo', '#a8d339'],
  ['ThemeHeadingColor', '#182322'],
  ['ThemeMutedColor', '#4B5A57'],
  ['ThemeBgColor', '#F6F4F3'],
  ['ThemeSurfaceColor', '#FFFFFF'],
  ['ThemeBorderColor', '#E7DCD8'],
  ['ThemeChartPalette', '#a8d339,#2778b7,#59ff4d,#1F9E78,#2E86AB,#6C4FB6,#3D5A80,#8C2F39,#D4A017,#4B5A57,#7A5C61,#2be42e'],

  ['ThemeLoginBgStyle', 'gradient-diagonal'],
  ['ThemeLoginBgFrom', '#a8d339'],
  ['ThemeLoginBgTo', '#2778b7'],
  ['ThemeLoginCardBg', '#FFFFFF'],
  ['ThemeLoginHeadingColor', '#182322'],
  ['ThemeLoginTextColor', '#4B5A57'],

  ['ThemePageHeadingColor', '#182322'],
  ['ThemePageSubheadingColor', '#4B5A57'],
  ['ThemeSectionHeadingColor', '#182322'],

  ['ThemeTabActiveTextColor', '#a8d339'],
  ['ThemeTabInactiveTextColor', '#4B5A57'],
  ['ThemeTabIndicatorStyle', 'gradient-diagonal'],
  ['ThemeTabIndicatorFrom', '#a8d339'],
  ['ThemeTabIndicatorTo', '#2778b7'],

  ['ThemeGateBgColor', '#FBF1DC'],
  ['ThemeGateBorderColor', '#E8C766'],
  ['ThemeGateTitleColor', '#C68A1E'],

  ['ThemeDocCompanyNameBold', 'TRUE'],
  ['ThemeDocCompanyNameItalic', 'FALSE'],
  ['ThemeDocCompanyNameUnderline', 'FALSE'],
  ['ThemeDocCompanyInfoBold', 'FALSE'],
  ['ThemeDocCompanyInfoItalic', 'FALSE'],
  ['ThemeDocCompanyInfoUnderline', 'FALSE'],
  ['ThemeDocHeaderLayout', 'logo-side'],

  ['ThemeDocFontFamily', "Georgia, 'Times New Roman', Times, serif"],
  ['ThemeDocLogoWidth', '96'],
  ['ThemeDocLogoHeight', '58'],

  ['ThemeFieldLabelColor', '#2778b7'],
  ['ThemeFieldValueColor', '#000000'],
  ['ThemeSectionBandColor', '#eaf6f1'],

  ['ThemeButtonHoverFrom', '#8fc22c'],
  ['ThemeButtonHoverTo', '#1f5f8f'],
  ['ThemeOutlineText', '#2778b7'],
  ['ThemeOutlineBorder', '#2778b7'],
  ['ThemeOutlineHoverBg', '#EAF3FB'],
  ['ThemeOutlineHoverText', '#2778b7']
];

const SOCIAL_LINK_DEFAULTS = {
  SocialWhatsapp: '918122664485',
  SocialLinkedin: 'https://www.linkedin.com/company/sj-physiotherapy/',
  SocialInstagram: 'https://www.instagram.com/sjphysiotherapy_/',
  SocialFacebook: 'https://www.facebook.com/profile.php?id=61593791160195',
  SocialYoutube: 'https://www.youtube.com/@SJ-Physiotherapy'
};

const CUSTOM_CHARTS_HEADERS = ['ChartID', 'Name', 'Type', 'DataSource', 'Dimension', 'Metric', 'MetricField', 'TopN', 'SortDir', 'SortOrder', 'CreatedAt', 'Color'];

const PHYSIOS_HEADERS = ['PhysioID', 'Name', 'Password', 'Active', 'CreatedAt', 'CanAccessFindEdit', 'CanAccessReportDownload', 'CanAccessDashboard', 'SignatureUrl', 'SignatureFileId'];

const ISSUES_HEADERS = ['IssueID', 'Name', 'Active', 'CreatedAt'];

const PATIENTS_HEADERS = ['PatientID', 'Name', 'Phone', 'Age', 'Sex', 'Occupation', 'Email', 'Address', 'UHID', 'HowKnow', 'ReferredBy', 'PatientKey', 'CreatedAt', 'UpdatedAt'];
const PATIENT_KEY_COL = 12; // 1-based column of PatientKey above

// The main record sheet - "Physiotherapy Assessment Form" - one row = one
// visit/assessment. Column order matters - every apiXxx function below
// that reads/writes this sheet by index depends on this exact order. New
// columns are ONLY ever appended at the end (see ensureHeaders_).
const VISIT_HEADERS = [
  'VisitID', 'PatientVisitID', 'PatientID', 'PatientName', 'Phone', 'Age', 'Sex', 'Occupation',
  'Email', 'Address', 'UHID', 'Date', 'ReferredBy', 'HowKnow', 'InvoiceNumber', 'IssueType',
  'ChiefComplaint', 'HistoryOfPresentIllness', 'Posture', 'ObsGait', 'DeformitySwelling',
  'VAS', 'NatureOfPain', 'AggravatingFactors', 'RelievingFactors',
  'PMH_DM', 'PMH_HTN', 'PMH_Thyroid', 'PMH_Cardiac', 'SurgeryFractureHospitalization',
  'ROM_JSON', 'MMT_JSON', 'PainMarksJSON', 'SpecialTestsJSON',
  'Ambulation', 'StairClimbing', 'ADLs',
  'BalanceSingleLegStance', 'BalanceRombergTest',
  'GaitPattern', 'GaitCadence', 'GaitLimping',
  'ClinicalDiagnosis', 'TreatmentGoalsJSON', 'TreatmentPlanJSON', 'FollowUpNotes', 'NextReviewDate',
  'PhysioID', 'PhysioName', 'SignatureUrl',
  'CreatedAt', 'UpdatedAt', 'UpdatedBy',
  // --- appended 2026-10: edit audit trail ---
  'LastEditReason', 'EditLog'
];
// Handy name -> column index (0-based) map, built once.
const V = {};
VISIT_HEADERS.forEach((h, i) => { V[h] = i; });

// Per-request memo. Apps Script re-evaluates global scope on every
// execution, so this never leaks between requests or users - it only
// stops the SAME request from re-opening the spreadsheet / re-reading
// Settings again and again (each of those is a slow service round trip).
const MEMO_ = {};

// ---------------------------------------------------------------------------
// 1. ENTRY POINTS
// ---------------------------------------------------------------------------
function doGet(e) {
  try {
    ensureSchemaCached_();
    const action = e.parameter.action;

    // Every GET action reads real patient data, so every one of them
    // requires a valid session token issued at login - except getSettings,
    // which the login screen itself calls before anyone has a session (to
    // theme the login gradient/card/logo). It only returns theme/clinic
    // display info, never patient data or any credential.
    const authCheck = (action === 'getSettings') ? { ok: true } : requireSession_(e.parameter.token);
    if (!authCheck.ok) return jsonOut(authCheck);

    let result;
    switch (action) {
      case 'bootstrap':            result = apiBootstrap(); break;
      case 'getSettings':          result = apiGetSettingsPublic(); break;
      case 'getPhysios':           result = apiGetPhysios(); break;
      case 'getIssues':            result = apiGetIssues(true); break;
      case 'findPatient':          result = apiFindPatient(e.parameter.phone, e.parameter.name); break;
      case 'getPatients':          result = apiGetPatientsList(); break;
      case 'getAssessment':        result = apiGetAssessment(e.parameter.visitId); break;
      case 'searchAssessments':    result = apiSearchAssessments(e.parameter); break;
      case 'getDashboardRaw':      result = apiGetDashboardRaw(); break;
      case 'getCustomCharts':      result = apiGetCustomCharts(); break;
      case 'getCustomChartData':   result = apiGetCustomChartData(e.parameter); break;
      case 'getUniversalReport':   result = apiGetUniversalReport(); break;
      case 'getDailyReport':       result = apiGetDailyReport(); break;
      case 'getCapacityStatus':    result = getCapacityCached_(); break;
      case 'getEmailPreview':      result = apiGetEmailPreview(e.parameter); break;
      default:
        result = { ok: false, error: 'Unknown GET action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    ensureSchemaCached_();
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const p = body.payload || {};

    // Every POST action except 'login' requires a valid session token.
    if (action !== 'login') {
      const authCheck = requireSession_(body.token);
      if (!authCheck.ok) return jsonOut(authCheck);
    }

    let result;
    switch (action) {
      case 'login':               result = apiLogin(p); break;
      case 'verifyPhysio':        result = apiVerifyPhysio(p); break;
      case 'saveAssessment':      result = apiSaveAssessment(p); break;
      case 'updateAssessment':    result = apiUpdateAssessment(p); break;
      case 'getAssessmentPdf':    result = apiGetAssessmentPdf(p); break;
      case 'savePatient':         result = apiSavePatient(p); break;
      case 'addIssue':            result = apiAddIssue(p); break;
      case 'updateIssue':         result = apiUpdateIssue(p); break;
      case 'deleteIssue':         result = apiDeleteIssue(p); break;
      case 'savePhysio':          result = apiSavePhysio(p); break;
      case 'togglePhysio':        result = apiTogglePhysio(p); break;
      case 'setPhysioAccess':     result = apiSetPhysioAccess(p); break;
      case 'deletePhysio':        result = apiDeletePhysio(p); break;
      case 'uploadSignature':     result = apiUploadSignature(p); break;
      case 'updateOwnPassword':   result = apiUpdateOwnPassword(p); break;
      case 'updateSettings':      result = apiUpdateSettings(p); break;
      case 'updateSuperAdminLogin': result = apiUpdateSuperAdminLogin(p); break;
      case 'updateTheme':         result = apiUpdateTheme(p); break;
      case 'resetTheme':          result = apiResetTheme(p); break;
      case 'saveCustomChart':     result = apiSaveCustomChart(p); break;
      case 'deleteCustomChart':   result = apiDeleteCustomChart(p); break;
      case 'reorderCustomCharts': result = apiReorderCustomCharts(p); break;
      case 'emailAssessmentPdf':  result = apiEmailAssessmentPdf(p); break;
      case 'refreshDashboardSheet': result = apiRefreshDashboardSheet(p); break;
      case 'getDataDiagnostics':  result = apiGetDataDiagnostics(p); break;
      case 'autoExpandDatabase':  result = apiAutoExpandDatabase(p); break;
      case 'resetToActiveOnly':   result = apiResetToActiveOnly(p); break;
      default:
        result = { ok: false, error: 'Unknown POST action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// 2. SESSION AUTH - deployment is "Execute as: Me" + "Anyone", so this
//    app's code is the ONLY gate. Every action (GET and POST, except
//    'login' itself) requires a valid session token, minted only by a
//    successful apiLogin() and stored server-side in CacheService (max 6h).
// ---------------------------------------------------------------------------
const SESSION_TTL_SECONDS = 21600; // 6 hours

function createSession_(sessionData) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(sessionData), SESSION_TTL_SECONDS);
  return token;
}

function requireSession_(token) {
  if (!token) return { ok: false, error: 'Not logged in. Please log in again.', sessionExpired: true };
  const raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) return { ok: false, error: 'Your session has expired. Please log in again.', sessionExpired: true };
  return { ok: true, session: JSON.parse(raw) };
}

// ---------------------------------------------------------------------------
// 3. SETTINGS HELPERS - memoized per request + cached across requests for
//    2 minutes. Every write through this app clears the cache immediately;
//    a value typed straight into the Settings sheet by hand shows up within
//    2 minutes.
// ---------------------------------------------------------------------------
const SETTINGS_CACHE_SECONDS = 120;

function settingsCacheKey_() { return 'settings_v2_' + ss_().getId(); }

function getSettingsMap_() {
  if (MEMO_.settings) return MEMO_.settings;
  const cache = CacheService.getScriptCache();
  const key = settingsCacheKey_();
  const cached = cache.get(key);
  if (cached) {
    try { MEMO_.settings = JSON.parse(cached); return MEMO_.settings; } catch (e) { /* fall through to a real read */ }
  }
  const sh = ss_().getSheetByName(SHEET.SETTINGS);
  const lastRow = sh.getLastRow();
  const data = lastRow >= 1 ? sh.getRange(1, 1, lastRow, 2).getValues() : [];
  const map = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) map[data[i][0]] = data[i][1];
  }
  MEMO_.settings = map;
  try { cache.put(key, JSON.stringify(map), SETTINGS_CACHE_SECONDS); } catch (e) { /* too large to cache - fine */ }
  return map;
}

function invalidateSettings_() {
  MEMO_.settings = null;
  try { CacheService.getScriptCache().remove(settingsCacheKey_()); } catch (e) { /* nothing cached */ }
}

function setSetting_(key, value) {
  const obj = {};
  obj[key] = value;
  setSettingsBatch_(obj);
}

// Writes many Settings keys with ONE read and as few writes as possible
// (previously saving the Theme tab did a full sheet read + a separate
// write for each of ~60 keys). Only rows whose key actually changed are
// written - grouped into contiguous runs - so an untouched value (e.g. a
// password with a leading zero) is never round-tripped through a re-write.
function setSettingsBatch_(obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return;
  const sh = ss_().getSheetByName(SHEET.SETTINGS);
  const lastRow = sh.getLastRow();
  const data = lastRow >= 1 ? sh.getRange(1, 1, lastRow, 2).getValues() : [];
  const rowOf = {};
  for (let i = 1; i < data.length; i++) { if (data[i][0]) rowOf[data[i][0]] = i; }

  const changedIdx = [];
  const appends = [];
  keys.forEach(k => {
    if (k in rowOf) { data[rowOf[k]][1] = obj[k]; changedIdx.push(rowOf[k]); }
    else appends.push([k, obj[k]]);
  });

  changedIdx.sort((a, b) => a - b);
  let start = null, prev = null;
  const flush = () => {
    if (start === null) return;
    const vals = data.slice(start, prev + 1).map(r => [r[1]]);
    sh.getRange(start + 1, 2, vals.length, 1).setValues(vals);
  };
  changedIdx.forEach(i => {
    if (start === null) { start = prev = i; }
    else if (i === prev + 1) { prev = i; }
    else { flush(); start = prev = i; }
  });
  flush();

  if (appends.length) sh.getRange(Math.max(lastRow, 1) + 1, 1, appends.length, 2).setValues(appends);
  invalidateSettings_();
}

// ---------------------------------------------------------------------------
// MULTI-DATABASE CONTINUITY - the "Active + Archive" model. Every
// read/write normally goes to the spreadsheet this script is bound to.
// Once Super Admin clicks "Add New Database", ACTIVE_SPREADSHEET_ID is set
// in this SCRIPT's properties and every read/write follows that pointer to
// a brand-new spreadsheet. Archived spreadsheets are read-only history.
// ---------------------------------------------------------------------------
function ss_() {
  if (MEMO_.ss) return MEMO_.ss;
  const activeId = PropertiesService.getScriptProperties().getProperty('ACTIVE_SPREADSHEET_ID');
  if (activeId) {
    try {
      MEMO_.ss = SpreadsheetApp.openById(activeId);
    } catch (e) {
      throw new Error('ACTIVE_SPREADSHEET_ID is set to "' + activeId + '" but that spreadsheet could not be opened (' + e + '). Check the ID is correct and this script\'s account still has access to it.');
    }
  } else {
    MEMO_.ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  return MEMO_.ss;
}

function resetMemo_() {
  Object.keys(MEMO_).forEach(k => { delete MEMO_[k]; });
}

function getArchiveRegistry_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ARCHIVE_SPREADSHEET_IDS');
  if (!raw) return [];
  try { return JSON.parse(raw) || []; } catch (e) { return []; }
}

// An archive that's been deleted, unshared, or briefly unreachable is
// skipped (not thrown) so one bad archive link can never take down
// Reports, Find/Edit or the Dashboard for everyone else.
function openArchives_() {
  if (MEMO_.archives) return MEMO_.archives;
  MEMO_.archives = getArchiveRegistry_().map(entry => {
    try { return { ss: SpreadsheetApp.openById(entry.id), label: entry.label || entry.id }; }
    catch (e) { return null; }
  }).filter(Boolean);
  return MEMO_.archives;
}

// Every database this app can currently read PATIENT VISIT HISTORY from -
// the active one first.
function allDbs_() {
  return [{ ss: ss_(), label: 'Active' }].concat(openArchives_());
}

function truthy_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

// ---------------------------------------------------------------------------
// 3b. FAST VISIT-SHEET ACCESS
// ---------------------------------------------------------------------------
// Reads ONLY the requested visit columns for every data row, grouped into
// as few contiguous range reads as possible, and returns full-width row
// arrays (unrequested columns are just '') so every caller can keep using
// row[V.Xxx] exactly as before. This skips transferring the heavy JSON /
// notes columns for screens that never display them (Reports, Dashboard,
// ID generation). Columns that don't exist on an older/archived sheet come
// back as '' instead of throwing.
function readVisitRows_(sh, names) {
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const lastCol = sh.getLastColumn();
  const wanted = ['VisitID'].concat(names || []);
  const idxs = Array.from(new Set(wanted.map(n => V[n]).filter(i => i !== undefined))).sort((a, b) => a - b);

  const runs = [];
  idxs.forEach(i => {
    const r = runs[runs.length - 1];
    if (r && i - r.end <= 2) r.end = i; // reading 1-2 extra small columns beats an extra round trip
    else runs.push({ start: i, end: i });
  });

  const n = lastRow - 1;
  const blocks = runs.map(r => {
    if (r.start >= lastCol) return null;
    const end = Math.min(r.end, lastCol - 1);
    return { start: r.start, values: sh.getRange(2, r.start + 1, n, end - r.start + 1).getValues() };
  }).filter(Boolean);

  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(VISIT_HEADERS.length).fill('');
    blocks.forEach(b => {
      const src = b.values[i];
      for (let k = 0; k < src.length; k++) row[b.start + k] = src[k];
    });
    rows[i] = row;
  }
  return rows;
}

// 1-based sheet row of a Visit ID, or 0 - located with a TextFinder (runs
// inside Google's servers) instead of downloading the whole sheet.
function findVisitRowNumber_(sh, visitId) {
  if (!sh || !visitId) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const cell = sh.getRange(2, V.VisitID + 1, lastRow - 1, 1)
    .createTextFinder(String(visitId).trim()).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

// Reads one full visit row (padded to the current header width).
function readVisitRow_(sh, rowNum) {
  const width = Math.min(sh.getLastColumn(), VISIT_HEADERS.length);
  const vals = sh.getRange(rowNum, 1, 1, width).getValues()[0];
  while (vals.length < VISIT_HEADERS.length) vals.push('');
  return vals;
}

// ---------------------------------------------------------------------------
// 4. SCHEMA SETUP - creates every sheet + header + default rows the FIRST
//    time it's needed. Never destructive.
// ---------------------------------------------------------------------------
// Cached for 5 minutes per spreadsheet AND per backend build - so the very
// first request after a new deployment always re-checks the schema (this
// is what adds the new LastEditReason / EditLog columns to an existing
// sheet automatically).
function ensureSchemaCached_() {
  const cache = CacheService.getScriptCache();
  const key = 'schemaOk_' + BACKEND_BUILD + '_' + ss_().getId();
  if (cache.get(key)) return;
  ensureSchema_();
  cache.put(key, '1', 300);
}

function ensureSchema_(ssRefParam) {
  const ssRef = ssRefParam || ss_();

  const settingsSh = createSheetIfMissing_(ssRef, SHEET.SETTINGS, ['Key', 'Value']);
  if (settingsSh.getLastRow() < 2) {
    const defaults = [
      ['ClinicName', 'SJ Physiotherapy'],
      ['Address', '243, Ground Floor, Analyangadu Road Extn., Singanallur, Coimbatore - 641 005, Tamilnadu'],
      ['Phone', '+91 96294 95946'],
      ['Website', 'www.sjphysiotherapy.in'],
      ['ClinicEmail', 'Info.sjphysiotherapy@gmail.com'],
      ['RegistrationNo', ''],
      ['LogoURL', DEFAULT_LOGO_URL],
      ['PrintLogoURL', ''],
      ['ShowClinicEmail', 'TRUE'],
      ['SocialWhatsapp', SOCIAL_LINK_DEFAULTS.SocialWhatsapp],
      ['SocialInstagram', SOCIAL_LINK_DEFAULTS.SocialInstagram],
      ['SocialFacebook', SOCIAL_LINK_DEFAULTS.SocialFacebook],
      ['SocialLinkedin', SOCIAL_LINK_DEFAULTS.SocialLinkedin],
      ['SocialYoutube', SOCIAL_LINK_DEFAULTS.SocialYoutube],
      ['SuperAdminUser', 'SJ Physiotherapy'],
      ['SuperAdminPass', 'SJ12345']
    ].concat(THEME_SETTING_DEFAULTS);
    settingsSh.getRange(2, 1, defaults.length, 2).setValues(defaults);
  } else {
    migrateSettingsSheet_(settingsSh);
  }

  const physiosSh = createSheetIfMissing_(ssRef, SHEET.PHYSIOS, PHYSIOS_HEADERS);
  if (physiosSh.getLastRow() < 2) {
    physiosSh.appendRow(['PT001', 'SJ Physiotherapy', 'SJ12345', true, new Date(), true, true, true, '', '']);
  }

  const issuesSh = createSheetIfMissing_(ssRef, SHEET.ISSUES, ISSUES_HEADERS);
  if (issuesSh.getLastRow() < 2) {
    ['Low Back Pain', 'Neck Pain', 'Frozen Shoulder', 'Knee Osteoarthritis', 'Post-Surgical Rehab',
     'Sports Injury', 'Stroke Rehabilitation', 'Sciatica', 'Cervical Spondylosis', 'Ankle Sprain'].forEach(name => {
      issuesSh.appendRow([nextId_(issuesSh, 'ISS'), name, true, new Date()]);
    });
  }

  createSheetIfMissing_(ssRef, SHEET.PATIENTS, PATIENTS_HEADERS);
  const visitsSh = createSheetIfMissing_(ssRef, SHEET.VISITS, VISIT_HEADERS);
  ensureHeaders_(visitsSh, VISIT_HEADERS);
  createSheetIfMissing_(ssRef, SHEET.CUSTOM_CHARTS, CUSTOM_CHARTS_HEADERS);
  if (!ssRefParam) invalidateSettings_();
}

// Appends any header that's missing from the END of an existing sheet's
// header row (never reorders, never touches data). Grows the sheet's
// column count first if needed - writing past a sheet's last column
// would otherwise throw.
function ensureHeaders_(sh, headers) {
  const lastCol = sh.getLastColumn();
  if (lastCol >= headers.length) return;
  if (sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  }
  const missing = headers.slice(lastCol);
  sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#0f6e5c').setFontColor('#FFFFFF');
}

// Keeps an existing Settings sheet current without clobbering anything
// the clinic customised (see SETUP_GUIDE.md for the full explanation).
function migrateSettingsSheet_(settingsSh) {
  const lastRow = settingsSh.getLastRow();
  const data = settingsSh.getRange(1, 1, lastRow, 2).getValues();
  const rowOfKey = {};
  const valueOfKey = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) { rowOfKey[data[i][0]] = i + 1; valueOfKey[data[i][0]] = data[i][1]; }
  }

  const missing = THEME_SETTING_DEFAULTS.filter(([key]) => !(key in rowOfKey));
  if (missing.length) settingsSh.getRange(lastRow + 1, 1, missing.length, 2).setValues(missing);

  const props = PropertiesService.getScriptProperties();
  const flagKey = 'MIGRATED_BRAND_DEFAULTS_V3_' + settingsSh.getParent().getId();
  if (!props.getProperty(flagKey)) {
    const forceCorrect = {
      ThemeDocHeaderColor: '#2778b7',
      ThemeFieldLabelColor: '#2778b7',
      ThemeFieldValueColor: '#000000'
    };
    Object.keys(forceCorrect).forEach(key => {
      if (rowOfKey[key]) settingsSh.getRange(rowOfKey[key], 2).setValue(forceCorrect[key]);
    });
    Object.keys(SOCIAL_LINK_DEFAULTS).forEach(key => {
      if (rowOfKey[key] && !valueOfKey[key]) {
        settingsSh.getRange(rowOfKey[key], 2).setValue(SOCIAL_LINK_DEFAULTS[key]);
      }
    });
    props.setProperty(flagKey, 'TRUE');
  }
}

function createFreshDatabaseSpreadsheet_(name) {
  const newSs = SpreadsheetApp.create(name);
  ensureSchema_(newSs);
  const defaultSheet = newSs.getSheetByName('Sheet1');
  if (defaultSheet && newSs.getSheets().length > 1) newSs.deleteSheet(defaultSheet);
  return newSs;
}

// Carries MASTER data forward from one database to another - Settings,
// Physiotherapists, IssuesList, Patients, CustomCharts. Never touches the
// visit history - that stays behind on the archived spreadsheet.
function copyMasterDataForward_(fromSs, toSs) {
  [SHEET.SETTINGS, SHEET.PHYSIOS, SHEET.ISSUES, SHEET.PATIENTS, SHEET.CUSTOM_CHARTS].forEach(name => {
    const fromSh = fromSs.getSheetByName(name);
    const toSh = toSs.getSheetByName(name);
    if (!fromSh || !toSh) return;
    const data = fromSh.getDataRange().getValues();
    if (data.length <= 1) return;
    const rows = data.slice(1);
    const numCols = data[0].length;
    if (toSh.getLastRow() > 1) toSh.getRange(2, 1, toSh.getLastRow() - 1, toSh.getLastColumn()).clearContent();
    toSh.getRange(2, 1, rows.length, numCols).setValues(rows);
  });
}

function createSheetIfMissing_(ssRef, name, headers) {
  let sh = ssRef.getSheetByName(name);
  if (!sh) sh = ssRef.insertSheet(name);
  if (sh.getLastRow() === 0) {
    if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#0f6e5c').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

// Run this ONCE from the Apps Script editor (Run > setupDatabase) right
// after pasting the code in. Running it again is harmless.
function setupDatabase() {
  ensureSchema_();
  buildUniversalReportSheet_();
  buildDailyReportSheet_();
  SpreadsheetApp.getUi().alert(
    'Setup complete!\n\nDefault Super Admin login:\nUsername: SJ Physiotherapy\nPassword: SJ12345\n\n' +
    'Default Physiotherapist login:\nID: PT001\nPassword: SJ12345\n\nChange both from Admin Settings after your first login.'
  );
}

// Optional keep-warm trigger - see SETUP_GUIDE.md.
function enableKeepWarm() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'keepWarm_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('keepWarm_').timeBased().everyMinutes(5).create();
  if (typeof SpreadsheetApp.getUi === 'function') {
    try { SpreadsheetApp.getUi().alert('Keep-warm enabled: this script will quietly tick every 5 minutes to help avoid Apps Script cold-start delays.'); } catch (e) {}
  }
}
function disableKeepWarm() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'keepWarm_') ScriptApp.deleteTrigger(t);
  });
}
function keepWarm_() {
  ensureSchemaCached_();
  getSettingsMap_(); // keeps the settings cache warm too
}

// ---------------------------------------------------------------------------
// 5. LOGIN / AUTH
// ---------------------------------------------------------------------------
// A successful login now also returns everything bootstrap needs, so the
// app opens with ONE server round trip instead of three (login, bootstrap,
// capacity check).
function apiLogin(p) {
  const s = getSettingsMap_();
  const user = String(s.SuperAdminUser || 'SJ Physiotherapy').trim();
  const pass = String(s.SuperAdminPass || 'SJ12345').trim();
  const uname = String(p.username || '').trim();
  const pwd = String(p.password || '').trim();

  if (uname === user && pwd === pass) {
    const token = createSession_({ role: 'admin', displayName: user });
    return { ok: true, role: 'admin', displayName: user, sessionToken: token, bootstrap: apiBootstrap() };
  }

  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const [id, name, ppass, active, , canFindEdit, canReportDownload, canDashboard] = data[i];
    if (!id) continue;
    if (String(id).trim() === uname && String(ppass).trim() === pwd) {
      if (!truthy_(active)) return { ok: false, error: 'This physiotherapist ID is deactivated' };
      const token = createSession_({ role: 'physio', physioId: id, physioName: name });
      return {
        ok: true, role: 'physio', displayName: name, physioId: id, physioName: name, sessionToken: token,
        canAccessFindEdit: truthy_(canFindEdit),
        canAccessReportDownload: truthy_(canReportDownload),
        canAccessDashboard: truthy_(canDashboard),
        bootstrap: apiBootstrap()
      };
    }
  }
  return { ok: false, error: 'Invalid username or password' };
}

function requireSuperAdmin_(user, pass) {
  const s = getSettingsMap_();
  const su = String(s.SuperAdminUser || 'SJ Physiotherapy').trim();
  const sp = String(s.SuperAdminPass || 'SJ12345').trim();
  if (String(user || '').trim() === su && String(pass || '').trim() === sp) return { ok: true };
  return { ok: false, error: 'Super admin credentials required or incorrect' };
}

// Re-verifies a physiotherapist's OWN credentials at the moment they sign /
// save an assessment (never cached client-side).
function apiVerifyPhysio(p) {
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const [id, name, pass, active] = data[i];
    if (String(id) === String(p.physioId) && String(pass) === String(p.password)) {
      if (!truthy_(active)) return { ok: false, error: 'This physiotherapist ID is deactivated' };
      return { ok: true, physioId: id, physioName: name, signatureUrl: data[i][8] || '' };
    }
  }
  return { ok: false, error: 'Invalid physiotherapist ID or password' };
}

// ---------------------------------------------------------------------------
// 6. BOOTSTRAP (everything the app shell needs right after login)
// ---------------------------------------------------------------------------
function apiBootstrap() {
  return {
    ok: true,
    settings: apiGetSettingsPublic().settings,
    physios: apiGetPhysios().physios.filter(b => b.active),
    issues: apiGetIssues(false).issues,
    howKnowOptions: HOWKNOW_OPTIONS,
    ambulationOptions: AMBULATION_OPTIONS,
    nextVisitId: peekNextVisitId_(),
    capacity: getCapacityCached_(),
    serverBuild: BACKEND_BUILD
  };
}

// Never sends either Super Admin credential to the browser - getSettings
// is reachable without a login (it themes the login screen), so the admin
// USERNAME is withheld too rather than handing out half of the login.
function apiGetSettingsPublic() {
  const s = getSettingsMap_();
  const pub = {};
  Object.keys(s).forEach(k => {
    if (k === 'SuperAdminPass' || k === 'SuperAdminUser') return;
    pub[k] = s[k];
  });
  return { ok: true, settings: pub };
}

function apiUpdateSettings(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const fields = ['ClinicName', 'Address', 'Phone', 'Website', 'ClinicEmail', 'RegistrationNo',
    'LogoURL', 'PrintLogoURL', 'ShowClinicEmail', 'SocialWhatsapp', 'SocialInstagram',
    'SocialFacebook', 'SocialLinkedin', 'SocialYoutube'];
  const updates = {};
  fields.forEach(f => { if (p[f] !== undefined) updates[f] = p[f]; });
  setSettingsBatch_(updates);
  return { ok: true };
}

function apiUpdateSuperAdminLogin(p) {
  const auth = requireSuperAdmin_(p.currentUser, p.currentPass);
  if (!auth.ok) return auth;
  const updates = {};
  if (p.newUser) updates.SuperAdminUser = String(p.newUser).trim();
  if (p.newPass) updates.SuperAdminPass = String(p.newPass).trim();
  if (!Object.keys(updates).length) return { ok: false, error: 'Enter a new username and/or password' };
  setSettingsBatch_(updates);
  return { ok: true };
}

function apiUpdateTheme(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const updates = {};
  THEME_SETTING_DEFAULTS.forEach(([key]) => { if (p[key] !== undefined) updates[key] = p[key]; });
  setSettingsBatch_(updates);
  return { ok: true };
}

function apiResetTheme(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const updates = {};
  THEME_SETTING_DEFAULTS.forEach(([key, val]) => { updates[key] = val; });
  setSettingsBatch_(updates);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 7. PHYSIOTHERAPISTS
// ---------------------------------------------------------------------------
function apiGetPhysios() {
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  const physios = [];
  for (let i = 1; i < data.length; i++) {
    const [id, name, , active, createdAt, canFindEdit, canReportDownload, canDashboard, signatureUrl] = data[i];
    if (!id) continue;
    physios.push({
      physioId: id, name: name,
      active: truthy_(active),
      createdAt: formatDate_(createdAt),
      canAccessFindEdit: truthy_(canFindEdit),
      canAccessReportDownload: truthy_(canReportDownload),
      canAccessDashboard: truthy_(canDashboard),
      signatureUrl: signatureUrl || ''
    });
  }
  return { ok: true, physios: physios };
}

function apiSavePhysio(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  if (p.editPhysioId) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(p.editPhysioId)) {
        sh.getRange(i + 1, 2).setValue(p.name);
        if (p.password) sh.getRange(i + 1, 3).setValue(p.password);
        if (p.signatureUrl !== undefined) sh.getRange(i + 1, 9).setValue(p.signatureUrl);
        return { ok: true, physioId: p.editPhysioId };
      }
    }
    return { ok: false, error: 'Physiotherapist not found' };
  }
  // Next ID = highest existing number + 1. (It used to be the row count,
  // which re-issued an existing ID - e.g. a second "PT003" - as soon as any
  // physiotherapist had been deleted.)
  let max = 0;
  for (let i = 1; i < data.length; i++) {
    const m = String(data[i][0] || '').match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const id = 'PT' + Utilities.formatString('%03d', max + 1);
  sh.appendRow([id, p.name, p.password, true, new Date(), true, true, true, p.signatureUrl || '', '']);
  return { ok: true, physioId: id };
}

function apiTogglePhysio(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.physioId)) {
      const cur = truthy_(data[i][3]);
      sh.getRange(i + 1, 4).setValue(!cur);
      return { ok: true, active: !cur };
    }
  }
  return { ok: false, error: 'Physiotherapist not found' };
}

// field must be one of: canAccessFindEdit, canAccessReportDownload, canAccessDashboard
function apiSetPhysioAccess(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const colMap = { canAccessFindEdit: 6, canAccessReportDownload: 7, canAccessDashboard: 8 };
  const col = colMap[p.field];
  if (!col) return { ok: false, error: 'Unknown permission field' };
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.physioId)) {
      sh.getRange(i + 1, col).setValue(!!p.value);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Physiotherapist not found' };
}

function apiDeletePhysio(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.physioId)) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Physiotherapist not found' };
}

function apiUploadSignature(p) {
  const check = apiVerifyPhysio({ physioId: p.physioId, password: p.password });
  if (!check.ok) return check;
  if (!p.base64Png) return { ok: false, error: 'No image received' };

  const folder = getOrCreateSignatureFolder_();
  const bytes = Utilities.base64Decode(String(p.base64Png).split(',').pop());
  const blob = Utilities.newBlob(bytes, 'image/png', 'signature_' + p.physioId + '.png');
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const url = 'https://drive.google.com/uc?export=view&id=' + file.getId();

  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.physioId)) {
      const oldFileId = data[i][9];
      if (oldFileId) {
        try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) { /* already gone - fine */ }
      }
      sh.getRange(i + 1, 9, 1, 2).setValues([[url, file.getId()]]);
      return { ok: true, signatureUrl: url };
    }
  }
  return { ok: false, error: 'Physiotherapist not found' };
}

function getOrCreateSignatureFolder_() {
  const name = 'SJ Physiotherapy - Signatures';
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

function apiUpdateOwnPassword(p) {
  const check = apiVerifyPhysio({ physioId: p.physioId, password: p.currentPassword });
  if (!check.ok) return check;
  if (!p.newPassword) return { ok: false, error: 'New password required' };
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.physioId)) {
      sh.getRange(i + 1, 3).setValue(p.newPassword);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Physiotherapist not found' };
}

// ---------------------------------------------------------------------------
// 8. ISSUES LIST
// ---------------------------------------------------------------------------
function apiGetIssues(includeInactive) {
  const sh = ss_().getSheetByName(SHEET.ISSUES);
  const data = sh.getDataRange().getValues();
  const issues = [];
  for (let i = 1; i < data.length; i++) {
    const [id, name, active, createdAt] = data[i];
    if (!id) continue;
    if (!includeInactive && !truthy_(active)) continue;
    issues.push({ issueId: id, name: name, active: truthy_(active), createdAt: formatDate_(createdAt) });
  }
  return { ok: true, issues: issues };
}

function apiAddIssue(p) {
  const name = String(p.name || '').trim();
  if (!name) return { ok: false, error: 'Issue name is required' };
  const sh = ss_().getSheetByName(SHEET.ISSUES);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).toLowerCase() === name.toLowerCase()) {
      if (!truthy_(data[i][2])) sh.getRange(i + 1, 3).setValue(true);
      return { ok: true, issueId: data[i][0], name: data[i][1] };
    }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const id = nextId_(sh, 'ISS');
    sh.appendRow([id, name, true, new Date()]);
    return { ok: true, issueId: id, name: name };
  } finally {
    lock.releaseLock();
  }
}

function apiUpdateIssue(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.ISSUES);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.issueId)) {
      sh.getRange(i + 1, 2, 1, 2).setValues([[
        p.name !== undefined ? p.name : data[i][1],
        p.active !== undefined ? !!p.active : data[i][2]
      ]]);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Issue not found' };
}

function apiDeleteIssue(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.ISSUES);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.issueId)) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Issue not found' };
}

// ---------------------------------------------------------------------------
// 9. PATIENTS (master registry)
// ---------------------------------------------------------------------------
function normalizePhone_(phone) {
  return String(phone || '').replace(/\D/g, '');
}
function normalizeNameKey_(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function patientKey_(phone, name) {
  return normalizePhone_(phone) + '_' + normalizeNameKey_(name);
}

// 1-based row of a patient key on the Patients sheet, or 0.
function findPatientRowNumber_(sh, key) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2 || !key) return 0;
  const cell = sh.getRange(2, PATIENT_KEY_COL, lastRow - 1, 1)
    .createTextFinder(key).matchEntireCell(true).matchCase(true).findNext();
  return cell ? cell.getRow() : 0;
}

function apiFindPatient(phone, name) {
  const key = patientKey_(phone, name);
  if (!key || key === '_') return { ok: true, found: false };
  const sh = ss_().getSheetByName(SHEET.PATIENTS);
  const rowNum = findPatientRowNumber_(sh, key);
  if (!rowNum) return { ok: true, found: false };
  const row = sh.getRange(rowNum, 1, 1, PATIENTS_HEADERS.length).getValues()[0];
  return { ok: true, found: true, patient: rowToPatient_(row) };
}

function rowToPatient_(row) {
  return {
    patientId: row[0], name: row[1], phone: row[2], age: row[3], sex: row[4],
    occupation: row[5], email: row[6], address: row[7], uhid: row[8],
    howKnow: row[9], referredBy: row[10], patientKey: row[11]
  };
}

function apiGetPatientsList() {
  const sh = ss_().getSheetByName(SHEET.PATIENTS);
  const data = sh.getDataRange().getValues();
  const patients = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][11]) continue;
    patients.push(rowToPatient_(data[i]));
  }
  return { ok: true, patients: patients };
}

// Upsert-by-key: same phone+name combination always maps to the same
// Patients row.
function apiSavePatient(p) {
  const key = patientKey_(p.phone, p.name);
  const sh = ss_().getSheetByName(SHEET.PATIENTS);
  const now = new Date();
  const rowNum = findPatientRowNumber_(sh, key);
  if (rowNum) {
    let patientId = p.patientId;
    if (patientId) sh.getRange(rowNum, 1).setValue(patientId);
    else patientId = sh.getRange(rowNum, 1).getValue();
    sh.getRange(rowNum, 2, 1, 10).setValues([[p.name, p.phone, p.age, p.sex, p.occupation, p.email, p.address, p.uhid, p.howKnow, p.referredBy]]);
    sh.getRange(rowNum, 14).setValue(now);
    return { ok: true, patientId: patientId, patientKey: key, isNew: false };
  }
  sh.appendRow([p.patientId || '', p.name, p.phone, p.age, p.sex, p.occupation, p.email, p.address, p.uhid, p.howKnow, p.referredBy, key, now, now]);
  return { ok: true, patientId: p.patientId || '', patientKey: key, isNew: true };
}

// ---------------------------------------------------------------------------
// 10. ID GENERATION - counters live in Script Properties. Every caller must
//     already hold LockService.getScriptLock() for its read-then-write.
// ---------------------------------------------------------------------------
function nextSequentialId_(counterKey, prefix, padLength, bootstrapSheet, idColIndex, consume) {
  if (consume === undefined) consume = true;
  const props = PropertiesService.getScriptProperties();
  let current = Number(props.getProperty(counterKey));
  if (!current || isNaN(current)) {
    current = highestExistingIdSuffix_(bootstrapSheet, idColIndex);
  }
  const next = current + 1;
  if (consume) props.setProperty(counterKey, String(next));
  return prefix + '-' + Utilities.formatString('%0' + padLength + 'd', next);
}

function highestExistingIdSuffix_(sheet, idColIndex) {
  if (!sheet) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const col = sheet.getRange(2, idColIndex + 1, lastRow - 1, 1).getValues();
  let max = 0;
  for (let i = 0; i < col.length; i++) {
    const m = String(col[i][0] || '').match(/(\d+)\s*$/);
    if (m) { const n = Number(m[1]); if (n > max) max = n; }
  }
  return max;
}

function nextId_(sheet, prefix) {
  return nextSequentialId_('IDCTR_' + prefix, prefix, 4, sheet, 0, true);
}

function nextVisitId_() {
  const sh = ss_().getSheetByName(SHEET.VISITS);
  return nextSequentialId_('IDCTR_PAF', 'PAF', 6, sh, V.VisitID, true);
}
function peekNextVisitId_() {
  const sh = ss_().getSheetByName(SHEET.VISITS);
  return nextSequentialId_('IDCTR_PAF', 'PAF', 6, sh, V.VisitID, false);
}

// PER-PATIENT visit id, e.g. 9876543210_RAMESHKUMAR-V03. Reads only the
// PatientName + Phone columns (not every column of every visit).
function nextPatientVisitId_(phone, name) {
  const key = patientKey_(phone, name);
  const sh = ss_().getSheetByName(SHEET.VISITS);
  let count = 0;
  const lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    const cols = sh.getRange(2, V.PatientName + 1, lastRow - 1, 2).getValues(); // PatientName, Phone
    for (let i = 0; i < cols.length; i++) {
      if (patientKey_(cols[i][1], cols[i][0]) === key) count++;
    }
  }
  return key + '-V' + Utilities.formatString('%02d', count + 1);
}

// ---------------------------------------------------------------------------
// 11. SAVE / UPDATE ASSESSMENT (core transaction)
// ---------------------------------------------------------------------------
const ASSESSMENT_FIELDS = [
  'date', 'referredBy', 'howKnow', 'invoiceNumber', 'issueType',
  'chiefComplaint', 'historyOfPresentIllness', 'posture', 'obsGait', 'deformitySwelling',
  'vas', 'natureOfPain', 'aggravatingFactors', 'relievingFactors',
  'pmhDM', 'pmhHTN', 'pmhThyroid', 'pmhCardiac', 'surgeryFractureHospitalization',
  'romJson', 'mmtJson', 'painMarksJson', 'specialTestsJson',
  'ambulation', 'stairClimbing', 'adls',
  'balanceSingleLegStance', 'balanceRombergTest',
  'gaitPattern', 'gaitCadence', 'gaitLimping',
  'clinicalDiagnosis', 'treatmentGoalsJson', 'treatmentPlanJson', 'followUpNotes', 'nextReviewDate'
];
const ASSESSMENT_FIELD_TO_COLUMN = {
  date: 'Date', referredBy: 'ReferredBy', howKnow: 'HowKnow', invoiceNumber: 'InvoiceNumber', issueType: 'IssueType',
  chiefComplaint: 'ChiefComplaint', historyOfPresentIllness: 'HistoryOfPresentIllness', posture: 'Posture',
  obsGait: 'ObsGait', deformitySwelling: 'DeformitySwelling', vas: 'VAS', natureOfPain: 'NatureOfPain',
  aggravatingFactors: 'AggravatingFactors', relievingFactors: 'RelievingFactors',
  pmhDM: 'PMH_DM', pmhHTN: 'PMH_HTN', pmhThyroid: 'PMH_Thyroid', pmhCardiac: 'PMH_Cardiac',
  surgeryFractureHospitalization: 'SurgeryFractureHospitalization',
  romJson: 'ROM_JSON', mmtJson: 'MMT_JSON', painMarksJson: 'PainMarksJSON', specialTestsJson: 'SpecialTestsJSON',
  ambulation: 'Ambulation', stairClimbing: 'StairClimbing', adls: 'ADLs',
  balanceSingleLegStance: 'BalanceSingleLegStance', balanceRombergTest: 'BalanceRombergTest',
  gaitPattern: 'GaitPattern', gaitCadence: 'GaitCadence', gaitLimping: 'GaitLimping',
  clinicalDiagnosis: 'ClinicalDiagnosis', treatmentGoalsJson: 'TreatmentGoalsJSON', treatmentPlanJson: 'TreatmentPlanJSON',
  followUpNotes: 'FollowUpNotes', nextReviewDate: 'NextReviewDate'
};
const PATIENT_FIELD_TO_COLUMN = {
  patientId: 'PatientID', patientName: 'PatientName', phone: 'Phone', age: 'Age', sex: 'Sex',
  occupation: 'Occupation', email: 'Email', address: 'Address', uhid: 'UHID'
};

function apiSaveAssessment(p) {
  const physioCheck = apiVerifyPhysio({ physioId: p.physioId, password: p.physioPassword });
  if (!physioCheck.ok) return physioCheck;

  const d = p.data || {};
  if (!String(d.patientName || '').trim()) return { ok: false, error: 'Patient name is required' };
  if (!String(d.phone || '').trim()) return { ok: false, error: 'Phone number is required' };
  if (!String(d.date || '').trim()) return { ok: false, error: 'Date is required' };

  const capacity = getCapacityCached_();
  if (capacity.ok && capacity.blocked) {
    return { ok: false, error: 'This database is full (' + capacity.percentUsed + '% of capacity). Ask Super Admin to click "Add New Database" in Admin Settings → Database before saving more records.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const patientResult = apiSavePatient({
      patientId: d.patientId, name: d.patientName, phone: d.phone, age: d.age, sex: d.sex,
      occupation: d.occupation, email: d.email, address: d.address, uhid: d.uhid,
      howKnow: d.howKnow, referredBy: d.referredBy
    });

    const visitId = nextVisitId_();
    const patientVisitId = nextPatientVisitId_(d.phone, d.patientName);

    const now = new Date();
    const row = new Array(VISIT_HEADERS.length).fill('');
    row[V.VisitID] = visitId;
    row[V.PatientVisitID] = patientVisitId;
    Object.keys(PATIENT_FIELD_TO_COLUMN).forEach(f => { row[V[PATIENT_FIELD_TO_COLUMN[f]]] = d[f] !== undefined && d[f] !== null ? d[f] : ''; });
    ASSESSMENT_FIELDS.forEach(f => {
      const col = ASSESSMENT_FIELD_TO_COLUMN[f];
      if (col) row[V[col]] = d[f] !== undefined ? d[f] : '';
    });
    row[V.PhysioID] = physioCheck.physioId;
    row[V.PhysioName] = physioCheck.physioName;
    row[V.SignatureUrl] = physioCheck.signatureUrl || '';
    row[V.CreatedAt] = now;
    row[V.UpdatedAt] = now;
    row[V.UpdatedBy] = physioCheck.physioName;

    const sh = ss_().getSheetByName(SHEET.VISITS);
    sh.appendRow(row);

    // The saved record goes straight back to the browser, so it can show
    // the preview without a second "getAssessment" round trip.
    const assessment = rowToAssessment_(row);
    assessment.archived = false;
    assessment.dbLabel = 'Active';
    return { ok: true, visitId: visitId, patientVisitId: patientVisitId, patientId: patientResult.patientId, assessment: assessment };
  } finally {
    lock.releaseLock();
  }
}

// Editing an EXISTING assessment requires Super Admin, OR a
// physiotherapist re-authorizing with their own password.
function authorizeAssessmentEdit_(p) {
  if (p.superAdminUser || p.superAdminPass) {
    const admin = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
    if (admin.ok) return { ok: true, actor: 'Super Admin' };
    return admin;
  }
  const physio = apiVerifyPhysio({ physioId: p.physioId, password: p.physioPassword });
  if (physio.ok) return { ok: true, actor: physio.physioName, physioId: physio.physioId };
  return { ok: false, error: physio.error || 'Super Admin or the owning physiotherapist must authorize this edit' };
}

// Comparable text form of a cell value (a Date read from the sheet vs the
// 'yyyy-MM-dd' string the browser sends, a number vs its digits, ...).
function cellCompareValue_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return formatDate_(v);
  return String(v);
}

function apiUpdateAssessment(p) {
  const reason = String(p.editReason || '').trim();
  if (!reason) return { ok: false, error: 'Please enter a Reason for Edit before saving changes.' };
  if (reason.length > EDIT_REASON_MAX_LEN) return { ok: false, error: 'Reason for Edit is too long (max ' + EDIT_REASON_MAX_LEN + ' characters).' };

  const auth = authorizeAssessmentEdit_(p);
  if (!auth.ok) return auth;

  const d = p.data || {};
  if (d.patientName !== undefined && !String(d.patientName).trim()) return { ok: false, error: 'Patient name is required' };
  if (d.phone !== undefined && !String(d.phone).trim()) return { ok: false, error: 'Phone number is required' };
  if (d.date !== undefined && !String(d.date).trim()) return { ok: false, error: 'Date is required' };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = ss_().getSheetByName(SHEET.VISITS);
    const rowNum = findVisitRowNumber_(sh, p.visitId);
    if (!rowNum) {
      const archives = openArchives_();
      for (let a = 0; a < archives.length; a++) {
        if (findVisitRowNumber_(archives[a].ss.getSheetByName(SHEET.VISITS), p.visitId)) {
          return { ok: false, error: 'This record is in an archived database ("' + archives[a].label + '") and is read-only.' };
        }
      }
      return { ok: false, error: 'Assessment not found' };
    }

    // ONE read of the row, every change applied in memory, ONE write back
    // (this used to be ~45 separate setValue calls - the slowest part of
    // saving an edit).
    const row = readVisitRow_(sh, rowNum);
    const changed = [];
    const apply = (colName, newVal) => {
      const idx = V[colName];
      if (cellCompareValue_(row[idx]) !== cellCompareValue_(newVal)) {
        row[idx] = newVal;
        changed.push(colName);
      }
    };
    Object.keys(PATIENT_FIELD_TO_COLUMN).forEach(f => { if (d[f] !== undefined) apply(PATIENT_FIELD_TO_COLUMN[f], d[f]); });
    ASSESSMENT_FIELDS.forEach(f => { if (d[f] !== undefined) apply(ASSESSMENT_FIELD_TO_COLUMN[f], d[f]); });

    const now = new Date();
    const log = safeJsonParse_(row[V.EditLog] || '[]', []);
    const logArr = Array.isArray(log) ? log : [];
    logArr.push({ at: fmtDate_(now, 'yyyy-MM-dd HH:mm'), by: auth.actor, reason: reason, fields: changed });
    row[V.UpdatedAt] = now;
    row[V.UpdatedBy] = auth.actor;
    row[V.LastEditReason] = reason;
    row[V.EditLog] = JSON.stringify(logArr.slice(-EDIT_LOG_MAX_ENTRIES));

    sh.getRange(rowNum, 1, 1, VISIT_HEADERS.length).setValues([row]);

    const assessment = rowToAssessment_(row);
    assessment.archived = false;
    assessment.dbLabel = 'Active';
    return { ok: true, visitId: p.visitId, assessment: assessment, changedFields: changed };
  } finally {
    lock.releaseLock();
  }
}

function rowToAssessment_(row) {
  const obj = {};
  VISIT_HEADERS.forEach((h, i) => {
    let v = row[i];
    if (h === 'Date' || h === 'NextReviewDate' || h === 'CreatedAt' || h === 'UpdatedAt') v = formatDate_(v);
    obj[h.charAt(0).toLowerCase() + h.slice(1)] = v === undefined ? '' : v;
  });
  // Consistent camelCase aliases used everywhere on the client.
  obj.visitId = row[V.VisitID]; obj.patientVisitId = row[V.PatientVisitID]; obj.patientId = row[V.PatientID];
  obj.romJson = row[V.ROM_JSON]; obj.mmtJson = row[V.MMT_JSON];
  obj.painMarksJson = row[V.PainMarksJSON]; obj.specialTestsJson = row[V.SpecialTestsJSON];
  obj.treatmentGoalsJson = row[V.TreatmentGoalsJSON]; obj.treatmentPlanJson = row[V.TreatmentPlanJSON];
  obj.updatedAtFull = fmtDate_(row[V.UpdatedAt], 'yyyy-MM-dd HH:mm');
  return obj;
}

// Looks in the active database first, then every archived one.
function apiGetAssessment(visitId) {
  const dbs = allDbs_();
  for (let d = 0; d < dbs.length; d++) {
    const sh = dbs[d].ss.getSheetByName(SHEET.VISITS);
    const rowNum = findVisitRowNumber_(sh, visitId);
    if (!rowNum) continue;
    const assessment = rowToAssessment_(readVisitRow_(sh, rowNum));
    assessment.archived = (d > 0);
    assessment.dbLabel = dbs[d].label;
    return { ok: true, assessment: assessment };
  }
  return { ok: false, error: 'Assessment not found for ID: ' + visitId };
}

// Find/Edit search - Visit ID, Patient ID, phone, name or invoice number.
function apiSearchAssessments(params) {
  const q = String(params.q || '').trim().toLowerCase();
  if (!q) return { ok: true, results: [] };
  const results = [];
  const dbs = allDbs_();
  for (let d = 0; d < dbs.length && results.length < 50; d++) {
    const sh = dbs[d].ss.getSheetByName(SHEET.VISITS);
    const rows = readVisitRows_(sh, ['PatientVisitID', 'PatientID', 'PatientName', 'Phone', 'Date', 'InvoiceNumber', 'IssueType', 'PhysioName']);
    // Newest first within each database.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row[V.VisitID]) continue;
      const hay = [row[V.VisitID], row[V.PatientVisitID], row[V.PatientID], row[V.PatientName], row[V.Phone], row[V.InvoiceNumber]]
        .map(x => String(x || '').toLowerCase()).join(' | ');
      if (hay.indexOf(q) !== -1) {
        results.push({
          visitId: row[V.VisitID], patientVisitId: row[V.PatientVisitID], patientId: row[V.PatientID],
          patientName: row[V.PatientName], phone: row[V.Phone], date: formatDate_(row[V.Date]),
          issueType: row[V.IssueType], invoiceNumber: row[V.InvoiceNumber], physioName: row[V.PhysioName],
          archived: (d > 0), dbLabel: dbs[d].label
        });
        if (results.length >= 50) break;
      }
    }
  }
  return { ok: true, results: results };
}

// ---------------------------------------------------------------------------
// 12. DASHBOARD - one flattened per-visit dataset; every widget filters
//     its own slice client-side. Custom chart definitions and the two
//     running totals ride along, so the whole Dashboard is ONE request.
// ---------------------------------------------------------------------------
function apiGetDashboardRaw() {
  const rows = [];
  const cols = ['Date', 'IssueType', 'HowKnow', 'PhysioName', 'Sex', 'Ambulation', 'StairClimbing', 'ADLs', 'ReferredBy', 'VAS', 'Age', 'Phone', 'PatientName'];
  allDbs_().forEach(db => {
    readVisitRows_(db.ss.getSheetByName(SHEET.VISITS), cols).forEach(row => {
      if (!row[V.VisitID]) return;
      rows.push({
        date: formatDate_(row[V.Date]),
        issueType: String(row[V.IssueType] || 'Unspecified'),
        howKnow: String(row[V.HowKnow] || 'Unspecified'),
        physioName: String(row[V.PhysioName] || 'Unspecified'),
        sex: String(row[V.Sex] || 'Unspecified'),
        ambulation: String(row[V.Ambulation] || 'Unspecified'),
        stairClimbing: String(row[V.StairClimbing] || 'Unspecified'),
        adls: String(row[V.ADLs] || 'Unspecified'),
        referredBy: String(row[V.ReferredBy] || 'Unspecified'),
        vas: row[V.VAS], age: row[V.Age],
        patientKey: patientKey_(row[V.Phone], row[V.PatientName])
      });
    });
  });
  const truncated = rows.length > REPORT_ROW_CAP;
  const patientsSh = ss_().getSheetByName(SHEET.PATIENTS);
  return {
    ok: true, rows: rows.slice(0, REPORT_ROW_CAP), truncated: truncated,
    charts: apiGetCustomCharts().charts,
    patientsCount: patientsSh ? Math.max(0, patientsSh.getLastRow() - 1) : 0,
    issuesCount: apiGetIssues(false).issues.length
  };
}

function apiRefreshDashboardSheet(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  buildUniversalReportSheet_();
  buildDailyReportSheet_();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 13. CUSTOM CHARTS
// ---------------------------------------------------------------------------
function apiGetCustomCharts() {
  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  const data = sh.getDataRange().getValues();
  const charts = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    charts.push({
      chartId: row[0], name: row[1], type: row[2], dataSource: row[3], dimension: row[4],
      metric: row[5], metricField: row[6], topN: row[7], sortDir: row[8], sortOrder: row[9],
      createdAt: formatDate_(row[10]), color: row[11]
    });
  }
  charts.sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
  return { ok: true, charts: charts };
}

function validateChartDef_(p) {
  if (!p.name) return 'Chart name is required';
  if (!['bar', 'pie', 'donut', 'number'].includes(p.type)) return 'Invalid chart type';
  if (!['visits', 'patients', 'issues'].includes(p.dataSource)) return 'Invalid data source';
  if (p.type !== 'number' && p.dataSource === 'visits' && !p.dimension) return 'Group-by dimension is required';
  if (!['sum', 'average', 'count'].includes(p.metric)) return 'Invalid measure';
  return null;
}

function apiSaveCustomChart(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const err = validateChartDef_(p);
  if (err) return { ok: false, error: err };
  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  if (p.chartId) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(p.chartId)) {
        sh.getRange(i + 1, 2, 1, 9).setValues([[p.name, p.type, p.dataSource, p.dimension || '', p.metric, p.metricField || '', p.topN || 0, p.sortDir || 'desc', data[i][9]]]);
        sh.getRange(i + 1, 12).setValue(p.color || '#0f6e5c');
        return { ok: true, chartId: p.chartId };
      }
    }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const id = nextId_(sh, 'CHT');
    const order = sh.getLastRow();
    sh.appendRow([id, p.name, p.type, p.dataSource, p.dimension || '', p.metric, p.metricField || '', p.topN || 0, p.sortDir || 'desc', order, new Date(), p.color || '#0f6e5c']);
    return { ok: true, chartId: id };
  } finally {
    lock.releaseLock();
  }
}

function apiDeleteCustomChart(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.chartId)) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Chart not found' };
}

function apiReorderCustomCharts(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  const data = sh.getDataRange().getValues();
  (p.orderedIds || []).forEach((id, idx) => {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) { sh.getRange(i + 1, 10).setValue(idx); break; }
    }
  });
  return { ok: true };
}

function apiGetCustomChartData(p) {
  const chartsResp = apiGetCustomCharts();
  const chart = chartsResp.charts.find(c => String(c.chartId) === String(p.chartId));
  if (!chart) return { ok: false, error: 'Chart not found' };

  if (chart.dataSource === 'patients') {
    return { ok: true, type: 'number', value: apiGetPatientsList().patients.length, label: 'Total Patients' };
  }
  if (chart.dataSource === 'issues') {
    return { ok: true, type: 'number', value: apiGetIssues(false).issues.length, label: 'Active Issue Types' };
  }

  const dimIdx = V[chart.dimension];
  const metricIdx = chart.metricField ? V[chart.metricField] : null;
  const rows = readVisitRows_(ss_().getSheetByName(SHEET.VISITS), [chart.dimension, chart.metricField].filter(Boolean))
    .filter(r => r[V.VisitID]);

  if (chart.type === 'number') {
    if (chart.metric === 'count') return { ok: true, type: 'number', value: rows.length, label: chart.name };
    let sum = 0;
    rows.forEach(r => { sum += Number(r[metricIdx]) || 0; });
    const value = chart.metric === 'average' ? (rows.length ? sum / rows.length : 0) : sum;
    return { ok: true, type: 'number', value: value, label: chart.name };
  }

  const groups = {};
  rows.forEach(r => {
    const key = String((dimIdx !== undefined ? r[dimIdx] : '') || 'Unspecified');
    if (!groups[key]) groups[key] = { sum: 0, count: 0 };
    groups[key].count++;
    if (metricIdx !== null && metricIdx !== undefined) groups[key].sum += Number(r[metricIdx]) || 0;
  });
  let out = Object.keys(groups).map(k => ({
    label: k,
    value: chart.metric === 'count' ? groups[k].count : (chart.metric === 'average' ? (groups[k].sum / groups[k].count) : groups[k].sum)
  }));
  out.sort((a, b) => chart.sortDir === 'asc' ? a.value - b.value : b.value - a.value);
  const topN = Number(chart.topN) || 0;
  if (topN > 0) out = out.slice(0, topN);
  return { ok: true, type: chart.type, rows: out, color: chart.color };
}

// ---------------------------------------------------------------------------
// 14. DATE / FORMAT UTILITIES
// ---------------------------------------------------------------------------
function fmtDate_(d, pattern, ssRef) {
  if (!d) return '';
  const tz = MEMO_.tz || (MEMO_.tz = (ssRef || ss_()).getSpreadsheetTimeZone());
  try { return Utilities.formatDate(new Date(d), tz, pattern); } catch (e) { return String(d); }
}
function formatDate_(val) {
  if (!val) return '';
  if (Object.prototype.toString.call(val) === '[object Date]') return fmtDate_(val, 'yyyy-MM-dd');
  return String(val);
}
function parseDateOnly_(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return dateOnly_(d);
}
function dateOnly_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function todayDateOnly_() {
  return dateOnly_(new Date());
}
function escHtml_(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Breaks up address text with zero-width spaces so Gmail doesn't auto-link
// fragments of it.
function breakAutoLink_(str) {
  return escHtml_(str).split('').join('&#8203;');
}

// ---------------------------------------------------------------------------
// 15. REPORTS - live, filterable, flattened views.
// ---------------------------------------------------------------------------
const UNIVERSAL_REPORT_COLS = ['PatientVisitID', 'PatientID', 'PatientName', 'Phone', 'Age', 'Sex', 'Occupation', 'Email',
  'Address', 'UHID', 'Date', 'ReferredBy', 'HowKnow', 'InvoiceNumber', 'IssueType', 'ChiefComplaint', 'ClinicalDiagnosis',
  'VAS', 'Ambulation', 'StairClimbing', 'ADLs', 'NextReviewDate', 'PhysioID', 'PhysioName', 'CreatedAt', 'UpdatedAt',
  'UpdatedBy', 'LastEditReason'];

function apiGetUniversalReport() {
  const rows = [];
  allDbs_().forEach(db => {
    readVisitRows_(db.ss.getSheetByName(SHEET.VISITS), UNIVERSAL_REPORT_COLS).forEach(row => {
      if (!row[V.VisitID]) return;
      rows.push({
        visitId: row[V.VisitID], patientVisitId: row[V.PatientVisitID], patientId: row[V.PatientID],
        patientName: row[V.PatientName], phone: row[V.Phone], age: row[V.Age], sex: row[V.Sex],
        occupation: row[V.Occupation], email: row[V.Email], address: row[V.Address], uhid: row[V.UHID],
        date: formatDate_(row[V.Date]), referredBy: row[V.ReferredBy], howKnow: row[V.HowKnow],
        invoiceNumber: row[V.InvoiceNumber], issueType: row[V.IssueType],
        chiefComplaint: row[V.ChiefComplaint], clinicalDiagnosis: row[V.ClinicalDiagnosis],
        vas: row[V.VAS], ambulation: row[V.Ambulation], stairClimbing: row[V.StairClimbing], adls: row[V.ADLs],
        nextReviewDate: formatDate_(row[V.NextReviewDate]),
        physioId: row[V.PhysioID], physioName: row[V.PhysioName],
        createdAt: formatDate_(row[V.CreatedAt]), updatedAt: formatDate_(row[V.UpdatedAt]), updatedBy: row[V.UpdatedBy],
        lastEditReason: row[V.LastEditReason] || '',
        dbLabel: db.label
      });
    });
  });
  rows.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const truncated = rows.length > REPORT_ROW_CAP;
  return { ok: true, rows: rows.slice(0, REPORT_ROW_CAP), truncated: truncated };
}

function apiGetDailyReport() {
  const byDate = {};
  allDbs_().forEach(db => {
    readVisitRows_(db.ss.getSheetByName(SHEET.VISITS), ['Date', 'Phone', 'PatientName', 'IssueType']).forEach(row => {
      if (!row[V.VisitID]) return;
      const date = formatDate_(row[V.Date]);
      if (!byDate[date]) byDate[date] = { date: date, totalVisits: 0, uniquePatients: new Set(), issues: {} };
      byDate[date].totalVisits++;
      byDate[date].uniquePatients.add(patientKey_(row[V.Phone], row[V.PatientName]));
      const issue = String(row[V.IssueType] || 'Unspecified');
      byDate[date].issues[issue] = (byDate[date].issues[issue] || 0) + 1;
    });
  });
  const rows = Object.keys(byDate).sort().reverse().map(date => {
    const d = byDate[date];
    const topIssue = Object.keys(d.issues).sort((a, b) => d.issues[b] - d.issues[a])[0] || '';
    return { date: date, totalVisits: d.totalVisits, uniquePatients: d.uniquePatients.size, topIssue: topIssue };
  });
  return { ok: true, rows: rows };
}

function buildUniversalReportSheet_() {
  const ssRef = ss_();
  let sh = ssRef.getSheetByName(SHEET.UNIVERSAL_REPORT);
  if (!sh) sh = ssRef.insertSheet(SHEET.UNIVERSAL_REPORT);
  sh.clear();
  const rows = apiGetUniversalReport().rows;
  const headers = ['Visit ID', 'Patient Visit ID', 'Patient ID', 'Patient Name', 'Phone', 'Age', 'Sex', 'Occupation',
    'Email', 'Address', 'UHID', 'Date', 'Referred By', 'How Known', 'Invoice No.', 'Issue Type',
    'Chief Complaint', 'Clinical Diagnosis', 'VAS', 'Ambulation', 'Stair Climbing', 'ADLs',
    'Next Review Date', 'Physio ID', 'Physio Name', 'Created At', 'Updated At', 'Updated By', 'Last Edit Reason'];
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0f6e5c').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  if (rows.length) {
    const body = rows.map(r => [r.visitId, r.patientVisitId, r.patientId, r.patientName, r.phone, r.age, r.sex,
      r.occupation, r.email, r.address, r.uhid, r.date, r.referredBy, r.howKnow, r.invoiceNumber, r.issueType,
      r.chiefComplaint, r.clinicalDiagnosis, r.vas, r.ambulation, r.stairClimbing, r.adls, r.nextReviewDate,
      r.physioId, r.physioName, r.createdAt, r.updatedAt, r.updatedBy, r.lastEditReason]);
    sh.getRange(2, 1, body.length, headers.length).setValues(body);
  }
  sh.autoResizeColumns(1, headers.length);
}

function buildDailyReportSheet_() {
  const ssRef = ss_();
  let sh = ssRef.getSheetByName(SHEET.DAILY_REPORT);
  if (!sh) sh = ssRef.insertSheet(SHEET.DAILY_REPORT);
  sh.clear();
  const rows = apiGetDailyReport().rows;
  const headers = ['Date', 'Total Visits', 'Unique Patients', 'Top Issue'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0f6e5c').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows.map(r => [r.date, r.totalVisits, r.uniquePatients, r.topIssue]));
  }
  sh.autoResizeColumns(1, headers.length);
}

// ---------------------------------------------------------------------------
// 16. DATABASE STATUS, CAPACITY MONITORING & "ADD NEW DATABASE"
// ---------------------------------------------------------------------------
const CAPACITY_CELL_LIMIT = 10000000;
const CAPACITY_WARNING_THRESHOLD = 0.75;
const CAPACITY_BLOCK_THRESHOLD = 0.98;

function apiGetCapacityStatus() {
  const ssRef = ss_();
  let totalCells = 0;
  ssRef.getSheets().forEach(sh => { totalCells += sh.getMaxRows() * sh.getMaxColumns(); });
  const pct = totalCells / CAPACITY_CELL_LIMIT;
  return {
    ok: true, totalCells: totalCells, limit: CAPACITY_CELL_LIMIT,
    percentUsed: Math.round(pct * 1000) / 10,
    warning: pct >= CAPACITY_WARNING_THRESHOLD,
    blocked: pct >= CAPACITY_BLOCK_THRESHOLD
  };
}

// Capacity moves by a few hundred cells per visit against a 10,000,000
// ceiling, so a 10-minute cache is plenty accurate and saves ~20 service
// calls on every login and every save.
function getCapacityCached_() {
  const cache = CacheService.getScriptCache();
  const key = 'capacity_' + ss_().getId();
  const cached = cache.get(key);
  if (cached) { try { return JSON.parse(cached); } catch (e) { /* recompute */ } }
  const r = apiGetCapacityStatus();
  try { cache.put(key, JSON.stringify(r), 600); } catch (e) { /* fine */ }
  return r;
}

function apiGetDataDiagnostics(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;

  function dbInfo_(ssRef) {
    const visitsSh = ssRef.getSheetByName(SHEET.VISITS);
    const patientsSh = ssRef.getSheetByName(SHEET.PATIENTS);
    const physiosSh = ssRef.getSheetByName(SHEET.PHYSIOS);
    let totalCells = 0;
    ssRef.getSheets().forEach(sh => { totalCells += sh.getMaxRows() * sh.getMaxColumns(); });
    return {
      name: ssRef.getName(), url: ssRef.getUrl(),
      percentUsed: Math.round((totalCells / CAPACITY_CELL_LIMIT) * 1000) / 10,
      rowCounts: {
        visits: Math.max(0, (visitsSh ? visitsSh.getLastRow() : 1) - 1),
        patients: Math.max(0, (patientsSh ? patientsSh.getLastRow() : 1) - 1),
        physios: Math.max(0, (physiosSh ? physiosSh.getLastRow() : 1) - 1)
      }
    };
  }

  const activeSs = ss_();
  const activeInfo = dbInfo_(activeSs);
  const active = {
    name: activeInfo.name, url: activeInfo.url, percentUsed: activeInfo.percentUsed,
    rowCounts: activeInfo.rowCounts, reachable: true,
    nextVisitId: peekNextVisitId_()
  };

  const archives = getArchiveRegistry_().map(entry => {
    try {
      const info = dbInfo_(SpreadsheetApp.openById(entry.id));
      return { label: entry.label || entry.id, name: info.name, url: info.url, percentUsed: info.percentUsed, rowCounts: info.rowCounts, reachable: true };
    } catch (e) {
      return { label: entry.label || entry.id, name: '(not reachable - deleted or unshared)', url: '', percentUsed: 0, rowCounts: null, reachable: false };
    }
  });

  return { ok: true, active: active, archives: archives };
}

function apiAutoExpandDatabase(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const oldSs = ss_();
    const oldId = oldSs.getId();
    const tz = oldSs.getSpreadsheetTimeZone() || 'Etc/UTC';
    const timestamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
    const label = (p.label && String(p.label).trim())
      ? String(p.label).trim()
      : ('Archived ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
    const clinicName = getSettingsMap_().ClinicName || 'Physiotherapy';
    const newName = clinicName + ' - Patient Records DB (' + timestamp + ')';

    const newSs = createFreshDatabaseSpreadsheet_(newName);
    copyMasterDataForward_(oldSs, newSs);

    const props = PropertiesService.getScriptProperties();
    const registry = getArchiveRegistry_();
    registry.push({ id: oldId, label: label, archivedAt: new Date().toISOString() });
    props.setProperty('ARCHIVE_SPREADSHEET_IDS', JSON.stringify(registry));
    props.setProperty('ACTIVE_SPREADSHEET_ID', newSs.getId());
    resetMemo_();

    return {
      ok: true, archivedLabel: label, newSpreadsheetName: newName,
      newSpreadsheetUrl: newSs.getUrl(), newSpreadsheetId: newSs.getId()
    };
  } catch (err) {
    return { ok: false, error: 'Could not create the new database automatically: ' + err };
  } finally {
    lock.releaseLock();
  }
}

function apiResetToActiveOnly(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('ARCHIVE_SPREADSHEET_IDS');
    MEMO_.archives = null;

    const activeSs = ss_();
    const visitsSh = activeSs.getSheetByName(SHEET.VISITS);
    const issuesSh = activeSs.getSheetByName(SHEET.ISSUES);
    const visitMax = highestExistingIdSuffix_(visitsSh, V.VisitID);
    const issueMax = highestExistingIdSuffix_(issuesSh, 0);
    props.setProperty('IDCTR_PAF', String(visitMax));
    props.setProperty('IDCTR_ISS', String(issueMax));

    return { ok: true, nextVisitId: 'PAF-' + Utilities.formatString('%06d', visitMax + 1) };
  } catch (err) {
    return { ok: false, error: 'Could not reset: ' + err };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 17. PRINT / PDF / EMAIL - the printed Physiotherapy Assessment Sheet.
// ---------------------------------------------------------------------------

// Must stay IN SYNC with ROM_STRUCTURE in app.js.
const ROM_STRUCTURE = {
  Shoulder: ['Flexion', 'Extension', 'Abduction', 'Adduction', 'IR', 'ER'],
  Elbow: ['Flexion', 'Extension'],
  Wrist: ['Flexion', 'Extension'],
  Hip: ['Flexion', 'Extension', 'Abduction', 'Adduction', 'IR', 'ER'],
  Knee: ['Flexion', 'Extension'],
  Ankle: ['DF', 'PF'],
  Neck: ['Flexion', 'Extension', 'Lateral Flexion'],
  Forearm: ['Pronation', 'Supination']
};

// Fetches an image once and caches the data URI for 6 hours (when it fits
// in CacheService's 100KB-per-value limit), so the logo and the four body
// images aren't re-downloaded for every PDF / email.
function getLogoDataUri_(url) {
  if (!url || /via\.placeholder\.com/i.test(url)) return '';
  const cache = CacheService.getScriptCache();
  const key = 'img_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, url));
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return '';
    const blob = resp.getBlob();
    const contentType = blob.getContentType() || 'image/png';
    const uri = 'data:' + contentType + ';base64,' + Utilities.base64Encode(blob.getBytes());
    try { cache.put(key, uri, 21600); } catch (e) { /* larger than 100KB - just re-fetch next time */ }
    return uri;
  } catch (err) {
    return '';
  }
}

function safeJsonParse_(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function fld_(label, value, s) {
  const labelHtml = label ? '<span class="fl-label" style="color:' + (s.ThemeFieldLabelColor || '#2778b7') + '">' + escHtml_(label) + ': </span>' : '';
  const shown = (value === null || value === undefined || value === '') ? '-' : value;
  return '<div class="doc-field">' + labelHtml +
    '<span class="fl-value" style="color:' + (s.ThemeFieldValueColor || '#000000') + '">' + escHtml_(shown) + '</span>' +
    '</div>';
}

function romTableHtml_(jsonStr, s) {
  const dataObj = safeJsonParse_(jsonStr, {}) || {};
  let rows = '';
  Object.keys(ROM_STRUCTURE).forEach(joint => {
    const movements = ROM_STRUCTURE[joint];
    movements.forEach((m, idx) => {
      const cell = (dataObj[joint] && dataObj[joint][m]) || { R: '', L: '' };
      rows += '<tr>' +
        (idx === 0 ? '<td class="rom-joint" rowspan="' + movements.length + '">' + escHtml_(joint) + '</td>' : '') +
        '<td>' + escHtml_(m) + '</td><td class="num">' + escHtml_(cell.R) + '</td><td class="num">' + escHtml_(cell.L) + '</td></tr>';
    });
  });
  return '<table class="rom-table"><thead><tr><th colspan="2">Movement</th><th>Right</th><th>Left</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function specialTestsTableHtml_(jsonStr) {
  const rows = safeJsonParse_(jsonStr, []) || [];
  if (!rows.length) return '<table class="special-tests-table"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody><tr><td colspan="2" class="muted">No special tests recorded</td></tr></tbody></table>';
  const body = rows.map(r => '<tr><td>' + escHtml_(r.test) + '</td><td>' + escHtml_(r.result) + '</td></tr>').join('');
  return '<table class="special-tests-table"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody>' + body + '</tbody></table>';
}

function listHtml_(jsonStr) {
  const items = safeJsonParse_(jsonStr, []) || [];
  if (!items.length) return '<div class="muted">None recorded</div>';
  return '<ol class="doc-list">' + items.map(i => '<li>' + escHtml_(i) + '</li>').join('') + '</ol>';
}

// The four body-map views - the clinic's own reference images. Must stay
// identical to BODY_VIEWS in app.js. (https: the http:// links were being
// silently upgraded or blocked as "mixed content" on the https site.)
const BODY_VIEW_IMAGES = {
  front: 'https://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Front-View.png',
  back: 'https://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Back-View.png',
  right: 'https://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Right-Facing-View.png',
  left: 'https://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Left-Facing-View.png'
};

function getBodyViewDataUri_(view) {
  return getLogoDataUri_(BODY_VIEW_IMAGES[view]);
}

function bodyDiagramsHtml_(painMarksJson) {
  const marks = safeJsonParse_(painMarksJson, []) || [];
  const views = [
    { key: 'front', label: 'FRONT VIEW' }, { key: 'back', label: 'BACK VIEW' },
    { key: 'right', label: 'RIGHT SIDE VIEW' }, { key: 'left', label: 'LEFT SIDE VIEW' }
  ];
  const cells = views.map(v => {
    const src = getBodyViewDataUri_(v.key) || BODY_VIEW_IMAGES[v.key];
    const dots = marks.filter(m => m.view === v.key).map(m =>
      '<span class="doc-mark-dot" style="left:' + Number(m.x) + '%;top:' + Number(m.y) + '%;background-color:' + escHtml_(m.color) + '"></span>'
    ).join('');
    return '<div class="doc-body-view">' +
      '<span class="doc-body-img-wrap"><img src="' + src + '">' + dots + '</span>' +
      '<div class="doc-body-view-label">' + v.label + '</div></div>';
  }).join('');
  return '<div class="doc-body-diagrams">' + cells + '</div>' +
    '<div class="body-legend"><span><i style="background-color:#d1352f"></i> Pain Point</span> <span><i style="background-color:#2778b7"></i> Radiating Point</span></div>';
}

function checkboxRow_(label, checked, s) {
  return '<span class="pmh-item"><span class="chk">' + (checked ? '&#9745;' : '&#9744;') + '</span> ' +
    '<span style="color:' + (s.ThemeFieldLabelColor || '#2778b7') + '">' + escHtml_(label) + '</span></span>';
}

// ONE continuous document shared (class names + section order) with
// buildAssessmentDocHtml_ in app.js.
function buildAssessmentHtmlForPdf_(a, s) {
  const logo = getLogoDataUri_(s.PrintLogoURL || s.LogoURL);
  const font = s.ThemeDocFontFamily || "Georgia, 'Times New Roman', Times, serif";
  const headerFrom = s.ThemeDocHeaderColor || '#2778b7';
  const headerTo = s.ThemeDocHeaderColorTo || '#a8d339';
  const labelColor = s.ThemeFieldLabelColor || '#2778b7';
  const headingColor = s.ThemeHeadingColor || '#182322';

  const pmh = [checkboxRow_('DM', truthy_(a.pMH_DM), s), checkboxRow_('HTN', truthy_(a.pMH_HTN), s),
    checkboxRow_('Thyroid', truthy_(a.pMH_Thyroid), s), checkboxRow_('Cardiac', truthy_(a.pMH_Cardiac), s)].join(' &nbsp; ');

  const vasScale = [...Array(11).keys()].map(n =>
    '<span class="vas-num' + (String(n) === String(a.vAS) ? ' vas-active' : '') + '">' + n + '</span>').join('');

  const signatureImg = a.signatureUrl ? '<img class="sig-img" src="' + escHtml_(a.signatureUrl) + '">' : '<div class="sig-line"></div>';

  return '<html><head><meta charset="utf-8"><style>' + docPrintCss_(font, headerFrom, headerTo, headingColor) + '</style></head><body>' +
    docHeaderHtml_(s, logo, headerFrom, headerTo) +
    '<div class="doc-title-bar" style="background-image:linear-gradient(135deg,' + headerFrom + ' 0%,' + headerTo + ' 100%)">PHYSIOTHERAPY ASSESSMENT SHEET</div>' +

    '<div class="doc-page">' +

    '<div class="doc-section">' +
    '<div class="section-band">Patient Details</div>' +
    '<div class="doc-row cols-4">' + fld_('Patient Name', a.patientName, s) + fld_('Date', a.date, s) + fld_('Referred By', a.referredBy, s) + fld_('Age / Sex', (a.age || '-') + ' / ' + (a.sex || '-'), s) + '</div>' +
    '<div class="doc-row cols-4">' + fld_('UHID / File No.', a.uHID, s) + fld_('Contact No.', a.phone, s) + fld_('Occupation', a.occupation, s) + fld_('Email ID', a.email, s) + '</div>' +
    '<div class="doc-row cols-3">' + fld_('Address', a.address, s) + fld_('How They Knew Us', a.howKnow, s) + fld_('Invoice No.', a.invoiceNumber, s) + '</div>' +
    '<div class="doc-row cols-1">' + fld_('Issue Type', a.issueType, s) + '</div>' +
    '<div class="doc-row cols-2">' + fld_('Chief Complaint', a.chiefComplaint, s) + fld_('History of Present Illness', a.historyOfPresentIllness, s) + '</div>' +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Observation &amp; Pain Assessment</div>' +
    '<div class="doc-row cols-3">' + fld_('Posture', a.posture, s) + fld_('Gait', a.obsGait, s) + fld_('Deformity / Swelling', a.deformitySwelling, s) + '</div>' +
    '<div class="doc-field"><span class="fl-label" style="color:' + labelColor + '">Pain Assessment (VAS): </span></div>' +
    '<div class="vas-row">' + vasScale + '</div>' +
    '<div class="doc-row cols-3">' + fld_('Nature of Pain', a.natureOfPain, s) + fld_('Aggravating Factors', a.aggravatingFactors, s) + fld_('Relieving Factors', a.relievingFactors, s) + '</div>' +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Past Medical History</div>' +
    '<div class="pmh-row">' + pmh + '</div>' + fld_('Surgery / Fracture / Hospitalization', a.surgeryFractureHospitalization, s) +
    '</div>' +

    '<div class="doc-section flow">' +
    '<div class="section-band">Range of Motion (ROM)</div>' + romTableHtml_(a.romJson, s) +
    '</div>' +
    '<div class="doc-section flow">' +
    '<div class="section-band">Muscle Strength (MMT)</div>' + romTableHtml_(a.mmtJson, s) +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Mark Pain Point &amp; Radiating Point</div>' + bodyDiagramsHtml_(a.painMarksJson) +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Special Tests</div>' + specialTestsTableHtml_(a.specialTestsJson) +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Functional Assessment</div>' +
    // a.aDLs - the header "ADLs" becomes "aDLs" (it was a.adLs, so the
    // emailed PDF always printed "-" for ADLs).
    '<div class="doc-row cols-3">' + fld_('Ambulation', a.ambulation, s) + fld_('Stair Climbing', a.stairClimbing, s) + fld_('ADLs', a.aDLs, s) + '</div>' +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Balance</div>' +
    '<div class="doc-row cols-2">' + fld_('Single Leg Stance', a.balanceSingleLegStance, s) + fld_('Romberg Test', a.balanceRombergTest, s) + '</div>' +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Gait</div>' +
    '<div class="doc-row cols-3">' + fld_('Pattern', a.gaitPattern, s) + fld_('Cadence', a.gaitCadence, s) + fld_('Limping', a.gaitLimping, s) + '</div>' +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Clinical Diagnosis</div>' + fld_('', a.clinicalDiagnosis, s) +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="doc-row cols-2">' +
      '<div><div class="doc-field"><span class="fl-label" style="color:' + labelColor + '">Treatment Goals</span></div>' + listHtml_(a.treatmentGoalsJson) + '</div>' +
      '<div><div class="doc-field"><span class="fl-label" style="color:' + labelColor + '">Treatment Plan</span></div>' + listHtml_(a.treatmentPlanJson) + '</div>' +
    '</div>' +
    '</div>' +

    '<div class="doc-section">' +
    '<div class="section-band">Follow Up / Notes</div>' +
    '<div class="notes-box">' + escHtml_(a.followUpNotes || '').replace(/\n/g, '<br>') + '</div>' +
    '</div>' +

    '<div class="doc-footer-section footer-row">' +
      '<div>' + fld_('Next Review Date', a.nextReviewDate, s) + '</div>' +
      '<div class="sig-block">' + signatureImg + '<div class="sig-caption">' + escHtml_(a.physioName || 'Physiotherapist') + '<br><span class="muted">Physiotherapist Signature</span></div></div>' +
    '</div>' +

    '<div class="doc-footer-section record-ids">Visit ID: ' + escHtml_(a.visitId) + ' &nbsp;|&nbsp; Patient Visit ID: ' + escHtml_(a.patientVisitId) + '</div>' +
    '<div class="doc-footer-section tagline" style="color:' + headerFrom + '">Move Better. Live Better.</div>' +
    '</div>' +
    '</body></html>';
}

// Diagonal gradient header band, clinic-info text white. Honors the
// Theme tab's "Header Layout" (logo beside / above the company info).
function docHeaderHtml_(s, logo, headerFrom, headerTo) {
  const logoW = (s.ThemeDocLogoWidth || 96) + 'px', logoH = (s.ThemeDocLogoHeight || 58) + 'px';
  const nameStyle = 'font-weight:' + (truthy_(s.ThemeDocCompanyNameBold) ? 'bold' : 'normal') +
    ';font-style:' + (truthy_(s.ThemeDocCompanyNameItalic) ? 'italic' : 'normal') +
    ';text-decoration:' + (truthy_(s.ThemeDocCompanyNameUnderline) ? 'underline' : 'none');
  const infoStyle = 'font-weight:' + (truthy_(s.ThemeDocCompanyInfoBold) ? 'bold' : 'normal') +
    ';font-style:' + (truthy_(s.ThemeDocCompanyInfoItalic) ? 'italic' : 'normal') +
    ';text-decoration:' + (truthy_(s.ThemeDocCompanyInfoUnderline) ? 'underline' : 'none');
  const layout = s.ThemeDocHeaderLayout === 'logo-top' ? 'flex-direction:column;align-items:flex-start;' : '';
  return '<div class="doc-header-band" style="' + layout + 'background-image:linear-gradient(135deg,' + headerFrom + ' 0%,' + headerTo + ' 100%)">' +
    (logo ? '<img class="doc-logo" style="width:' + logoW + ';height:' + logoH + '" src="' + logo + '">' : '') +
    '<div class="doc-header-text">' +
      '<div class="doc-company-name" style="color:#FFFFFF;' + nameStyle + '">' + escHtml_(s.ClinicName) + '</div>' +
      '<div class="doc-company-info" style="color:#FFFFFF;' + infoStyle + '">' + escHtml_(s.Address) + '</div>' +
      '<div class="doc-company-info" style="color:#FFFFFF;' + infoStyle + '">' + escHtml_(s.Phone) +
        (truthy_(s.ShowClinicEmail) && s.ClinicEmail ? ' &nbsp;|&nbsp; ' + escHtml_(s.ClinicEmail) : '') +
        (s.Website ? ' &nbsp;|&nbsp; ' + escHtml_(s.Website) : '') + '</div>' +
    '</div></div>';
}

function docPrintCss_(font, headerFrom, headerTo, headingColor) {
  return '*{-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact;}' +
    'html,body{width:800px;}' +
    'body{font-family:' + font + ';color:#000000;margin:0;padding:18px 26px;line-height:1.5;}' +
    '.doc-header-band{display:flex;align-items:center;gap:14px;padding:12px 16px;margin-bottom:0;}' +
    '.doc-logo{object-fit:contain;}' +
    '.doc-company-name{font-size:20px;} .doc-company-info{font-size:11.5px;line-height:1.4;}' +
    '.doc-title-bar{color:#fff;text-align:center;font-weight:bold;letter-spacing:1px;padding:6px;font-size:13px;margin-bottom:12px;}' +
    '.doc-section{page-break-inside:avoid;break-inside:avoid;margin-bottom:10px;}' +
    '.doc-section.flow{page-break-inside:auto;break-inside:auto;}' +
    'table.rom-table thead,table.special-tests-table thead{display:table-header-group;}' +
    'table.rom-table tr,table.special-tests-table tr{page-break-inside:avoid;break-inside:avoid;}' +
    '.section-band{padding:5px 10px;font-weight:800;font-size:12.5px;margin:16px 0 8px;border-radius:5px;background-color:#FCE2DC;color:' + headingColor + ';}' +
    '.doc-row{display:flex;flex-wrap:wrap;gap:4px 20px;margin-bottom:2px;}' +
    '.doc-row.cols-1>.doc-field,.doc-row.cols-1>div{flex:1 1 100%;}' +
    '.doc-row.cols-2>.doc-field,.doc-row.cols-2>div{flex:1 1 calc(50% - 20px);min-width:200px;}' +
    '.doc-row.cols-3>.doc-field,.doc-row.cols-3>div{flex:1 1 calc(33.333% - 20px);min-width:160px;}' +
    '.doc-row.cols-4>.doc-field,.doc-row.cols-4>div{flex:1 1 calc(25% - 20px);min-width:140px;}' +
    '.doc-field{font-size:12px;padding:3px 0;line-height:1.5;} .fl-label{font-weight:bold;} .muted{color:#8a938f;font-style:italic;}' +
    '.vas-row{display:flex;justify-content:space-between;max-width:420px;margin:6px 0 10px;font-size:11px;}' +
    '.vas-num{width:18px;height:18px;border:1px solid #999;border-radius:50%;text-align:center;line-height:18px;}' +
    '.vas-active{background-color:#d1352f;color:#fff;border-color:#d1352f;font-weight:bold;}' +
    '.pmh-row{font-size:12px;margin-bottom:6px;} .pmh-item{margin-right:14px;} .chk{font-size:14px;}' +
    'table.rom-table,table.special-tests-table{border-collapse:collapse;width:100%;font-size:11px;margin-bottom:8px;}' +
    'table.rom-table th,table.rom-table td,table.special-tests-table th,table.special-tests-table td{border:1px solid #ccc;padding:4px 7px;text-align:left;}' +
    'table.rom-table .num,table.special-tests-table .num{text-align:center;width:70px;}' +
    '.rom-joint{font-weight:bold;background-color:#f5f5f5;vertical-align:top;}' +
    '.doc-body-diagrams{display:flex;gap:8px;justify-content:space-around;margin-bottom:8px;background:#fff;}' +
    '.doc-body-view{text-align:center;width:23%;background:#fff;}' +
    '.doc-body-img-wrap{position:relative;display:inline-block;max-width:100%;}' +
    '.doc-body-img-wrap img{max-width:100%;max-height:205px;width:auto;height:auto;display:block;margin:0 auto;}' +
    '.doc-mark-dot{position:absolute;width:7px;height:7px;border-radius:50%;border:1px solid #fff;transform:translate(-50%,-50%);box-shadow:0 0 0 0.5px rgba(0,0,0,0.35);}' +
    '.doc-body-view-label{font-size:9.5px;font-weight:bold;color:#4B5A57;margin-top:3px;}' +
    '.body-legend{width:100%;font-size:10px;margin-top:4px;} .body-legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:3px;}' +
    '.doc-list{margin:2px 0 8px;padding-left:18px;font-size:12px;line-height:1.5;}' +
    '.notes-box{border:1px solid #ddd;min-height:90px;padding:6px 8px;font-size:12px;border-radius:3px;line-height:1.5;}' +
    '.footer-row{display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px;}' +
    '.sig-block{text-align:center;} .sig-img{max-width:150px;max-height:60px;display:block;margin:0 auto 4px;}' +
    '.sig-line{width:150px;border-bottom:1px solid #333;height:44px;}' +
    '.sig-caption{font-size:11px;} .record-ids{font-size:9.5px;color:#8a938f;margin-top:12px;}' +
    '.tagline{text-align:center;font-style:italic;font-size:11px;margin-top:4px;}';
}

// Builds the same PDF that gets emailed and hands it back to the browser
// as base64 - this is what "Save as PDF" uses on phones and tablets, where
// the browser's own print-to-PDF is missing (in-app browsers, home-screen
// apps) or unreliable.
function apiGetAssessmentPdf(p) {
  const res = apiGetAssessment(p.visitId);
  if (!res.ok) return res;
  const a = res.assessment;
  const s = apiGetSettingsPublic().settings;
  try {
    const blob = HtmlService.createHtmlOutput(buildAssessmentHtmlForPdf_(a, s)).getAs('application/pdf');
    const safeName = String(a.patientName || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const fileName = 'Assessment-' + a.visitId + (safeName ? '-' + safeName : '') + '.pdf';
    return { ok: true, fileName: fileName, mimeType: 'application/pdf', base64: Utilities.base64Encode(blob.getBytes()) };
  } catch (err) {
    return { ok: false, error: 'Could not build the PDF: ' + (err && err.message ? err.message : err) };
  }
}

// ---------------------------------------------------------------------------
// 19. EMAIL / SHARE
// ---------------------------------------------------------------------------
function apiEmailAssessmentPdf(p) {
  const email = String(p.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address' };
  const res = apiGetAssessment(p.visitId);
  if (!res.ok) return res;
  const a = res.assessment;
  const s = apiGetSettingsPublic().settings;
  try {
    const pdfHtml = buildAssessmentHtmlForPdf_(a, s);
    const pdfBlob = HtmlService.createHtmlOutput(pdfHtml).getAs('application/pdf').setName('Assessment-' + a.visitId + '.pdf');
    const emailHtml = buildBrandedEmailShell_(s, buildEmailAssessmentBodyHtml_(a, s));
    MailApp.sendEmail({
      to: email,
      name: s.ClinicName || 'Physiotherapy Assessment',
      subject: 'Physiotherapy Assessment - ' + a.patientName + ' (' + a.visitId + ')',
      htmlBody: emailHtml,
      attachments: [pdfBlob]
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Could not send email: ' + err.message };
  }
}

function apiGetEmailPreview(p) {
  const res = apiGetAssessment(p.visitId);
  if (!res.ok) return res;
  const s = apiGetSettingsPublic().settings;
  return { ok: true, html: buildBrandedEmailShell_(s, buildEmailAssessmentBodyHtml_(res.assessment, s)) };
}

function buildEmailAssessmentBodyHtml_(a, s) {
  const ink = '#000000';
  const border = s.ThemeBorderColor || '#E0E0E0';
  const font = "font-family:Georgia,'Times New Roman',Times,serif;";

  const rows = [
    ['Visit ID', a.visitId], ['Date', a.date], ['Patient', a.patientName], ['Issue Type', a.issueType],
    ['Clinical Diagnosis', a.clinicalDiagnosis], ['Next Review Date', a.nextReviewDate], ['Physiotherapist', a.physioName]
  ];
  const rowsHtml = rows.map(r =>
    '<tr>' +
    '<td style="padding:12px 10px;border-bottom:1px solid ' + border + ';' + font + 'font-size:14px;line-height:22px;color:' + ink + ';">' + escHtml_(r[0]) + '</td>' +
    '<td align="right" style="padding:12px 10px;border-bottom:1px solid ' + border + ';' + font + 'font-size:14px;line-height:22px;color:' + ink + ';font-weight:700;">' + escHtml_(r[1] || '-') + '</td>' +
    '</tr>'
  ).join('');

  return '' +
    '<tr><td align="left" style="' + font + 'font-size:14px;line-height:22px;color:' + ink + ';padding-bottom:22px;">' +
    '<b>Dear ' + escHtml_(a.patientName || 'Patient') + ',</b><br><br>' +
    'Thank you for visiting ' + escHtml_(s.ClinicName || 'us') + '. Here’s a summary of your physiotherapy assessment, Visit <b>' + escHtml_(String(a.visitId)) + '</b>, dated ' + escHtml_(a.date) + '. The full assessment sheet is also attached to this email as a PDF.' +
    '</td></tr>' +
    '<tr><td style="padding-bottom:22px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ' + border + ';border-radius:10px;overflow:hidden;">' +
    rowsHtml +
    '</table>' +
    '</td></tr>' +
    '<tr><td align="left" style="' + font + 'font-size:14px;line-height:22px;color:' + ink + ';">' +
    'Questions about this assessment? Just reply to this email' + (s.Phone ? ' or call us at <b>' + escHtml_(s.Phone) + '</b>' : '') + '.<br><br>' +
    'Warm regards,<br><b>Team ' + escHtml_(s.ClinicName || '') + '</b>' +
    '</td></tr>';
}

// The reusable branded email shell (logo linked live, never base64 -
// keeps the email under MailApp's body-size limit).
function buildBrandedEmailShell_(s, bodyRowsHtml) {
  const font = "Georgia, 'Times New Roman', Times, serif";
  const gradFrom = '#2778b7';
  const gradTo = '#a8d339';
  const gradText = '#FFFFFF';
  const logo = 'https://sjphysiotherapy.in/LOGO/SJ-PHYSIOTHERAPY-EMAIL-LOGO.png';
  const companyName = escHtml_(s.ClinicName || '');

  const ICONS_BASE = 'https://sjphysiotherapy.in/SOCIAL%20MEDIA/';
  const socialDefs = [
    s.Phone ? { icon: 'PHONE-E.png', href: 'tel:+91' + String(s.Phone).replace(/[^0-9]/g, '').slice(-10), alt: 'Phone' } : null,
    s.ClinicEmail ? { icon: 'MAIL-E.png', href: 'mailto:' + s.ClinicEmail, alt: 'Mail' } : null,
    s.SocialWhatsapp ? { icon: 'WA-E.png', href: 'https://wa.me/' + String(s.SocialWhatsapp).replace(/[^0-9]/g, ''), alt: 'WhatsApp' } : null,
    s.SocialLinkedin ? { icon: 'LINKEDIN-E.png', href: s.SocialLinkedin, alt: 'LinkedIn' } : null,
    s.SocialInstagram ? { icon: 'INSTA-E.png', href: s.SocialInstagram, alt: 'Instagram' } : null,
    s.SocialFacebook ? { icon: 'FACEBOOK-E.png', href: s.SocialFacebook, alt: 'Facebook' } : null,
    s.SocialYoutube ? { icon: 'YOUTUBE-E.png', href: s.SocialYoutube, alt: 'YouTube' } : null
  ].filter(Boolean);

  const socialHtml = socialDefs.length
    ? '<tr><td align="center" style="padding:0 0 32px;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      socialDefs.map(function (d) {
        return '<td style="padding:0 9px;"><a href="' + escHtml_(d.href) + '" target="_blank" style="text-decoration:none;"><img src="' + ICONS_BASE + d.icon + '" width="32" height="32" alt="' + d.alt + '" style="display:block;width:32px;height:32px;border:0;"></a></td>';
      }).join('') +
      '</tr></table></td></tr>'
    : '';

  return '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">' +
    '<style>' +
    'html,body{margin:0!important;padding:0!important;height:100%!important;width:100%!important;}' +
    '*{-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;}' +
    'table,td{mso-table-lspace:0pt!important;mso-table-rspace:0pt!important;border-collapse:collapse!important;}' +
    'img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}' +
    'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;}' +
    'body{font-family:' + font + ';}' +
    '@media only screen and (max-width:600px){' +
    '.eml-pad{padding-left:22px!important;padding-right:22px!important;}' +
    '.eml-logo{width:325px!important;}' +
    '.eml-table td{font-size:13px!important;padding:10px 6px!important;}' +
    '}' +
    '</style></head>' +
    '<body style="margin:0;padding:0;background-color:#eef3f6;width:100%;" bgcolor="#eef3f6">' +
    '<center style="width:100%;background-color:#eef3f6;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#eef3f6;"><tr><td align="center" style="padding:0;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background-color:#ffffff;">' +

    '<tr><td style="padding:0;">' +
    '<div style="background-color:' + gradFrom + ';background-image:linear-gradient(135deg, ' + gradFrom + ' 0%, ' + gradTo + ' 100%);">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td align="center" class="eml-pad" style="padding:40px 40px;">' +
    '<img src="' + logo + '" class="eml-logo" width="500" alt="' + companyName + '" style="display:block;width:500px;max-width:80%;height:auto;margin:0 auto;border:0;">' +
    '</td></tr></table></div></td></tr>' +

    '<tr><td style="padding:0;background-color:#ffffff;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td align="center" class="eml-pad" style="padding:46px 48px 34px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="eml-table">' +
    bodyRowsHtml +
    '</table></td></tr></table></td></tr>' +

    '<tr><td style="padding:0;">' +
    '<div style="background-color:' + gradFrom + ';background-image:linear-gradient(135deg, ' + gradFrom + ' 0%, ' + gradTo + ' 100%);">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td align="center" class="eml-pad" style="padding:42px 40px 36px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td align="center" style="padding:0 0 24px;font-size:15px;line-height:26px;color:' + gradText + ';font-family:' + font + ';">' +
    '<b>' + companyName + '</b>' + (s.Address ? ' &nbsp;' + breakAutoLink_(s.Address) : '') +
    '</td></tr></table>' +
    socialHtml +
    '</td></tr></table></div></td></tr>' +

    '</table></td></tr></table></center></body></html>';
}
