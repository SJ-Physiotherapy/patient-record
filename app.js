/* =========================================================================
   SJ PHYSIOTHERAPY - PATIENT ASSESSMENT & RECORDS SYSTEM
   Frontend logic (vanilla JS only - no third-party scripts)
   ========================================================================= */
'use strict';

// -------------------------------------------------------------------------
// 0. CONFIG - paste your Apps Script Web App URL here after deployment.
//    Guide: SETUP_GUIDE.md, Step 4.
// -------------------------------------------------------------------------
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbyn8GHWlGoJu053qLL_eG7Az7T80dlm0EgutUgupkuZPeOsN5GX2ZMY9GmtzTbMGNOt/exec'
};

const FRONTEND_BUILD = 'SJP-PAF-2026-10-09-01';
const EXPECTED_BACKEND_BUILD = 'SJP-PAF-2026-10-09-01'; // must match BACKEND_BUILD in Code.gs
console.log('SJ Physiotherapy - Assessment app.js build', FRONTEND_BUILD);

const DEFAULT_LOGO_URL = 'https://sjphysiotherapy.in/LOGO/favicon.png';
const API_TIMEOUT_MS = 45000;
const PDF_TIMEOUT_MS = 120000;
const DASH_CACHE_MS = 60000;
const SUPER_ADMIN_AUTH = '__superadmin__';
const EDIT_REASON_MIN = 3;

function checkBackendBuild_(serverBuild) {
  const bar = document.getElementById('staleBackendBar');
  if (!bar) return;
  if (serverBuild && serverBuild === EXPECTED_BACKEND_BUILD) {
    bar.classList.remove('show'); bar.innerHTML = ''; return;
  }
  bar.innerHTML = '&#9888;&#65039; This website\'s backend (Apps Script) is running an OLDER version than expected ' +
    '(server says: <code>' + escapeHtml(serverBuild || 'unknown') + '</code>, expected <code>' + escapeHtml(EXPECTED_BACKEND_BUILD) + '</code>). ' +
    'In Apps Script: Deploy &rarr; Manage deployments &rarr; edit the deployment &rarr; "New version" &rarr; Deploy.';
  bar.classList.add('show');
}

// -------------------------------------------------------------------------
// 1. STATE
// -------------------------------------------------------------------------
// Fixed Range-of-Motion / Muscle-Strength table shape - MUST stay in sync
// with ROM_STRUCTURE in Code.gs.
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

const state = {
  settings: {},
  physios: [],
  issues: [],
  howKnowOptions: [],
  ambulationOptions: ['Independent', 'Assisted'],
  bootstrapped: false,
  formReady: false,
  customCharts: [],
  customChartFilters: {},
  dashCounts: null,
  dashRaw: [],
  dashFilters: {},
  dashLoadedAt: 0,
  themeChartPalette: ['#a8d339', '#2778b7', '#59ff4d', '#1F9E78', '#2E86AB', '#6C4FB6', '#3D5A80', '#8C2F39', '#D4A017', '#4B5A57', '#7A5C61', '#2be42e'],
  session: { role: null, physioId: '', physioName: '', canAccessFindEdit: false, canAccessReportDownload: false, canAccessDashboard: false },
  // Live editable-form state for the parts too structured for plain inputs:
  form: {
    romData: {}, mmtData: {}, painMarks: [], specialTests: [], treatmentGoals: [], treatmentPlan: [],
    activeMarkColor: '#d1352f', activeMarkType: 'pain'
  },
  formDirty: false,
  saving: false,
  lastSavedAssessment: null,   // the record currently shown in the preview
  previewReturnView: 'assessment',
  editing: null,               // { visitId, record } while a record is being edited
  draftSnapshot: null,         // a half-typed NEW assessment, parked while editing
  lastLookupQuery: '',
  pdfCache: null
};

// -------------------------------------------------------------------------
// 2. API HELPERS
//    SECURITY NOTE: the ONLY thing ever written to sessionStorage is the
//    opaque session token (meaningless without the server-side cache entry
//    behind it, expires in 6h) plus a few non-secret display fields. The
//    PASSWORD is never written anywhere in the browser at any point.
//
//    Robustness: every call resolves to an {ok:false, error} object instead
//    of throwing on network failure, timeout, or a non-JSON reply - so a
//    flaky connection can never leave a button stuck on "Saving...". GETs
//    are retried once on a dropped connection and de-duplicated while in
//    flight (a double-tap never fires two identical requests).
// -------------------------------------------------------------------------
const inflightGets_ = new Map();
let suppressUnloadWarning_ = false;

function getToken_() { return sessionStorage.getItem('SJP_token') || ''; }
function sleep_(ms) { return new Promise(res => setTimeout(res, ms)); }
function nextPaint_() { return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))); }

function networkErrorResult_(err) {
  const timedOut = err && err.name === 'AbortError';
  return {
    ok: false, networkError: true,
    error: timedOut
      ? 'The server is taking too long to respond. Please check your connection and try again.'
      : 'Could not reach the server. Please check your internet connection and try again.'
  };
}

async function fetchJson_(url, init, timeoutMs) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || API_TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {}));
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      return { ok: false, error: 'The server sent an unexpected reply (HTTP ' + res.status + '). If this keeps happening, check the Apps Script deployment.' };
    }
    handleSessionExpiry_(data);
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function apiPost(action, payload, opts) {
  try {
    return await fetchJson_(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // "simple" request - no CORS preflight
      body: JSON.stringify({ action, payload, token: getToken_() })
    }, opts && opts.timeoutMs);
  } catch (err) {
    return networkErrorResult_(err);
  }
}

async function apiGet(action, params, opts) {
  const qs = new URLSearchParams(Object.assign({ action, token: getToken_() }, params || {})).toString();
  if (inflightGets_.has(qs)) return inflightGets_.get(qs);
  const p = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fetchJson_(CONFIG.API_URL + '?' + qs, { cache: 'no-store' }, opts && opts.timeoutMs);
      } catch (err) {
        if (attempt === 1 || (err && err.name === 'AbortError')) return networkErrorResult_(err);
        await sleep_(700);
      }
    }
    return networkErrorResult_(null);
  })();
  inflightGets_.set(qs, p);
  try { return await p; } finally { inflightGets_.delete(qs); }
}

const SESSION_STORAGE_KEYS = ['SJP_displayName', 'SJP_role', 'SJP_token', 'SJP_physioId', 'SJP_physioName',
  'SJP_canAccessFindEdit', 'SJP_canAccessReportDownload', 'SJP_canAccessDashboard'];

let sessionExpiryHandled_ = false;
function handleSessionExpiry_(r) {
  if (r && r.ok === false && r.sessionExpired && !sessionExpiryHandled_) {
    sessionExpiryHandled_ = true;
    SESSION_STORAGE_KEYS.forEach(k => sessionStorage.removeItem(k));
    toast('Your session expired. Please log in again.', 'error');
    suppressUnloadWarning_ = true;
    setTimeout(() => location.reload(), 1200);
  }
}

// Wraps any async action: disables the button, shows a spinner, always
// restores it - even if the action throws.
async function withBusy_(btn, busyText, fn) {
  if (!btn) return fn();
  if (btn.classList.contains('is-busy')) return undefined;
  const original = btn.innerHTML;
  btn.classList.add('is-busy'); btn.disabled = true;
  if (busyText) btn.textContent = busyText;
  try { return await fn(); }
  finally { btn.classList.remove('is-busy'); btn.disabled = false; btn.innerHTML = original; }
}

// -------------------------------------------------------------------------
// 3. TOASTS
// -------------------------------------------------------------------------
function toast(msg, type) {
  const wrap = document.getElementById('toastHost');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 6000 : 4200);
}

// -------------------------------------------------------------------------
// 4. UTILITIES
// -------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function truncate(str, n) { str = String(str || ''); return str.length > n ? str.slice(0, n - 1) + '…' : str; }
function todayStr_() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function el_(id) { return document.getElementById(id); }
function val_(id) { const e = el_(id); return e ? e.value : ''; }
function setVal_(id, v) { const e = el_(id); if (e) e.value = (v === undefined || v === null) ? '' : v; }
function checked_(id) { const e = el_(id); return !!(e && e.checked); }
function setChecked_(id, v) { const e = el_(id); if (e) e.checked = !!v; }
function truthyStr_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function safeParse_(str, fallback) {
  if (str === null || str === undefined || str === '') return fallback;
  if (typeof str === 'object') return str;
  try { const v = JSON.parse(str); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function deepClone_(o) { return JSON.parse(JSON.stringify(o)); }
function debounce_(fn, ms) { let t; return function () { const args = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); }; }
function usableUrl_(u) { u = String(u || '').trim(); return (!u || /via\.placeholder\.com/i.test(u)) ? '' : u; }
function safeColor_(c) { c = String(c || ''); return /^#[0-9a-f]{3,8}$/i.test(c) || /^rgba?\([\d\s.,%]+\)$/i.test(c) ? c : '#d1352f'; }
function digitsOnly_(s) { return String(s || '').replace(/\D/g, ''); }
function isValidEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }

function isMobileDevice_() {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
// In-app browsers (WhatsApp, Instagram, Facebook, Gmail/Google app, Android
// WebViews...) silently ignore window.print().
function isInAppBrowser_() {
  const ua = navigator.userAgent || '';
  return /; wv\)|\bwv\b|FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|GSA\/|Snapchat|LinkedInApp|Twitter/i.test(ua);
}
function browserPrintAvailable_() {
  if (typeof window.print !== 'function') return false;
  if (window.navigator.standalone === true) return false; // iOS home-screen web app: print() does nothing
  if (isInAppBrowser_()) return false;
  return true;
}

// -------------------------------------------------------------------------
// 5. THEME CACHE - public clinic/theme settings are cached in this browser
//    (never anything secret) so the login screen and app paint in the
//    clinic's own colors instantly instead of flashing defaults while the
//    server wakes up.
// -------------------------------------------------------------------------
const THEME_CACHE_KEY = 'SJP_publicSettings_v1';
function cachePublicSettings_(s) {
  try {
    const copy = Object.assign({}, s);
    delete copy.SuperAdminUser; delete copy.SuperAdminPass;
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(copy));
  } catch (e) { /* private mode / storage full - not important */ }
}
function readCachedPublicSettings_() {
  try { const raw = localStorage.getItem(THEME_CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

// -------------------------------------------------------------------------
// 6. LOGIN / LOGOUT
// -------------------------------------------------------------------------
el_('loginBtn').addEventListener('click', doLogin);
el_('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
el_('loginUser').addEventListener('keydown', e => { if (e.key === 'Enter') el_('loginPass').focus(); });

function showApp_() { el_('loginScreen').classList.add('hidden'); el_('appShell').classList.remove('hidden'); }
function showLogin_(msg) {
  el_('appShell').classList.add('hidden'); el_('loginScreen').classList.remove('hidden');
  if (msg) { el_('loginError').textContent = msg; el_('loginError').style.display = 'block'; }
}

async function doLogin() {
  const username = val_('loginUser').trim();
  const password = val_('loginPass').trim();
  const errBox = el_('loginError');
  errBox.style.display = 'none';
  if (!username || !password) {
    errBox.textContent = 'Please enter both username and password.';
    errBox.style.display = 'block';
    return;
  }
  const btn = el_('loginBtn');
  await withBusy_(btn, 'Checking...', async () => {
    const r = await apiPost('login', { username, password });
    // The password variable goes out of scope right here and is never
    // written anywhere - only the server's response is kept.
    if (!r.ok) {
      errBox.textContent = r.error || 'Invalid username or password.';
      errBox.style.display = 'block';
      return;
    }
    setVal_('loginPass', '');
    sessionStorage.setItem('SJP_displayName', r.displayName || username);
    sessionStorage.setItem('SJP_role', r.role || 'admin');
    sessionStorage.setItem('SJP_token', r.sessionToken || '');
    if (r.role === 'physio') {
      sessionStorage.setItem('SJP_physioId', r.physioId || '');
      sessionStorage.setItem('SJP_physioName', r.physioName || '');
      sessionStorage.setItem('SJP_canAccessFindEdit', r.canAccessFindEdit ? '1' : '0');
      sessionStorage.setItem('SJP_canAccessReportDownload', r.canAccessReportDownload ? '1' : '0');
      sessionStorage.setItem('SJP_canAccessDashboard', r.canAccessDashboard ? '1' : '0');
    }
    el_('whoAmI').textContent = r.displayName || username;
    showApp_();
    // The new backend sends everything bootstrap needs inside the login
    // reply itself - one round trip instead of three.
    const ok = await bootstrapApp(r.bootstrap);
    if (!ok) showLogin_('Logged in, but the app data could not be loaded. Please try again.');
  });
}

el_('logoutBtn').addEventListener('click', () => {
  if (state.formDirty && !confirm('You have unsaved changes on the form. Log out anyway?')) return;
  SESSION_STORAGE_KEYS.forEach(k => sessionStorage.removeItem(k));
  suppressUnloadWarning_ = true;
  location.reload();
});

// -------------------------------------------------------------------------
// 7. NAVIGATION
// -------------------------------------------------------------------------
const VIEW_FOR_NAV = { assessment: 'view-assessment', lookup: 'view-lookup', reports: 'view-reports', dashboard: 'view-dashboard', admin: 'view-admin' };

function setActiveNav_(navKey) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === navKey));
}

function switchToView_(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
  // While a record is open, Print / Save-as-PDF (including Ctrl+P) print
  // that record and nothing else - see the PRINT section in style.css.
  document.body.classList.toggle('record-open', viewId === 'view-record-preview');
  closeSidebar_();
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

// Leaving the Edit view: confirm if there are unsaved edits, then put the
// form back where it belongs (restoring any parked new-assessment draft).
function confirmLeaveEdit_() {
  if (!state.editing) return true;
  if (state.formDirty && !confirm('You have unsaved changes to ' + state.editing.visitId + '. Discard them?')) return false;
  exitEditMode_();
  return true;
}

function goToView_(navKey) {
  if (!confirmLeaveEdit_()) return false;
  setActiveNav_(navKey);
  switchToView_(VIEW_FOR_NAV[navKey] || 'view-assessment');
  if (navKey === 'dashboard') loadDashboard();
  if (navKey === 'reports') loadReport(reportState.active);
  if (navKey === 'admin') loadAdminTabData_();
  if (navKey === 'lookup') setTimeout(() => { if (!isMobileDevice_()) el_('lookupQuery').focus(); }, 50);
  return true;
}

document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => goToView_(btn.dataset.view)));

function closeSidebar_() { el_('sidebar').classList.remove('open'); }
el_('hamburgerBtn').addEventListener('click', () => el_('sidebar').classList.toggle('open'));
el_('sidebarScrim').addEventListener('click', closeSidebar_);

window.addEventListener('beforeunload', e => {
  if (state.formDirty && !suppressUnloadWarning_) { e.preventDefault(); e.returnValue = ''; }
});

// -------------------------------------------------------------------------
// 8. BODY VIEW IMAGES - the clinic's own reference images. Must stay
//    identical to BODY_VIEW_IMAGES in Code.gs. (https: the old http:// links
//    were "mixed content" on the https site - silently upgraded at best,
//    blocked at worst, which also broke printing on some phones.)
// -------------------------------------------------------------------------
const BODY_VIEWS = [
  { key: 'front', label: 'Front View', url: 'https://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Front-View.png' },
  { key: 'back', label: 'Back View', url: 'https://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Back-View.png' },
  { key: 'right', label: 'Right Side View', url: 'https://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Right-Facing-View.png' },
  { key: 'left', label: 'Left Side View', url: 'https://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Left-Facing-View.png' }
];

// -------------------------------------------------------------------------
// 9. THEME ENGINE
// -------------------------------------------------------------------------
function gradientCss_(style, from, to) {
  from = from || '#2778b7'; to = to || from;
  if (!style || style === 'solid') return from;
  const dir = style === 'gradient-vertical' ? '180deg' : style === 'gradient-horizontal' ? '90deg' : '135deg';
  return `linear-gradient(${dir}, ${from} 0%, ${to} 100%)`;
}
function applyTheme_(s) {
  s = s || {};
  const root = document.documentElement.style;
  root.setProperty('--brand-gradient', gradientCss_(s.ThemeButtonStyle, s.ThemeButtonFrom, s.ThemeButtonTo));
  root.setProperty('--brand-gradient-hover', gradientCss_(s.ThemeButtonStyle, s.ThemeButtonHoverFrom || s.ThemeButtonFrom, s.ThemeButtonHoverTo || s.ThemeButtonTo));
  root.setProperty('--sidebar-gradient', gradientCss_(s.ThemeSidebarStyle || 'gradient-vertical', s.ThemeSidebarFrom || '#a8d339', s.ThemeSidebarTo || '#2778b7'));
  root.setProperty('--theme-button-text', s.ThemeButtonText || '#FFFFFF');
  root.setProperty('--theme-sidebar-text', s.ThemeSidebarText || '#FFFFFF');
  root.setProperty('--theme-nav-active-bg', s.ThemeNavActiveBg || '#FFFFFF');
  root.setProperty('--theme-nav-active-text', s.ThemeNavActiveText || s.ThemeButtonFrom || '#a8d339');
  root.setProperty('--theme-bill-header', s.ThemeDocHeaderColor || '#2778b7');
  root.setProperty('--theme-bill-header-to', s.ThemeDocHeaderColorTo || '#a8d339');
  root.setProperty('--theme-field-label', s.ThemeFieldLabelColor || '#2778b7');
  root.setProperty('--theme-field-value', s.ThemeFieldValueColor || '#000000');
  root.setProperty('--theme-heading', s.ThemeHeadingColor || '#182322');
  root.setProperty('--theme-muted', s.ThemeMutedColor || '#4B5A57');
  root.setProperty('--theme-bg', s.ThemeBgColor || '#F6F4F3');
  root.setProperty('--theme-surface', s.ThemeSurfaceColor || '#FFFFFF');
  root.setProperty('--theme-border', s.ThemeBorderColor || '#E7DCD8');
  root.setProperty('--theme-bill-font', s.ThemeDocFontFamily || "Georgia, 'Times New Roman', Times, serif");
  root.setProperty('--theme-bill-logo-w', (s.ThemeDocLogoWidth || 96) + 'px');
  root.setProperty('--theme-bill-logo-h', (s.ThemeDocLogoHeight || 58) + 'px');
  root.setProperty('--theme-outline-text', s.ThemeOutlineText || '#2778b7');
  root.setProperty('--theme-outline-border', s.ThemeOutlineBorder || s.ThemeOutlineText || '#2778b7');
  root.setProperty('--theme-outline-hover-bg', s.ThemeOutlineHoverBg || '#EAF3FB');
  root.setProperty('--theme-outline-hover-text', s.ThemeOutlineHoverText || '#2778b7');
  root.setProperty('--theme-login-gradient', gradientCss_(s.ThemeLoginBgStyle || 'gradient-diagonal', s.ThemeLoginBgFrom || '#a8d339', s.ThemeLoginBgTo || '#2778b7'));
  root.setProperty('--theme-login-card-bg', s.ThemeLoginCardBg || '#FFFFFF');
  root.setProperty('--theme-login-heading', s.ThemeLoginHeadingColor || '#182322');
  root.setProperty('--theme-login-text', s.ThemeLoginTextColor || '#4B5A57');
  // These Theme-tab settings were saved but never applied anywhere before:
  root.setProperty('--theme-page-heading', s.ThemePageHeadingColor || '#182322');
  root.setProperty('--theme-page-subheading', s.ThemePageSubheadingColor || '#4B5A57');
  root.setProperty('--theme-section-heading', s.ThemeSectionHeadingColor || '#182322');
  root.setProperty('--theme-tab-active-text', s.ThemeTabActiveTextColor || '#a8d339');
  root.setProperty('--theme-tab-inactive-text', s.ThemeTabInactiveTextColor || '#4B5A57');
  root.setProperty('--theme-tab-indicator', gradientCss_(s.ThemeTabIndicatorStyle || 'gradient-diagonal', s.ThemeTabIndicatorFrom || '#a8d339', s.ThemeTabIndicatorTo || '#2778b7'));
  root.setProperty('--theme-gate-bg', s.ThemeGateBgColor || '#FBF1DC');
  root.setProperty('--theme-gate-border', s.ThemeGateBorderColor || '#E8C766');
  root.setProperty('--theme-gate-title', s.ThemeGateTitleColor || '#C68A1E');

  state.themeChartPalette = String(s.ThemeChartPalette || '').split(',').map(c => c.trim()).filter(Boolean);
  if (!state.themeChartPalette.length) state.themeChartPalette = ['#a8d339', '#2778b7', '#59ff4d'];

  const logoUrl = usableUrl_(s.LogoURL) || DEFAULT_LOGO_URL;
  ['loginLogo', 'sidebarLogo', 'topbarLogo'].forEach(id => { const img = el_(id); if (img && img.getAttribute('src') !== logoUrl) img.src = logoUrl; });
  el_('sidebarCompanyName').textContent = s.ClinicName || 'SJ Physiotherapy';
  document.title = (s.ClinicName || 'SJ Physiotherapy') + ' - Patient Assessment & Records System';
}

// -------------------------------------------------------------------------
// 10. BOOTSTRAP
// -------------------------------------------------------------------------
async function bootstrapApp(prefetched) {
  restoreSessionDisplay_();
  const r = (prefetched && prefetched.ok) ? prefetched : await apiGet('bootstrap', {});
  if (!r.ok) {
    if (!r.sessionExpired) toast(r.error || 'Could not load app data', 'error');
    return false;
  }
  checkBackendBuild_(r.serverBuild);
  state.settings = r.settings || {};
  cachePublicSettings_(state.settings);
  state.physios = r.physios || [];
  state.issues = r.issues || [];
  state.howKnowOptions = r.howKnowOptions || [];
  state.ambulationOptions = r.ambulationOptions || ['Independent', 'Assisted'];
  applyTheme_(state.settings);
  applyRoleVisibility_();
  populateStaticDropdowns_();
  if (!state.formReady) {
    initRomMmtTables_();
    initBodyDiagrams_();
    initVasScale_();
    wireFormDirtyTracking_();
    state.formReady = true;
  }
  renderSpecialTests_();
  renderGoalsPlan_();
  if (!val_('f_date')) setVal_('f_date', todayStr_());
  state.bootstrapped = true;
  if (r.capacity) warnCapacity_(r.capacity); else checkCapacityAndWarn_();
  return true;
}

function warnCapacity_(c) {
  if (!c || !c.ok) return;
  if (c.blocked) {
    toast('This database is full (' + c.percentUsed + '%). Ask Super Admin to add a new database from Admin Settings → Database before saving more records.', 'error');
  } else if (c.warning) {
    toast('Heads up: this database is ' + c.percentUsed + '% full. Super Admin can add a new one anytime from Admin Settings → Database.', '');
  }
}
async function checkCapacityAndWarn_() {
  const r = await apiGet('getCapacityStatus', {});
  warnCapacity_(r);
}

function restoreSessionDisplay_() {
  state.session.role = sessionStorage.getItem('SJP_role') || 'admin';
  state.session.physioId = sessionStorage.getItem('SJP_physioId') || '';
  state.session.physioName = sessionStorage.getItem('SJP_physioName') || '';
  state.session.canAccessFindEdit = sessionStorage.getItem('SJP_canAccessFindEdit') === '1';
  state.session.canAccessReportDownload = sessionStorage.getItem('SJP_canAccessReportDownload') === '1';
  state.session.canAccessDashboard = sessionStorage.getItem('SJP_canAccessDashboard') === '1';
  el_('whoAmI').textContent = sessionStorage.getItem('SJP_displayName') || 'SJ Physiotherapy';
}
function isAdmin_() { return state.session.role !== 'physio'; }

function applyRoleVisibility_() {
  const isAdmin = isAdmin_();
  el_('navAdmin').style.display = isAdmin ? '' : 'none';
  document.querySelector('.nav-item[data-view="lookup"]').style.display = (isAdmin || state.session.canAccessFindEdit) ? '' : 'none';
  document.querySelector('.nav-item[data-view="reports"]').style.display = (isAdmin || state.session.canAccessReportDownload) ? '' : 'none';
  document.querySelector('.nav-item[data-view="dashboard"]').style.display = (isAdmin || state.session.canAccessDashboard) ? '' : 'none';

  if (state.session.role === 'physio') {
    el_('physioAuthFields').style.display = 'none';
    el_('physioLockedField').style.display = '';
    el_('physioSignPasswordField').style.display = '';
    el_('physioLockedText').value = state.session.physioName;
  } else {
    el_('physioAuthFields').style.display = 'contents';
    el_('physioLockedField').style.display = 'none';
    el_('physioSignPasswordField').style.display = 'none';
  }
  updateFormSignaturePreview_();
}

// -------------------------------------------------------------------------
// PHYSIOTHERAPIST SIGNATURE PREVIEW - live on the form itself.
// -------------------------------------------------------------------------
function currentFormPhysioId_() {
  return state.session.role === 'physio' ? state.session.physioId : val_('f_physioId');
}
function updateFormSignaturePreview_() {
  const img = el_('formSignaturePreview'), empty = el_('formSignatureEmpty'), caption = el_('formSignatureCaption');
  if (!img) return;
  // While editing, the record keeps the signature it was signed with -
  // editing never changes who signed it.
  if (state.editing) {
    const rec = state.editing.record || {};
    el_('formSignatureHint').textContent = 'Editing never changes who signed a record - it keeps its original physiotherapist signature.';
    if (rec.signatureUrl) { img.src = rec.signatureUrl; img.style.display = ''; empty.style.display = 'none'; }
    else { img.style.display = 'none'; empty.style.display = ''; empty.textContent = 'No signature on this record'; }
    caption.innerHTML = `Signed by <b>${escapeHtml(rec.physioName || 'Physiotherapist')}</b>.`;
    return;
  }
  el_('formSignatureHint').innerHTML = 'Pulled in automatically from the selected physiotherapist\'s own login - uploaded once from Admin Settings &rarr; My Login, never drawn or typed here.';
  const physioId = currentFormPhysioId_();
  const physio = state.physios.find(p => String(p.physioId) === String(physioId));
  if (!physio) {
    img.style.display = 'none'; empty.style.display = '';
    empty.textContent = 'No physiotherapist selected yet';
    caption.innerHTML = '';
    return;
  }
  if (physio.signatureUrl) {
    img.src = physio.signatureUrl; img.style.display = ''; empty.style.display = 'none';
    caption.innerHTML = `This signature belongs to <b>${escapeHtml(physio.name)}</b> and will be added to the printed assessment sheet automatically.`;
  } else {
    img.style.display = 'none'; empty.style.display = '';
    empty.textContent = 'No signature on file';
    caption.innerHTML = `<span class="warn">${escapeHtml(physio.name)} hasn't uploaded a signature yet</span> - they can add one from Admin Settings &rarr; My Login. The record can still be saved without it.`;
  }
}
el_('f_physioId').addEventListener('change', () => { updateFormSignaturePreview_(); updateAuthLabels_(); });

function populateStaticDropdowns_() {
  const howKnowSel = el_('f_howKnow');
  const curHow = howKnowSel.value;
  howKnowSel.innerHTML = '<option value="">Select...</option>' + state.howKnowOptions.map(o => `<option>${escapeHtml(o)}</option>`).join('');
  howKnowSel.value = curHow;

  const issueSel = el_('f_issueType');
  const curIssue = issueSel.value;
  issueSel.innerHTML = '<option value="">Select issue...</option>' + state.issues.map(i => `<option>${escapeHtml(i.name)}</option>`).join('');
  ensureSelectHasValue_(issueSel, curIssue);

  const physioSel = el_('f_physioId');
  const curPhysio = physioSel.value;
  physioSel.innerHTML = '<option value="">Select physiotherapist...</option>' +
    state.physios.filter(p => p.active).map(p => `<option value="${escapeHtml(p.physioId)}">${escapeHtml(p.name)} (${escapeHtml(p.physioId)})</option>`).join('');
  if (state.editing) addSuperAdminAuthOption_();
  physioSel.value = curPhysio;
  updateFormSignaturePreview_();
}

// A saved record may reference an issue type that has since been renamed
// or deactivated - keep it selectable instead of silently blanking it.
function ensureSelectHasValue_(sel, value) {
  if (value && !Array.from(sel.options).some(o => o.value === value)) {
    const opt = document.createElement('option');
    opt.textContent = value; opt.value = value;
    sel.appendChild(opt);
  }
  sel.value = value || '';
}

// -------------------------------------------------------------------------
// 11. ROM / MMT EDITABLE TABLES (built once; one delegated listener each)
// -------------------------------------------------------------------------
function emptyRomData_() {
  const d = {};
  Object.keys(ROM_STRUCTURE).forEach(j => { d[j] = {}; ROM_STRUCTURE[j].forEach(m => { d[j][m] = { R: '', L: '' }; }); });
  return d;
}
function buildRomTableDom_(tableEl, storeKey) {
  let html = '<thead><tr><th colspan="2">Movement</th><th>Right</th><th>Left</th></tr></thead><tbody>';
  Object.keys(ROM_STRUCTURE).forEach(joint => {
    const movements = ROM_STRUCTURE[joint];
    movements.forEach((m, idx) => {
      html += '<tr>' + (idx === 0 ? `<td class="rom-joint-cell" rowspan="${movements.length}">${escapeHtml(joint)}</td>` : '') +
        `<td>${escapeHtml(m)}</td>` +
        `<td><input data-joint="${escapeHtml(joint)}" data-move="${escapeHtml(m)}" data-side="R" class="rom-input" placeholder="e.g. 0-90&deg;" aria-label="${escapeHtml(joint + ' ' + m + ' right')}"></td>` +
        `<td><input data-joint="${escapeHtml(joint)}" data-move="${escapeHtml(m)}" data-side="L" class="rom-input" placeholder="e.g. 0-90&deg;" aria-label="${escapeHtml(joint + ' ' + m + ' left')}"></td>` +
        '</tr>';
    });
  });
  tableEl.innerHTML = html + '</tbody>';
  tableEl.addEventListener('input', e => {
    const inp = e.target.closest('.rom-input');
    if (!inp) return;
    const store = state.form[storeKey];
    if (!store[inp.dataset.joint]) store[inp.dataset.joint] = {};
    if (!store[inp.dataset.joint][inp.dataset.move]) store[inp.dataset.joint][inp.dataset.move] = { R: '', L: '' };
    store[inp.dataset.joint][inp.dataset.move][inp.dataset.side] = inp.value;
  });
}
function fillRomTableFromStore_(tableEl, store) {
  tableEl.querySelectorAll('.rom-input').forEach(inp => {
    const cell = store[inp.dataset.joint] && store[inp.dataset.joint][inp.dataset.move];
    inp.value = (cell && cell[inp.dataset.side]) || '';
  });
}
function initRomMmtTables_() {
  state.form.romData = emptyRomData_(); state.form.mmtData = emptyRomData_();
  buildRomTableDom_(el_('romTable'), 'romData');
  buildRomTableDom_(el_('mmtTable'), 'mmtData');
}
function resetRomTables_() {
  state.form.romData = emptyRomData_(); state.form.mmtData = emptyRomData_();
  fillRomTableFromStore_(el_('romTable'), state.form.romData);
  fillRomTableFromStore_(el_('mmtTable'), state.form.mmtData);
}
function loadRomFromJson_(storeKey, tableId, jsonStr) {
  const store = emptyRomData_();
  const parsed = safeParse_(jsonStr, {});
  Object.keys(parsed || {}).forEach(joint => {
    if (!store[joint]) store[joint] = {};
    Object.keys(parsed[joint] || {}).forEach(m => { store[joint][m] = Object.assign({ R: '', L: '' }, parsed[joint][m]); });
  });
  state.form[storeKey] = store;
  fillRomTableFromStore_(el_(tableId), store);
}

// -------------------------------------------------------------------------
// 12. VAS SCALE
// -------------------------------------------------------------------------
function initVasScale_() {
  renderVasScale_(0);
  el_('f_vas').addEventListener('input', () => renderVasScale_(Number(val_('f_vas'))));
}
function renderVasScale_(active) {
  let html = '';
  for (let n = 0; n <= 10; n++) html += `<span class="${n === active ? 'active' : ''}">${n}</span>`;
  el_('vasScaleDisplay').innerHTML = html;
}

// -------------------------------------------------------------------------
// 13. BODY DIAGRAMS - interactive pain map. A mark is stored as nothing
//     more than {view, x%, y%, type, color} and redrawn as a small dot over
//     the clinic's reference image at whatever size it renders.
// -------------------------------------------------------------------------
function initBodyDiagrams_() {
  state.form.painMarks = [];
  const wrap = el_('bodyDiagramsWrap');
  wrap.innerHTML = BODY_VIEWS.map(v => `
    <div class="body-view">
      <div class="body-img-holder" data-view="${v.key}">
        <span class="body-img-inner">
          <img src="${v.url}" alt="${escapeHtml(v.label)}" draggable="false" decoding="async">
        </span>
      </div>
      <div class="body-view-label">${escapeHtml(v.label)}</div>
    </div>`).join('') + `
    <div class="body-legend">
      <span><i style="background:#d1352f"></i> Pain Point</span>
      <span><i style="background:#2778b7"></i> Radiating Point</span>
    </div>`;

  wrap.querySelectorAll('img').forEach(img => {
    img.addEventListener('load', () => { img.closest('.body-img-holder').classList.remove('img-broken'); redrawAllMarks_(); });
    img.addEventListener('error', () => img.closest('.body-img-holder').classList.add('img-broken'));
  });
  wrap.addEventListener('click', e => {
    const inner = e.target.closest('.body-img-inner');
    if (inner) onBodyDiagramClick_(e, inner);
  });

  document.querySelectorAll('.mark-tool[data-color]').forEach(btn => btn.addEventListener('click', () => selectMarkTool_(btn)));
  // Picking a custom color now switches to the Custom marker straight away
  // (before, a new color only took effect after re-clicking "Custom").
  el_('markCustomColor').addEventListener('input', () => {
    const btn = el_('markCustomBtn');
    btn.dataset.color = val_('markCustomColor');
    selectMarkTool_(btn);
  });
  el_('clearMarksBtn').addEventListener('click', () => {
    if (!state.form.painMarks.length) return;
    if (!confirm('Remove all ' + state.form.painMarks.length + ' marked point(s)?')) return;
    state.form.painMarks = [];
    markFormDirty_();
    redrawAllMarks_();
  });
}
function selectMarkTool_(btn) {
  document.querySelectorAll('.mark-tool').forEach(b => b.classList.toggle('active', b === btn));
  state.form.activeMarkColor = btn.dataset.color;
  state.form.activeMarkType = btn.dataset.type;
}

function onBodyDiagramClick_(e, inner) {
  const clickedDot = e.target.closest('.body-mark-dot');
  if (clickedDot) {
    state.form.painMarks.splice(Number(clickedDot.dataset.idx), 1);
    markFormDirty_();
    redrawAllMarks_();
    return;
  }
  const img = inner.querySelector('img');
  if (!img || !img.complete || !img.naturalWidth) return; // image still loading
  const rect = inner.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const view = inner.closest('.body-img-holder').dataset.view;
  const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
  state.form.painMarks.push({ view: view, x: Math.round(xPct * 10) / 10, y: Math.round(yPct * 10) / 10, type: state.form.activeMarkType, color: state.form.activeMarkColor });
  markFormDirty_();
  redrawAllMarks_();
}

function redrawAllMarks_() {
  document.querySelectorAll('#bodyDiagramsWrap .body-img-inner').forEach(inner => {
    const view = inner.closest('.body-img-holder').dataset.view;
    inner.querySelectorAll('.body-mark-dot').forEach(d => d.remove());
    const frag = document.createDocumentFragment();
    state.form.painMarks.forEach((m, idx) => {
      if (m.view !== view) return;
      const dot = document.createElement('span');
      dot.className = 'body-mark-dot';
      dot.style.left = m.x + '%';
      dot.style.top = m.y + '%';
      dot.style.background = safeColor_(m.color);
      dot.dataset.idx = idx;
      dot.title = 'Tap to remove';
      frag.appendChild(dot);
    });
    inner.appendChild(frag);
  });
}

// -------------------------------------------------------------------------
// 14. DYNAMIC ROWS - Special Tests / Treatment Goals / Treatment Plan
//     (one delegated listener per container, wired once)
// -------------------------------------------------------------------------
function renderSpecialTests_() {
  el_('specialTestsRows').innerHTML = state.form.specialTests.map((t, i) => `
    <div class="dyn-row">
      <input placeholder="Test name" data-idx="${i}" data-field="test" class="st-input" value="${escapeHtml(t.test)}" aria-label="Test name">
      <input placeholder="Result" data-idx="${i}" data-field="result" class="st-input" value="${escapeHtml(t.result)}" aria-label="Result">
      <button type="button" class="remove-row-btn" data-idx="${i}" aria-label="Remove test">&times;</button>
    </div>`).join('');
}
function renderGoalsPlan_() {
  el_('goalsRows').innerHTML = state.form.treatmentGoals.map((g, i) => `
    <div class="dyn-row"><input data-idx="${i}" class="goal-input" value="${escapeHtml(g)}" placeholder="Goal ${i + 1}" aria-label="Goal ${i + 1}">
      <button type="button" class="remove-row-btn" data-idx="${i}" aria-label="Remove goal">&times;</button></div>`).join('');
  el_('planRows').innerHTML = state.form.treatmentPlan.map((p, i) => `
    <div class="dyn-row"><input data-idx="${i}" class="plan-input" value="${escapeHtml(p)}" placeholder="Plan item ${i + 1}" aria-label="Plan item ${i + 1}">
      <button type="button" class="remove-row-btn" data-idx="${i}" aria-label="Remove plan item">&times;</button></div>`).join('');
}
el_('specialTestsRows').addEventListener('input', e => {
  const inp = e.target.closest('.st-input'); if (!inp) return;
  const row = state.form.specialTests[Number(inp.dataset.idx)]; if (row) row[inp.dataset.field] = inp.value;
});
el_('specialTestsRows').addEventListener('click', e => {
  const b = e.target.closest('.remove-row-btn'); if (!b) return;
  state.form.specialTests.splice(Number(b.dataset.idx), 1); markFormDirty_(); renderSpecialTests_();
});
el_('goalsRows').addEventListener('input', e => { const inp = e.target.closest('.goal-input'); if (inp) state.form.treatmentGoals[Number(inp.dataset.idx)] = inp.value; });
el_('planRows').addEventListener('input', e => { const inp = e.target.closest('.plan-input'); if (inp) state.form.treatmentPlan[Number(inp.dataset.idx)] = inp.value; });
el_('goalsRows').addEventListener('click', e => { const b = e.target.closest('.remove-row-btn'); if (!b) return; state.form.treatmentGoals.splice(Number(b.dataset.idx), 1); markFormDirty_(); renderGoalsPlan_(); });
el_('planRows').addEventListener('click', e => { const b = e.target.closest('.remove-row-btn'); if (!b) return; state.form.treatmentPlan.splice(Number(b.dataset.idx), 1); markFormDirty_(); renderGoalsPlan_(); });

function addRowAndFocus_(pushFn, renderFn, containerId, selector) {
  pushFn(); renderFn(); markFormDirty_();
  const inputs = el_(containerId).querySelectorAll(selector);
  const last = inputs[inputs.length - (selector === '.st-input' ? 2 : 1)];
  if (last) last.focus();
}
el_('addSpecialTestBtn').addEventListener('click', () => addRowAndFocus_(() => state.form.specialTests.push({ test: '', result: '' }), renderSpecialTests_, 'specialTestsRows', '.st-input'));
el_('addGoalBtn').addEventListener('click', () => addRowAndFocus_(() => state.form.treatmentGoals.push(''), renderGoalsPlan_, 'goalsRows', '.goal-input'));
el_('addPlanBtn').addEventListener('click', () => addRowAndFocus_(() => state.form.treatmentPlan.push(''), renderGoalsPlan_, 'planRows', '.plan-input'));

// -------------------------------------------------------------------------
// 15. DIRTY TRACKING - knows when the form has unsaved changes, so leaving
//     mid-edit, logging out or closing the tab asks first.
// -------------------------------------------------------------------------
function markFormDirty_() {
  state.formDirty = true;
  updateEditSaveBar_();
}
function wireFormDirtyTracking_() {
  const wrap = el_('assessmentFormWrap');
  const handler = e => {
    const t = e.target;
    if (!t || t.type === 'password' || t.id === 'f_editReason' || t.id === 'markCustomColor' || t.id === 'f_physioId') return;
    markFormDirty_();
  };
  wrap.addEventListener('input', handler);
  wrap.addEventListener('change', handler);
  // Typing in a field clears its error highlight straight away.
  wrap.addEventListener('input', e => { const f = e.target.closest && e.target.closest('.field.has-error'); if (f) f.classList.remove('has-error'); });
  wrap.addEventListener('change', e => { const f = e.target.closest && e.target.closest('.field.has-error'); if (f) f.classList.remove('has-error'); });
}

// -------------------------------------------------------------------------
// 16. ISSUE "ADD NEW" (from the form) + PATIENT MATCH LOOKUP
// -------------------------------------------------------------------------
el_('addIssueBtn').addEventListener('click', async () => {
  const name = prompt('New issue / diagnosis type:');
  if (!name || !name.trim()) return;
  await withBusy_(el_('addIssueBtn'), '', async () => {
    const r = await apiPost('addIssue', { name: name.trim() });
    if (!r.ok) { toast(r.error || 'Could not add issue', 'error'); return; }
    if (!state.issues.find(i => i.issueId === r.issueId)) state.issues.push({ issueId: r.issueId, name: r.name, active: true });
    populateStaticDropdowns_();
    el_('f_issueType').value = r.name;
    markFormDirty_();
    toast('Issue added', 'success');
  });
});

let patientLookupTimer_ = null;
let patientLookupSeq_ = 0;
function wirePatientLookup_() {
  const trigger = () => {
    clearTimeout(patientLookupTimer_);
    if (state.editing) return; // never auto-fill over a record being edited
    patientLookupTimer_ = setTimeout(async () => {
      const phone = val_('f_phone').trim(), name = val_('f_patientName').trim();
      const hint = el_('patientMatchHint');
      if (digitsOnly_(phone).length < 6 || !name) { hint.textContent = ''; return; }
      const seq = ++patientLookupSeq_;
      const r = await apiGet('findPatient', { phone, name });
      // Ignore stale replies (the user kept typing) and anything that lands
      // after an edit started.
      if (seq !== patientLookupSeq_ || state.editing) return;
      if (r.ok && r.found) {
        const p = r.patient;
        hint.className = 'field-hint match-found';
        hint.textContent = '✓ Matched existing patient' + (p.patientId ? ' (Patient ID: ' + p.patientId + ')' : '') + ' - other fields auto-filled below, review before saving.';
        if (!val_('f_age')) setVal_('f_age', p.age);
        if (!val_('f_sex')) setVal_('f_sex', p.sex);
        if (!val_('f_occupation')) setVal_('f_occupation', p.occupation);
        if (!val_('f_email')) setVal_('f_email', p.email);
        if (!val_('f_address')) setVal_('f_address', p.address);
        if (!val_('f_uhid')) setVal_('f_uhid', p.uhid);
        if (!val_('f_patientId')) setVal_('f_patientId', p.patientId);
        if (!val_('f_howKnow')) setVal_('f_howKnow', p.howKnow);
        if (!val_('f_referredBy')) setVal_('f_referredBy', p.referredBy);
      } else if (r.ok) {
        hint.className = 'field-hint match-new';
        hint.textContent = 'New patient - a patient record will be created automatically.';
      } else {
        hint.textContent = '';
      }
    }, 500);
  };
  el_('f_phone').addEventListener('input', trigger);
  el_('f_patientName').addEventListener('input', trigger);
}
wirePatientLookup_();

// -------------------------------------------------------------------------
// 17. COLLECT / FILL / SNAPSHOT FORM DATA
// -------------------------------------------------------------------------
function collectFormData_() {
  return {
    patientId: val_('f_patientId').trim(), patientName: val_('f_patientName').trim(), phone: val_('f_phone').trim(),
    age: val_('f_age'), sex: val_('f_sex'), occupation: val_('f_occupation'), email: val_('f_email').trim(),
    address: val_('f_address'), uhid: val_('f_uhid'),
    date: val_('f_date'), referredBy: val_('f_referredBy'), howKnow: val_('f_howKnow'),
    invoiceNumber: val_('f_invoiceNumber').trim(), issueType: val_('f_issueType'),
    chiefComplaint: val_('f_chiefComplaint'), historyOfPresentIllness: val_('f_hpi'),
    posture: val_('f_posture'), obsGait: val_('f_obsGait'), deformitySwelling: val_('f_deformitySwelling'),
    vas: val_('f_vas'), natureOfPain: val_('f_natureOfPain'), aggravatingFactors: val_('f_aggravatingFactors'), relievingFactors: val_('f_relievingFactors'),
    pmhDM: checked_('f_pmhDM'), pmhHTN: checked_('f_pmhHTN'), pmhThyroid: checked_('f_pmhThyroid'), pmhCardiac: checked_('f_pmhCardiac'),
    surgeryFractureHospitalization: val_('f_surgeryFractureHospitalization'),
    romJson: JSON.stringify(state.form.romData), mmtJson: JSON.stringify(state.form.mmtData),
    painMarksJson: JSON.stringify(state.form.painMarks),
    specialTestsJson: JSON.stringify(state.form.specialTests.filter(t => (t.test || '').trim() || (t.result || '').trim())),
    ambulation: val_('f_ambulation'), stairClimbing: val_('f_stairClimbing'), adls: val_('f_adls'),
    balanceSingleLegStance: val_('f_balanceSingleLegStance'), balanceRombergTest: val_('f_balanceRombergTest'),
    gaitPattern: val_('f_gaitPattern'), gaitCadence: val_('f_gaitCadence'), gaitLimping: val_('f_gaitLimping'),
    clinicalDiagnosis: val_('f_clinicalDiagnosis'),
    treatmentGoalsJson: JSON.stringify(state.form.treatmentGoals.map(s => String(s).trim()).filter(Boolean)),
    treatmentPlanJson: JSON.stringify(state.form.treatmentPlan.map(s => String(s).trim()).filter(Boolean)),
    followUpNotes: val_('f_followUpNotes'), nextReviewDate: val_('f_nextReviewDate')
  };
}

function fillFormFromAssessment_(a) {
  setVal_('f_patientId', a.patientId); setVal_('f_patientName', a.patientName); setVal_('f_phone', a.phone);
  setVal_('f_age', a.age); setVal_('f_sex', a.sex); setVal_('f_occupation', a.occupation); setVal_('f_email', a.email);
  setVal_('f_address', a.address); setVal_('f_uhid', a.uHID);
  setVal_('f_date', a.date); setVal_('f_referredBy', a.referredBy); setVal_('f_howKnow', a.howKnow);
  setVal_('f_invoiceNumber', a.invoiceNumber); ensureSelectHasValue_(el_('f_issueType'), a.issueType);
  setVal_('f_chiefComplaint', a.chiefComplaint); setVal_('f_hpi', a.historyOfPresentIllness);
  setVal_('f_posture', a.posture); setVal_('f_obsGait', a.obsGait); setVal_('f_deformitySwelling', a.deformitySwelling);
  setVal_('f_vas', a.vAS || 0); renderVasScale_(Number(a.vAS) || 0);
  setVal_('f_natureOfPain', a.natureOfPain); setVal_('f_aggravatingFactors', a.aggravatingFactors); setVal_('f_relievingFactors', a.relievingFactors);
  setChecked_('f_pmhDM', truthyStr_(a.pMH_DM)); setChecked_('f_pmhHTN', truthyStr_(a.pMH_HTN));
  setChecked_('f_pmhThyroid', truthyStr_(a.pMH_Thyroid)); setChecked_('f_pmhCardiac', truthyStr_(a.pMH_Cardiac));
  setVal_('f_surgeryFractureHospitalization', a.surgeryFractureHospitalization);
  loadRomFromJson_('romData', 'romTable', a.romJson);
  loadRomFromJson_('mmtData', 'mmtTable', a.mmtJson);
  state.form.painMarks = safeParse_(a.painMarksJson, []); redrawAllMarks_();
  state.form.specialTests = safeParse_(a.specialTestsJson, []); renderSpecialTests_();
  setVal_('f_ambulation', a.ambulation); setVal_('f_stairClimbing', a.stairClimbing); setVal_('f_adls', a.aDLs);
  setVal_('f_balanceSingleLegStance', a.balanceSingleLegStance); setVal_('f_balanceRombergTest', a.balanceRombergTest);
  setVal_('f_gaitPattern', a.gaitPattern); setVal_('f_gaitCadence', a.gaitCadence); setVal_('f_gaitLimping', a.gaitLimping);
  setVal_('f_clinicalDiagnosis', a.clinicalDiagnosis);
  state.form.treatmentGoals = safeParse_(a.treatmentGoalsJson, []); state.form.treatmentPlan = safeParse_(a.treatmentPlanJson, []); renderGoalsPlan_();
  setVal_('f_followUpNotes', a.followUpNotes); setVal_('f_nextReviewDate', a.nextReviewDate);
  updateFormSignaturePreview_();
}

// Every plain field of the form (passwords and file inputs excluded).
function formFieldEls_() {
  return Array.from(el_('assessmentFormWrap').querySelectorAll('input[id], select[id], textarea[id]'))
    .filter(e => e.type !== 'password' && e.type !== 'file');
}
function snapshotForm_() {
  const fields = {};
  formFieldEls_().forEach(e => { fields[e.id] = (e.type === 'checkbox') ? e.checked : e.value; });
  return {
    fields,
    form: deepClone_({ romData: state.form.romData, mmtData: state.form.mmtData, painMarks: state.form.painMarks,
      specialTests: state.form.specialTests, treatmentGoals: state.form.treatmentGoals, treatmentPlan: state.form.treatmentPlan }),
    hintText: el_('patientMatchHint').textContent, hintClass: el_('patientMatchHint').className,
    dirty: state.formDirty
  };
}
function restoreSnapshot_(snap) {
  formFieldEls_().forEach(e => {
    if (!(e.id in snap.fields)) return;
    if (e.type === 'checkbox') e.checked = !!snap.fields[e.id];
    else if (e.tagName === 'SELECT') ensureSelectHasValue_(e, snap.fields[e.id]);
    else e.value = snap.fields[e.id];
  });
  Object.assign(state.form, deepClone_(snap.form));
  fillRomTableFromStore_(el_('romTable'), state.form.romData);
  fillRomTableFromStore_(el_('mmtTable'), state.form.mmtData);
  redrawAllMarks_(); renderSpecialTests_(); renderGoalsPlan_();
  renderVasScale_(Number(val_('f_vas')) || 0);
  el_('patientMatchHint').textContent = snap.hintText || '';
  el_('patientMatchHint').className = snap.hintClass || 'field-hint';
  updateFormSignaturePreview_();
}

// Blanks every field. The selected physiotherapist is kept on purpose (the
// next patient is usually seen by the same person); passwords never linger.
function clearFormToBlank_() {
  const keepPhysio = val_('f_physioId');
  formFieldEls_().forEach(e => {
    if (e.id === 'markCustomColor' || e.id === 'physioLockedText') return;
    if (e.type === 'checkbox') e.checked = false;
    else e.value = '';
  });
  setVal_('f_physioPassword', ''); setVal_('f_physioOwnPassword', '');
  setVal_('f_date', todayStr_()); setVal_('f_vas', 0); renderVasScale_(0);
  if (state.session.role === 'physio') el_('physioLockedText').value = state.session.physioName;
  resetRomTables_();
  state.form.painMarks = []; state.form.specialTests = []; state.form.treatmentGoals = []; state.form.treatmentPlan = [];
  redrawAllMarks_(); renderSpecialTests_(); renderGoalsPlan_();
  el_('patientMatchHint').textContent = '';
  updateReasonCount_();
  clearFieldErrors_();
  setStatus_('physioStatus', '', '');
  if (keepPhysio && keepPhysio !== SUPER_ADMIN_AUTH) setVal_('f_physioId', keepPhysio);
  updateFormSignaturePreview_();
}

function resetAssessmentForm_() {
  clearFormToBlank_();
  state.formDirty = false;
}
el_('resetFormBtn').addEventListener('click', () => {
  if (state.formDirty && !confirm('Clear everything typed into this assessment?')) return;
  resetAssessmentForm_();
  window.scrollTo(0, 0);
});

// -------------------------------------------------------------------------
// 18. EDIT MODE - lives under "Find / Edit Record", never under "New
//     Assessment". The one assessment form is moved into the Edit view,
//     filled with the record, and moved back afterwards. Any half-typed new
//     assessment is parked first and restored untouched.
// -------------------------------------------------------------------------
function addSuperAdminAuthOption_() {
  if (state.session.role === 'physio') return;
  const sel = el_('f_physioId');
  if (sel.querySelector(`option[value="${SUPER_ADMIN_AUTH}"]`)) return;
  const opt = new Option('Super Admin (use my admin password)', SUPER_ADMIN_AUTH);
  sel.insertBefore(opt, sel.options[1] || null);
}
function removeSuperAdminAuthOption_() {
  const o = el_('f_physioId').querySelector(`option[value="${SUPER_ADMIN_AUTH}"]`);
  if (o) o.remove();
}
function updateAuthLabels_() {
  const editing = !!state.editing;
  el_('f_physioIdLabel').textContent = editing ? 'Authorize Changes As' : 'Physiotherapist';
  el_('f_physioPasswordLabel').textContent = (editing && val_('f_physioId') === SUPER_ADMIN_AUTH) ? 'Super Admin Password' : 'Password';
  el_('f_physioOwnPasswordLabel').textContent = editing ? 'Confirm Your Password to Save Changes' : 'Confirm Your Password to Sign';
}

function enterEditMode_(a) {
  if (!a || a.archived) return;
  if (state.editing) exitEditMode_();
  state.draftSnapshot = snapshotForm_();
  state.editing = { visitId: a.visitId, record: a };

  const wrap = el_('assessmentFormWrap');
  el_('editFormHost').appendChild(wrap);
  wrap.classList.add('is-editing');

  clearFormToBlank_();
  fillFormFromAssessment_(a);
  setVal_('f_editReason', ''); updateReasonCount_();
  addSuperAdminAuthOption_();
  if (state.session.role !== 'physio') setVal_('f_physioId', SUPER_ADMIN_AUTH);
  updateAuthLabels_();
  updateFormSignaturePreview_();

  el_('signSaveTitle').textContent = 'Confirm & Save Changes';
  el_('saveAssessmentBtn').innerHTML = saveBtnLabel_();
  el_('editHeading').textContent = 'Edit Record - ' + a.visitId;
  el_('editSub').textContent = (a.patientName || '') + (a.date ? ' · visit dated ' + a.date : '') + (a.physioName ? ' · signed by ' + a.physioName : '');

  state.formDirty = false;
  updateEditSaveBar_();
  setActiveNav_('lookup');
  switchToView_('view-edit');
}

function exitEditMode_() {
  const wrap = el_('assessmentFormWrap');
  wrap.classList.remove('is-editing');
  el_('assessmentFormHost').appendChild(wrap);
  state.editing = null;
  removeSuperAdminAuthOption_();
  clearFormToBlank_();
  setVal_('f_editReason', '');
  if (state.draftSnapshot) {
    restoreSnapshot_(state.draftSnapshot);
    state.formDirty = !!state.draftSnapshot.dirty;
    state.draftSnapshot = null;
  } else {
    state.formDirty = false;
  }
  el_('signSaveTitle').textContent = 'Confirm & Save (Physiotherapist Authorization Required)';
  el_('saveAssessmentBtn').innerHTML = saveBtnLabel_();
  updateAuthLabels_();
  updateFormSignaturePreview_();
}

function cancelEdit_() {
  if (!state.editing) return;
  if (state.formDirty && !confirm('Discard your unsaved changes to ' + state.editing.visitId + '?')) return;
  const rec = state.editing.record;
  exitEditMode_();
  if (rec) showRecordPreview_(rec, state.previewReturnView || 'lookup');
  else goToView_('lookup');
}
el_('cancelEditBtn').addEventListener('click', cancelEdit_);
el_('cancelEditInlineBtn').addEventListener('click', cancelEdit_);
el_('editSaveBarCancelBtn').addEventListener('click', cancelEdit_);
el_('editSaveBarSaveBtn').addEventListener('click', () => saveAssessment_());

function updateEditSaveBar_() {
  const t = el_('editSaveBarText');
  if (!t || !state.editing) return;
  t.textContent = 'Editing ' + state.editing.visitId + ' · ' + (state.formDirty ? 'unsaved changes' : 'no changes yet');
  t.classList.toggle('dirty', state.formDirty);
}

function updateReasonCount_() {
  const n = val_('f_editReason').length;
  el_('editReasonCount').textContent = n + ' / 500';
}
el_('f_editReason').addEventListener('input', updateReasonCount_);

// -------------------------------------------------------------------------
// 19. VALIDATE + SAVE / UPDATE ASSESSMENT
// -------------------------------------------------------------------------
function markFieldError_(id) { const e = el_(id); const f = e && e.closest('.field'); if (f) f.classList.add('has-error'); }
function clearFieldErrors_() { document.querySelectorAll('.field.has-error').forEach(f => f.classList.remove('has-error')); }
function focusField_(id) {
  const e = el_(id);
  if (!e) return;
  e.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => { try { e.focus({ preventScroll: true }); } catch (err) { e.focus(); } }, 250);
}
function setStatus_(id, text, kind) { const e = el_(id); if (!e) return; e.textContent = text || ''; e.className = 'biller-status' + (kind ? ' ' + kind : ''); }

// Returns the first problem as {id, msg}, highlighting every bad field.
function validateForm_() {
  const problems = [];
  const editing = !!state.editing;
  const name = val_('f_patientName').trim();
  const phone = val_('f_phone').trim();
  if (!name) problems.push({ id: 'f_patientName', msg: 'Patient name is required.' });
  // Phone format is checked for new records, and for edits only when the
  // phone itself was changed (so an older record with a short landline
  // number can still be edited).
  const phoneChanged = !editing || digitsOnly_(phone) !== digitsOnly_(state.editing.record && state.editing.record.phone);
  if (!phone) problems.push({ id: 'f_phone', msg: 'Contact number is required.' });
  else if (phoneChanged && digitsOnly_(phone).length < 10) problems.push({ id: 'f_phone', msg: 'Enter a valid contact number (at least 10 digits).' });
  if (!val_('f_date')) problems.push({ id: 'f_date', msg: 'Date is required.' });
  const email = val_('f_email').trim();
  if (email && !isValidEmail_(email)) problems.push({ id: 'f_email', msg: 'That email address doesn\'t look right - fix it or leave it blank.' });
  if (editing && val_('f_editReason').trim().length < EDIT_REASON_MIN) problems.push({ id: 'f_editReason', msg: 'Please enter a Reason for Edit before saving changes.' });

  if (state.session.role === 'physio') {
    if (!val_('f_physioOwnPassword')) problems.push({ id: 'f_physioOwnPassword', msg: editing ? 'Confirm your password to save these changes.' : 'Please confirm your password to sign this record.' });
  } else {
    if (!val_('f_physioId')) problems.push({ id: 'f_physioId', msg: editing ? 'Choose who is authorizing these changes.' : 'Select the physiotherapist for this record.' });
    if (!val_('f_physioPassword')) problems.push({ id: 'f_physioPassword', msg: 'Enter the password to authorize.' });
  }
  problems.forEach(p => markFieldError_(p.id));
  return problems[0] || null;
}

function authPayload_() {
  if (state.session.role === 'physio') return { physioId: state.session.physioId, physioPassword: val_('f_physioOwnPassword') };
  const pid = val_('f_physioId');
  if (pid === SUPER_ADMIN_AUTH) return { superAdminUser: sessionStorage.getItem('SJP_displayName') || '', superAdminPass: val_('f_physioPassword') };
  return { physioId: pid, physioPassword: val_('f_physioPassword') };
}

function saveBtnLabel_() { return state.editing ? '&#128190; Save Changes' : 'Save &amp; Generate Record'; }
function setSaving_(on) {
  state.saving = on;
  const main = el_('saveAssessmentBtn'), bar = el_('editSaveBarSaveBtn');
  [main, bar].forEach(b => {
    b.classList.toggle('is-busy', on); b.disabled = on;
    if (on) b.textContent = 'Saving...';
  });
  if (!on) {
    // Labels are recomputed (not restored) - the form may have switched
    // between edit and create mode while the save was in flight.
    main.innerHTML = saveBtnLabel_();
    bar.innerHTML = '&#128190; Save Changes';
  }
}

el_('saveAssessmentBtn').addEventListener('click', () => saveAssessment_());

async function saveAssessment_() {
  if (state.saving) return;
  clearFieldErrors_();
  setStatus_('physioStatus', '', '');
  const problem = validateForm_();
  if (problem) { toast(problem.msg, 'error'); focusField_(problem.id); return; }

  const editing = state.editing ? Object.assign({}, state.editing) : null;
  setSaving_(true);
  try {
    const data = collectFormData_();
    const auth = authPayload_();
    const r = editing
      ? await apiPost('updateAssessment', Object.assign({ visitId: editing.visitId, data, editReason: val_('f_editReason').trim() }, auth))
      : await apiPost('saveAssessment', Object.assign({ data }, auth));

    if (!r.ok) {
      setStatus_('physioStatus', r.error || 'Could not save', 'err');
      toast(r.error || 'Could not save', 'error');
      if (/password|credential|authori/i.test(r.error || '')) {
        const pwId = state.session.role === 'physio' ? 'f_physioOwnPassword' : 'f_physioPassword';
        markFieldError_(pwId); focusField_(pwId);
      }
      return;
    }

    setVal_('f_physioPassword', ''); setVal_('f_physioOwnPassword', ''); // never linger in the DOM
    invalidateDataCaches_();

    // New backend returns the saved record in the same reply; fall back to
    // a fetch for an older backend.
    let a = r.assessment;
    if (!a) {
      const full = await apiGet('getAssessment', { visitId: editing ? editing.visitId : r.visitId });
      if (full.ok) a = full.assessment;
    }

    if (editing) {
      const n = (r.changedFields || []).length;
      state.formDirty = false;
      exitEditMode_();
      toast(r.changedFields ? (n ? 'Record updated - ' + n + ' field' + (n === 1 ? '' : 's') + ' changed' : 'Saved - no field values were different') : 'Record updated', 'success');
      if (state.lastLookupQuery) doLookupSearch_({ quiet: true });
      if (a) showRecordPreview_(a, 'lookup'); else goToView_('lookup');
    } else {
      resetAssessmentForm_(); // the next patient starts on a clean form
      toast('Assessment saved' + (a && a.visitId ? ' - ' + a.visitId : ''), 'success');
      if (a) showRecordPreview_(a, 'assessment');
    }
  } finally {
    setSaving_(false);
  }
}

function invalidateDataCaches_() {
  state.dashLoadedAt = 0;
  Object.keys(reportState.loaded).forEach(k => { reportState.loaded[k] = false; });
}

// -------------------------------------------------------------------------
// 20. RECORD DOCUMENT RENDERING (client-side mirror of buildAssessmentHtmlForPdf_
//     in Code.gs - same structure/classes).
// -------------------------------------------------------------------------
function fld(label, value) {
  const s = state.settings;
  const shown = (value === null || value === undefined || value === '') ? '-' : value;
  const labelHtml = label ? `<span class="fl-label" style="color:${escapeHtml(s.ThemeFieldLabelColor || '#2778b7')}">${escapeHtml(label)}: </span>` : '';
  return `<div class="doc-field">${labelHtml}<span class="fl-value" style="color:${escapeHtml(s.ThemeFieldValueColor || '#000000')}">${escapeHtml(shown)}</span></div>`;
}
function romTableHtmlClient_(jsonStr) {
  const dataObj = safeParse_(jsonStr, {});
  let rows = '';
  Object.keys(ROM_STRUCTURE).forEach(joint => {
    const movements = ROM_STRUCTURE[joint];
    movements.forEach((m, idx) => {
      const cell = (dataObj[joint] && dataObj[joint][m]) || { R: '', L: '' };
      rows += `<tr>${idx === 0 ? `<td class="rom-joint" rowspan="${movements.length}">${escapeHtml(joint)}</td>` : ''}` +
        `<td>${escapeHtml(m)}</td><td class="num">${escapeHtml(cell.R)}</td><td class="num">${escapeHtml(cell.L)}</td></tr>`;
    });
  });
  return `<table class="rom-table"><thead><tr><th colspan="2">Movement</th><th>Right</th><th>Left</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function specialTestsHtmlClient_(jsonStr) {
  const rows = safeParse_(jsonStr, []);
  if (!rows.length) return '<table class="special-tests-table"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody><tr><td colspan="2" class="muted">No special tests recorded</td></tr></tbody></table>';
  return '<table class="special-tests-table"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody>' +
    rows.map(r => `<tr><td>${escapeHtml(r.test)}</td><td>${escapeHtml(r.result)}</td></tr>`).join('') + '</tbody></table>';
}
function listHtmlClient_(jsonStr) {
  const items = safeParse_(jsonStr, []);
  if (!items.length) return '<div class="muted">None recorded</div>';
  return '<ol class="doc-list">' + items.map(i => `<li>${escapeHtml(i)}</li>`).join('') + '</ol>';
}
function checkboxHtmlClient_(label, checked) {
  return `<span class="pmh-item"><span class="chk">${checked ? '&#9745;' : '&#9744;'}</span> ` +
    `<span style="color:${escapeHtml(state.settings.ThemeFieldLabelColor || '#2778b7')}">${escapeHtml(label)}</span></span>`;
}
function bodyDiagramsHtmlClient_(painMarksJson) {
  const marks = safeParse_(painMarksJson, []);
  const cells = BODY_VIEWS.map(v => {
    const dots = marks.filter(m => m.view === v.key).map(m =>
      `<span class="doc-mark-dot" style="left:${Number(m.x)}%;top:${Number(m.y)}%;background-color:${safeColor_(m.color)}"></span>`).join('');
    return `<div class="doc-body-view"><span class="doc-body-img-wrap"><img src="${v.url}" alt="">${dots}</span>` +
      `<div class="doc-body-view-label">${escapeHtml(v.label.toUpperCase())}</div></div>`;
  }).join('');
  return `<div class="doc-body-diagrams">${cells}</div>` +
    `<div class="body-legend"><span><i style="background-color:#d1352f"></i>Pain Point</span><span><i style="background-color:#2778b7"></i>Radiating Point</span></div>`;
}
function docHeaderHtmlClient_() {
  const s = state.settings;
  const logo = usableUrl_(s.PrintLogoURL) || usableUrl_(s.LogoURL);
  const headerFrom = s.ThemeDocHeaderColor || '#2778b7';
  const headerTo = s.ThemeDocHeaderColorTo || '#a8d339';
  const nameStyle = `font-weight:${truthyStr_(s.ThemeDocCompanyNameBold) ? 'bold' : 'normal'};font-style:${truthyStr_(s.ThemeDocCompanyNameItalic) ? 'italic' : 'normal'};text-decoration:${truthyStr_(s.ThemeDocCompanyNameUnderline) ? 'underline' : 'none'}`;
  const infoStyle = `font-weight:${truthyStr_(s.ThemeDocCompanyInfoBold) ? 'bold' : 'normal'};font-style:${truthyStr_(s.ThemeDocCompanyInfoItalic) ? 'italic' : 'normal'};text-decoration:${truthyStr_(s.ThemeDocCompanyInfoUnderline) ? 'underline' : 'none'}`;
  const layout = s.ThemeDocHeaderLayout === 'logo-top' ? 'flex-direction:column;align-items:flex-start;' : '';
  return `<div class="doc-header-band" style="${layout}background-image:linear-gradient(135deg,${escapeHtml(headerFrom)} 0%,${escapeHtml(headerTo)} 100%)">${logo ? `<img class="doc-logo" src="${escapeHtml(logo)}" alt="">` : ''}<div class="doc-header-text">` +
    `<div class="doc-company-name" style="color:#FFFFFF;${nameStyle}">${escapeHtml(s.ClinicName)}</div>` +
    `<div class="doc-company-info" style="color:#FFFFFF;${infoStyle}">${escapeHtml(s.Address)}</div>` +
    `<div class="doc-company-info" style="color:#FFFFFF;${infoStyle}">${escapeHtml(s.Phone)}${truthyStr_(s.ShowClinicEmail) && s.ClinicEmail ? ' &nbsp;|&nbsp; ' + escapeHtml(s.ClinicEmail) : ''}${s.Website ? ' &nbsp;|&nbsp; ' + escapeHtml(s.Website) : ''}</div>` +
    `</div></div>`;
}

function buildAssessmentDocHtml_(a) {
  const s = state.settings;
  const headerFrom = s.ThemeDocHeaderColor || '#2778b7';
  const labelColor = escapeHtml(s.ThemeFieldLabelColor || '#2778b7');
  const pmh = [checkboxHtmlClient_('DM', truthyStr_(a.pMH_DM)), checkboxHtmlClient_('HTN', truthyStr_(a.pMH_HTN)),
    checkboxHtmlClient_('Thyroid', truthyStr_(a.pMH_Thyroid)), checkboxHtmlClient_('Cardiac', truthyStr_(a.pMH_Cardiac))].join(' &nbsp; ');
  let vasScale = '';
  for (let n = 0; n <= 10; n++) {
    const active = String(n) === String(a.vAS);
    vasScale += `<span class="vas-num${active ? ' vas-active' : ''}">${n}</span>`;
  }
  const signatureImg = a.signatureUrl ? `<img class="sig-img" src="${escapeHtml(a.signatureUrl)}" alt="">` : '<div class="sig-line"></div>';

  return `${docHeaderHtmlClient_()}
    <div class="doc-title-bar" style="background-image:linear-gradient(135deg,${escapeHtml(headerFrom)} 0%,${escapeHtml(s.ThemeDocHeaderColorTo || '#a8d339')} 100%)">PHYSIOTHERAPY ASSESSMENT SHEET</div>

    <div class="doc-page">

    <div class="doc-section">
    <div class="section-band">Patient Details</div>
    <div class="doc-row cols-4">${fld('Patient Name', a.patientName)}${fld('Date', a.date)}${fld('Referred By', a.referredBy)}${fld('Age / Sex', (a.age || '-') + ' / ' + (a.sex || '-'))}</div>
    <div class="doc-row cols-4">${fld('UHID / File No.', a.uHID)}${fld('Contact No.', a.phone)}${fld('Occupation', a.occupation)}${fld('Email ID', a.email)}</div>
    <div class="doc-row cols-3">${fld('Address', a.address)}${fld('How They Knew Us', a.howKnow)}${fld('Invoice No.', a.invoiceNumber)}</div>
    <div class="doc-row cols-1">${fld('Issue Type', a.issueType)}</div>
    <div class="doc-row cols-2">${fld('Chief Complaint', a.chiefComplaint)}${fld('History of Present Illness', a.historyOfPresentIllness)}</div>
    </div>

    <div class="doc-section">
    <div class="section-band">Observation &amp; Pain Assessment</div>
    <div class="doc-row cols-3">${fld('Posture', a.posture)}${fld('Gait', a.obsGait)}${fld('Deformity / Swelling', a.deformitySwelling)}</div>
    <div class="doc-field"><span class="fl-label" style="color:${labelColor}">Pain Assessment (VAS): </span></div>
    <div class="vas-row">${vasScale}</div>
    <div class="doc-row cols-3">${fld('Nature of Pain', a.natureOfPain)}${fld('Aggravating Factors', a.aggravatingFactors)}${fld('Relieving Factors', a.relievingFactors)}</div>
    </div>

    <div class="doc-section">
    <div class="section-band">Past Medical History</div>
    <div class="pmh-row">${pmh}</div>
    ${fld('Surgery / Fracture / Hospitalization', a.surgeryFractureHospitalization)}
    </div>

    <div class="doc-section flow">
    <div class="section-band">Range of Motion (ROM)</div>${romTableHtmlClient_(a.romJson)}
    </div>
    <div class="doc-section flow">
    <div class="section-band">Muscle Strength (MMT)</div>${romTableHtmlClient_(a.mmtJson)}
    </div>

    <div class="doc-section">
    <div class="section-band">Mark Pain Point &amp; Radiating Point</div>${bodyDiagramsHtmlClient_(a.painMarksJson)}
    </div>

    <div class="doc-section">
    <div class="section-band">Special Tests</div>${specialTestsHtmlClient_(a.specialTestsJson)}
    </div>

    <div class="doc-section">
    <div class="section-band">Functional Assessment</div>
    <div class="doc-row cols-3">${fld('Ambulation', a.ambulation)}${fld('Stair Climbing', a.stairClimbing)}${fld('ADLs', a.aDLs)}</div>
    </div>

    <div class="doc-section">
    <div class="section-band">Balance</div>
    <div class="doc-row cols-2">${fld('Single Leg Stance', a.balanceSingleLegStance)}${fld('Romberg Test', a.balanceRombergTest)}</div>
    </div>

    <div class="doc-section">
    <div class="section-band">Gait</div>
    <div class="doc-row cols-3">${fld('Pattern', a.gaitPattern)}${fld('Cadence', a.gaitCadence)}${fld('Limping', a.gaitLimping)}</div>
    </div>

    <div class="doc-section">
    <div class="section-band">Clinical Diagnosis</div>${fld('', a.clinicalDiagnosis)}
    </div>

    <div class="doc-section">
    <div class="doc-row cols-2">
      <div><div class="doc-field"><span class="fl-label" style="color:${labelColor}">Treatment Goals</span></div>${listHtmlClient_(a.treatmentGoalsJson)}</div>
      <div><div class="doc-field"><span class="fl-label" style="color:${labelColor}">Treatment Plan</span></div>${listHtmlClient_(a.treatmentPlanJson)}</div>
    </div>
    </div>

    <div class="doc-section">
    <div class="section-band">Follow Up / Notes</div>
    <div class="notes-box">${escapeHtml(a.followUpNotes || '')}</div>
    </div>

    <div class="doc-footer-section footer-row">
      <div>${fld('Next Review Date', a.nextReviewDate)}</div>
      <div class="sig-block">${signatureImg}<div class="sig-caption">${escapeHtml(a.physioName || 'Physiotherapist')}<br><span class="muted">Physiotherapist Signature</span></div></div>
    </div>
    <div class="doc-footer-section record-ids">Visit ID: ${escapeHtml(a.visitId)} &nbsp;|&nbsp; Patient Visit ID: ${escapeHtml(a.patientVisitId)}</div>
    <div class="doc-footer-section tagline" style="color:${escapeHtml(headerFrom)}">Move Better. Live Better.</div>
    </div>`;
}

// Friendly names for the edit-history "fields changed" list.
const FIELD_LABELS = {
  PatientID: 'Patient ID', PatientName: 'Patient Name', Phone: 'Contact No.', UHID: 'UHID / File No.',
  HowKnow: 'How They Knew Us', InvoiceNumber: 'Invoice No.', HistoryOfPresentIllness: 'History of Present Illness',
  ObsGait: 'Gait (Observation)', DeformitySwelling: 'Deformity / Swelling', VAS: 'Pain (VAS)',
  PMH_DM: 'PMH: DM', PMH_HTN: 'PMH: HTN', PMH_Thyroid: 'PMH: Thyroid', PMH_Cardiac: 'PMH: Cardiac',
  SurgeryFractureHospitalization: 'Surgery / Fracture / Hospitalization',
  ROM_JSON: 'Range of Motion', MMT_JSON: 'Muscle Strength', PainMarksJSON: 'Pain Points', SpecialTestsJSON: 'Special Tests',
  ADLs: 'ADLs', BalanceSingleLegStance: 'Single Leg Stance', BalanceRombergTest: 'Romberg Test',
  TreatmentGoalsJSON: 'Treatment Goals', TreatmentPlanJSON: 'Treatment Plan', FollowUpNotes: 'Follow Up / Notes',
  NextReviewDate: 'Next Review Date'
};
function fieldLabel_(h) { return FIELD_LABELS[h] || String(h).replace(/([a-z])([A-Z])/g, '$1 $2'); }

function renderEditInfo_(a) {
  const box = el_('recordEditInfo');
  const log = safeParse_(a.editLog, []);
  if (!Array.isArray(log) || !log.length) { box.hidden = true; box.innerHTML = ''; return; }
  const last = log[log.length - 1];
  const items = log.slice().reverse().map(e => `<li><b>${escapeHtml(e.at)}</b> by ${escapeHtml(e.by)} - ${escapeHtml(e.reason)}` +
    (e.fields && e.fields.length ? `<div class="fields">Changed: ${e.fields.map(f => escapeHtml(fieldLabel_(f))).join(', ')}</div>` : '<div class="fields">No field values changed</div>') + '</li>').join('');
  box.innerHTML = `&#9998; Edited <b>${log.length}</b> time${log.length === 1 ? '' : 's'} &middot; last on <b>${escapeHtml(last.at)}</b> by <b>${escapeHtml(last.by)}</b><br>Reason: ${escapeHtml(last.reason)}` +
    `<details><summary>Full edit history</summary><ol>${items}</ol></details>`;
  box.hidden = false;
}

// Shows a record. The SAME markup is kept in #printRoot, so Print /
// Save-as-PDF always output exactly what's on screen.
function showRecordPreview_(a, returnTo) {
  state.previewReturnView = returnTo || 'assessment';
  state.lastSavedAssessment = a;
  const html = buildAssessmentDocHtml_(a);
  el_('docPaper').innerHTML = html;
  el_('printRoot').innerHTML = '<div class="print-doc">' + html + '</div>';

  el_('recordPreviewHeading').textContent = a.patientName ? ('Record - ' + a.patientName) : 'Record';
  el_('recordPreviewSub').textContent = 'Visit ' + (a.visitId || '') + (a.date ? ' · ' + a.date : '');
  renderEditInfo_(a);

  setActiveNav_(state.previewReturnView);
  switchToView_('view-record-preview');

  const badge = el_('previewSavedBadge');
  if (a.archived) {
    badge.textContent = '\u{1F5C4}️ Archived - Read Only' + (a.dbLabel ? ' (' + a.dbLabel + ')' : '');
    badge.className = 'badge badge-archived';
    el_('editRecordBtn').style.display = 'none';
  } else {
    badge.textContent = '✓ Saved';
    badge.className = 'badge badge-ok';
    el_('editRecordBtn').style.display = '';
  }
  fitDocScale_();
  // Re-fit as images arrive (they change the document's height - before,
  // the bottom of a record could end up clipped).
  el_('docPaper').querySelectorAll('img').forEach(img => { if (!img.complete) img.addEventListener('load', fitDocScale_, { once: true }); });
}

function fitDocScale_() {
  const outer = document.querySelector('.doc-scale-outer');
  const inner = el_('docPaper');
  if (!outer || !inner || !outer.clientWidth) return;
  const scale = Math.min(1, (outer.clientWidth - 2) / 800);
  inner.style.transform = 'scale(' + scale + ')';
  outer.style.height = Math.ceil(inner.offsetHeight * scale) + 'px';
}
window.addEventListener('resize', debounce_(fitDocScale_, 100));
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fitDocScale_()).observe(el_('docPaper'));

el_('closePreviewBtn').addEventListener('click', () => goToView_(state.previewReturnView || 'assessment'));

el_('editRecordBtn').addEventListener('click', () => {
  const a = state.lastSavedAssessment;
  if (!a || a.archived) return;
  enterEditMode_(a);
});

// -------------------------------------------------------------------------
// 21. SHARE / PRINT / PDF / EMAIL / WHATSAPP
// -------------------------------------------------------------------------
let shareMethod = null;
el_('shareRecordBtn').addEventListener('click', () => {
  const a = state.lastSavedAssessment;
  if (!a) return;
  el_('shareRecordTitle').textContent = 'Share Record - ' + a.visitId;
  el_('shareEmailField').style.display = 'none';
  el_('shareWhatsappField').style.display = 'none';
  el_('share_send').style.display = 'none';
  setVal_('share_email', a.email || '');
  setVal_('share_phone', digitsOnly_(a.phone).slice(-10));
  setStatus_('shareStatus', '', '');
  el_('shareHint').textContent = isMobileDevice_() || !browserPrintAvailable_()
    ? 'Save as PDF downloads the record as a real PDF file on this device.'
    : 'Save as PDF opens the print window - set Destination to "Save as PDF".';
  const pdfKey = a.visitId + '|' + (a.updatedAtFull || a.updatedAt || '');
  if (state.pdfCache && state.pdfCache.key === pdfKey) showPdfReady_(state.pdfCache); else el_('sharePdfReady').hidden = true;
  shareMethod = null;
  el_('shareRecordModal').classList.add('show');
});
el_('share_cancel').addEventListener('click', () => el_('shareRecordModal').classList.remove('show'));

function waitForImages_(root, timeoutMs) {
  const imgs = Array.from(root.querySelectorAll('img')).filter(i => !i.complete);
  if (!imgs.length) return Promise.resolve();
  return Promise.race([
    Promise.all(imgs.map(i => new Promise(res => { i.addEventListener('load', res, { once: true }); i.addEventListener('error', res, { once: true }); }))),
    sleep_(timeoutMs || 8000)
  ]);
}

async function printRecord_() {
  const a = state.lastSavedAssessment;
  if (!a) return;
  if (!browserPrintAvailable_()) {
    toast('This browser can\'t print directly - opening the record as a PDF you can print from.', '');
    await getRecordPdf_('open');
    return;
  }
  await withBusy_(el_('sharePrintBtn'), 'Preparing...', async () => {
    if (!el_('printRoot').innerHTML) el_('printRoot').innerHTML = '<div class="print-doc">' + buildAssessmentDocHtml_(a) + '</div>';
    await waitForImages_(el_('printRoot'), 8000);
    el_('shareRecordModal').classList.remove('show');
    await nextPaint_();
    window.print();
  });
}

async function saveRecordPdf_() {
  if (isMobileDevice_() || !browserPrintAvailable_()) {
    const ok = await getRecordPdf_('download');
    if (!ok && browserPrintAvailable_()) {
      toast('Opening the print window instead - choose "Save as PDF" there.', '');
      await printRecord_();
    }
    return;
  }
  toast('In the print window, set Destination to "Save as PDF".', '');
  await printRecord_();
}

function base64ToBlob_(b64, type) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}
function triggerDownload_(url, fileName) {
  const link = document.createElement('a');
  link.href = url; link.download = fileName; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
}
function showPdfReady_(pdf) {
  el_('sharePdfName').textContent = '\u{1F4C4} ' + pdf.fileName + ' is ready';
  const dl = el_('sharePdfDownloadLink'); dl.href = pdf.url; dl.setAttribute('download', pdf.fileName);
  el_('sharePdfOpenLink').href = pdf.url;
  let canShareFile = false;
  try { canShareFile = !!(navigator.canShare && navigator.canShare({ files: [new File([pdf.blob], pdf.fileName, { type: 'application/pdf' })] })); } catch (e) { canShareFile = false; }
  el_('sharePdfShareBtn').hidden = !canShareFile;
  el_('sharePdfReady').hidden = false;
}

// Gets the server-built PDF (identical to the emailed attachment), caches
// it per record version, and downloads/opens it. The ready-row in the
// dialog stays as a manual fallback if a browser blocks the automatic
// download.
async function getRecordPdf_(mode) {
  const a = state.lastSavedAssessment;
  if (!a) return false;
  const key = a.visitId + '|' + (a.updatedAtFull || a.updatedAt || '');
  let pdf = state.pdfCache && state.pdfCache.key === key ? state.pdfCache : null;
  if (!pdf) {
    const r = await withBusy_(el_('shareDownloadPdfBtn'), 'Preparing PDF...', () => {
      setStatus_('shareStatus', 'Preparing the PDF - this can take a few seconds...', '');
      return apiPost('getAssessmentPdf', { visitId: a.visitId }, { timeoutMs: PDF_TIMEOUT_MS });
    });
    if (!r) return false;
    if (!r.ok || !r.base64) {
      const msg = /Unknown POST action/i.test(r.error || '')
        ? 'PDF download needs the updated Apps Script - redeploy it as a New version (see SETUP_GUIDE).'
        : (r.error || 'Could not create the PDF.');
      setStatus_('shareStatus', msg, 'err');
      return false;
    }
    if (state.pdfCache && state.pdfCache.url) URL.revokeObjectURL(state.pdfCache.url);
    const blob = base64ToBlob_(r.base64, 'application/pdf');
    pdf = state.pdfCache = { key, blob, url: URL.createObjectURL(blob), fileName: r.fileName || ('Assessment-' + a.visitId + '.pdf') };
  }
  showPdfReady_(pdf);
  setStatus_('shareStatus', mode === 'open' ? 'PDF ready - opening it now.' : 'PDF downloaded. If nothing appeared, tap "Download PDF" below.', 'ok');
  if (mode === 'open') {
    const w = window.open(pdf.url, '_blank');
    if (!w) setStatus_('shareStatus', 'Tap "Open" below to view the PDF.', 'ok');
  } else {
    triggerDownload_(pdf.url, pdf.fileName);
  }
  return true;
}

el_('sharePdfShareBtn').addEventListener('click', async () => {
  const pdf = state.pdfCache; const a = state.lastSavedAssessment;
  if (!pdf || !a) return;
  try {
    await navigator.share({
      files: [new File([pdf.blob], pdf.fileName, { type: 'application/pdf' })],
      title: 'Physiotherapy Assessment - ' + (a.patientName || a.visitId),
      text: 'Physiotherapy assessment record ' + a.visitId + ' from ' + (state.settings.ClinicName || 'the clinic') + '.'
    });
  } catch (e) {
    if (e && e.name !== 'AbortError') setStatus_('shareStatus', 'Sharing isn\'t available here - use Download PDF instead.', 'err');
  }
});

el_('sharePrintBtn').addEventListener('click', printRecord_);
el_('shareDownloadPdfBtn').addEventListener('click', saveRecordPdf_);

el_('shareViaEmailBtn').addEventListener('click', () => {
  shareMethod = 'email';
  el_('shareEmailField').style.display = 'block'; el_('shareWhatsappField').style.display = 'none';
  el_('share_send').style.display = 'inline-flex'; el_('share_send').textContent = 'Send Email';
  el_('share_email').focus();
});
el_('shareEmailPreviewBtn').addEventListener('click', async () => {
  const a = state.lastSavedAssessment;
  await withBusy_(el_('shareEmailPreviewBtn'), 'Loading...', async () => {
    const r = await apiGet('getEmailPreview', { visitId: a.visitId });
    if (!r.ok) { toast(r.error || 'Could not load preview', 'error'); return; }
    el_('emailPreviewFrame').srcdoc = r.html;
    el_('emailPreviewModal').classList.add('show');
  });
});
el_('emailPreview_close').addEventListener('click', () => el_('emailPreviewModal').classList.remove('show'));
el_('emailPreview_send').addEventListener('click', () => { el_('emailPreviewModal').classList.remove('show'); el_('share_send').click(); });

el_('shareViaWhatsappBtn').addEventListener('click', () => {
  shareMethod = 'whatsapp';
  el_('shareWhatsappField').style.display = 'block'; el_('shareEmailField').style.display = 'none';
  el_('share_send').style.display = 'inline-flex'; el_('share_send').textContent = 'Open WhatsApp';
  el_('share_phone').focus();
});

el_('share_send').addEventListener('click', async () => {
  const a = state.lastSavedAssessment;
  const btn = el_('share_send');
  if (shareMethod === 'email') {
    const email = val_('share_email').trim();
    if (!isValidEmail_(email)) { setStatus_('shareStatus', 'Enter a valid email address.', 'err'); return; }
    await withBusy_(btn, 'Sending...', async () => {
      const r = await apiPost('emailAssessmentPdf', { visitId: a.visitId, email }, { timeoutMs: PDF_TIMEOUT_MS });
      if (r.ok) { setStatus_('shareStatus', 'Emailed to ' + email + '.', 'ok'); toast('Record emailed successfully', 'success'); }
      else setStatus_('shareStatus', r.error || 'Could not send email.', 'err');
    });
  } else if (shareMethod === 'whatsapp') {
    const digits = digitsOnly_(val_('share_phone')).slice(-10);
    if (!/^\d{10}$/.test(digits)) { setStatus_('shareStatus', 'Enter a valid 10-digit number.', 'err'); return; }
    const text = `Hello ${a.patientName}, here is your physiotherapy assessment record (${a.visitId}) from ${state.settings.ClinicName || 'our clinic'}. Issue: ${a.issueType || '-'}. Next Review: ${a.nextReviewDate || '-'}.`;
    window.open('https://wa.me/91' + digits + '?text=' + encodeURIComponent(text), '_blank');
    setStatus_('shareStatus', 'WhatsApp opened in a new tab.', 'ok');
  }
});

// -------------------------------------------------------------------------
// 22. FIND / EDIT RECORD (lookup)
// -------------------------------------------------------------------------
el_('lookupBtn').addEventListener('click', () => doLookupSearch_());
el_('lookupQuery').addEventListener('keydown', e => { if (e.key === 'Enter') doLookupSearch_(); });

async function doLookupSearch_(opts) {
  const quiet = opts && opts.quiet;
  const q = quiet ? state.lastLookupQuery : val_('lookupQuery').trim();
  if (!q) { if (!quiet) el_('lookupResults').innerHTML = ''; return; }
  state.lastLookupQuery = q;
  const run = async () => {
    if (!quiet) el_('lookupResults').innerHTML = '<p class="field-hint">Searching...</p>';
    const r = await apiGet('searchAssessments', { q });
    if (!r.ok) { if (!quiet) { el_('lookupResults').innerHTML = ''; toast(r.error || 'Search failed', 'error'); } return; }
    if (!r.results.length) { el_('lookupResults').innerHTML = '<p class="field-hint">No matching records found.</p>'; return; }
    el_('lookupResults').innerHTML = `<p class="field-hint" style="margin-bottom:10px;">${r.results.length}${r.results.length >= 50 ? '+' : ''} record${r.results.length === 1 ? '' : 's'} found${r.results.length >= 50 ? ' - showing the 50 most recent, refine your search to narrow it down' : ''}.</p>` +
      r.results.map(row => `
      <div class="lookup-result-row">
        <div class="lookup-result-meta">
          <b>${escapeHtml(row.patientName)}</b> &nbsp;|&nbsp; ${escapeHtml(row.visitId)} &nbsp;|&nbsp; ${escapeHtml(row.date)} &nbsp;|&nbsp;
          ${escapeHtml(row.issueType || '-')} &nbsp;|&nbsp; Phone: ${escapeHtml(row.phone)} &nbsp;|&nbsp; Physio: ${escapeHtml(row.physioName)}
          ${row.invoiceNumber ? ' &nbsp;|&nbsp; Invoice: ' + escapeHtml(row.invoiceNumber) : ' &nbsp;|&nbsp; <i>Invoice not yet filled</i>'}
          ${row.archived ? ' &nbsp;<span class="badge badge-archived" style="font-size:10.5px;">Archived</span>' : ''}
        </div>
        <button class="btn btn-outline btn-sm lookup-open-btn" data-visit="${escapeHtml(row.visitId)}">Open</button>
      </div>`).join('');
  };
  if (quiet) await run(); else await withBusy_(el_('lookupBtn'), 'Searching...', run);
}
el_('lookupResults').addEventListener('click', e => {
  const btn = e.target.closest('.lookup-open-btn');
  if (btn) openLookupRecord_(btn.dataset.visit, btn);
});
async function openLookupRecord_(visitId, btn) {
  await withBusy_(btn, 'Opening...', async () => {
    const r = await apiGet('getAssessment', { visitId });
    if (!r.ok) { toast(r.error || 'Could not load record', 'error'); return; }
    showRecordPreview_(r.assessment, 'lookup');
  });
}

// -------------------------------------------------------------------------
// 23. REPORTS - Universal Report + Daily Report. Live, filterable,
//     column-choosable, downloadable as a real Excel file.
// -------------------------------------------------------------------------
const REPORT_CONFIGS = {
  universal: {
    label: 'Universal Report', action: 'getUniversalReport',
    columns: [
      { key: 'visitId', label: 'Visit ID' }, { key: 'patientVisitId', label: 'Patient Visit ID' },
      { key: 'patientId', label: 'Patient ID' }, { key: 'patientName', label: 'Patient Name' },
      { key: 'phone', label: 'Phone' }, { key: 'age', label: 'Age', type: 'number' }, { key: 'sex', label: 'Sex' },
      { key: 'date', label: 'Date' }, { key: 'issueType', label: 'Issue Type' }, { key: 'referredBy', label: 'Referred By' },
      { key: 'howKnow', label: 'How Known' }, { key: 'invoiceNumber', label: 'Invoice No.' },
      { key: 'chiefComplaint', label: 'Chief Complaint' }, { key: 'clinicalDiagnosis', label: 'Clinical Diagnosis' },
      { key: 'vas', label: 'VAS', type: 'number' }, { key: 'ambulation', label: 'Ambulation' },
      { key: 'nextReviewDate', label: 'Next Review Date' }, { key: 'physioName', label: 'Physiotherapist' },
      { key: 'createdAt', label: 'Created At' }, { key: 'updatedAt', label: 'Updated At' }, { key: 'updatedBy', label: 'Updated By' },
      { key: 'lastEditReason', label: 'Last Edit Reason' }, { key: 'dbLabel', label: 'Database' }
    ],
    defaultCols: ['visitId', 'patientName', 'phone', 'date', 'issueType', 'vas', 'nextReviewDate', 'physioName']
  },
  daily: {
    label: 'Daily Report', action: 'getDailyReport',
    columns: [
      { key: 'date', label: 'Date' }, { key: 'totalVisits', label: 'Total Visits', type: 'number' },
      { key: 'uniquePatients', label: 'Unique Patients', type: 'number' }, { key: 'topIssue', label: 'Top Issue' }
    ],
    defaultCols: ['date', 'totalVisits', 'uniquePatients', 'topIssue']
  }
};
const reportState = { active: 'universal', data: {}, loaded: {}, truncated: {}, visibleCols: {}, filters: {} };
Object.keys(REPORT_CONFIGS).forEach(k => {
  reportState.data[k] = []; reportState.loaded[k] = false; reportState.truncated[k] = false;
  reportState.visibleCols[k] = new Set(REPORT_CONFIGS[k].defaultCols);
  reportState.filters[k] = {};
});

document.querySelectorAll('.report-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.report-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    reportState.active = btn.dataset.report;
    loadReport(reportState.active);
  });
});
el_('refreshReportBtn').addEventListener('click', () => withBusy_(el_('refreshReportBtn'), '', () => loadReport(reportState.active, true)));

function canDownloadReports_() { return state.session.role !== 'physio' || state.session.canAccessReportDownload; }

async function loadReport(key, forceReload) {
  el_('reportDownloadBtn').style.display = canDownloadReports_() ? '' : 'none';
  if (reportState.loaded[key] && !forceReload) { renderReportTable_(key); return; }
  el_('reportLoadingHint').style.display = ''; el_('reportEmptyHint').style.display = 'none';
  const config = REPORT_CONFIGS[key];
  const r = await apiGet(config.action, {});
  el_('reportLoadingHint').style.display = 'none';
  if (!r.ok) { toast(r.error || 'Could not load report', 'error'); return; }
  reportState.data[key] = r.rows || [];
  reportState.truncated[key] = !!r.truncated;
  reportState.loaded[key] = true;
  if (reportState.active === key) renderReportTable_(key);
}

function filterReportRows_(rows, filters) {
  const active = Object.keys(filters).filter(k => filters[k]).map(k => [k, String(filters[k]).toLowerCase()]);
  if (!active.length) return rows;
  return rows.filter(row => active.every(([k, f]) => String(row[k] == null ? '' : row[k]).toLowerCase().includes(f)));
}

// Header + filter inputs are rendered once per column change; typing in a
// filter only re-renders the body (before, every keystroke rebuilt the
// filter inputs too, so the box being typed in lost focus after 1 letter).
function renderReportTable_(key) {
  const config = REPORT_CONFIGS[key];
  const cols = config.columns.filter(c => reportState.visibleCols[key].has(c.key));
  el_('reportHeaderRow').innerHTML = cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
  el_('reportFilterRow').innerHTML = cols.map(c =>
    `<th><input type="search" class="report-filter-input" data-key="${c.key}" placeholder="Filter..." aria-label="Filter ${escapeHtml(c.label)}" value="${escapeHtml(reportState.filters[key][c.key] || '')}"></th>`).join('');
  renderReportBody_(key);
}
const renderReportBodyDebounced_ = debounce_(key => renderReportBody_(key), 160);
el_('reportFilterRow').addEventListener('input', e => {
  const inp = e.target.closest('.report-filter-input'); if (!inp) return;
  reportState.filters[reportState.active][inp.dataset.key] = inp.value;
  renderReportBodyDebounced_(reportState.active);
});
function renderReportBody_(key) {
  const config = REPORT_CONFIGS[key];
  const cols = config.columns.filter(c => reportState.visibleCols[key].has(c.key));
  const rows = filterReportRows_(reportState.data[key], reportState.filters[key]);
  el_('reportTableBody').innerHTML = rows.map(row => '<tr>' + cols.map(c => `<td>${escapeHtml(row[c.key])}</td>`).join('') + '</tr>').join('');
  el_('reportRowCount').textContent = rows.length.toLocaleString() + ' row' + (rows.length === 1 ? '' : 's') +
    (reportState.truncated[key] ? ' (server capped at most recent 5,000)' : '');
  el_('reportEmptyHint').style.display = (rows.length || !reportState.loaded[key]) ? 'none' : '';
}

el_('reportClearFiltersBtn').addEventListener('click', () => { reportState.filters[reportState.active] = {}; renderReportTable_(reportState.active); });

el_('reportColumnsBtn').addEventListener('click', () => {
  const key = reportState.active; const config = REPORT_CONFIGS[key];
  el_('reportColumnsList').innerHTML = config.columns.map(c =>
    `<label><input type="checkbox" class="rc-check" data-key="${c.key}" ${reportState.visibleCols[key].has(c.key) ? 'checked' : ''}> ${escapeHtml(c.label)}</label>`).join('');
  el_('reportColumnsPopover').style.display = 'block';
});
el_('reportColumnsCancelBtn').addEventListener('click', () => { el_('reportColumnsPopover').style.display = 'none'; });
el_('reportColumnsApplyBtn').addEventListener('click', () => {
  const key = reportState.active;
  const chosen = new Set(); document.querySelectorAll('.rc-check:checked').forEach(c => chosen.add(c.dataset.key));
  reportState.visibleCols[key] = chosen.size ? chosen : new Set(REPORT_CONFIGS[key].defaultCols);
  el_('reportColumnsPopover').style.display = 'none';
  renderReportTable_(key);
});

el_('reportDownloadBtn').addEventListener('click', () => {
  if (!canDownloadReports_()) { toast('You do not have access to download reports.', 'error'); return; }
  const key = reportState.active; const config = REPORT_CONFIGS[key];
  const cols = config.columns.filter(c => reportState.visibleCols[key].has(c.key));
  const rows = filterReportRows_(reportState.data[key], reportState.filters[key]);
  if (!rows.length) { toast('Nothing to download.', 'error'); return; }
  const headers = cols.map(c => c.label);
  const dataRows = rows.map(row => cols.map(c => {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return '';
    if (c.type === 'number') { const n = Number(v); return isNaN(n) ? '' : n; }
    return String(v);
  }));
  const xml = buildExcelXml_(config.label, headers, dataRows);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadFileFromString_(config.label.replace(/\s+/g, '_') + '_' + stamp + '.xls', xml, 'application/vnd.ms-excel;charset=utf-8');
  toast('Downloaded ' + rows.length.toLocaleString() + ' rows', 'success');
});

function buildExcelXml_(sheetLabel, headers, rows) {
  // Strips characters XML 1.0 forbids (they'd make Excel refuse the file).
  const esc = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeSheetName = esc(sheetLabel).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report';
  const headerCells = headers.map(h => `<Cell ss:StyleID="Header"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('');
  const bodyRows = rows.map(r => '<Row>' + r.map(cell => {
    const isNum = typeof cell === 'number' && isFinite(cell);
    return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${esc(cell)}</Data></Cell>`;
  }).join('') + '</Row>').join('');
  return '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#0f6e5c" ss:Pattern="Solid"/></Style></Styles>' +
    `<Worksheet ss:Name="${safeSheetName}"><Table><Row>${headerCells}</Row>${bodyRows}</Table></Worksheet></Workbook>`;
}
function downloadFileFromString_(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  triggerDownload_(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// -------------------------------------------------------------------------
// 24. DASHBOARD - every KPI card and chart carries its OWN independent
//     filters. One request brings the per-visit dataset, the custom chart
//     definitions and the running totals; switching back to the Dashboard
//     within a minute redraws instantly from memory.
// -------------------------------------------------------------------------
const DASH_FILTER_DIMENSIONS = [
  ['issueType', 'Issue Type'], ['howKnow', 'How Known'], ['physioName', 'Physiotherapist'], ['sex', 'Sex'],
  ['ambulation', 'Ambulation'], ['stairClimbing', 'Stair Climbing'], ['adls', 'ADLs'], ['referredBy', 'Referred By']
];
const DASH_WIDGETS = {
  totalVisits: { kind: 'kpi', elId: 'kpiTotalVisits' },
  totalPatients: { kind: 'kpi-unique', elId: 'kpiTotalPatients' },
  issueBar: { kind: 'bar', dimension: 'issueType', containerId: 'issueBarChart' },
  howKnowDonut: { kind: 'donut', dimension: 'howKnow', containerId: 'howKnowDonutChart' },
  physioDonut: { kind: 'donut', dimension: 'physioName', containerId: 'physioDonutChart' }
};
Object.keys(DASH_WIDGETS).forEach(k => { state.dashFilters[k] = { filterBy: '', filterValue: '', dateFrom: '', dateTo: '' }; });

el_('refreshDashboardBtn').addEventListener('click', () => withBusy_(el_('refreshDashboardBtn'), '', () => loadDashboard(true)));

async function loadDashboard(force) {
  const fresh = state.dashLoadedAt && (Date.now() - state.dashLoadedAt < DASH_CACHE_MS);
  if (state.dashLoadedAt) renderDashboardFromState_();
  if (fresh && !force) return;
  el_('dashDefaultGrid').classList.add('loading');
  const r = await apiGet('getDashboardRaw', {});
  el_('dashDefaultGrid').classList.remove('loading');
  if (!r.ok) { toast(r.error || 'Could not load dashboard', 'error'); return; }
  state.dashRaw = r.rows || [];
  state.dashLoadedAt = Date.now();
  if (r.charts) {
    state.customCharts = r.charts;
    state.dashCounts = { patients: r.patientsCount, issues: r.issuesCount };
    renderDashboardFromState_();
  } else {
    renderDashboardFromState_();
    loadCustomCharts_(); // older backend
  }
}

function renderDashboardFromState_() {
  renderDashCardFilters_();
  renderAllDashWidgets_();
  el_('addCustomChartBtn').style.display = isAdmin_() ? '' : 'none';
  ensureCustomChartFilters_();
  renderCustomChartsGrid_();
}

function dashFilterToolbarHtml_(widgetKey, f) {
  return `
    <div class="dcf-row"><span class="dcf-pill">Filter By</span>
      <select class="dcf-filterby" data-widget="${widgetKey}" aria-label="Filter by">
        <option value="">None</option>
        ${DASH_FILTER_DIMENSIONS.map(([k, l]) => `<option value="${k}" ${f.filterBy === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="dcf-row"><span class="dcf-pill">Filter Value</span>
      <select class="dcf-filterval" data-widget="${widgetKey}" aria-label="Filter value" ${!f.filterBy ? 'disabled' : ''}>
        <option value="">${f.filterBy ? 'All' : 'Select Filter By first'}</option>
      </select>
    </div>
    <div class="dcf-row"><span class="dcf-pill">Date Range</span>
      <div class="dcf-daterange">
        <input type="date" class="dcf-datefrom" data-widget="${widgetKey}" value="${escapeHtml(f.dateFrom)}" aria-label="From date">
        <input type="date" class="dcf-dateto" data-widget="${widgetKey}" value="${escapeHtml(f.dateTo)}" aria-label="To date">
      </div>
    </div>`;
}

function renderDashCardFilters_() {
  Object.keys(DASH_WIDGETS).forEach(key => {
    const container = document.querySelector(`[data-widget-filters="${key}"]`);
    if (!container) return;
    container.innerHTML = dashFilterToolbarHtml_(key, state.dashFilters[key]);
    populateDashFilterValueOptionsIn_(container, key, state.dashFilters[key]);
  });
  wireDashFilterToolbar_(document.querySelectorAll('#dashDefaultGrid .dash-card-filters'), state.dashFilters, key => computeAndRenderWidget_(key));
}

function wireDashFilterToolbar_(scopeNodeList, filterState, onChange) {
  scopeNodeList.forEach(scope => {
    scope.querySelectorAll('.dcf-filterby').forEach(sel => sel.onchange = () => {
      const id = sel.dataset.widget;
      filterState[id].filterBy = sel.value; filterState[id].filterValue = '';
      populateDashFilterValueOptionsIn_(scope, id, filterState[id]);
      onChange(id);
    });
    scope.querySelectorAll('.dcf-filterval').forEach(sel => sel.onchange = () => {
      const id = sel.dataset.widget; filterState[id].filterValue = sel.value; onChange(id);
    });
    scope.querySelectorAll('.dcf-datefrom, .dcf-dateto').forEach(inp => inp.onchange = () => {
      const id = inp.dataset.widget;
      filterState[id].dateFrom = scope.querySelector(`.dcf-datefrom[data-widget="${id}"]`).value;
      filterState[id].dateTo = scope.querySelector(`.dcf-dateto[data-widget="${id}"]`).value;
      onChange(id);
    });
  });
}
function populateDashFilterValueOptionsIn_(scope, key, f) {
  const sel = scope.querySelector(`.dcf-filterval[data-widget="${key}"]`);
  if (!sel) return;
  if (!f.filterBy) { sel.innerHTML = '<option value="">Select Filter By first</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const values = Array.from(new Set(state.dashRaw.map(r => r[f.filterBy]))).filter(Boolean).sort();
  sel.innerHTML = '<option value="">All</option>' + values.map(v => `<option value="${escapeHtml(v)}" ${f.filterValue === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

function applyDashFilters_(rows, f) {
  if (!f || (!f.filterValue && !f.dateFrom && !f.dateTo)) return rows;
  return rows.filter(r => {
    if (f.filterBy && f.filterValue && String(r[f.filterBy]) !== f.filterValue) return false;
    if (f.dateFrom && r.date < f.dateFrom) return false;
    if (f.dateTo && r.date > f.dateTo) return false;
    return true;
  });
}

function renderAllDashWidgets_() { Object.keys(DASH_WIDGETS).forEach(computeAndRenderWidget_); }

function computeAndRenderWidget_(key) {
  const cfg = DASH_WIDGETS[key];
  const filtered = applyDashFilters_(state.dashRaw, state.dashFilters[key]);
  if (cfg.kind === 'kpi') {
    el_(cfg.elId).textContent = filtered.length.toLocaleString();
  } else if (cfg.kind === 'kpi-unique') {
    el_(cfg.elId).textContent = new Set(filtered.map(r => r.patientKey)).size.toLocaleString();
  } else {
    const groups = {};
    filtered.forEach(r => { const v = r[cfg.dimension] || 'Unspecified'; groups[v] = (groups[v] || 0) + 1; });
    const items = Object.keys(groups).map(k => ({ name: k, count: groups[k] })).sort((a, b) => b.count - a.count);
    const container = el_(cfg.containerId);
    if (cfg.kind === 'bar') drawGenericBarChart_(container, items.map(i => i.name), items.map(i => i.count));
    else drawGenericDonutChart_(container, items);
  }
}

function drawGenericBarChart_(container, labels, values) {
  if (!labels.length) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">No data for this filter.</p>'; return; }
  const palette = state.themeChartPalette;
  const maxVal = Math.max.apply(null, values.concat([1]));
  const barW = 46, gap = 22, chartH = 200, leftPad = 10, labelSpace = 120;
  const width = labels.length * (barW + gap) + leftPad * 2;
  let bars = '';
  labels.forEach((label, idx) => {
    const v = values[idx];
    const h = Math.max(4, (v / maxVal) * (chartH - 40));
    const x = leftPad + idx * (barW + gap);
    const y = chartH - h - 24;
    const color = escapeHtml(palette[idx % palette.length]);
    const labelX = x + barW / 2, labelY = chartH + 6;
    bars += `<g><title>${escapeHtml(label)}: ${formatChartNumber_(v)}</title><rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="6" fill="${color}"></rect>
      <text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" font-size="12" font-weight="700" fill="#182322">${formatChartNumber_(v)}</text>
      <text x="${labelX}" y="${labelY}" text-anchor="start" transform="rotate(90 ${labelX} ${labelY})" font-size="10" fill="#4B5A57">${escapeHtml(truncate(label, 18))}</text></g>`;
  });
  container.innerHTML = `<svg viewBox="0 0 ${width} ${chartH + labelSpace}" width="${width}" style="max-width:none; overflow:visible;" role="img">${bars}</svg>`;
}

function drawGenericDonutChart_(container, items) {
  if (!container) return;
  const palette = state.themeChartPalette;
  const withColor = items.map((it, idx) => ({ label: it.name, value: it.count, color: escapeHtml(palette[idx % palette.length]) }));
  const total = withColor.reduce((s, i) => s + i.value, 0);
  if (!total) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">No data for this filter.</p>'; return; }
  const r = 70, hole = 40, cx = 90, cy = 90;
  let angleStart = -90, paths = '';
  const nonZero = withColor.filter(i => i.value > 0);
  if (nonZero.length === 1) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${nonZero[0].color}"></circle>`;
  } else {
    withColor.forEach(it => {
      if (it.value <= 0) return;
      const frac = it.value / total; const angleEnd = angleStart + frac * 360;
      paths += describeArc_(cx, cy, r, angleStart, angleEnd, it.color); angleStart = angleEnd;
    });
  }
  paths += `<circle cx="${cx}" cy="${cy}" r="${hole}" fill="#FFFFFF"></circle>`;
  const legend = withColor.map(it => `<div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:4px;">
    <span style="width:10px;height:10px;border-radius:3px;background:${it.color};display:inline-block;flex-shrink:0;"></span>
    ${escapeHtml(it.label)}: ${formatChartNumber_(it.value)} (${Math.round(it.value / total * 100)}%)</div>`).join('');
  container.innerHTML = `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;"><svg width="180" height="180" viewBox="0 0 180 180" role="img">${paths}</svg><div>${legend}</div></div>`;
}
function describeArc_(cx, cy, r, startAngle, endAngle, color) {
  const s = polarToCartesian_(cx, cy, r, endAngle), e = polarToCartesian_(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `<path d="M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 0 ${e.x} ${e.y} Z" fill="${color}"></path>`;
}
function polarToCartesian_(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

// -------------------------------------------------------------------------
// 25. CUSTOM DASHBOARD CHARTS
// -------------------------------------------------------------------------
const CHART_DIM_TO_RAW_KEY = { IssueType: 'issueType', HowKnow: 'howKnow', PhysioName: 'physioName', Sex: 'sex',
  Ambulation: 'ambulation', StairClimbing: 'stairClimbing', ADLs: 'adls', ReferredBy: 'referredBy', Date: 'date' };
const CHART_METRIC_TO_RAW_KEY = { VAS: 'vas', Age: 'age' };
const VISIT_CHART_DIMENSIONS = [
  ['IssueType', 'Issue Type'], ['HowKnow', 'How Known'], ['PhysioName', 'Physiotherapist'], ['Sex', 'Sex'],
  ['Ambulation', 'Ambulation'], ['StairClimbing', 'Stair Climbing'], ['ADLs', 'ADLs'], ['ReferredBy', 'Referred By'], ['Date', 'Date']
];
function ensureCustomChartFilters_() {
  state.customCharts.forEach(c => {
    const id = 'cc_' + c.chartId;
    if (!state.customChartFilters[id]) state.customChartFilters[id] = { filterBy: '', filterValue: '', dateFrom: '', dateTo: '' };
  });
}
async function loadCustomCharts_() {
  const r = await apiGet('getCustomCharts', {});
  if (!r.ok) return;
  state.customCharts = r.charts || [];
  ensureCustomChartFilters_();
  renderCustomChartsGrid_();
}
function renderCustomChartsGrid_() {
  const grid = el_('customChartsGrid');
  el_('customChartsEmptyHint').style.display = state.customCharts.length ? 'none' : '';
  const isAdmin = isAdmin_();
  grid.innerHTML = state.customCharts.map(c => {
    const id = 'cc_' + c.chartId;
    const filterable = c.dataSource === 'visits';
    return `
    <div class="dash-card chart-card wide dash-card-filterable">
      <div class="dash-card-main">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <h4>${escapeHtml(c.name)}</h4>
          ${isAdmin ? `<div style="display:flex;gap:6px;">
            <button class="btn btn-outline btn-sm cc-edit" data-id="${escapeHtml(c.chartId)}">Edit</button>
            <button class="btn btn-danger btn-sm cc-del" data-id="${escapeHtml(c.chartId)}">Delete</button></div>` : ''}
        </div>
        <div id="${escapeHtml(id)}" class="chart-scroll"></div>
      </div>
      ${filterable ? `<div class="dash-card-filters cc-filters" data-cc-filters="${escapeHtml(id)}"></div>` : ''}
    </div>`;
  }).join('');

  state.customCharts.filter(c => c.dataSource === 'visits').forEach(c => {
    const id = 'cc_' + c.chartId;
    const container = document.querySelector(`[data-cc-filters="${id}"]`);
    if (container) { container.innerHTML = dashFilterToolbarHtml_(id, state.customChartFilters[id]); populateDashFilterValueOptionsIn_(container, id, state.customChartFilters[id]); }
  });
  wireDashFilterToolbar_(document.querySelectorAll('.cc-filters'), state.customChartFilters, id => renderOneCustomChart_(state.customCharts.find(c => 'cc_' + c.chartId === id)));

  state.customCharts.forEach(c => renderOneCustomChart_(c));
  grid.querySelectorAll('.cc-edit').forEach(btn => btn.addEventListener('click', () => openChartBuilder_(state.customCharts.find(c => String(c.chartId) === btn.dataset.id))));
  grid.querySelectorAll('.cc-del').forEach(btn => btn.addEventListener('click', () => deleteCustomChart_(btn.dataset.id)));
}

function renderOneCustomChart_(def) {
  if (!def) return;
  const container = el_('cc_' + def.chartId);
  if (!container) return;

  if (def.dataSource !== 'visits') {
    // Running totals now arrive with the dashboard data - no extra request.
    if (state.dashCounts && (def.dataSource === 'patients' || def.dataSource === 'issues')) {
      container.innerHTML = `<div style="font-size:34px;font-weight:800;color:var(--theme-heading);margin-top:6px;">${formatChartNumber_(state.dashCounts[def.dataSource])}</div>`;
    } else {
      loadOneCustomChartDataFromServer_(def, container);
    }
    return;
  }

  const id = 'cc_' + def.chartId;
  const filtered = applyDashFilters_(state.dashRaw, state.customChartFilters[id]);
  const dimKey = CHART_DIM_TO_RAW_KEY[def.dimension];
  const metricKey = CHART_METRIC_TO_RAW_KEY[def.metricField];

  if (def.type === 'number') {
    let value;
    if (def.metric === 'count') value = filtered.length;
    else {
      const nums = filtered.map(r => Number(r[metricKey]) || 0);
      const sum = nums.reduce((a, b) => a + b, 0);
      value = def.metric === 'average' ? (nums.length ? sum / nums.length : 0) : sum;
    }
    container.innerHTML = `<div style="font-size:34px;font-weight:800;color:var(--theme-heading);margin-top:6px;">${formatChartNumber_(value)}</div>`;
    return;
  }

  const groups = {};
  filtered.forEach(r => {
    const key = String(r[dimKey] || 'Unspecified');
    if (!groups[key]) groups[key] = { sum: 0, count: 0 };
    groups[key].count++;
    if (metricKey) groups[key].sum += Number(r[metricKey]) || 0;
  });
  let rows = Object.keys(groups).map(k => ({
    label: k, value: def.metric === 'count' ? groups[k].count : (def.metric === 'average' ? (groups[k].sum / groups[k].count) : groups[k].sum)
  }));
  rows.sort((a, b) => def.sortDir === 'asc' ? a.value - b.value : b.value - a.value);
  const topN = Number(def.topN) || 0;
  if (topN > 0) rows = rows.slice(0, topN);

  if (def.type === 'bar') drawGenericBarChart_(container, rows.map(r => r.label), rows.map(r => r.value));
  else drawGenericDonutChart_(container, rows.map(r => ({ name: r.label, count: r.value })));
}

async function loadOneCustomChartDataFromServer_(def, container) {
  const r = await apiGet('getCustomChartData', { chartId: def.chartId });
  if (!r.ok) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">' + escapeHtml(r.error || 'Could not load') + '</p>'; return; }
  if (r.type === 'number') {
    container.innerHTML = `<div style="font-size:34px;font-weight:800;color:var(--theme-heading);margin-top:6px;">${formatChartNumber_(r.value)}</div>`;
    return;
  }
  const labels = r.rows.map(x => x.label), values = r.rows.map(x => x.value);
  if (r.type === 'bar') drawGenericBarChart_(container, labels, values);
  else drawGenericDonutChart_(container, r.rows.map(x => ({ name: x.label, count: x.value })));
}
function formatChartNumber_(n) { n = Number(n) || 0; return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1); }

async function deleteCustomChart_(chartId) {
  if (!confirm('Delete this chart?')) return;
  const auth = promptSuperAdminAuth_();
  if (!auth) return;
  const r = await apiPost('deleteCustomChart', { chartId, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not delete', 'error'); return; }
  toast('Chart deleted', 'success'); loadCustomCharts_();
}
function promptSuperAdminAuth_() {
  // Reuse what's already typed on the Admin Settings screen, if anything.
  const typed = superAdminFromFields_();
  if (typed.user && typed.pass) return typed;
  const user = prompt('Super Admin username to authorize this change:');
  if (user === null) return null;
  const pass = prompt('Super Admin password:');
  if (pass === null) return null;
  return { user, pass };
}

el_('addCustomChartBtn').addEventListener('click', () => openChartBuilder_(null));
function openChartBuilder_(existing) {
  el_('chartBuilderTitle').textContent = existing ? 'Edit Chart' : 'New Chart';
  setVal_('cb_chartId', existing ? existing.chartId : '');
  setVal_('cb_name', existing ? existing.name : '');
  setVal_('cb_dataSource', existing ? existing.dataSource : 'visits');
  setVal_('cb_metric', existing ? existing.metric : 'count');
  setVal_('cb_type', existing ? existing.type : 'bar');
  setVal_('cb_topN', existing ? existing.topN : '');
  setVal_('cb_sortDir', existing ? existing.sortDir : 'desc');
  setVal_('cb_color', existing ? (existing.color || '#0f6e5c') : '#0f6e5c');
  updateChartBuilderDynamicFields_();
  setVal_('cb_dimension', existing && existing.dimension ? existing.dimension : 'IssueType');
  setVal_('cb_metricField', existing && existing.metricField ? existing.metricField : 'VAS');
  setStatus_('chartBuilderStatus', '', '');
  el_('chartBuilderModal').classList.add('show');
}
function updateChartBuilderDynamicFields_() {
  const ds = val_('cb_dataSource');
  const dimSel = el_('cb_dimension');
  if (ds === 'visits') {
    const cur = dimSel.value;
    dimSel.innerHTML = VISIT_CHART_DIMENSIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    if (cur) dimSel.value = cur;
    el_('cb_dimensionField').style.display = ''; el_('cb_dataSourceHint').textContent = 'One bar/slice per visit-level field you choose below.';
  } else {
    el_('cb_dimensionField').style.display = 'none';
    el_('cb_dataSourceHint').textContent = ds === 'patients' ? 'Shows a single running total of all patients - best as a Number Card.' : 'Shows a single running total of active issue types - best as a Number Card.';
  }
  const isNumber = val_('cb_type') === 'number';
  el_('cb_topNField').style.display = isNumber ? 'none' : '';
  el_('cb_sortDirField').style.display = isNumber ? 'none' : '';
  el_('cb_metricFieldWrap').style.display = val_('cb_metric') === 'count' ? 'none' : '';
}
el_('cb_dataSource').addEventListener('change', updateChartBuilderDynamicFields_);
el_('cb_type').addEventListener('change', updateChartBuilderDynamicFields_);
el_('cb_metric').addEventListener('change', updateChartBuilderDynamicFields_);
el_('cb_cancel').addEventListener('click', () => el_('chartBuilderModal').classList.remove('show'));
el_('cb_save').addEventListener('click', async () => {
  if (!val_('cb_name').trim()) { setStatus_('chartBuilderStatus', 'Give the chart a name.', 'err'); return; }
  const auth = promptSuperAdminAuth_();
  if (!auth) return;
  const payload = {
    chartId: val_('cb_chartId') || undefined, name: val_('cb_name').trim(), type: val_('cb_type'),
    dataSource: val_('cb_dataSource'), dimension: val_('cb_dataSource') === 'visits' ? val_('cb_dimension') : '', metric: val_('cb_metric'),
    metricField: val_('cb_metric') === 'count' ? '' : val_('cb_metricField'), topN: val_('cb_topN'), sortDir: val_('cb_sortDir'), color: val_('cb_color'),
    superAdminUser: auth.user, superAdminPass: auth.pass
  };
  await withBusy_(el_('cb_save'), 'Saving...', async () => {
    const r = await apiPost('saveCustomChart', payload);
    if (!r.ok) { setStatus_('chartBuilderStatus', r.error || 'Could not save', 'err'); return; }
    el_('chartBuilderModal').classList.remove('show');
    toast('Chart saved', 'success');
    loadCustomCharts_();
  });
});

// -------------------------------------------------------------------------
// 26. ADMIN SETTINGS - tab switching
// -------------------------------------------------------------------------
document.querySelectorAll('.admin-tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab[data-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.admin-pane').forEach(p => p.classList.remove('active'));
    el_('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'database') loadDbStatus_();
  });
});

function loadAdminTabData_() {
  renderPhysioTable_();
  renderIssueTable_();
  fillClinicForm_();
  renderThemeGrid_();
  el_('accountAdminPane').style.display = isAdmin_() ? '' : 'none';
  el_('accountPhysioPane').style.display = state.session.role === 'physio' ? '' : 'none';
  if (state.session.role === 'physio') loadMySignature_();
}

// ---- Physiotherapists ----
function renderPhysioTable_() {
  el_('physioTableBody').innerHTML = state.physios.map(p => {
    const id = escapeHtml(p.physioId);
    return `
    <tr>
      <td>${id}</td><td>${escapeHtml(p.name)}</td>
      <td><label class="pmh-check"><input type="checkbox" class="py-toggle" data-id="${id}" ${p.active ? 'checked' : ''} aria-label="Active"></label></td>
      <td><label class="pmh-check"><input type="checkbox" class="py-access" data-id="${id}" data-field="canAccessFindEdit" ${p.canAccessFindEdit ? 'checked' : ''} aria-label="Find/Edit access"></label></td>
      <td><label class="pmh-check"><input type="checkbox" class="py-access" data-id="${id}" data-field="canAccessReportDownload" ${p.canAccessReportDownload ? 'checked' : ''} aria-label="Reports access"></label></td>
      <td><label class="pmh-check"><input type="checkbox" class="py-access" data-id="${id}" data-field="canAccessDashboard" ${p.canAccessDashboard ? 'checked' : ''} aria-label="Dashboard access"></label></td>
      <td>${p.signatureUrl ? '<img src="' + escapeHtml(p.signatureUrl) + '" style="height:26px;" alt="Signature">' : '<span class="field-hint">Not uploaded</span>'}</td>
      <td><button class="btn btn-outline btn-sm py-edit" data-id="${id}">Edit</button> <button class="btn btn-danger btn-sm py-del" data-id="${id}">Delete</button></td>
    </tr>`;
  }).join('');
}
el_('physioTableBody').addEventListener('change', e => {
  const t = e.target;
  if (t.classList.contains('py-toggle')) togglePhysio_(t.dataset.id);
  else if (t.classList.contains('py-access')) setPhysioAccess_(t.dataset.id, t.dataset.field, t.checked);
});
el_('physioTableBody').addEventListener('click', e => {
  const edit = e.target.closest('.py-edit'); if (edit) { openPhysioModal_(state.physios.find(p => String(p.physioId) === edit.dataset.id)); return; }
  const del = e.target.closest('.py-del'); if (del) deletePhysio_(del.dataset.id);
});
function superAdminFromFields_() { return { user: val_('admin_su_user').trim(), pass: val_('admin_su_pass') }; }
function requireAdminFields_() {
  const a = superAdminFromFields_();
  if (!a.user || !a.pass) { toast('Enter the Super Admin username and password at the top of Admin Settings first.', 'error'); el_(a.user ? 'admin_su_pass' : 'admin_su_user').focus(); return null; }
  return a;
}

async function togglePhysio_(id) {
  const auth = requireAdminFields_(); if (!auth) { renderPhysioTable_(); return; }
  const r = await apiPost('togglePhysio', { physioId: id, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not update', 'error'); renderPhysioTable_(); return; }
  toast('Updated', 'success'); await reloadPhysios_();
}
async function setPhysioAccess_(id, field, value) {
  const auth = requireAdminFields_(); if (!auth) { renderPhysioTable_(); return; }
  const r = await apiPost('setPhysioAccess', { physioId: id, field, value, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not update', 'error'); renderPhysioTable_(); return; }
  toast('Updated', 'success'); await reloadPhysios_();
}
async function deletePhysio_(id) {
  const auth = requireAdminFields_(); if (!auth) return;
  if (!confirm('Delete this physiotherapist account? This cannot be undone.')) return;
  const r = await apiPost('deletePhysio', { physioId: id, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not delete', 'error'); return; }
  toast('Deleted', 'success'); await reloadPhysios_();
}
async function reloadPhysios_() {
  const r = await apiGet('getPhysios', {});
  if (r.ok) { state.physios = r.physios; renderPhysioTable_(); populateStaticDropdowns_(); }
}

el_('addPhysioBtn').addEventListener('click', () => openPhysioModal_(null));
function openPhysioModal_(existing) {
  el_('physioModalTitle').textContent = existing ? 'Edit Physiotherapist' : 'Add Physiotherapist';
  setVal_('pm_editId', existing ? existing.physioId : '');
  setVal_('pm_name', existing ? existing.name : '');
  setVal_('pm_password', '');
  setVal_('pm_signatureUrl', existing ? (existing.signatureUrl || '') : '');
  updatePmSignaturePreview_();
  setStatus_('physioModalStatus', '', '');
  el_('physioModal').classList.add('show');
}
function updatePmSignaturePreview_() {
  const url = val_('pm_signatureUrl').trim();
  const img = el_('pm_signaturePreview'), empty = el_('pm_signatureEmpty');
  if (url) { img.src = url; img.style.display = ''; empty.style.display = 'none'; }
  else { img.style.display = 'none'; empty.style.display = ''; }
}
el_('pm_signatureUrl').addEventListener('input', debounce_(updatePmSignaturePreview_, 300));
el_('pm_cancel').addEventListener('click', () => el_('physioModal').classList.remove('show'));
el_('pm_save').addEventListener('click', async () => {
  const auth = superAdminFromFields_();
  const editId = val_('pm_editId');
  const payload = {
    name: val_('pm_name').trim(), password: val_('pm_password'), signatureUrl: val_('pm_signatureUrl').trim(),
    editPhysioId: editId || undefined, superAdminUser: auth.user, superAdminPass: auth.pass
  };
  if (!payload.name) { setStatus_('physioModalStatus', 'Name is required', 'err'); return; }
  if (!editId && !payload.password) { setStatus_('physioModalStatus', 'Password is required for a new account', 'err'); return; }
  if (!auth.user || !auth.pass) { setStatus_('physioModalStatus', 'Enter the Super Admin credentials at the top of Admin Settings first.', 'err'); return; }
  await withBusy_(el_('pm_save'), 'Saving...', async () => {
    const r = await apiPost('savePhysio', payload);
    if (!r.ok) { setStatus_('physioModalStatus', r.error || 'Could not save', 'err'); return; }
    el_('physioModal').classList.remove('show');
    toast(editId ? 'Saved' : 'Added ' + (r.physioId || ''), 'success'); await reloadPhysios_();
  });
});

// ---- Issues List ----
function renderIssueTable_() {
  el_('issueTableBody').innerHTML = state.issues.map(i => {
    const id = escapeHtml(i.issueId);
    return `
    <tr>
      <td>${id}</td>
      <td><input type="text" class="issue-name-input" data-id="${id}" value="${escapeHtml(i.name)}" aria-label="Issue name"></td>
      <td><label class="pmh-check"><input type="checkbox" class="issue-active-toggle" data-id="${id}" ${i.active ? 'checked' : ''} aria-label="Active"></label></td>
      <td><button class="btn btn-outline btn-sm issue-save" data-id="${id}">Save</button> <button class="btn btn-danger btn-sm issue-del" data-id="${id}">Delete</button></td>
    </tr>`;
  }).join('');
}
el_('issueTableBody').addEventListener('click', e => {
  const save = e.target.closest('.issue-save'); if (save) { saveIssueEdit_(save.dataset.id, save); return; }
  const del = e.target.closest('.issue-del'); if (del) deleteIssue_(del.dataset.id);
});
async function saveIssueEdit_(id, btn) {
  const nameInput = el_('issueTableBody').querySelector(`.issue-name-input[data-id="${CSS.escape(id)}"]`);
  const activeInput = el_('issueTableBody').querySelector(`.issue-active-toggle[data-id="${CSS.escape(id)}"]`);
  const auth = requireAdminFields_(); if (!auth) return;
  await withBusy_(btn, '', async () => {
    const r = await apiPost('updateIssue', { issueId: id, name: nameInput.value.trim(), active: activeInput.checked, superAdminUser: auth.user, superAdminPass: auth.pass });
    if (!r.ok) { toast(r.error || 'Could not save', 'error'); return; }
    toast('Saved', 'success'); await reloadIssues_();
  });
}
async function deleteIssue_(id) {
  const auth = requireAdminFields_(); if (!auth) return;
  if (!confirm('Delete this issue type?')) return;
  const r = await apiPost('deleteIssue', { issueId: id, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not delete', 'error'); return; }
  toast('Deleted', 'success'); await reloadIssues_();
}
async function reloadIssues_() {
  const r = await apiGet('getIssues', {});
  if (r.ok) { state.issues = r.issues; renderIssueTable_(); populateStaticDropdowns_(); }
}
el_('addIssueAdminBtn').addEventListener('click', async () => {
  const name = val_('newIssueName').trim();
  if (!name) { el_('newIssueName').focus(); return; }
  await withBusy_(el_('addIssueAdminBtn'), '', async () => {
    const r = await apiPost('addIssue', { name });
    if (!r.ok) { toast(r.error || 'Could not add', 'error'); return; }
    setVal_('newIssueName', ''); toast('Added', 'success'); await reloadIssues_();
  });
});
el_('newIssueName').addEventListener('keydown', e => { if (e.key === 'Enter') el_('addIssueAdminBtn').click(); });

// ---- Clinic Details ----
function fillClinicForm_() {
  const s = state.settings;
  setVal_('s_logo', s.LogoURL); setVal_('s_printLogo', s.PrintLogoURL); setVal_('s_clinicName', s.ClinicName);
  setVal_('s_phone', s.Phone); setVal_('s_address', s.Address); setVal_('s_website', s.Website);
  setVal_('s_clinicEmail', s.ClinicEmail); setVal_('s_registrationNo', s.RegistrationNo);
  setVal_('s_socialWhatsapp', s.SocialWhatsapp); setVal_('s_socialInstagram', s.SocialInstagram);
  setVal_('s_socialFacebook', s.SocialFacebook); setVal_('s_socialLinkedin', s.SocialLinkedin); setVal_('s_socialYoutube', s.SocialYoutube);
}
el_('saveClinicBtn').addEventListener('click', async () => {
  const auth = requireAdminFields_(); if (!auth) return;
  const fields = {
    ClinicName: val_('s_clinicName'), Address: val_('s_address'), Phone: val_('s_phone'), Website: val_('s_website'),
    ClinicEmail: val_('s_clinicEmail'), RegistrationNo: val_('s_registrationNo'), LogoURL: val_('s_logo'), PrintLogoURL: val_('s_printLogo'),
    SocialWhatsapp: val_('s_socialWhatsapp'), SocialInstagram: val_('s_socialInstagram'), SocialFacebook: val_('s_socialFacebook'),
    SocialLinkedin: val_('s_socialLinkedin'), SocialYoutube: val_('s_socialYoutube')
  };
  await withBusy_(el_('saveClinicBtn'), 'Saving...', async () => {
    const r = await apiPost('updateSettings', Object.assign({ superAdminUser: auth.user, superAdminPass: auth.pass }, fields));
    if (!r.ok) { setStatus_('clinicStatus', r.error || 'Could not save', 'err'); return; }
    setStatus_('clinicStatus', 'Saved.', 'ok');
    Object.assign(state.settings, fields); cachePublicSettings_(state.settings); applyTheme_(state.settings);
    toast('Clinic details saved', 'success');
  });
});

// ---- Theme ----
const THEME_COLOR_FIELDS = [
  'ThemeLoginBgFrom', 'ThemeLoginBgTo', 'ThemeLoginCardBg', 'ThemeLoginHeadingColor', 'ThemeLoginTextColor',
  'ThemeSidebarFrom', 'ThemeSidebarTo', 'ThemeSidebarText', 'ThemeNavActiveBg', 'ThemeNavActiveText',
  'ThemeButtonFrom', 'ThemeButtonTo', 'ThemeButtonText', 'ThemeButtonHoverFrom', 'ThemeButtonHoverTo',
  'ThemeOutlineText', 'ThemeOutlineBorder', 'ThemeOutlineHoverBg', 'ThemeOutlineHoverText',
  'ThemePageHeadingColor', 'ThemePageSubheadingColor', 'ThemeSectionHeadingColor',
  'ThemeTabActiveTextColor', 'ThemeTabInactiveTextColor', 'ThemeTabIndicatorFrom', 'ThemeTabIndicatorTo',
  'ThemeGateBgColor', 'ThemeGateBorderColor', 'ThemeGateTitleColor',
  'ThemeDocHeaderColor', 'ThemeFieldLabelColor', 'ThemeFieldValueColor', 'ThemeSectionBandColor',
  'ThemeHeadingColor', 'ThemeMutedColor', 'ThemeSurfaceColor', 'ThemeBgColor', 'ThemeBorderColor'
];
const THEME_STYLE_SELECT_FIELDS = ['ThemeLoginBgStyle', 'ThemeSidebarStyle', 'ThemeButtonStyle', 'ThemeTabIndicatorStyle', 'ThemeDocFontFamily', 'ThemeDocHeaderLayout'];
const THEME_CHECKBOX_FIELDS = ['ThemeDocCompanyNameBold', 'ThemeDocCompanyNameItalic', 'ThemeDocCompanyNameUnderline',
  'ThemeDocCompanyInfoBold', 'ThemeDocCompanyInfoItalic', 'ThemeDocCompanyInfoUnderline'];
const THEME_NUMBER_FIELDS = ['ThemeDocLogoWidth', 'ThemeDocLogoHeight'];

function toHexColor_(v, fallback) { v = String(v || '').trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v : (/^#[0-9a-f]{3}$/i.test(v) ? '#' + v.slice(1).split('').map(c => c + c).join('') : fallback); }

function renderThemeGrid_() {
  const s = state.settings;
  THEME_COLOR_FIELDS.forEach(key => { const e = el_('th_' + key); if (e) e.value = toHexColor_(s[key], '#000000'); });
  THEME_STYLE_SELECT_FIELDS.forEach(key => { const e = el_('th_' + key); if (e) e.value = s[key] || e.options[0].value; if (e && !e.value) e.value = e.options[0].value; });
  THEME_CHECKBOX_FIELDS.forEach(key => { const e = el_('th_' + key); if (e) e.checked = truthyStr_(s[key]); });
  THEME_NUMBER_FIELDS.forEach(key => { const e = el_('th_' + key); if (e) e.value = s[key] || ''; });

  const palette = String(s.ThemeChartPalette || '').split(',').map(c => c.trim()).filter(Boolean);
  while (palette.length < 12) palette.push('#888888');
  el_('themeChartSwatches').innerHTML = palette.slice(0, 12).map((c, i) =>
    `<input type="color" class="th-chart-swatch" id="th_chart_${i}" value="${toHexColor_(c, '#888888')}" aria-label="Chart color ${i + 1}">`).join('');

  wireThemeLivePreview_();
  updateAllThemePreviews_();
}

function wireThemeLivePreview_() {
  document.querySelectorAll('.th-input, .th-style-select').forEach(e => { e.oninput = updateAllThemePreviews_; e.onchange = updateAllThemePreviews_; });
  document.querySelectorAll('#tab-theme input[type=checkbox]').forEach(e => { e.onchange = updateAllThemePreviews_; });
  document.querySelectorAll('.th-chart-swatch').forEach(e => { e.oninput = updateAllThemePreviews_; });
  document.querySelectorAll('.logo-preset-btn').forEach(btn => {
    btn.onclick = () => { setVal_('th_ThemeDocLogoWidth', btn.dataset.w); setVal_('th_ThemeDocLogoHeight', btn.dataset.h); updateAllThemePreviews_(); };
  });
}

function readThemeFormValues_() {
  const v = {};
  THEME_COLOR_FIELDS.forEach(key => { v[key] = val_('th_' + key); });
  THEME_STYLE_SELECT_FIELDS.forEach(key => { v[key] = val_('th_' + key); });
  THEME_CHECKBOX_FIELDS.forEach(key => { v[key] = checked_('th_' + key) ? 'TRUE' : 'FALSE'; });
  THEME_NUMBER_FIELDS.forEach(key => { v[key] = val_('th_' + key); });
  v.ThemeChartPalette = Array.from(document.querySelectorAll('.th-chart-swatch')).map(e => e.value).join(',');
  return v;
}

function updateAllThemePreviews_() {
  const v = readThemeFormValues_();

  el_('loginPreview').querySelector('.tp-login-bg').style.background = gradientCss_(v.ThemeLoginBgStyle, v.ThemeLoginBgFrom, v.ThemeLoginBgTo);
  const loginCard = el_('loginPreview').querySelector('.tp-login-card');
  loginCard.style.background = v.ThemeLoginCardBg;
  loginCard.querySelector('.tp-login-name').style.color = v.ThemeLoginHeadingColor;
  loginCard.querySelector('.tp-login-sub').style.color = v.ThemeLoginTextColor;

  const sb = el_('sidebarPreview').querySelector('.tp-sidebar');
  sb.style.background = gradientCss_(v.ThemeSidebarStyle, v.ThemeSidebarFrom, v.ThemeSidebarTo);
  sb.querySelectorAll('.tp-sidebar-item').forEach(item => { item.style.color = v.ThemeSidebarText; });
  const activeItem = sb.querySelector('.tp-active');
  activeItem.style.background = v.ThemeNavActiveBg; activeItem.style.color = v.ThemeNavActiveText;

  const bp = el_('buttonPreview');
  const fills = bp.querySelectorAll('.tp-btn-fill');
  fills[0].style.background = gradientCss_(v.ThemeButtonStyle, v.ThemeButtonFrom, v.ThemeButtonTo); fills[0].style.color = v.ThemeButtonText;
  fills[1].style.background = gradientCss_(v.ThemeButtonStyle, v.ThemeButtonHoverFrom, v.ThemeButtonHoverTo); fills[1].style.color = v.ThemeButtonText;
  const outs = bp.querySelectorAll('.tp-btn-outline');
  outs[0].style.color = v.ThemeOutlineText; outs[0].style.borderColor = v.ThemeOutlineBorder || v.ThemeOutlineText;
  outs[1].style.background = v.ThemeOutlineHoverBg; outs[1].style.color = v.ThemeOutlineHoverText; outs[1].style.borderColor = v.ThemeOutlineBorder || v.ThemeOutlineText;

  const hp = el_('headingPreview');
  hp.querySelector('.tp-page-heading').style.color = v.ThemePageHeadingColor;
  hp.querySelector('.tp-page-sub').style.color = v.ThemePageSubheadingColor;
  hp.querySelector('.tp-section-heading').style.color = v.ThemeSectionHeadingColor;

  const tp = el_('tabsPreview');
  tp.querySelectorAll('.tp-tab').forEach(t => { t.style.color = v.ThemeTabInactiveTextColor; });
  const activeTab = tp.querySelector('.tp-tab-active');
  activeTab.style.color = v.ThemeTabActiveTextColor;
  activeTab.style.borderImage = `${gradientCss_(v.ThemeTabIndicatorStyle, v.ThemeTabIndicatorFrom, v.ThemeTabIndicatorTo)} 1`;
  activeTab.style.borderBottomColor = v.ThemeTabIndicatorTo;

  const gp = el_('gatePreview').querySelector('.tp-gate');
  gp.style.background = v.ThemeGateBgColor; gp.style.borderColor = v.ThemeGateBorderColor; gp.style.color = v.ThemeGateTitleColor;

  const dp = el_('docPreview');
  dp.style.fontFamily = v.ThemeDocFontFamily;
  const nameEl = dp.querySelector('.tp-doc-name'), infoEl = dp.querySelector('.tp-doc-info');
  dp.querySelector('.tp-doc-header').style.borderBottomColor = v.ThemeDocHeaderColor;
  nameEl.style.color = v.ThemeDocHeaderColor;
  dp.querySelector('.tp-doc-id').style.color = v.ThemeDocHeaderColor;
  nameEl.style.fontWeight = truthyStr_(v.ThemeDocCompanyNameBold) ? '800' : '400';
  nameEl.style.fontStyle = truthyStr_(v.ThemeDocCompanyNameItalic) ? 'italic' : 'normal';
  nameEl.style.textDecoration = truthyStr_(v.ThemeDocCompanyNameUnderline) ? 'underline' : 'none';
  infoEl.style.fontWeight = truthyStr_(v.ThemeDocCompanyInfoBold) ? '700' : '400';
  infoEl.style.fontStyle = truthyStr_(v.ThemeDocCompanyInfoItalic) ? 'italic' : 'normal';
  infoEl.style.textDecoration = truthyStr_(v.ThemeDocCompanyInfoUnderline) ? 'underline' : 'none';
  const docHeaderEl = dp.querySelector('.tp-doc-header');
  docHeaderEl.style.flexDirection = v.ThemeDocHeaderLayout === 'logo-top' ? 'column' : 'row';
  docHeaderEl.style.alignItems = v.ThemeDocHeaderLayout === 'logo-top' ? 'flex-start' : 'center';
  dp.querySelector('.tp-doc-band').style.background = v.ThemeSectionBandColor;
  dp.querySelector('.tp-doc-fl').style.color = v.ThemeFieldLabelColor;
  dp.querySelector('.tp-doc-fv').style.color = v.ThemeFieldValueColor;
  const logoW = Math.max(20, Math.min(70, Number(v.ThemeDocLogoWidth) || 40));
  const logoH = Math.max(20, Math.min(70, Number(v.ThemeDocLogoHeight) || 40));
  const docLogo = dp.querySelector('.tp-doc-logo'); docLogo.style.width = logoW + 'px'; docLogo.style.height = logoH + 'px';

  const txp = el_('textPreview');
  txp.querySelector('.tp-text-outer').style.background = v.ThemeBgColor;
  const txCard = txp.querySelector('.tp-text-card');
  txCard.style.background = v.ThemeSurfaceColor; txCard.style.border = '1px solid ' + v.ThemeBorderColor;
  txCard.querySelector('.tp-text-heading').style.color = v.ThemeHeadingColor;
  txCard.querySelector('.tp-text-muted').style.color = v.ThemeMutedColor;

  const palette = v.ThemeChartPalette.split(',').map(c => c.trim()).filter(Boolean);
  const heights = [62, 38, 50, 28, 44, 20, 56, 32, 46, 24, 40, 30];
  el_('tpChartBars').innerHTML = palette.map((c, i) => `<span style="height:${heights[i % heights.length]}px;background:${escapeHtml(c)}"></span>`).join('');
  el_('tpNumberCards').innerHTML = palette.slice(0, 4).map(c => `<span style="background:${escapeHtml(c)}">128</span>`).join('');
}

el_('saveThemeBtn').addEventListener('click', async () => {
  const auth = requireAdminFields_(); if (!auth) return;
  const values = readThemeFormValues_();
  await withBusy_(el_('saveThemeBtn'), 'Saving...', async () => {
    const r = await apiPost('updateTheme', Object.assign({ superAdminUser: auth.user, superAdminPass: auth.pass }, values));
    if (!r.ok) { setStatus_('themeStatus', r.error || 'Could not save', 'err'); return; }
    setStatus_('themeStatus', 'Theme saved.', 'ok');
    Object.assign(state.settings, values); cachePublicSettings_(state.settings); applyTheme_(state.settings);
    toast('Theme updated', 'success');
  });
});
el_('resetThemeBtn').addEventListener('click', async () => {
  const auth = requireAdminFields_(); if (!auth) return;
  if (!confirm('Reset all theme colors to default?')) return;
  await withBusy_(el_('resetThemeBtn'), 'Resetting...', async () => {
    const r = await apiPost('resetTheme', { superAdminUser: auth.user, superAdminPass: auth.pass });
    if (!r.ok) { toast(r.error || 'Could not reset', 'error'); return; }
    const boot = await apiGet('getSettings', {});
    if (boot.ok) { state.settings = boot.settings; cachePublicSettings_(state.settings); applyTheme_(state.settings); renderThemeGrid_(); fillClinicForm_(); }
    toast('Theme reset to default', 'success');
  });
});

// ---- Database(s) Status ----
function capacityBarClass_(pct) { return pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok'; }

function dbCardHtml_(db, isActive) {
  const reachable = db.reachable !== false;
  const badge = isActive ? '<span class="ds-db-badge active">Active</span>' : '<span class="ds-db-badge archived">Archived</span>';
  if (!reachable) {
    return `<div class="ds-db-card ds-unreachable">
      <div class="ds-db-top">${badge}<span class="ds-db-label">${escapeHtml(db.label || '')}</span></div>
      <div class="ds-db-name">${escapeHtml(db.name)}</div>
    </div>`;
  }
  const pct = Math.min(100, db.percentUsed || 0);
  const barClass = capacityBarClass_(pct);
  const rows = db.rowCounts || {};
  return `<div class="ds-db-card">
    <div class="ds-db-top">
      ${badge}
      ${db.label ? `<span class="ds-db-label">${escapeHtml(db.label)}</span>` : ''}
    </div>
    <div class="ds-db-name">${db.url ? `<a href="${escapeHtml(db.url)}" target="_blank" rel="noopener">${escapeHtml(db.name)} &#8599;</a>` : escapeHtml(db.name)}</div>
    <div class="ds-db-progress-track"><div class="ds-db-progress-fill ${barClass}" style="width:${pct}%"></div></div>
    <div class="ds-db-progress-text"><span>${pct}% of capacity used</span><span>${barClass === 'crit' ? 'Nearly full - add a new database soon' : barClass === 'warn' ? 'Getting full' : 'Plenty of room'}</span></div>
    <div class="ds-db-rows">
      <span><b>${(rows.visits || 0).toLocaleString()}</b> visits</span>
      <span><b>${(rows.patients || 0).toLocaleString()}</b> patients</span>
      <span><b>${(rows.physios || 0).toLocaleString()}</b> physiotherapists</span>
    </div>
    ${isActive && db.nextVisitId ? `<div class="ds-db-next">Next Visit ID here will be <b>${escapeHtml(db.nextVisitId)}</b></div>` : ''}
  </div>`;
}

async function loadDbStatus_() {
  const auth = superAdminFromFields_();
  if (!auth.user || !auth.pass) {
    el_('dataStatusResult').innerHTML = '<div class="ds-loading">Enter your Super Admin credentials above, then click Refresh.</div>';
    return;
  }
  el_('dataStatusResult').innerHTML = '<div class="ds-loading">Loading...</div>';
  const r = await apiPost('getDataDiagnostics', { superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) {
    el_('dataStatusResult').innerHTML = `<div class="ds-loading">${escapeHtml(r.error || 'Could not load database status')}</div>`;
    return;
  }
  const cards = [dbCardHtml_(r.active, true)].concat((r.archives || []).map(a => dbCardHtml_(a, false)));
  el_('dataStatusResult').innerHTML = `<div class="ds-db-list">${cards.join('')}</div>`;
}
el_('checkDataStatusBtn').addEventListener('click', () => withBusy_(el_('checkDataStatusBtn'), '', loadDbStatus_));

el_('addNewDatabaseBtn').addEventListener('click', async () => {
  const auth = requireAdminFields_(); if (!auth) return;
  if (!confirm('This creates a brand-new spreadsheet, copies your clinic settings, physiotherapist accounts, ' +
    'issues list and patients into it, and switches every new assessment there from now on. The current database ' +
    'is kept exactly as-is (nothing is deleted) and stays readable from Find/Edit, Reports and the Dashboard as ' +
    'archived history. Continue?')) return;
  await withBusy_(el_('addNewDatabaseBtn'), 'Creating new database...', async () => {
    const r = await apiPost('autoExpandDatabase', { superAdminUser: auth.user, superAdminPass: auth.pass }, { timeoutMs: PDF_TIMEOUT_MS });
    const resultBox = el_('dbExpandResult');
    resultBox.style.display = '';
    if (!r.ok) {
      resultBox.innerHTML = `<b style="color:var(--danger)">Could not create a new database:</b> ${escapeHtml(r.error || 'Unknown error')}`;
      toast(r.error || 'Could not create new database', 'error');
      return;
    }
    resultBox.innerHTML = `<b>New database created and is now active:</b> ${escapeHtml(r.newSpreadsheetName)}<br>` +
      `<a href="${escapeHtml(r.newSpreadsheetUrl)}" target="_blank" rel="noopener">Open the new spreadsheet &#8599;</a><br>` +
      `The previous database is now archived ("${escapeHtml(r.archivedLabel)}") and still fully readable from Find/Edit, Reports and the Dashboard.`;
    toast('New database created and switched to', 'success');
    invalidateDataCaches_();
    await loadDbStatus_();
  });
});

el_('resetToActiveOnlyBtn').addEventListener('click', async () => {
  const auth = requireAdminFields_(); if (!auth) return;
  if (!confirm('This forgets every archived database link (they are NOT deleted - just unlinked from this app) ' +
    'and re-bases Visit ID / Issue ID numbering on only what is actually in the active spreadsheet right now. ' +
    'Use this only to fix numbering after manually editing the sheet, or to undo a test "Add New Database". Continue?')) return;
  const r = await apiPost('resetToActiveOnly', { superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not reset', 'error'); return; }
  toast('Numbering reset. Next Visit ID will be ' + r.nextVisitId, 'success');
  invalidateDataCaches_();
  await loadDbStatus_();
});

// ---- My Login ----
el_('saveAdminLoginBtn').addEventListener('click', async () => {
  const auth = requireAdminFields_(); if (!auth) return;
  if (!val_('acc_newUser').trim() && !val_('acc_newPass')) { setStatus_('adminLoginStatus', 'Enter a new username and/or password.', 'err'); return; }
  await withBusy_(el_('saveAdminLoginBtn'), 'Updating...', async () => {
    const r = await apiPost('updateSuperAdminLogin', { currentUser: auth.user, currentPass: auth.pass, newUser: val_('acc_newUser').trim(), newPass: val_('acc_newPass') });
    if (!r.ok) { setStatus_('adminLoginStatus', r.error || 'Could not update', 'err'); return; }
    setStatus_('adminLoginStatus', 'Login updated. Use the new credentials next time.', 'ok');
    if (val_('acc_newUser').trim()) sessionStorage.setItem('SJP_displayName', val_('acc_newUser').trim());
    setVal_('acc_newPass', '');
    toast('Super Admin login updated', 'success');
  });
});
el_('savePhysioPassBtn').addEventListener('click', async () => {
  if (!val_('acc_currentPass') || !val_('acc_physioNewPass')) { setStatus_('physioPassStatus', 'Enter your current and new password.', 'err'); return; }
  await withBusy_(el_('savePhysioPassBtn'), 'Updating...', async () => {
    const r = await apiPost('updateOwnPassword', { physioId: state.session.physioId, currentPassword: val_('acc_currentPass'), newPassword: val_('acc_physioNewPass') });
    setVal_('acc_currentPass', ''); setVal_('acc_physioNewPass', '');
    if (!r.ok) { setStatus_('physioPassStatus', r.error || 'Could not update', 'err'); return; }
    setStatus_('physioPassStatus', 'Password updated.', 'ok'); toast('Password updated', 'success');
  });
});

el_('signatureFileInput').addEventListener('change', () => {
  const file = el_('signatureFileInput').files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { setStatus_('signatureStatus', 'That image is over 2 MB - please use a smaller PNG.', 'err'); el_('signatureFileInput').value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { el_('mySignaturePreview').src = reader.result; el_('mySignaturePreview').style.display = ''; };
  reader.readAsDataURL(file);
});
el_('uploadSignatureBtn').addEventListener('click', () => {
  const file = el_('signatureFileInput').files[0];
  if (!file) { setStatus_('signatureStatus', 'Choose a PNG file first.', 'err'); return; }
  const password = val_('acc_sigPassword');
  if (!password) { setStatus_('signatureStatus', 'Confirm your password.', 'err'); return; }
  const reader = new FileReader();
  reader.onload = () => withBusy_(el_('uploadSignatureBtn'), 'Uploading...', async () => {
    const r = await apiPost('uploadSignature', { physioId: state.session.physioId, password, base64Png: reader.result });
    setVal_('acc_sigPassword', '');
    if (!r.ok) { setStatus_('signatureStatus', r.error || 'Could not upload', 'err'); return; }
    setStatus_('signatureStatus', 'Signature uploaded and will now auto-fill on every record you sign.', 'ok');
    toast('Signature uploaded', 'success');
    const p = state.physios.find(x => String(x.physioId) === String(state.session.physioId));
    if (p) p.signatureUrl = r.signatureUrl;
    updateFormSignaturePreview_();
  });
  reader.readAsDataURL(file);
});
async function loadMySignature_() {
  const r = await apiGet('getPhysios', {});
  if (!r.ok) return;
  const me = r.physios.find(p => String(p.physioId) === String(state.session.physioId));
  if (me && me.signatureUrl) { el_('mySignaturePreview').src = me.signatureUrl; el_('mySignaturePreview').style.display = ''; }
}

// -------------------------------------------------------------------------
// 27. MODAL / POPOVER DISMISS HELPERS
// -------------------------------------------------------------------------
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });
});
document.addEventListener('click', e => {
  const popover = el_('reportColumnsPopover');
  const btn = el_('reportColumnsBtn');
  if (popover && popover.style.display === 'block' && !popover.contains(e.target) && !btn.contains(e.target)) {
    popover.style.display = 'none';
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll('.modal-overlay.show');
  if (open.length) { open[open.length - 1].classList.remove('show'); return; }
  closeSidebar_();
});

// -------------------------------------------------------------------------
// 28. STARTUP - paint with the cached theme immediately; if a session token
//     from earlier in this tab is still valid (page refresh), skip straight
//     past the login screen. The token is always re-validated server-side.
// -------------------------------------------------------------------------
(async function initOnLoad_() {
  const cached = readCachedPublicSettings_();
  if (cached) { state.settings = cached; applyTheme_(cached); }

  if (getToken_()) {
    showApp_();
    let ok = false;
    try { ok = await bootstrapApp(); } catch (e) { ok = false; }
    if (!ok && !sessionExpiryHandled_) showLogin_('Could not load the app right now. Please log in again.');
    return;
  }
  // Not logged in yet - refresh the login screen's theme from the server.
  const r = await apiGet('getSettings', {});
  if (r.ok && r.settings) { state.settings = r.settings; cachePublicSettings_(r.settings); applyTheme_(r.settings); }
})();
