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
  ['ThemeDocHeaderColor', '#04bd07'],
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
  ['ThemeFieldLabelColor', '#0f6e5c'],
  ['ThemeFieldValueColor', '#182322'],
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
    ensureSchema_();
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
      case 'getDashboardData':     result = apiGetDashboardData(e.parameter); break;
      case 'getCustomCharts':      result = apiGetCustomCharts(); break;
      case 'getCustomChartData':   result = apiGetCustomChartData(e.parameter); break;
      case 'getUniversalReport':   result = apiGetUniversalReport(); break;
      case 'getDailyReport':       result = apiGetDailyReport(); break;
      case 'getDbStatus':          result = apiGetDbStatus(); break;
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
    ensureSchema_();
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

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function truthy_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

// ---------------------------------------------------------------------------
// 4. SCHEMA SETUP - creates every sheet + header + default rows the FIRST
//    time it's needed. Cheap no-op on every later call. Never destructive -
//    only creates what's missing, never deletes or overwrites existing data.
// ---------------------------------------------------------------------------
function ensureSchema_() {
  const ssRef = ss_();

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
      ['SocialWhatsapp', '9629495946'],
      ['SocialInstagram', ''],
      ['SocialFacebook', ''],
      ['SocialLinkedin', ''],
      ['SocialYoutube', ''],
      ['SuperAdminUser', 'SJ Physiotherapy'],
      ['SuperAdminPass', 'SJ12345']
    ].concat(THEME_SETTING_DEFAULTS);
    defaults.forEach(row => settingsSh.appendRow(row));
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
        return { ok: true, physioId: p.editPhysioId };
      }
    }
    return { ok: false, error: 'Physiotherapist not found' };
  }
  const id = 'PT' + Utilities.formatString('%03d', sh.getLastRow());
  sh.appendRow([id, p.name, p.password, true, new Date(), true, true, true, '', '']);
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

function apiGetAssessment(visitId) {
  const sh = ss_().getSheetByName(SHEET.VISITS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][V.VisitID]) === String(visitId)) {
      return { ok: true, assessment: rowToAssessment_(data[i]) };
    }
  }
  return { ok: false, error: 'Assessment not found for ID: ' + visitId };
}

// Search used by the Find/Edit screen - by Visit ID, Patient ID, phone, or
// patient name (partial match on name/phone is fine, exact on the two IDs).
function apiSearchAssessments(params) {
  const q = String(params.q || '').trim().toLowerCase();
  if (!q) return { ok: true, results: [] };
  const sh = ss_().getSheetByName(SHEET.VISITS);
  const data = sh.getDataRange().getValues();
  const results = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[V.VisitID]) continue;
    const hay = [row[V.VisitID], row[V.PatientVisitID], row[V.PatientID], row[V.PatientName], row[V.Phone], row[V.InvoiceNumber]]
      .map(x => String(x || '').toLowerCase()).join(' | ');
    if (hay.indexOf(q) !== -1) {
      results.push({
        visitId: row[V.VisitID], patientVisitId: row[V.PatientVisitID], patientId: row[V.PatientID],
        patientName: row[V.PatientName], phone: row[V.Phone], date: formatDate_(row[V.Date]),
        issueType: row[V.IssueType], invoiceNumber: row[V.InvoiceNumber], physioName: row[V.PhysioName]
      });
    }
    if (results.length >= 50) break;
  }
  results.reverse();
  return { ok: true, results: results };
}

// ---------------------------------------------------------------------------
// 12. DASHBOARD - default widgets (mirrors the billing app's Revenue
//     Dashboard: KPI cards + a bar chart + two donut charts, each
//     click-to-filter) plus the same Super-Admin custom chart builder.
// ---------------------------------------------------------------------------
function apiGetDashboardData(params) {
  const sh = ss_().getSheetByName(SHEET.VISITS);
  const data = sh.getDataRange().getValues();

  let dateFrom = parseDateOnly_(params.dateFrom);
  let dateTo = parseDateOnly_(params.dateTo);
  if (dateFrom && dateTo && dateFrom > dateTo) { const t = dateFrom; dateFrom = dateTo; dateTo = t; }
  const issueFilter = (params.issueType || '').trim().toLowerCase();
  const howKnowFilter = (params.howKnow || '').trim().toLowerCase();
  const physioFilter = (params.physioName || '').trim().toLowerCase();

  let totalVisits = 0;
  const patientSet = new Set();
  const issueTotals = {};   // issue name -> count
  const howKnowTotals = {}; // source -> count
  const physioTotals = {};  // physio name -> count

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[V.VisitID]) continue;
    const visitDate = dateOnly_(new Date(row[V.Date]));
    if (dateFrom && visitDate < dateFrom) continue;
    if (dateTo && visitDate > dateTo) continue;
    const issue = String(row[V.IssueType] || 'Unspecified');
    const howKnow = String(row[V.HowKnow] || 'Unspecified');
    const physioName = String(row[V.PhysioName] || 'Unspecified');
    if (issueFilter && issue.toLowerCase() !== issueFilter) continue;
    if (howKnowFilter && howKnow.toLowerCase() !== howKnowFilter) continue;
    if (physioFilter && physioName.toLowerCase() !== physioFilter) continue;

    totalVisits++;
    patientSet.add(patientKey_(row[V.Phone], row[V.PatientName]));
    issueTotals[issue] = (issueTotals[issue] || 0) + 1;
    howKnowTotals[howKnow] = (howKnowTotals[howKnow] || 0) + 1;
    physioTotals[physioName] = (physioTotals[physioName] || 0) + 1;
  }

  const toSortedArray = obj => Object.keys(obj).map(k => ({ name: k, count: obj[k] })).sort((a, b) => b.count - a.count);

  return {
    ok: true,
    totalVisits: totalVisits,
    totalPatients: patientSet.size,
    issueTotals: toSortedArray(issueTotals),
    howKnowTotals: toSortedArray(howKnowTotals),
    physioTotals: toSortedArray(physioTotals)
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

// ---------------------------------------------------------------------------
// 15. REPORTS - live, filterable, flattened views. Everyone can browse;
//     no one can edit from here. Mirrors the billing app's Universal
//     Report / Daily Report screens exactly (same toolbar: column chooser,
//     per-column filters, clear filters, download Excel).
// ---------------------------------------------------------------------------
function apiGetUniversalReport() {
  const sh = ss_().getSheetByName(SHEET.VISITS);
  const data = sh.getDataRange().getValues();
  const rows = [];
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
      createdAt: formatDate_(row[V.CreatedAt]), updatedAt: formatDate_(row[V.UpdatedAt]), updatedBy: row[V.UpdatedBy]
    });
  }
  rows.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const truncated = rows.length > REPORT_ROW_CAP;
  return { ok: true, rows: rows.slice(0, REPORT_ROW_CAP), truncated: truncated };
}

function apiGetDailyReport() {
  const sh = ss_().getSheetByName(SHEET.VISITS);
  const data = sh.getDataRange().getValues();
  const byDate = {};
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
// 16. DATABASE STATUS - a simplified "Database" admin tab: real row/cell
//     counts against Google Sheets' ceiling, so Super Admin always knows
//     how much headroom is left. (The billing app additionally supports
//     archiving into a second spreadsheet when a sheet gets huge - that
//     multi-spreadsheet failover is intentionally left out of this first
//     draft to keep the schema simple; the counts below make it obvious
//     well before it would ever matter for a single clinic's patient load.)
// ---------------------------------------------------------------------------
const SHEETS_CELL_CEILING = 10000000; // Google Sheets' own per-spreadsheet cell limit

function apiGetDbStatus() {
  const ssRef = ss_();
  const sheetsInfo = [SHEET.VISITS, SHEET.PATIENTS, SHEET.PHYSIOS, SHEET.ISSUES].map(name => {
    const sh = ssRef.getSheetByName(name);
    if (!sh) return { name: name, rows: 0, cols: 0, cells: 0 };
    const rows = Math.max(0, sh.getLastRow() - 1);
    const cols = sh.getLastColumn();
    return { name: name, rows: rows, cols: cols, cells: rows * cols };
  });
  let totalCellsUsed = 0;
  ssRef.getSheets().forEach(sh => { totalCellsUsed += sh.getLastRow() * sh.getLastColumn(); });
  return {
    ok: true,
    sheets: sheetsInfo,
    totalCellsUsed: totalCellsUsed,
    cellCeiling: SHEETS_CELL_CEILING,
    percentUsed: Math.round((totalCellsUsed / SHEETS_CELL_CEILING) * 1000) / 10,
    totalVisits: sheetsInfo[0].rows,
    totalPatients: sheetsInfo[1].rows,
    totalPhysios: sheetsInfo[2].rows,
    totalIssues: sheetsInfo[3].rows
  };
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
// own configurable color - point 20.
function fld_(label, value, s) {
  const labelHtml = label ? '<span class="fl-label" style="color:' + (s.ThemeFieldLabelColor || '#0f6e5c') + '">' + escHtml_(label) + ': </span>' : '';
  return '<div class="doc-field">' + labelHtml +
    '<span class="fl-value" style="color:' + (s.ThemeFieldValueColor || '#182322') + '">' + escHtml_(value || '-') + '</span>' +
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

// Renders the four body-map views with any saved marks drawn as small
// colored dots at their saved percentage coordinates - pure SVG, no image.
function bodyDiagramsHtml_(painMarksJson) {
  const marks = safeJsonParse_(painMarksJson, []);
  const views = [
    { key: 'front', label: 'FRONT VIEW', svg: BODY_SVG_FRONT, mirror: false },
    { key: 'back', label: 'BACK VIEW', svg: BODY_SVG_BACK, mirror: false },
    { key: 'right', label: 'RIGHT SIDE VIEW', svg: BODY_SVG_SIDE, mirror: false },
    { key: 'left', label: 'LEFT SIDE VIEW', svg: BODY_SVG_SIDE, mirror: true }
  ];
  const cells = views.map(v => {
    const dots = marks.filter(m => m.view === v.key).map(m =>
      '<circle cx="' + (m.x * 2) + '" cy="' + (m.y * 4.8) + '" r="4.2" fill="' + escHtml_(m.color) + '" stroke="#ffffff" stroke-width="1"/>'
    ).join('');
    const transform = v.mirror ? ' style="transform:scaleX(-1)"' : '';
    return '<div class="body-view">' +
      '<svg viewBox="0 0 200 480" class="body-svg"' + transform + '>' + v.svg + dots + '</svg>' +
      '<div class="body-view-label">' + v.label + '</div></div>';
  }).join('');
  return '<div class="body-diagrams">' + cells + '<div class="body-legend">' +
    '<span><i style="background:#d1352f"></i> Pain Point</span> <span><i style="background:#2778b7"></i> Radiating Point</span>' +
    '</div></div>';
}

function checkboxRow_(label, checked, s) {
  return '<span class="pmh-item"><span class="chk">' + (checked ? '&#9745;' : '&#9744;') + '</span> ' +
    '<span style="color:' + (s.ThemeFieldLabelColor || '#0f6e5c') + '">' + escHtml_(label) + '</span></span>';
}

function buildAssessmentHtmlForPdf_(a, s) {
  const logo = getLogoDataUri_(s.PrintLogoURL || s.LogoURL);
  const font = s.ThemeDocFontFamily || "Georgia, 'Times New Roman', Times, serif";
  const headerColor = s.ThemeDocHeaderColor || '#04bd07';
  const labelColor = s.ThemeFieldLabelColor || '#0f6e5c';
  const bandColor = s.ThemeSectionBandColor || '#eaf6f1';

  const pmh = [checkboxRow_('DM', truthy_(a.pMH_DM), s), checkboxRow_('HTN', truthy_(a.pMH_HTN), s),
    checkboxRow_('Thyroid', truthy_(a.pMH_Thyroid), s), checkboxRow_('Cardiac', truthy_(a.pMH_Cardiac), s)].join(' &nbsp; ');

  const vasScale = [...Array(11).keys()].map(n =>
    '<span class="vas-num' + (String(n) === String(a.vAS) ? ' vas-active' : '') + '">' + n + '</span>').join('');

  const signatureImg = a.signatureUrl ? '<img class="sig-img" src="' + escHtml_(a.signatureUrl) + '">' : '<div class="sig-line"></div>';

  return '<html><head><meta charset="utf-8"><style>' + docPrintCss_(font, headerColor, bandColor) + '</style></head><body>' +
    docHeaderHtml_(s, logo) +
    '<div class="doc-title-bar" style="background:' + headerColor + '">PHYSIOTHERAPY ASSESSMENT SHEET</div>' +

    '<div class="doc-page">' +
    '<div class="section-band" style="background:' + bandColor + '">Patient Details</div>' +
    '<div class="grid-4">' +
      fld_('Patient Name', a.patientName, s) + fld_('Date', a.date, s) + fld_('Referred By', a.referredBy, s) + fld_('Age / Sex', (a.age || '-') + ' / ' + (a.sex || '-'), s) +
      fld_('UHID / File No.', a.uHID, s) + fld_('Contact No.', a.phone, s) + fld_('Occupation', a.occupation, s) + fld_('Email ID', a.email, s) +
      fld_('Address', a.address, s) + fld_('How They Knew Us', a.howKnow, s) + fld_('Invoice No.', a.invoiceNumber, s) + fld_('Issue Type', a.issueType, s) +
    '</div>' +

    '<div class="grid-2">' + fld_('Chief Complaint', a.chiefComplaint, s) + fld_('History of Present Illness', a.historyOfPresentIllness, s) + '</div>' +

    '<div class="section-band" style="background:' + bandColor + '">Observation &amp; Pain Assessment</div>' +
    '<div class="grid-3">' + fld_('Posture', a.posture, s) + fld_('Gait', a.obsGait, s) + fld_('Deformity / Swelling', a.deformitySwelling, s) + '</div>' +
    '<div class="doc-field"><span class="fl-label" style="color:' + labelColor + '">Pain Assessment (VAS): </span></div>' +
    '<div class="vas-row">' + vasScale + '</div>' +
    '<div class="grid-3">' + fld_('Nature of Pain', a.natureOfPain, s) + fld_('Aggravating Factors', a.aggravatingFactors, s) + fld_('Relieving Factors', a.relievingFactors, s) + '</div>' +

    '<div class="section-band" style="background:' + bandColor + '">Past Medical History</div>' +
    '<div class="pmh-row">' + pmh + '</div>' + fld_('Surgery / Fracture / Hospitalization', a.surgeryFractureHospitalization, s) +

    '<div class="section-band" style="background:' + bandColor + '">Range of Motion (ROM)</div>' + romTableHtml_(a.romJson, s) +
    '<div class="section-band" style="background:' + bandColor + '">Muscle Strength (MMT)</div>' + romTableHtml_(a.mmtJson, s) +

    '<div class="section-band" style="background:' + bandColor + '">Mark Pain Point &amp; Radiating Pain</div>' + bodyDiagramsHtml_(a.painMarksJson) +

    '<div class="section-band" style="background:' + bandColor + '">Special Tests</div>' + specialTestsTableHtml_(a.specialTestsJson) +

    '<div class="section-band" style="background:' + bandColor + '">Functional Assessment</div>' +
    '<div class="grid-3">' + fld_('Ambulation', a.ambulation, s) + fld_('Stair Climbing', a.stairClimbing, s) + fld_('ADLs', a.adLs, s) + '</div>' +
    '</div>' + // end page 1

    '<div class="doc-page page-break">' +
    docHeaderHtml_(s, logo) +
    '<div class="doc-title-bar" style="background:' + headerColor + '">PHYSIOTHERAPY ASSESSMENT SHEET (contd.)</div>' +

    '<div class="section-band" style="background:' + bandColor + '">Balance</div>' +
    '<div class="grid-2">' + fld_('Single Leg Stance', a.balanceSingleLegStance, s) + fld_('Romberg Test', a.balanceRombergTest, s) + '</div>' +

    '<div class="section-band" style="background:' + bandColor + '">Gait</div>' +
    '<div class="grid-3">' + fld_('Pattern', a.gaitPattern, s) + fld_('Cadence', a.gaitCadence, s) + fld_('Limping', a.gaitLimping, s) + '</div>' +

    '<div class="section-band" style="background:' + bandColor + '">Clinical Diagnosis</div>' + fld_('', a.clinicalDiagnosis, s) +

    '<div class="grid-2">' +
      '<div><div class="doc-field"><span class="fl-label" style="color:' + labelColor + '">Treatment Goals</span></div>' + listHtml_(a.treatmentGoalsJson) + '</div>' +
      '<div><div class="doc-field"><span class="fl-label" style="color:' + labelColor + '">Treatment Plan</span></div>' + listHtml_(a.treatmentPlanJson) + '</div>' +
    '</div>' +

    '<div class="section-band" style="background:' + bandColor + '">Follow Up / Notes</div>' +
    '<div class="notes-box">' + escHtml_(a.followUpNotes || '').replace(/\n/g, '<br>') + '</div>' +

    '<div class="footer-row">' +
      '<div>' + fld_('Next Review Date', a.nextReviewDate, s) + '</div>' +
      '<div class="sig-block">' + signatureImg + '<div class="sig-caption">' + escHtml_(a.physioName || 'Physiotherapist') + '<br><span class="muted">Physiotherapist Signature</span></div></div>' +
    '</div>' +

    '<div class="record-ids">Visit ID: ' + escHtml_(a.visitId) + ' &nbsp;|&nbsp; Patient Visit ID: ' + escHtml_(a.patientVisitId) + '</div>' +
    '<div class="tagline">Move Better. Live Better.</div>' +
    '</div>' + // end page 2
    '</body></html>';
}

function docHeaderHtml_(s, logo) {
  const logoW = (s.ThemeDocLogoWidth || 96) + 'px', logoH = (s.ThemeDocLogoHeight || 58) + 'px';
  const nameStyle = 'font-weight:' + (truthy_(s.ThemeDocCompanyNameBold) ? 'bold' : 'normal') +
    ';font-style:' + (truthy_(s.ThemeDocCompanyNameItalic) ? 'italic' : 'normal') +
    ';text-decoration:' + (truthy_(s.ThemeDocCompanyNameUnderline) ? 'underline' : 'none');
  const infoStyle = 'font-weight:' + (truthy_(s.ThemeDocCompanyInfoBold) ? 'bold' : 'normal') +
    ';font-style:' + (truthy_(s.ThemeDocCompanyInfoItalic) ? 'italic' : 'normal') +
    ';text-decoration:' + (truthy_(s.ThemeDocCompanyInfoUnderline) ? 'underline' : 'none');
  return '<div class="doc-header">' +
    (logo ? '<img class="doc-logo" style="width:' + logoW + ';height:' + logoH + '" src="' + logo + '">' : '') +
    '<div class="doc-header-text">' +
      '<div class="doc-company-name" style="' + nameStyle + '">' + escHtml_(s.ClinicName) + '</div>' +
      '<div class="doc-company-info" style="' + infoStyle + '">' + escHtml_(s.Address) + '</div>' +
      '<div class="doc-company-info" style="' + infoStyle + '">' + escHtml_(s.Phone) +
        (truthy_(s.ShowClinicEmail) && s.ClinicEmail ? ' &nbsp;|&nbsp; ' + escHtml_(s.ClinicEmail) : '') +
        (s.Website ? ' &nbsp;|&nbsp; ' + escHtml_(s.Website) : '') + '</div>' +
    '</div></div>';
}

function docPrintCss_(font, headerColor, bandColor) {
  return 'body{font-family:' + font + ';color:#182322;margin:0;padding:18px 26px;}' +
    '.doc-header{display:flex;align-items:center;gap:14px;border-bottom:2px solid ' + headerColor + ';padding-bottom:8px;margin-bottom:6px;}' +
    '.doc-company-name{font-size:20px;} .doc-company-info{font-size:11.5px;color:#4B5A57;}' +
    '.doc-title-bar{color:#fff;text-align:center;font-weight:bold;letter-spacing:1px;padding:5px;font-size:13px;margin-bottom:10px;}' +
    '.section-band{padding:4px 8px;font-weight:bold;font-size:12.5px;margin:12px 0 6px;border-radius:3px;}' +
    '.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;} .grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 18px;}' +
    '.grid-4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px 18px;}' +
    '.doc-field{font-size:12px;padding:2px 0;} .fl-label{font-weight:bold;} .muted{color:#8a938f;font-style:italic;}' +
    '.vas-row{display:flex;justify-content:space-between;max-width:420px;margin:4px 0 8px;font-size:11px;}' +
    '.vas-num{width:18px;height:18px;border:1px solid #999;border-radius:50%;text-align:center;line-height:18px;}' +
    '.vas-active{background:#d1352f;color:#fff;border-color:#d1352f;font-weight:bold;}' +
    '.pmh-row{font-size:12px;margin-bottom:4px;} .pmh-item{margin-right:14px;} .chk{font-size:14px;}' +
    'table.rom-table,table.special-tests-table{border-collapse:collapse;width:100%;font-size:11px;margin-bottom:8px;}' +
    'table.rom-table th,table.rom-table td,table.special-tests-table th,table.special-tests-table td{border:1px solid #ccc;padding:3px 6px;text-align:left;}' +
    'table.rom-table .num,table.special-tests-table .num{text-align:center;width:70px;}' +
    '.rom-joint{font-weight:bold;background:#f5f5f5;vertical-align:top;}' +
    '.body-diagrams{display:flex;gap:6px;justify-content:space-between;margin-bottom:6px;}' +
    '.body-view{text-align:center;width:23%;} .body-svg{width:100%;height:auto;}' +
    '.body-view-label{font-size:9.5px;font-weight:bold;color:#4B5A57;}' +
    '.body-legend{width:100%;font-size:10px;margin-top:2px;} .body-legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:3px;}' +
    '.doc-list{margin:2px 0 8px;padding-left:18px;font-size:12px;}' +
    '.notes-box{border:1px solid #ddd;min-height:90px;padding:6px 8px;font-size:12px;border-radius:3px;}' +
    '.footer-row{display:flex;justify-content:space-between;align-items:flex-end;margin-top:18px;}' +
    '.sig-block{text-align:center;} .sig-img{max-width:150px;max-height:60px;display:block;margin:0 auto 4px;}' +
    '.sig-line{width:150px;border-bottom:1px solid #333;height:44px;}' +
    '.sig-caption{font-size:11px;} .record-ids{font-size:9.5px;color:#8a938f;margin-top:14px;}' +
    '.tagline{text-align:center;font-style:italic;color:' + headerColor + ';font-size:11px;margin-top:4px;}' +
    '.page-break{page-break-before:always;margin-top:18px;padding-top:14px;}';
}

// ---------------------------------------------------------------------------
// 18. BODY OUTLINE ARTWORK - original, simple clinical line-art figures
//     (not a traced/embedded image) used as the base for the four pain-map
//     views. Pure vector paths so they scale losslessly at any print size
//     and so the pain/radiating dots (point 5) can be laid exactly on top
//     using nothing but percentage coordinates.
// ---------------------------------------------------------------------------
const BODY_SVG_FRONT = `
  <g fill="none" stroke="#3a4a48" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
    <ellipse cx="100" cy="32" rx="18" ry="22"/>
    <path d="M82,30 q-4,2 -2,7"/>
    <path d="M118,30 q4,2 2,7"/>
    <path d="M92,51 L92,64 Q100,69 108,64 L108,51"/>
    <path d="M92,66 Q66,70 52,82 Q42,91 38,108 Q34,128 35,150 Q36,168 28,182 Q18,198 15,214 Q13,226 16,236 Q19,244 27,244 Q34,243 37,235 Q44,218 47,200 Q51,178 55,158 Q58,142 58,124 Q58,104 63,90"/>
    <path d="M16,236 Q10,240 10,248 Q10,256 18,258 Q26,259 28,251 Q29,246 27,244"/>
    <path d="M108,66 Q134,70 148,82 Q158,91 162,108 Q166,128 165,150 Q164,168 172,182 Q182,198 185,214 Q187,226 184,236 Q181,244 173,244 Q166,243 163,235 Q156,218 153,200 Q149,178 145,158 Q142,142 142,124 Q142,104 137,90"/>
    <path d="M184,236 Q190,240 190,248 Q190,256 182,258 Q174,259 172,251 Q171,246 173,244"/>
    <path d="M92,66 Q64,71 55,90 Q49,104 50,122 Q51,148 58,158 Q95,172 100,172 Q105,172 142,158 Q149,148 150,122 Q151,104 145,90 Q136,71 108,66"/>
    <path d="M58,158 Q54,178 56,196 Q58,212 66,222 L100,226 L134,222 Q142,212 144,196 Q146,178 142,158 Q100,172 58,158 Z"/>
    <path d="M66,222 Q60,260 58,300 Q56,340 54,376 Q52,404 50,424 Q49,436 53,444 Q58,451 66,450 Q73,449 75,440 Q77,420 79,392 Q82,352 86,314 Q89,286 92,262 Q95,240 98,226 L100,226"/>
    <path d="M134,222 Q140,260 142,300 Q144,340 146,376 Q148,404 150,424 Q151,436 147,444 Q142,451 134,450 Q127,449 125,440 Q123,420 121,392 Q118,352 114,314 Q111,286 108,262 Q105,240 102,226 L100,226"/>
    <path d="M50,424 Q44,432 46,440 Q48,446 56,446" opacity="0.9"/>
    <path d="M150,424 Q156,432 154,440 Q152,446 144,446" opacity="0.9"/>
    <path d="M58,158 Q100,166 142,158" stroke-width="1.3" opacity="0.45"/>
    <path d="M100,226 L100,262" stroke-width="1.3" opacity="0.45"/>
  </g>`;

// Back view reuses the exact same silhouette (so front/back line up
// anatomically) with the ear marks dropped - a plain head/back of skull.
const BODY_SVG_BACK = `
  <g fill="none" stroke="#3a4a48" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
    <ellipse cx="100" cy="32" rx="18" ry="22"/>
    <path d="M100,10 L100,16" stroke-width="1.3" opacity="0.45"/>
    <path d="M92,51 L92,64 Q100,69 108,64 L108,51"/>
    <path d="M92,66 Q66,70 52,82 Q42,91 38,108 Q34,128 35,150 Q36,168 28,182 Q18,198 15,214 Q13,226 16,236 Q19,244 27,244 Q34,243 37,235 Q44,218 47,200 Q51,178 55,158 Q58,142 58,124 Q58,104 63,90"/>
    <path d="M16,236 Q10,240 10,248 Q10,256 18,258 Q26,259 28,251 Q29,246 27,244"/>
    <path d="M108,66 Q134,70 148,82 Q158,91 162,108 Q166,128 165,150 Q164,168 172,182 Q182,198 185,214 Q187,226 184,236 Q181,244 173,244 Q166,243 163,235 Q156,218 153,200 Q149,178 145,158 Q142,142 142,124 Q142,104 137,90"/>
    <path d="M184,236 Q190,240 190,248 Q190,256 182,258 Q174,259 172,251 Q171,246 173,244"/>
    <path d="M92,66 Q64,71 55,90 Q49,104 50,122 Q51,148 58,158 Q95,172 100,172 Q105,172 142,158 Q149,148 150,122 Q151,104 145,90 Q136,71 108,66"/>
    <path d="M100,90 L100,150" stroke-width="1.3" opacity="0.4"/>
    <path d="M58,158 Q54,178 56,196 Q58,212 66,222 L100,226 L134,222 Q142,212 144,196 Q146,178 142,158 Q100,172 58,158 Z"/>
    <path d="M66,222 Q60,260 58,300 Q56,340 54,376 Q52,404 50,424 Q49,436 53,444 Q58,451 66,450 Q73,449 75,440 Q77,420 79,392 Q82,352 86,314 Q89,286 92,262 Q95,240 98,226 L100,226"/>
    <path d="M134,222 Q140,260 142,300 Q144,340 146,376 Q148,404 150,424 Q151,436 147,444 Q142,451 134,450 Q127,449 125,440 Q123,420 121,392 Q118,352 114,314 Q111,286 108,262 Q105,240 102,226 L100,226"/>
    <path d="M50,424 Q44,432 46,440 Q48,446 56,446" opacity="0.9"/>
    <path d="M150,424 Q156,432 154,440 Q152,446 144,446" opacity="0.9"/>
    <path d="M58,158 Q100,166 142,158" stroke-width="1.3" opacity="0.45"/>
  </g>`;

// Right-side profile. Mirrored with a CSS transform for the Left view -
// see bodyDiagramsHtml_ and the client-side renderBodyDiagram().
const BODY_SVG_SIDE = `
  <g fill="none" stroke="#3a4a48" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
    <path d="M92,14 Q78,16 76,32 Q75,44 82,52 Q84,55 83,60 L88,60 Q90,55 90,52 Q100,54 107,48 Q113,43 114,36 Q120,36 121,31 Q122,27 117,26 Q116,18 108,14 Q100,10 92,14 Z"/>
    <path d="M84,60 L83,72 Q92,78 99,72 L98,61"/>
    <path d="M99,68 Q116,74 122,90 Q126,104 122,118 Q119,130 122,142"/>
    <path d="M83,72 Q66,78 60,96 Q56,112 60,128 Q62,140 58,152"/>
    <path d="M118,88 Q132,96 136,112 Q140,128 134,146 Q130,162 132,178 Q134,192 128,202 Q123,210 114,208"/>
    <path d="M132,178 Q140,182 140,192 Q140,200 132,201 Q125,201 124,194"/>
    <path d="M122,142 Q126,152 122,164 Q118,176 106,182 L88,182 Q74,177 70,166 Q66,156 58,152"/>
    <path d="M106,182 Q112,212 110,246 Q108,280 108,312 Q108,338 110,360 Q111,372 108,382"/>
    <path d="M88,182 Q84,208 86,234 Q88,260 82,284 Q76,308 78,332 Q79,348 72,360"/>
    <path d="M108,382 Q107,390 115,393 Q128,397 134,392 Q137,388 131,385 Q120,381 108,382 Z"/>
    <path d="M72,360 Q68,368 70,376 Q72,383 81,383 Q87,383 88,377 Q89,370 84,364 Q79,359 72,360 Z"/>
    <path d="M122,118 Q90,130 58,152" stroke-width="1.3" opacity="0.45"/>
  </g>`;

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
  const rows = [
    ['Visit ID', a.visitId], ['Date', a.date], ['Patient', a.patientName], ['Issue Type', a.issueType],
    ['Clinical Diagnosis', a.clinicalDiagnosis], ['Next Review Date', a.nextReviewDate], ['Physiotherapist', a.physioName]
  ];
  const rowsHtml = rows.map(r => '<tr><td style="padding:6px 10px;color:#4B5A57;font-size:13px;">' + escHtml_(r[0]) +
    '</td><td style="padding:6px 10px;font-size:13px;font-weight:bold;">' + escHtml_(r[1] || '-') + '</td></tr>').join('');
  return '<p style="font-size:14px;">Dear ' + escHtml_(a.patientName) + ',</p>' +
    '<p style="font-size:14px;">Please find attached your physiotherapy assessment record from ' + escHtml_(s.ClinicName) + '.</p>' +
    '<table style="border-collapse:collapse;width:100%;margin:12px 0;">' + rowsHtml + '</table>' +
    '<p style="font-size:13px;color:#4B5A57;">The full assessment sheet, including range-of-motion charts and treatment plan, is attached as a PDF.</p>';
}

function buildBrandedEmailShell_(s, bodyRowsHtml) {
  const logo = getLogoDataUri_(s.LogoURL);
  return '<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;border:1px solid #E7DCD8;border-radius:8px;overflow:hidden;">' +
    '<div style="background:' + (s.ThemeDocHeaderColor || '#04bd07') + ';padding:16px;text-align:center;">' +
    (logo ? '<img src="' + logo + '" style="height:40px;">' : '') +
    '<div style="color:#fff;font-size:18px;font-weight:bold;margin-top:4px;">' + escHtml_(s.ClinicName) + '</div></div>' +
    '<div style="padding:20px;">' + bodyRowsHtml + '</div>' +
    '<div style="background:#F6F4F3;padding:12px;text-align:center;font-size:11px;color:#4B5A57;">' +
    escHtml_(s.Address) + '<br>' + escHtml_(s.Phone) + (s.Website ? ' | ' + escHtml_(s.Website) : '') + '</div></div>';
}
