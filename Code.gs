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
 *    are saved as a tiny JSON array of {view, x%, y%, type, color, label}
 *    coordinates in PainMarksJSON. The SAME base SVG outline + the SAME
 *    JSON-to-dots renderer is used on screen AND in print/PDF, so what you
 *    mark is pixel-identical wherever it's shown, at any resolution, using
 *    almost no storage.
 *  - ROM / MMT / Special Tests / Treatment Goals / Treatment Plan are all
 *    small structured sub-forms with a fixed or dynamic shape that doesn't
 *    belong as 100+ separate spreadsheet columns - each is stored as one
 *    JSON string in a single cell (exactly like BillItems is a separate
 *    sheet in the billing app - just implemented as an inline column here
 *    since each visit has exactly one of each, not a variable list of rows).
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
const BACKEND_BUILD = 'SJP-PAF-2026-09-17-01';

const REPORT_ROW_CAP = 5000; // sane ceiling so a huge sheet can never hang the Reports screen

// Fixed set of referral-source options shown on the assessment form and
// used for the "How did they hear about us" donut chart. Kept as a plain
// server-side constant (not editable in the sheet) since the clinic asked
// for exactly this fixed list - see HOWKNOW_OPTIONS usage in apiBootstrap.
const HOWKNOW_OPTIONS = ['Friends/Relatives', 'Instagram', 'Facebook', 'Google', 'LinkedIn', 'Another Hospital/Doctor', 'Others'];

const AMBULATION_OPTIONS = ['Independent', 'Assisted'];

// Theme customization - Super Admin only, applied live across the whole
// app (sidebar, buttons, charts, printed assessment header). Stored as
// plain Settings key/value rows, same mechanism as the billing app's
// theme engine, so no separate sheet is needed. Colors below intentionally
// match the billing app's own defaults byte-for-byte - same clinic, same
// brand, one consistent look across both systems.
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

  // --- Printed assessment sheet design - one shared design used everywhere
  //     the record is shown: on-screen preview, Print, Save-as-PDF, and the
  //     emailed PDF/email body. ---
  ['ThemeDocFontFamily', "Georgia, 'Times New Roman', Times, serif"],
  ['ThemeDocLogoWidth', '96'],
  ['ThemeDocLogoHeight', '58'],

  // Point 20 - field NAMES get their own colour on print/PDF, distinct from
  // the value typed in, so a printed sheet is easy to scan.
  ['ThemeFieldLabelColor', '#2778b7'],
  ['ThemeFieldValueColor', '#000000'],
  ['ThemeSectionBandColor', '#eaf6f1'],

  // --- Buttons - normal AND hover colors, both the solid/gradient
  //     "primary" style and the bordered "secondary/outline" style. ---
  ['ThemeButtonHoverFrom', '#8fc22c'],
  ['ThemeButtonHoverTo', '#1f5f8f'],
  ['ThemeOutlineText', '#2778b7'],
  ['ThemeOutlineBorder', '#2778b7'],
  ['ThemeOutlineHoverBg', '#EAF3FB'],
  ['ThemeOutlineHoverText', '#2778b7']
];

// The clinic's real social links - SocialWhatsapp stays a bare number (the
// email/footer code builds the wa.me link itself: 'https://wa.me/' + digits
// only), the rest are stored as the full profile URL and used as-is.
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

// The main record sheet - "Physiotherapy Assessment Form" - one row = one
// visit/assessment. Column order matters - every apiXxx function below
// that reads/writes this sheet by index depends on this exact order.
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
  'CreatedAt', 'UpdatedAt', 'UpdatedBy'
];
// Handy name -> column index (0-based) map, built once.
const V = {};
VISIT_HEADERS.forEach((h, i) => { V[h] = i; });

// ---------------------------------------------------------------------------
// 1. ENTRY POINTS
// ---------------------------------------------------------------------------
function doGet(e) {
  try {
    ensureSchemaCached_();
    const action = e.parameter.action;

    // Every GET action reads real patient data, so every one of them now
    // requires a valid session token issued at login - except getSettings,
    // which the login screen itself calls before anyone has a session (to
    // theme the login gradient/card/logo from Admin Settings). It only
    // returns theme/clinic display info, never patient data.
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
      case 'getCapacityStatus':    result = apiGetCapacityStatus(); break;
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
//    successful apiLogin() and stored server-side in CacheService (max 6h,
//    Apps Script's own cache ceiling). The token itself carries no secret -
//    it is meaningless without the server-side cache entry behind it, and
//    it is the ONLY thing the browser is ever asked to remember.
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
// 3. SETTINGS HELPERS
// ---------------------------------------------------------------------------
function getSettingsMap_() {
  const sh = ss_().getSheetByName(SHEET.SETTINGS);
  const data = sh.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) map[data[i][0]] = data[i][1];
  }
  return map;
}

function setSetting_(key, value) {
  const sh = ss_().getSheetByName(SHEET.SETTINGS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sh.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value]);
}

// ---------------------------------------------------------------------------
// MULTI-DATABASE CONTINUITY - the "Active + Archive" model, same mechanism
// as the billing app. Every read/write normally goes to the spreadsheet
// this script is bound to. Once Super Admin ever clicks "Add New Database"
// in Admin Settings -> Database, ACTIVE_SPREADSHEET_ID is set in this
// SCRIPT's own properties (not the spreadsheet's), and every read/write
// transparently follows that pointer instead - to a brand-new spreadsheet,
// with Settings/Physiotherapists/IssuesList/Patients/CustomCharts (the
// "master data") carried forward automatically. The just-archived
// spreadsheet is never touched or deleted - it's simply added to a
// registry so Reports, Find/Edit and the Dashboard keep reading its patient
// visit history too (merged with the new active one), while new writes
// only ever go to the active one. Until this is ever used, ACTIVE_SPREADSHEET_ID
// stays unset and behavior is 100% identical to a single spreadsheet.
// ---------------------------------------------------------------------------
function ss_() {
  const activeId = PropertiesService.getScriptProperties().getProperty('ACTIVE_SPREADSHEET_ID');
  if (activeId) {
    try {
      return SpreadsheetApp.openById(activeId);
    } catch (e) {
      throw new Error('ACTIVE_SPREADSHEET_ID is set to "' + activeId + '" but that spreadsheet could not be opened (' + e + '). Check the ID is correct and this script\'s account still has access to it.');
    }
  }
  return SpreadsheetApp.getActiveSpreadsheet();
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
  return getArchiveRegistry_().map(entry => {
    try { return { ss: SpreadsheetApp.openById(entry.id), label: entry.label || entry.id }; }
    catch (e) { return null; }
  }).filter(Boolean);
}

// Every database this app can currently read PATIENT VISIT HISTORY from -
// the active one first, so "most recent" naturally sorts first wherever
// this is used. Master data (Settings/Physiotherapists/Issues/Patients) is
// deliberately NOT merged this way - it's only ever read from the active
// spreadsheet, exactly as carried forward at the moment of the switch.
function allDbs_() {
  return [{ ss: ss_(), label: 'Active' }].concat(openArchives_());
}

function truthy_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

// ---------------------------------------------------------------------------
// 4. SCHEMA SETUP - creates every sheet + header + default rows the FIRST
//    time it's needed. Cheap no-op on every later call. Never destructive -
//    only creates what's missing, never deletes or overwrites existing data.
//    Accepts an explicit spreadsheet so the same logic can provision a
//    brand-new "Add New Database" spreadsheet, not just the bound one.
// ---------------------------------------------------------------------------
// ensureSchema_() is cheap once a spreadsheet is already fully set up, but
// it still costs several real Sheets-service round trips every time it runs
// (a getSheetByName + getLastRow per sheet, plus reading the whole Settings
// sheet for the staleness migration check) - and none of that can possibly
// change between one request and the next except right after a fresh
// deploy or a manual edit to the spreadsheet itself. Running it in full on
// literally every search/open/save (as doGet/doPost did before) means every
// single click pays that cost again for no reason. This caches "schema is
// fine" for 5 minutes per spreadsheet (shared across every user of this
// deployment, via CacheService), so only roughly one request every 5
// minutes actually does the check - every other one skips straight to its
// real work. Still self-heals quickly (within 5 minutes) if the sheet is
// ever missing something.
function ensureSchemaCached_() {
  const cache = CacheService.getScriptCache();
  const key = 'schemaOk_' + ss_().getId();
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
      ['LogoURL', 'https://via.placeholder.com/160x160.png?text=LOGO'],
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
    defaults.forEach(row => settingsSh.appendRow(row));
  } else {
    // An install that already had a Settings sheet before this round of
    // fixes never picks up a brand-new key (ThemeDocHeaderColorTo) or a
    // corrected one, since the block above only seeds a totally empty
    // sheet - this keeps an existing install current without ever
    // clobbering a value the person actually customized themselves.
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
  createSheetIfMissing_(ssRef, SHEET.VISITS, VISIT_HEADERS);
  createSheetIfMissing_(ssRef, SHEET.CUSTOM_CHARTS, CUSTOM_CHARTS_HEADERS);
}

// Runs on every request against a Settings sheet that already existed
// before this round of fixes, so those installs catch up automatically -
// no re-running setupDatabase() by hand needed. Two kinds of catch-up:
//  1) Any THEME_SETTING_DEFAULTS key that plain isn't a row yet (e.g. the
//     new ThemeDocHeaderColorTo gradient color) gets appended with its
//     default. Never touches a key that's already there.
//  2) A short list of specific corrections, each gated by its own
//     Script Property flag so it fires exactly once per spreadsheet and
//     can never re-stomp a value the person deliberately changed
//     afterwards from Admin Settings -> Theme / Clinic Details:
//       - ThemeDocHeaderColor was saved with an old, off-brand color on
//         older installs; corrected once to the clinic's actual brand
//         blue (#2778b7).
//       - The five social-link fields default to blank until someone
//         fills them in from Admin Settings; any still blank get the
//         clinic's real profile links filled in once.
function migrateSettingsSheet_(settingsSh) {
  const data = settingsSh.getDataRange().getValues();
  const rowOfKey = {};
  for (let i = 1; i < data.length; i++) { if (data[i][0]) rowOfKey[data[i][0]] = i + 1; } // 1-based sheet row
  const valueOfKey = {};
  for (let i = 1; i < data.length; i++) { if (data[i][0]) valueOfKey[data[i][0]] = data[i][1]; }

  THEME_SETTING_DEFAULTS.forEach(([key, value]) => {
    if (!(key in rowOfKey)) settingsSh.appendRow([key, value]);
  });

  const props = PropertiesService.getScriptProperties();
  const flagKey = 'MIGRATED_BRAND_DEFAULTS_V3_' + settingsSh.getParent().getId();
  if (!props.getProperty(flagKey)) {
    // Same staleness bug as the header gradient: these two also predate the
    // brand color spec and were never going to catch up on their own.
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

// Creates a brand-new spreadsheet with the full schema already provisioned
// - used by "Add New Database". Google always starts a new spreadsheet with
// one default "Sheet1" tab; it's removed once our own tabs exist, since
// this app never uses a sheet by that name.
function createFreshDatabaseSpreadsheet_(name) {
  const newSs = SpreadsheetApp.create(name);
  ensureSchema_(newSs);
  const defaultSheet = newSs.getSheetByName('Sheet1');
  if (defaultSheet && newSs.getSheets().length > 1) newSs.deleteSheet(defaultSheet);
  return newSs;
}

// Carries MASTER data forward from one database to another - Settings,
// Physiotherapists, IssuesList, Patients, CustomCharts. Never touches the
// "Physiotherapy Assessment Form" (patient visit history) - that
// transactional history is exactly what stays behind on the archived
// spreadsheet. Safe to call on a freshly-provisioned target (headers only,
// one row) - it simply fills in the rows underneath.
function copyMasterDataForward_(fromSs, toSs) {
  [SHEET.SETTINGS, SHEET.PHYSIOS, SHEET.ISSUES, SHEET.PATIENTS, SHEET.CUSTOM_CHARTS].forEach(name => {
    const fromSh = fromSs.getSheetByName(name);
    const toSh = toSs.getSheetByName(name);
    if (!fromSh || !toSh) return;
    const data = fromSh.getDataRange().getValues();
    if (data.length <= 1) return; // header only - nothing to carry over
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
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#0f6e5c').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

// Run this ONCE from the Apps Script editor (Run > setupDatabase) right
// after pasting the code in, so the sheets/headers/defaults exist before
// the very first web request. After that, ensureSchema_() keeps everything
// in sync automatically on every request - running this again is harmless.
function setupDatabase() {
  ensureSchema_();
  buildUniversalReportSheet_();
  buildDailyReportSheet_();
  SpreadsheetApp.getUi().alert(
    'Setup complete!\n\nDefault Super Admin login:\nUsername: SJ Physiotherapy\nPassword: SJ12345\n\n' +
    'Default Physiotherapist login:\nID: PT001\nPassword: SJ12345\n\nChange both from Admin Settings after your first login.'
  );
}

// Optional, one-time setup (Run > enableKeepWarm from the Apps Script
// editor). A big share of "why is the very first search/open of a session
// slow, then fine after that" on a free Apps Script Web App is Google's own
// container "cold start" - after a few minutes with no traffic, the next
// request has to spin up a fresh execution environment before it runs a
// single line of this app's code, entirely outside what any code here can
// speed up. This is the standard workaround: a time-driven trigger that
// quietly calls keepWarm_() every 5 minutes so an execution environment
// usually stays "hot" between real visits, without ever touching patient
// data or counting against any per-user quota (nobody has to be using the
// app for it to fire). Safe to run more than once - it removes any trigger
// this function created before, so it never stacks up duplicates.
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
}

// ---------------------------------------------------------------------------
// 5. LOGIN / AUTH
// ---------------------------------------------------------------------------
function apiLogin(p) {
  const s = getSettingsMap_();
  const user = (s.SuperAdminUser || 'SJ Physiotherapy').trim();
  const pass = String(s.SuperAdminPass || 'SJ12345').trim();
  const uname = (p.username || '').trim();
  const pwd = (p.password || '').trim();

  if (uname === user && pwd === pass) {
    const token = createSession_({ role: 'admin', displayName: user });
    return { ok: true, role: 'admin', displayName: user, sessionToken: token };
  }

  // Not super admin - try a physiotherapist login (PhysioID + their password).
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const [id, name, ppass, active, , canFindEdit, canReportDownload, canDashboard] = data[i];
    if (!id) continue;
    if (String(id) === uname && String(ppass) === pwd) {
      if (!truthy_(active)) return { ok: false, error: 'This physiotherapist ID is deactivated' };
      const token = createSession_({ role: 'physio', physioId: id, physioName: name });
      return {
        ok: true, role: 'physio', displayName: name, physioId: id, physioName: name, sessionToken: token,
        canAccessFindEdit: truthy_(canFindEdit),
        canAccessReportDownload: truthy_(canReportDownload),
        canAccessDashboard: truthy_(canDashboard)
      };
    }
  }
  return { ok: false, error: 'Invalid username or password' };
}

function requireSuperAdmin_(user, pass) {
  const s = getSettingsMap_();
  const su = (s.SuperAdminUser || 'SJ Physiotherapy').trim();
  const sp = String(s.SuperAdminPass || 'SJ12345').trim();
  if ((user || '').trim() === su && (pass || '').trim() === sp) return { ok: true };
  return { ok: false, error: 'Super admin credentials required or incorrect' };
}

// Re-verifies a physiotherapist's OWN credentials at the moment they sign /
// save an assessment. This is deliberately called fresh on every save (the
// password is never cached client-side - see the file header note) - the
// same "authorize this one transaction" pattern the billing app uses for
// billers, just without the insecure sessionStorage caching.
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
    serverBuild: BACKEND_BUILD
  };
}

function apiGetSettingsPublic() {
  const s = getSettingsMap_();
  const pub = {};
  Object.keys(s).forEach(k => {
    if (k === 'SuperAdminPass') return; // never sent to the client
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
  fields.forEach(f => {
    if (p[f] !== undefined) setSetting_(f, p[f]);
  });
  return { ok: true };
}

// "My Login" - Super Admin changing their own username/password.
function apiUpdateSuperAdminLogin(p) {
  const auth = requireSuperAdmin_(p.currentUser, p.currentPass);
  if (!auth.ok) return auth;
  if (p.newUser) setSetting_('SuperAdminUser', String(p.newUser).trim());
  if (p.newPass) setSetting_('SuperAdminPass', String(p.newPass).trim());
  return { ok: true };
}

function apiUpdateTheme(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  THEME_SETTING_DEFAULTS.forEach(([key]) => {
    if (p[key] !== undefined) setSetting_(key, p[key]);
  });
  return { ok: true };
}

function apiResetTheme(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  THEME_SETTING_DEFAULTS.forEach(([key, val]) => setSetting_(key, val));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 7. PHYSIOTHERAPISTS (admin-managed accounts, mirrors Billers in the
//    billing app - same CRUD shape, same permission-toggle pattern)
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

// Super Admin can set or change any physiotherapist's signature image
// directly here too - not just the physiotherapist's own "My Login" upload
// - by pasting an image URL, exactly the same pattern as Clinic Details ->
// Logo URL. Handy for setting a physio up before they've ever logged in
// themselves, or for a clinic that keeps signature images on their own
// site/drive rather than uploading through this app.
function apiSavePhysio(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  if (p.editPhysioId) {
    const data = sh.getDataRange().getValues();
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
  const id = 'PT' + Utilities.formatString('%03d', sh.getLastRow());
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

// A physiotherapist uploads/changes their OWN signature PNG from "My
// Login" once they're logged in (must re-confirm their own password - the
// same "authorize this one transaction" rule as saving an assessment).
// The image itself is stored in a private Drive folder (not in the sheet
// cell - keeps rows small and fast) and only the resulting URL is written
// back to the Physiotherapists sheet. From then on, every assessment that
// physiotherapist signs automatically pulls this image into the Signature
// field - see apiVerifyPhysio() returning signatureUrl.
function apiUploadSignature(p) {
  const check = apiVerifyPhysio({ physioId: p.physioId, password: p.password });
  if (!check.ok) return check;

  const folder = getOrCreateSignatureFolder_();
  const bytes = Utilities.base64Decode(p.base64Png.split(',').pop());
  const blob = Utilities.newBlob(bytes, 'image/png', 'signature_' + p.physioId + '.png');
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const url = 'https://drive.google.com/uc?export=view&id=' + file.getId();

  const sh = ss_().getSheetByName(SHEET.PHYSIOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.physioId)) {
      // Remove the previous signature file, if any, so old files don't pile up.
      const oldFileId = data[i][9];
      if (oldFileId) {
        try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) { /* already gone - fine */ }
      }
      sh.getRange(i + 1, 9).setValue(url);
      sh.getRange(i + 1, 10).setValue(file.getId());
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

// A physiotherapist changes their OWN password from "My Login".
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
// 8. ISSUES LIST (the diagnosis/issue-type dropdown - mirrors Products in
//    the billing app: anyone can add a new one on the fly while filling
//    the form; only Super Admin can edit/delete/deactivate from Admin
//    Settings > Issues List)
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

// Any logged-in physiotherapist (or admin) can add a new issue type while
// filling out an assessment - same convenience as "+ Add New
// Service/Treatment to List" on the billing screen. No super-admin gate
// here on purpose; editing/deleting an existing one below IS gated.
function apiAddIssue(p) {
  const name = String(p.name || '').trim();
  if (!name) return { ok: false, error: 'Issue name is required' };
  const sh = ss_().getSheetByName(SHEET.ISSUES);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).toLowerCase() === name.toLowerCase()) {
      if (!truthy_(data[i][2])) sh.getRange(i + 1, 3).setValue(true); // reactivate if it existed but was off
      return { ok: true, issueId: data[i][0], name: data[i][1] };
    }
  }
  const id = nextId_(sh, 'ISS');
  sh.appendRow([id, name, true, new Date()]);
  return { ok: true, issueId: id, name: name };
}

function apiUpdateIssue(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.ISSUES);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.issueId)) {
      if (p.name !== undefined) sh.getRange(i + 1, 2).setValue(p.name);
      if (p.active !== undefined) sh.getRange(i + 1, 3).setValue(!!p.active);
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
// 9. PATIENTS (master registry, mirrors Customers in the billing app)
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

function apiFindPatient(phone, name) {
  const key = patientKey_(phone, name);
  if (!key || key === '_') return { ok: true, found: false };
  const sh = ss_().getSheetByName(SHEET.PATIENTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][11]) === key) {
      return { ok: true, found: true, patient: rowToPatient_(data[i]) };
    }
  }
  return { ok: true, found: false };
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
// Patients row, regardless of what (if anything) was typed into the
// free-form Patient ID box - see the file header note on PatientKey vs
// PatientID.
function apiSavePatient(p) {
  const key = patientKey_(p.phone, p.name);
  const sh = ss_().getSheetByName(SHEET.PATIENTS);
  const data = sh.getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][11]) === key) {
      const row = i + 1;
      if (p.patientId) sh.getRange(row, 1).setValue(p.patientId);
      sh.getRange(row, 2, 1, 10).setValues([[p.name, p.phone, p.age, p.sex, p.occupation, p.email, p.address, p.uhid, p.howKnow, p.referredBy]]);
      sh.getRange(row, 14).setValue(now);
      return { ok: true, patientId: sh.getRange(row, 1).getValue(), patientKey: key, isNew: false };
    }
  }
  sh.appendRow([p.patientId || '', p.name, p.phone, p.age, p.sex, p.occupation, p.email, p.address, p.uhid, p.howKnow, p.referredBy, key, now, now]);
  return { ok: true, patientId: p.patientId || '', patientKey: key, isNew: true };
}

// ---------------------------------------------------------------------------
// 10. ID GENERATION - counters live in this Apps Script PROJECT's own
//     Script Properties (not derived by counting rows), so numbering never
//     collides or resets even as the sheet grows. Every caller must already
//     hold LockService.getScriptLock() for its whole read-then-write
//     sequence - see apiSaveAssessment for the pattern.
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
  const data = sheet.getDataRange().getValues();
  let max = 0;
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][idColIndex] || '');
    const m = id.match(/(\d+)\s*$/);
    if (m) { const n = Number(m[1]); if (n > max) max = n; }
  }
  return max;
}

function nextId_(sheet, prefix) {
  return nextSequentialId_('IDCTR_' + prefix, prefix, 4, sheet, 0, true);
}

// GLOBAL visit id - one running counter across the whole clinic, e.g. PAF-000123.
function nextVisitId_() {
  const sh = ss_().getSheetByName(SHEET.VISITS);
  return nextSequentialId_('IDCTR_PAF', 'PAF', 6, sh, V.VisitID, true);
}
function peekNextVisitId_() {
  const sh = ss_().getSheetByName(SHEET.VISITS);
  return nextSequentialId_('IDCTR_PAF', 'PAF', 6, sh, V.VisitID, false);
}

// PER-PATIENT visit id - built from the phone+name join (PatientKey), so
// "how many times has THIS specific patient visited" is always accurate
// even if the free-typed Patient ID field is blank, reused or mistyped.
// Format: <digits-of-phone>_<NAME>-V<n>, e.g. 9876543210_RAMESHKUMAR-V03.
function nextPatientVisitId_(phone, name) {
  const key = patientKey_(phone, name);
  const sh = ss_().getSheetByName(SHEET.VISITS);
  const data = sh.getDataRange().getValues();
  let count = 0;
  for (let i = 1; i < data.length; i++) {
    const rowKey = patientKey_(data[i][V.Phone], data[i][V.PatientName]);
    if (rowKey === key) count++;
  }
  const n = count + 1;
  return key + '-V' + Utilities.formatString('%02d', n);
}

// ---------------------------------------------------------------------------
// 11. SAVE / UPDATE ASSESSMENT (core transaction)
// ---------------------------------------------------------------------------
// Fields the client sends inside p.data for save/update - kept in one list
// so both functions stay in sync with VISIT_HEADERS.
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

function apiSaveAssessment(p) {
  // 1. Verify the physiotherapist signing this record - mandatory, always
  //    checked fresh against the sheet (see apiVerifyPhysio file-header note).
  const physioCheck = apiVerifyPhysio({ physioId: p.physioId, password: p.physioPassword });
  if (!physioCheck.ok) return physioCheck;

  const d = p.data || {};
  if (!String(d.patientName || '').trim()) return { ok: false, error: 'Patient name is required' };
  if (!String(d.phone || '').trim()) return { ok: false, error: 'Phone number is required' };
  if (!String(d.date || '').trim()) return { ok: false, error: 'Date is required' };

  // Belt-and-braces capacity check - the New Assessment screen already
  // warns/blocks proactively via apiGetCapacityStatus, but a save request
  // is refused here too rather than letting it silently fail once Google's
  // real per-spreadsheet ceiling is hit.
  const capacity = apiGetCapacityStatus();
  if (capacity.ok && capacity.blocked) {
    return { ok: false, error: 'This database is full (' + capacity.percentUsed + '% of capacity). Ask Super Admin to click "Add New Database" in Admin Settings \u2192 Database before saving more records.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // 2. Upsert the patient master record.
    const patientResult = apiSavePatient({
      patientId: d.patientId, name: d.patientName, phone: d.phone, age: d.age, sex: d.sex,
      occupation: d.occupation, email: d.email, address: d.address, uhid: d.uhid,
      howKnow: d.howKnow, referredBy: d.referredBy
    });

    // 3. Mint both IDs.
    const visitId = nextVisitId_();
    const patientVisitId = nextPatientVisitId_(d.phone, d.patientName);

    // 4. Build the row in VISIT_HEADERS order.
    const now = new Date();
    const row = new Array(VISIT_HEADERS.length).fill('');
    row[V.VisitID] = visitId;
    row[V.PatientVisitID] = patientVisitId;
    row[V.PatientID] = d.patientId || '';
    row[V.PatientName] = d.patientName;
    row[V.Phone] = d.phone;
    row[V.Age] = d.age || '';
    row[V.Sex] = d.sex || '';
    row[V.Occupation] = d.occupation || '';
    row[V.Email] = d.email || '';
    row[V.Address] = d.address || '';
    row[V.UHID] = d.uhid || '';
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

    return { ok: true, visitId: visitId, patientVisitId: patientVisitId, patientId: patientResult.patientId };
  } finally {
    lock.releaseLock();
  }
}

// Editing an EXISTING assessment - e.g. filling in the Invoice Number
// later, or correcting a field via Find/Edit. Requires Super Admin, OR the
// physiotherapist who owns the record re-authorizing with their own
// password (never a cached one).
function authorizeAssessmentEdit_(p) {
  const admin = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (admin.ok) return { ok: true, actor: 'Super Admin' };
  const physio = apiVerifyPhysio({ physioId: p.physioId, password: p.physioPassword });
  if (physio.ok) return { ok: true, actor: physio.physioName, physioId: physio.physioId };
  return { ok: false, error: 'Super Admin or the owning physiotherapist must authorize this edit' };
}

function apiUpdateAssessment(p) {
  const auth = authorizeAssessmentEdit_(p);
  if (!auth.ok) return auth;

  const sh = ss_().getSheetByName(SHEET.VISITS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][V.VisitID]) !== String(p.visitId)) continue;
    const row = i + 1;
    const d = p.data || {};
    // Patient-facing fields can be corrected too, not just the clinical ones.
    const patientCols = { patientId: V.PatientID, patientName: V.PatientName, phone: V.Phone, age: V.Age,
      sex: V.Sex, occupation: V.Occupation, email: V.Email, address: V.Address, uhid: V.UHID };
    Object.keys(patientCols).forEach(f => {
      if (d[f] !== undefined) sh.getRange(row, patientCols[f] + 1).setValue(d[f]);
    });
    ASSESSMENT_FIELDS.forEach(f => {
      if (d[f] === undefined) return;
      const col = ASSESSMENT_FIELD_TO_COLUMN[f];
      if (col) sh.getRange(row, V[col] + 1).setValue(d[f]);
    });
    sh.getRange(row, V.UpdatedAt + 1).setValue(new Date());
    sh.getRange(row, V.UpdatedBy + 1).setValue(auth.actor);
    return { ok: true, visitId: p.visitId };
  }
  // Not in the active database - check whether it's sitting in an archive
  // instead, purely so the error is clear rather than a bare "not found"
  // (archived databases are intentionally read-only, same as the billing app).
  const archives = openArchives_();
  for (let a = 0; a < archives.length; a++) {
    const archSh = archives[a].ss.getSheetByName(SHEET.VISITS);
    if (!archSh) continue;
    const archData = archSh.getDataRange().getValues();
    for (let i = 1; i < archData.length; i++) {
      if (String(archData[i][V.VisitID]) === String(p.visitId)) {
        return { ok: false, error: 'This record is in an archived database ("' + archives[a].label + '") and is read-only.' };
      }
    }
  }
  return { ok: false, error: 'Assessment not found' };
}

function rowToAssessment_(row) {
  const obj = {};
  VISIT_HEADERS.forEach((h, i) => {
    let v = row[i];
    if (h === 'Date' || h === 'NextReviewDate' || h === 'CreatedAt' || h === 'UpdatedAt') v = formatDate_(v);
    obj[h.charAt(0).toLowerCase() + h.slice(1)] = v;
  });
  // Convenience camelCase aliases for the JS-blob fields the client parses,
  // and for the two record IDs - the generic Header->camelCase conversion
  // above would otherwise produce "visitID"/"patientVisitID"/"patientID"
  // (capital ID), but every other part of this app (apiSaveAssessment's
  // own return value, apiSearchAssessments' results) already uses
  // "visitId"/"patientVisitId"/"patientId" - these aliases keep that one
  // consistent spelling everywhere the client reads it from.
  obj.visitId = row[V.VisitID]; obj.patientVisitId = row[V.PatientVisitID]; obj.patientId = row[V.PatientID];
  obj.romJson = row[V.ROM_JSON]; obj.mmtJson = row[V.MMT_JSON];
  obj.painMarksJson = row[V.PainMarksJSON]; obj.specialTestsJson = row[V.SpecialTestsJSON];
  obj.treatmentGoalsJson = row[V.TreatmentGoalsJSON]; obj.treatmentPlanJson = row[V.TreatmentPlanJSON];
  return obj;
}

// Looks in the active database first, then every archived one, so a
// record from before an "Add New Database" switch can still be opened,
// previewed and printed - archived records just come back flagged
// `archived: true` so the UI can make clear they're read-only.
function apiGetAssessment(visitId) {
  const dbs = allDbs_();
  for (let d = 0; d < dbs.length; d++) {
    const sh = dbs[d].ss.getSheetByName(SHEET.VISITS);
    if (!sh) continue;
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][V.VisitID]) === String(visitId)) {
        const assessment = rowToAssessment_(data[i]);
        assessment.archived = (d > 0);
        assessment.dbLabel = dbs[d].label;
        return { ok: true, assessment: assessment };
      }
    }
  }
  return { ok: false, error: 'Assessment not found for ID: ' + visitId };
}

// Search used by the Find/Edit screen - by Visit ID, Patient ID, phone, or
// patient name (partial match on name/phone is fine, exact on the two IDs).
// Searches the active database and every archived one, so a physiotherapist
// can always find a patient's full visit history regardless of which
// database it happens to be sitting in.
function apiSearchAssessments(params) {
  const q = String(params.q || '').trim().toLowerCase();
  if (!q) return { ok: true, results: [] };
  const results = [];
  const dbs = allDbs_();
  for (let d = 0; d < dbs.length && results.length < 50; d++) {
    const sh = dbs[d].ss.getSheetByName(SHEET.VISITS);
    if (!sh) continue;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) continue;
    const numRows = lastRow - 1;
    // Speed fix: a full-row getDataRange() here would also transfer every
    // row's ROM/MMT/pain-marks/treatment-plan/notes JSON (several of the
    // widest, heaviest columns on the sheet) just to search and display six
    // small text fields - real, growing cost on every keystroke-free search
    // as visit history builds up. Two narrow column reads (everything up to
    // IssueType in one shot, PhysioName in a second) instead of one
    // full-width read skip transferring any of that unused bulk.
    const mainCols = sh.getRange(2, 1, numRows, V.IssueType + 1).getValues(); // VisitID .. IssueType
    const physioCol = sh.getRange(2, V.PhysioName + 1, numRows, 1).getValues();
    for (let i = 0; i < numRows; i++) {
      const row = mainCols[i];
      if (!row[V.VisitID]) continue;
      const hay = [row[V.VisitID], row[V.PatientVisitID], row[V.PatientID], row[V.PatientName], row[V.Phone], row[V.InvoiceNumber]]
        .map(x => String(x || '').toLowerCase()).join(' | ');
      if (hay.indexOf(q) !== -1) {
        results.push({
          visitId: row[V.VisitID], patientVisitId: row[V.PatientVisitID], patientId: row[V.PatientID],
          patientName: row[V.PatientName], phone: row[V.Phone], date: formatDate_(row[V.Date]),
          issueType: row[V.IssueType], invoiceNumber: row[V.InvoiceNumber], physioName: physioCol[i][0],
          archived: (d > 0), dbLabel: dbs[d].label
        });
      }
      if (results.length >= 50) break;
    }
  }
  results.reverse();
  return { ok: true, results: results };
}

// ---------------------------------------------------------------------------
// 12. DASHBOARD - each KPI card and chart on the Dashboard gets its own
//     independent Filter By / Filter Value / Date Range (mirrors the
//     billing app's Revenue Dashboard exactly - never one global filter for
//     everything). Rather than round-trip to the server per widget per
//     filter change, the server hands over one flattened, lightweight
//     per-visit dataset ONCE, and every widget (default or custom) filters
//     and aggregates its own slice of it client-side, instantly.
// ---------------------------------------------------------------------------
function apiGetDashboardRaw() {
  const rows = [];
  allDbs_().forEach(db => {
    const sh = db.ss.getSheetByName(SHEET.VISITS);
    if (!sh) return;
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[V.VisitID]) continue;
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
    }
  });
  const truncated = rows.length > REPORT_ROW_CAP;
  return { ok: true, rows: rows.slice(0, REPORT_ROW_CAP), truncated: truncated };
}

function apiRefreshDashboardSheet(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  buildUniversalReportSheet_();
  buildDailyReportSheet_();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 13. CUSTOM CHARTS - Super Admin builds these on top of the fixed default
//     widgets. DataSource is one of: visits, patients, issues.
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
  if (p.type !== 'number' && !p.dimension) return 'Group-by dimension is required';
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
  const id = nextId_(sh, 'CHT');
  const order = sh.getLastRow();
  sh.appendRow([id, p.name, p.type, p.dataSource, p.dimension || '', p.metric, p.metricField || '', p.topN || 0, p.sortDir || 'desc', order, new Date(), p.color || '#0f6e5c']);
  return { ok: true, chartId: id };
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

// Aggregates a custom chart's data on demand - visits (any VISIT_HEADERS
// column as dimension/metric), patients (a running total only - see
// dataSourceHint in the UI), issues (same, running total of the list).
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

  // dataSource === 'visits'
  const sh = ss_().getSheetByName(SHEET.VISITS);
  const data = sh.getDataRange().getValues();
  const dimColName = chart.dimension; // e.g. 'IssueType', 'HowKnow', 'PhysioName', 'Sex'
  const dimIdx = V[dimColName];
  const metricIdx = chart.metricField ? V[chart.metricField] : null;

  if (chart.type === 'number') {
    if (chart.metric === 'count') return { ok: true, type: 'number', value: data.length - 1, label: chart.name };
    let sum = 0, n = 0;
    for (let i = 1; i < data.length; i++) {
      if (!data[i][V.VisitID]) continue;
      const v = Number(data[i][metricIdx]) || 0;
      sum += v; n++;
    }
    const value = chart.metric === 'average' ? (n ? sum / n : 0) : sum;
    return { ok: true, type: 'number', value: value, label: chart.name };
  }

  const groups = {}; // key -> {sum, count}
  for (let i = 1; i < data.length; i++) {
    if (!data[i][V.VisitID]) continue;
    const key = String(data[i][dimIdx] || 'Unspecified');
    if (!groups[key]) groups[key] = { sum: 0, count: 0 };
    groups[key].count++;
    if (metricIdx !== null) groups[key].sum += Number(data[i][metricIdx]) || 0;
  }
  let rows = Object.keys(groups).map(k => ({
    label: k,
    value: chart.metric === 'count' ? groups[k].count : (chart.metric === 'average' ? (groups[k].sum / groups[k].count) : groups[k].sum)
  }));
  rows.sort((a, b) => chart.sortDir === 'asc' ? a.value - b.value : b.value - a.value);
  const topN = Number(chart.topN) || 0;
  if (topN > 0) rows = rows.slice(0, topN);

  return { ok: true, type: chart.type, rows: rows, color: chart.color };
}

// ---------------------------------------------------------------------------
// 14. DATE / FORMAT UTILITIES
// ---------------------------------------------------------------------------
function fmtDate_(d, pattern, ssRef) {
  if (!d) return '';
  const tz = (ssRef || ss_()).getSpreadsheetTimeZone();
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

// Gmail (and a few other clients) scan plain email text and auto-link any
// fragment that looks like a physical address - often just PART of one,
// which is exactly the stray/broken-looking link this fixes. Breaking the
// text up with invisible zero-width spaces keeps it reading and displaying
// identically while defeating that pattern match; safe to use here since
// this only ever wraps plain address text, never markup.
function breakAutoLink_(str) {
  return escHtml_(str).split('').join('&#8203;');
}

// ---------------------------------------------------------------------------
// 15. REPORTS - live, filterable, flattened views. Everyone can browse;
//     no one can edit from here. Mirrors the billing app's Universal
//     Report / Daily Report screens exactly (same toolbar: column chooser,
//     per-column filters, clear filters, download Excel).
// ---------------------------------------------------------------------------
function apiGetUniversalReport() {
  const rows = [];
  allDbs_().forEach(db => {
    const sh = db.ss.getSheetByName(SHEET.VISITS);
    if (!sh) return;
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[V.VisitID]) continue;
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
        dbLabel: db.label
      });
    }
  });
  rows.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const truncated = rows.length > REPORT_ROW_CAP;
  return { ok: true, rows: rows.slice(0, REPORT_ROW_CAP), truncated: truncated };
}

function apiGetDailyReport() {
  const byDate = {};
  allDbs_().forEach(db => {
    const sh = db.ss.getSheetByName(SHEET.VISITS);
    if (!sh) return;
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[V.VisitID]) continue;
      const date = formatDate_(row[V.Date]);
      if (!byDate[date]) byDate[date] = { date: date, totalVisits: 0, uniquePatients: new Set(), issues: {} };
      byDate[date].totalVisits++;
      byDate[date].uniquePatients.add(patientKey_(row[V.Phone], row[V.PatientName]));
      const issue = String(row[V.IssueType] || 'Unspecified');
      byDate[date].issues[issue] = (byDate[date].issues[issue] || 0) + 1;
    }
  });
  const rows = Object.keys(byDate).sort().reverse().map(date => {
    const d = byDate[date];
    const topIssue = Object.keys(d.issues).sort((a, b) => d.issues[b] - d.issues[a])[0] || '';
    return { date: date, totalVisits: d.totalVisits, uniquePatients: d.uniquePatients.size, topIssue: topIssue };
  });
  return { ok: true, rows: rows };
}

// Materializes both reports as real, browsable sheet tabs in the
// spreadsheet itself (for anyone who opens the sheet directly, not just
// the website), same as the billing app's UniversalReport/DailyReport tabs.
function buildUniversalReportSheet_() {
  const ssRef = ss_();
  let sh = ssRef.getSheetByName(SHEET.UNIVERSAL_REPORT);
  if (!sh) sh = ssRef.insertSheet(SHEET.UNIVERSAL_REPORT);
  sh.clear();
  const rows = apiGetUniversalReport().rows;
  const headers = ['Visit ID', 'Patient Visit ID', 'Patient ID', 'Patient Name', 'Phone', 'Age', 'Sex', 'Occupation',
    'Email', 'Address', 'UHID', 'Date', 'Referred By', 'How Known', 'Invoice No.', 'Issue Type',
    'Chief Complaint', 'Clinical Diagnosis', 'VAS', 'Ambulation', 'Stair Climbing', 'ADLs',
    'Next Review Date', 'Physio ID', 'Physio Name', 'Created At', 'Updated At', 'Updated By'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0f6e5c').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  if (rows.length) {
    const body = rows.map(r => [r.visitId, r.patientVisitId, r.patientId, r.patientName, r.phone, r.age, r.sex,
      r.occupation, r.email, r.address, r.uhid, r.date, r.referredBy, r.howKnow, r.invoiceNumber, r.issueType,
      r.chiefComplaint, r.clinicalDiagnosis, r.vas, r.ambulation, r.stairClimbing, r.adls, r.nextReviewDate,
      r.physioId, r.physioName, r.createdAt, r.updatedAt, r.updatedBy]);
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
// 16. DATABASE STATUS, CAPACITY MONITORING & "ADD NEW DATABASE" - real
//     row/cell counts against Google Sheets' ceiling for EVERY database
//     this app knows about (the active one, plus every archived one), a
//     visual capacity bar per database, and the one-click button that lets
//     Super Admin grow into a brand-new spreadsheet without ever opening
//     the Apps Script editor. Mirrors the billing app's Database(s) Status
//     panel exactly - same thresholds, same one-click flow.
// ---------------------------------------------------------------------------
const CAPACITY_CELL_LIMIT = 10000000; // Google Sheets' own per-spreadsheet cell limit
const CAPACITY_WARNING_THRESHOLD = 0.75; // start warning well before the ceiling
const CAPACITY_BLOCK_THRESHOLD = 0.98;   // refuse new saves before Google's real ceiling silently bites

// Cheap, no-auth check of the ACTIVE database only - safe to call
// proactively (e.g. right after opening the New Assessment screen) so a
// physiotherapist is warned, or blocked, before typing up a whole record
// that then can't be saved.
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

// Everything the "Database(s) Status" panel needs, for every database this
// app knows about, in one call: name/link, Active vs Archived, capacity %,
// and Visits/Patients/Physiotherapists row counts. Archived databases are
// frozen (read-only) so they don't get a "Next Visit ID" prediction - that
// only makes sense for the one database new records actually get written
// into.
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

// The API endpoint the "+ Add New Database Now" button calls. Requires
// Super Admin credentials, same as every other admin action. Creates a
// brand-new spreadsheet, carries the master data (clinic settings,
// physiotherapist accounts, issues list, patients, custom charts) forward
// into it, archives the current spreadsheet as read-only patient-visit
// history, and switches every future save to the new one - all in one
// request, no Apps Script editor involved.
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

// The confirmed, deliberate reset. Un-links any archive spreadsheets (they
// are NOT touched or deleted - just forgotten, so Reports/Find-Edit/
// Dashboard stop pulling from them) and re-bases the Visit ID and Issue ID
// counters on ONLY what's actually sitting in the active spreadsheet's rows
// right now. Use after manually clearing rows directly in the sheet, or
// after testing "Add New Database" and deciding to start over.
function apiResetToActiveOnly(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('ARCHIVE_SPREADSHEET_IDS');

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
//     Same header/branding system as the billing app's invoice, plus:
//       - field NAMES rendered in ThemeFieldLabelColor, values in
//         ThemeFieldValueColor (point 20 - easy to scan on paper).
//       - the body diagrams are rendered as inline SVG with the saved
//         PainMarksJSON coordinates drawn as small colored dots on top -
//         never a raster image, identical function used for the on-screen
//         preview (see app.js renderBodyDiagram) and this server-side copy.
// ---------------------------------------------------------------------------

// Must stay IN SYNC with ROM_STRUCTURE in app.js - this is the fixed
// Range-of-Motion / Muscle-Strength table shape taken directly from the
// clinic's paper assessment sheet.
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

function getLogoDataUri_(url) {
  if (!url) return '';
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return '';
    const blob = resp.getBlob();
    const contentType = blob.getContentType() || 'image/png';
    const base64 = Utilities.base64Encode(blob.getBytes());
    return 'data:' + contentType + ';base64,' + base64;
  } catch (err) {
    return '';
  }
}

function safeJsonParse_(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

// One small reusable "label : value" block, label and value each in their
// own configurable color - point 20 / point 7 (label #2778b7, value black).
function fld_(label, value, s) {
  const labelHtml = label ? '<span class="fl-label" style="color:' + (s.ThemeFieldLabelColor || '#2778b7') + '">' + escHtml_(label) + ': </span>' : '';
  return '<div class="doc-field">' + labelHtml +
    '<span class="fl-value" style="color:' + (s.ThemeFieldValueColor || '#000000') + '">' + escHtml_(value || '-') + '</span>' +
    '</div>';
}

function romTableHtml_(jsonStr, s) {
  const dataObj = safeJsonParse_(jsonStr, {});
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
  const rows = safeJsonParse_(jsonStr, []);
  if (!rows.length) return '<table class="special-tests-table"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody><tr><td colspan="2" class="muted">No special tests recorded</td></tr></tbody></table>';
  const body = rows.map(r => '<tr><td>' + escHtml_(r.test) + '</td><td>' + escHtml_(r.result) + '</td></tr>').join('');
  return '<table class="special-tests-table"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody>' + body + '</tbody></table>';
}

function listHtml_(jsonStr) {
  const items = safeJsonParse_(jsonStr, []);
  if (!items.length) return '<div class="muted">None recorded</div>';
  return '<ol class="doc-list">' + items.map(i => '<li>' + escHtml_(i) + '</li>').join('') + '</ol>';
}

// The four body-map views are the clinic's own real reference images
// (hosted on sjphysiotherapy.in), never redrawn or altered by this app.
// Nothing about a mark is ever baked into a picture: each pain/radiating
// point is stored as three numbers - which view, and an x/y position as a
// PERCENTAGE of that image's own box - plus a color. Those percentages are
// turned back into small colored dots, absolutely-positioned on top of the
// image, every time the record is shown - on screen and again here in the
// printed PDF - so what was marked is what prints, and the database never
// holds anything heavier than a few numbers per point.
const BODY_VIEW_IMAGES = {
  front: 'http://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Front-View.png',
  back: 'http://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Back-View.png',
  right: 'http://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Right-Facing-View.png',
  left: 'http://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Left-Facing-View.png'
};

// Fetching + base64-encoding 4 images on every single PDF/email is wasteful
// since these pictures never change - cache the data URIs for the whole
// 6-hour ceiling Apps Script allows, same CacheService already used for
// sessions.
function getBodyViewDataUri_(view) {
  const cacheKey = 'bodyimg_' + view;
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) return cached;
  const uri = getLogoDataUri_(BODY_VIEW_IMAGES[view]);
  if (uri) {
    try { CacheService.getScriptCache().put(cacheKey, uri, 21600); } catch (e) { /* a data URI can exceed the 100KB cache value limit - fine, just re-fetch next time */ }
  }
  return uri;
}

function bodyDiagramsHtml_(painMarksJson) {
  const marks = safeJsonParse_(painMarksJson, []);
  const views = [
    { key: 'front', label: 'FRONT VIEW' }, { key: 'back', label: 'BACK VIEW' },
    { key: 'right', label: 'RIGHT SIDE VIEW' }, { key: 'left', label: 'LEFT SIDE VIEW' }
  ];
  const cells = views.map(v => {
    const src = getBodyViewDataUri_(v.key) || BODY_VIEW_IMAGES[v.key];
    // Point 7/8: whatever custom color was picked and saved for a mark
    // prints in that EXACT same color - background-color (not the
    // background shorthand) survives the print-color-adjust:exact rule
    // in docPrintCss_ far more reliably across Chrome's PDF pipeline.
    const dots = marks.filter(m => m.view === v.key).map(m =>
      '<span class="doc-mark-dot" style="left:' + m.x + '%;top:' + m.y + '%;background-color:' + escHtml_(m.color) + '"></span>'
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

// Point 5/8: ONE continuous document, ONE header call at the very top -
// no forced page-break, no second header. The browser/Apps-Script PDF
// engine paginates this naturally; .doc-section{page-break-inside:avoid}
// in docPrintCss_ keeps a section from being sliced across a page edge.
// Point 6: fields inside a section sit in flexbox rows (.doc-row.cols-N)
// so related fields line up on the same row instead of stacking one
// below another. This exact HTML (class names, section order) is shared
// byte-for-byte with buildAssessmentDocHtml_ in app.js (point 8), so
// on-screen preview, browser Print/Save-as-PDF, and the server PDF used
// for email are all the same document.
function buildAssessmentHtmlForPdf_(a, s) {
  const logo = getLogoDataUri_(s.PrintLogoURL || s.LogoURL);
  const font = s.ThemeDocFontFamily || "Georgia, 'Times New Roman', Times, serif";
  const headerFrom = s.ThemeDocHeaderColor || '#2778b7';
  const headerTo = s.ThemeDocHeaderColorTo || '#a8d339';
  const labelColor = s.ThemeFieldLabelColor || '#2778b7';
  // Section-band styling is intentionally NOT driven by ThemeSectionBandColor
  // here: the on-screen/print/"Save as PDF" version (app.js + style.css,
  // .section-band rule) never reads that setting either - it always renders
  // with the app's fixed soft-peach band + heading-color text. Using the
  // admin-set band color here (while the client ignores it) is exactly what
  // caused the section names to render as unreadable solid-color bars in the
  // emailed PDF whenever that setting held a dark/stale value. Matching the
  // client's fixed values keeps every output (print, Save-as-PDF, email PDF)
  // visually identical, which is the whole point of this function.
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
    '<div class="doc-row cols-3">' + fld_('Ambulation', a.ambulation, s) + fld_('Stair Climbing', a.stairClimbing, s) + fld_('ADLs', a.adLs, s) + '</div>' +
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
    '</div>' + // end doc-page
    '</body></html>';
}

// Point 7: diagonal gradient header band (headerFrom -> headerTo, 135deg),
// clinic-info text hardcoded white against that gradient, logo unchanged.
function docHeaderHtml_(s, logo, headerFrom, headerTo) {
  const logoW = (s.ThemeDocLogoWidth || 96) + 'px', logoH = (s.ThemeDocLogoHeight || 58) + 'px';
  const nameStyle = 'font-weight:' + (truthy_(s.ThemeDocCompanyNameBold) ? 'bold' : 'normal') +
    ';font-style:' + (truthy_(s.ThemeDocCompanyNameItalic) ? 'italic' : 'normal') +
    ';text-decoration:' + (truthy_(s.ThemeDocCompanyNameUnderline) ? 'underline' : 'none');
  const infoStyle = 'font-weight:' + (truthy_(s.ThemeDocCompanyInfoBold) ? 'bold' : 'normal') +
    ';font-style:' + (truthy_(s.ThemeDocCompanyInfoItalic) ? 'italic' : 'normal') +
    ';text-decoration:' + (truthy_(s.ThemeDocCompanyInfoUnderline) ? 'underline' : 'none');
  return '<div class="doc-header-band" style="background-image:linear-gradient(135deg,' + headerFrom + ' 0%,' + headerTo + ' 100%)">' +
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
    '.doc-company-name{font-size:20px;} .doc-company-info{font-size:11.5px;line-height:1.4;}' +
    '.doc-title-bar{color:#fff;text-align:center;font-weight:bold;letter-spacing:1px;padding:6px;font-size:13px;margin-bottom:12px;}' +
    '.doc-section{page-break-inside:avoid;break-inside:avoid;margin-bottom:10px;}' +
    // ROM/MMT (and any other naturally-long table section) opt OUT of
    // page-break-inside:avoid - a table taller than the remaining page
    // would otherwise be pushed whole onto the next page, leaving a large
    // blank gap behind it (this was the exact root cause of the reported
    // "huge blank space" bug). Its rows still avoid splitting individually,
    // and its header repeats on the next page if it does split.
    '.doc-section.flow{page-break-inside:auto;break-inside:auto;}' +
    'table.rom-table thead,table.special-tests-table thead{display:table-header-group;}' +
    'table.rom-table tr,table.special-tests-table tr{page-break-inside:avoid;break-inside:avoid;}' +
    // Fixed to match the client's own .section-band rule (style.css) exactly -
    // background: the app's soft-peach note color, text: the heading color -
    // never the admin-set ThemeSectionBandColor, so this always matches what
    // print/Save-as-PDF already shows and is never at risk of unreadable
    // (same-color-as-background) text regardless of what that setting holds.
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
    '.doc-body-diagrams{display:flex;gap:8px;justify-content:space-around;margin-bottom:8px;}' +
    '.doc-body-view{text-align:center;width:23%;}' +
    '.doc-body-img-wrap{position:relative;display:inline-block;max-width:100%;}' +
    '.doc-body-img-wrap img{max-width:100%;max-height:170px;width:auto;height:auto;display:block;margin:0 auto;}' +
    '.doc-mark-dot{position:absolute;width:9px;height:9px;border-radius:50%;border:1px solid #fff;transform:translate(-50%,-50%);box-shadow:0 0 0 0.5px rgba(0,0,0,0.35);}' +
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

// Point 9: mirrors the billing app's buildEmailBillBodyHtml_ exactly -
// plain black Georgia text, a bordered summary table, a warm sign-off.
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

// Point 1/9: the reusable branded shell, copied element-for-element from
// the billing app's buildBrandedEmailShell_ - same two gradient colors,
// same layout, same up-to-7 social icons. Point 1's fix lives right here:
// the header logo is linked from its live hosted URL, NEVER embedded as a
// base64 data URI in the email body - that base64 embedding was what blew
// past MailApp's "Email Body Size" ceiling. The PDF attachment (a separate,
// much larger limit) is unaffected and still uses the clinic's real logo.
function buildBrandedEmailShell_(s, bodyRowsHtml) {
  const font = "Georgia, 'Times New Roman', Times, serif";
  // Fixed brand gradient, independent of the in-app Theme colors, so the
  // email never drifts from this design regardless of the app's own theme.
  const gradFrom = '#2778b7';
  const gradTo = '#a8d339';
  const gradText = '#FFFFFF';
  // Fixed rectangular wordmark logo for the email header specifically -
  // linked live, never base64-embedded (see note above).
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
        return '<td style="padding:0 9px;"><a href="' + d.href + '" target="_blank" style="text-decoration:none;"><img src="' + ICONS_BASE + d.icon + '" width="32" height="32" alt="' + d.alt + '" style="display:block;width:32px;height:32px;border:0;"></a></td>';
      }).join('') +
      '</tr></table></td></tr>'
    : '';

  return '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    // Tells mail clients (mainly Apple Mail/Outlook; Gmail is inconsistent,
    // which is why the address itself is also de-linked below) not to
    // auto-detect and auto-link plain text that looks like a phone number,
    // address or date.
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
