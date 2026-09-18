/* =========================================================================
   SJ PHYSIOTHERAPY - PATIENT ASSESSMENT & RECORDS SYSTEM
   Frontend logic (vanilla JS only - no third-party scripts)
   ========================================================================= */

// -------------------------------------------------------------------------
// 0. CONFIG - paste your Apps Script Web App URL here after deployment.
//    Guide: SETUP_GUIDE.md, Step 4.
// -------------------------------------------------------------------------
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbyn8GHWlGoJu053qLL_eG7Az7T80dlm0EgutUgupkuZPeOsN5GX2ZMY9GmtzTbMGNOt/exec'
};

const FRONTEND_BUILD = 'SJP-PAF-2026-09-17-01';
const EXPECTED_BACKEND_BUILD = 'SJP-PAF-2026-09-17-01'; // must match BACKEND_BUILD in Code.gs
console.log('SJ Physiotherapy - Assessment app.js build', FRONTEND_BUILD);

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
  customCharts: [],
  themeChartPalette: ['#a8d339', '#2778b7', '#59ff4d', '#1F9E78', '#2E86AB', '#6C4FB6', '#3D5A80', '#8C2F39', '#D4A017', '#4B5A57', '#7A5C61', '#2be42e'],
  session: { role: null, physioId: '', physioName: '', canAccessFindEdit: false, canAccessReportDownload: false, canAccessDashboard: false },
  // Live editable-form state for the parts too structured for plain inputs:
  form: {
    romData: {}, mmtData: {}, painMarks: [], specialTests: [], treatmentGoals: [], treatmentPlan: [],
    activeMarkColor: '#d1352f', activeMarkType: 'pain'
  },
  lastSavedAssessment: null,
  editingVisitId: null // set when the form is being used to EDIT an existing record rather than create a new one
};

// -------------------------------------------------------------------------
// 2. API HELPERS
//    SECURITY NOTE: the ONLY thing ever written to sessionStorage is the
//    opaque session token (meaningless without the server-side cache entry
//    behind it, expires in 6h) plus a few non-secret display fields (name,
//    role, which permission toggles are on) purely so the UI doesn't flash
//    on a page refresh. The actual PASSWORD is never written anywhere in
//    the browser at any point - not here, not at login, not when signing
//    an assessment. See apiVerifyPhysio_ / the Save/Sign flow below, which
//    always re-collects the password fresh from an input field and sends
//    it once, directly, to be checked against the sheet.
// -------------------------------------------------------------------------
async function apiPost(action, payload) {
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload, token: sessionStorage.getItem('SJP_token') || '' })
  });
  const data = await res.json();
  handleSessionExpiry_(data);
  return data;
}
async function apiGet(action, params) {
  const qs = new URLSearchParams({ action, token: sessionStorage.getItem('SJP_token') || '', ...(params || {}) }).toString();
  const res = await fetch(CONFIG.API_URL + '?' + qs, { cache: 'no-store' });
  const data = await res.json();
  handleSessionExpiry_(data);
  return data;
}

const SESSION_STORAGE_KEYS = ['SJP_displayName', 'SJP_role', 'SJP_token', 'SJP_physioId', 'SJP_physioName',
  'SJP_canAccessFindEdit', 'SJP_canAccessReportDownload', 'SJP_canAccessDashboard'];

function handleSessionExpiry_(r) {
  if (r && r.ok === false && r.sessionExpired) {
    SESSION_STORAGE_KEYS.forEach(k => sessionStorage.removeItem(k));
    toast('Your session expired. Please log in again.', 'error');
    setTimeout(() => location.reload(), 1200);
  }
}

// -------------------------------------------------------------------------
// 3. TOASTS
// -------------------------------------------------------------------------
function toast(msg, type) {
  const wrap = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4200);
}

// -------------------------------------------------------------------------
// 4. LOGIN / LOGOUT
// -------------------------------------------------------------------------
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value.trim();
  const errBox = document.getElementById('loginError');
  errBox.style.display = 'none';
  if (!username || !password) {
    errBox.textContent = 'Please enter both username and password.';
    errBox.style.display = 'block';
    return;
  }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Checking...';
  try {
    const r = await apiPost('login', { username, password });
    // The password variable goes out of scope right here and is never
    // written anywhere - only the server's response (role, name, token,
    // permission flags) is kept.
    if (r.ok) {
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
      document.getElementById('whoAmI').textContent = r.displayName || username;
      document.getElementById('loginScreen').classList.add('hidden');
      document.getElementById('appShell').classList.remove('hidden');
      await bootstrapApp();
    } else {
      errBox.textContent = r.error || 'Invalid username or password.';
      errBox.style.display = 'block';
    }
  } catch (err) {
    errBox.textContent = 'Could not reach the server. Check API_URL in app.js and your internet connection.';
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Log In';
  }
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  SESSION_STORAGE_KEYS.forEach(k => sessionStorage.removeItem(k));
  location.reload();
});

// -------------------------------------------------------------------------
// 5. NAVIGATION
// -------------------------------------------------------------------------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    document.getElementById('sidebar').classList.remove('open');
    if (btn.dataset.view === 'dashboard') loadDashboard();
    if (btn.dataset.view === 'reports') loadReport(reportState.active);
    if (btn.dataset.view === 'admin') loadAdminTabData_();
  });
});
document.getElementById('hamburgerBtn').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));

// -------------------------------------------------------------------------
// 6. UTILITIES
// -------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(str, n) { str = String(str || ''); return str.length > n ? str.slice(0, n - 1) + '…' : str; }
function todayStr_() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function el_(id) { return document.getElementById(id); }
function val_(id) { const e = el_(id); return e ? e.value : ''; }
function setVal_(id, v) { const e = el_(id); if (e) e.value = (v === undefined || v === null) ? '' : v; }
function checked_(id) { const e = el_(id); return !!(e && e.checked); }
function setChecked_(id, v) { const e = el_(id); if (e) e.checked = !!v; }

// -------------------------------------------------------------------------
// 7. BODY OUTLINE ARTWORK - must stay pixel-identical to BODY_SVG_FRONT /
//    BODY_SVG_BACK / BODY_SVG_SIDE in Code.gs, since the same coordinates
//    are used to place marks both on screen and in the printed PDF.
// -------------------------------------------------------------------------
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

const BODY_VIEWS = [
  { key: 'front', label: 'Front View', svg: BODY_SVG_FRONT, mirror: false },
  { key: 'back', label: 'Back View', svg: BODY_SVG_BACK, mirror: false },
  { key: 'right', label: 'Right Side View', svg: BODY_SVG_SIDE, mirror: false },
  { key: 'left', label: 'Left Side View', svg: BODY_SVG_SIDE, mirror: true }
];

// -------------------------------------------------------------------------
// 8. THEME ENGINE - reads the Settings sheet's Theme* keys and writes
//    resolved CSS custom properties straight onto :root, exactly like the
//    billing app's theme engine (same key names for the shared pieces:
//    buttons, sidebar, tabs, login, chart palette).
// -------------------------------------------------------------------------
function gradientCss_(style, from, to) {
  if (style === 'solid') return from;
  const dir = style === 'gradient-vertical' ? '180deg' : style === 'gradient-horizontal' ? '90deg' : '135deg';
  return `linear-gradient(${dir}, ${from} 0%, ${to} 100%)`;
}
function applyTheme_(s) {
  const root = document.documentElement.style;
  const brandGrad = gradientCss_(s.ThemeButtonStyle, s.ThemeButtonFrom, s.ThemeButtonTo);
  const brandGradHover = gradientCss_(s.ThemeButtonStyle, s.ThemeButtonHoverFrom, s.ThemeButtonHoverTo);
  const sidebarGrad = gradientCss_(s.ThemeSidebarStyle, s.ThemeSidebarFrom, s.ThemeSidebarTo);
  root.setProperty('--brand-gradient', brandGrad);
  root.setProperty('--brand-gradient-hover', brandGradHover);
  root.setProperty('--sidebar-gradient', sidebarGrad);
  root.setProperty('--theme-button-text', s.ThemeButtonText || '#FFFFFF');
  root.setProperty('--theme-sidebar-text', s.ThemeSidebarText || '#FFFFFF');
  root.setProperty('--theme-nav-active-bg', s.ThemeNavActiveBg || '#FFFFFF');
  root.setProperty('--theme-nav-active-text', s.ThemeNavActiveText || s.ThemeButtonFrom || '#a8d339');
  root.setProperty('--theme-bill-header', s.ThemeDocHeaderColor || '#04bd07');
  root.setProperty('--theme-heading', s.ThemeHeadingColor || '#182322');
  root.setProperty('--theme-muted', s.ThemeMutedColor || '#4B5A57');
  root.setProperty('--theme-bg', s.ThemeBgColor || '#F6F4F3');
  root.setProperty('--theme-surface', s.ThemeSurfaceColor || '#FFFFFF');
  root.setProperty('--theme-border', s.ThemeBorderColor || '#E7DCD8');
  root.setProperty('--theme-bill-font', s.ThemeDocFontFamily || "Georgia, 'Times New Roman', Times, serif");
  root.setProperty('--theme-bill-logo-w', (s.ThemeDocLogoWidth || 96) + 'px');
  root.setProperty('--theme-bill-logo-h', (s.ThemeDocLogoHeight || 58) + 'px');
  root.setProperty('--theme-button-hover-from', s.ThemeButtonHoverFrom || '#8fc22c');
  root.setProperty('--theme-button-hover-to', s.ThemeButtonHoverTo || '#1f5f8f');
  root.setProperty('--theme-outline-text', s.ThemeOutlineText || '#2778b7');
  root.setProperty('--theme-outline-border', s.ThemeOutlineBorder || '#2778b7');
  root.setProperty('--theme-outline-hover-bg', s.ThemeOutlineHoverBg || '#EAF3FB');
  root.setProperty('--theme-outline-hover-text', s.ThemeOutlineHoverText || '#2778b7');
  const loginGrad = gradientCss_(s.ThemeLoginBgStyle, s.ThemeLoginBgFrom, s.ThemeLoginBgTo);
  root.setProperty('--theme-login-gradient', loginGrad);
  root.setProperty('--theme-login-card-bg', s.ThemeLoginCardBg || '#FFFFFF');
  root.setProperty('--theme-login-heading', s.ThemeLoginHeadingColor || '#182322');
  root.setProperty('--theme-login-text', s.ThemeLoginTextColor || '#4B5A57');

  state.themeChartPalette = (s.ThemeChartPalette || '').split(',').map(c => c.trim()).filter(Boolean);
  if (!state.themeChartPalette.length) state.themeChartPalette = ['#a8d339', '#2778b7', '#59ff4d'];

  document.querySelectorAll('.sidebar-brand .name, #loginLogo').forEach(() => {});
  const logoUrl = s.LogoURL || 'https://via.placeholder.com/160x160.png?text=LOGO';
  el_('loginLogo').src = logoUrl;
  el_('sidebarLogo').src = logoUrl;
  el_('topbarLogo').src = logoUrl;
  el_('sidebarCompanyName').textContent = s.ClinicName || 'SJ Physiotherapy';
  document.title = (s.ClinicName || 'SJ Physiotherapy') + ' - Patient Assessment & Records System';
}

// -------------------------------------------------------------------------
// 9. BOOTSTRAP
// -------------------------------------------------------------------------
async function bootstrapApp() {
  restoreSessionDisplay_();
  const r = await apiGet('bootstrap', {});
  if (!r.ok) { toast(r.error || 'Could not load app data', 'error'); return; }
  checkBackendBuild_(r.serverBuild);
  state.settings = r.settings || {};
  state.physios = r.physios || [];
  state.issues = r.issues || [];
  state.howKnowOptions = r.howKnowOptions || [];
  state.ambulationOptions = r.ambulationOptions || ['Independent', 'Assisted'];
  applyTheme_(state.settings);
  applyRoleVisibility_();
  populateStaticDropdowns_();
  initRomMmtTables_();
  initBodyDiagrams_();
  initVasScale_();
  renderSpecialTests_();
  renderGoalsPlan_();
  setVal_('f_date', todayStr_());
  state.bootstrapped = true;
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

function applyRoleVisibility_() {
  const isAdmin = state.session.role !== 'physio';
  el_('navAdmin').style.display = isAdmin ? '' : 'none';
  document.querySelector('[data-view="lookup"]').style.display = (isAdmin || state.session.canAccessFindEdit) ? '' : 'none';
  document.querySelector('[data-view="reports"]').style.display = (isAdmin || state.session.canAccessReportDownload) ? '' : 'none';
  document.querySelector('[data-view="dashboard"]').style.display = (isAdmin || state.session.canAccessDashboard) ? '' : 'none';

  // Physio-authorization box on the assessment form: a logged-in physio
  // sees their own name locked in + a fresh password box (never
  // pre-filled); Super Admin sees a dropdown to pick who this record is
  // for + that person's password.
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
}

function populateStaticDropdowns_() {
  const howKnowSel = el_('f_howKnow');
  howKnowSel.innerHTML = '<option value="">Select...</option>' + state.howKnowOptions.map(o => `<option>${escapeHtml(o)}</option>`).join('');

  const issueSel = el_('f_issueType');
  issueSel.innerHTML = '<option value="">Select issue...</option>' + state.issues.map(i => `<option>${escapeHtml(i.name)}</option>`).join('');

  const physioSel = el_('f_physioId');
  physioSel.innerHTML = '<option value="">Select physiotherapist...</option>' +
    state.physios.filter(p => p.active).map(p => `<option value="${escapeHtml(p.physioId)}">${escapeHtml(p.name)} (${escapeHtml(p.physioId)})</option>`).join('');
}

// -------------------------------------------------------------------------
// 10. ROM / MMT EDITABLE TABLES
// -------------------------------------------------------------------------
function buildRomTableDom_(tableEl, dataStore) {
  let html = '<thead><tr><th colspan="2">Movement</th><th>Right</th><th>Left</th></tr></thead><tbody>';
  Object.keys(ROM_STRUCTURE).forEach(joint => {
    const movements = ROM_STRUCTURE[joint];
    if (!dataStore[joint]) dataStore[joint] = {};
    movements.forEach((m, idx) => {
      if (!dataStore[joint][m]) dataStore[joint][m] = { R: '', L: '' };
      html += '<tr>' + (idx === 0 ? `<td class="rom-joint-cell" rowspan="${movements.length}">${escapeHtml(joint)}</td>` : '') +
        `<td>${escapeHtml(m)}</td>` +
        `<td><input data-joint="${joint}" data-move="${m}" data-side="R" class="rom-input" placeholder="e.g. 0-90&deg;"></td>` +
        `<td><input data-joint="${joint}" data-move="${m}" data-side="L" class="rom-input" placeholder="e.g. 0-90&deg;"></td>` +
        '</tr>';
    });
  });
  html += '</tbody>';
  tableEl.innerHTML = html;
  tableEl.querySelectorAll('.rom-input').forEach(inp => {
    inp.addEventListener('input', () => {
      dataStore[inp.dataset.joint][inp.dataset.move][inp.dataset.side] = inp.value;
    });
  });
}
function initRomMmtTables_() {
  state.form.romData = {}; state.form.mmtData = {};
  buildRomTableDom_(el_('romTable'), state.form.romData);
  buildRomTableDom_(el_('mmtTable'), state.form.mmtData);
}
function fillRomTableFromJson_(tableEl, dataStore, jsonStr) {
  const parsed = (() => { try { return JSON.parse(jsonStr || '{}'); } catch (e) { return {}; } })();
  Object.keys(parsed).forEach(joint => { dataStore[joint] = parsed[joint]; });
  tableEl.querySelectorAll('.rom-input').forEach(inp => {
    const v = (dataStore[inp.dataset.joint] && dataStore[inp.dataset.joint][inp.dataset.move] && dataStore[inp.dataset.joint][inp.dataset.move][inp.dataset.side]) || '';
    inp.value = v;
  });
}

// -------------------------------------------------------------------------
// 11. VAS SCALE
// -------------------------------------------------------------------------
function initVasScale_() {
  renderVasScale_(0);
  el_('f_vas').addEventListener('input', () => renderVasScale_(Number(el_('f_vas').value)));
}
function renderVasScale_(active) {
  let html = '';
  for (let n = 0; n <= 10; n++) html += `<span class="${n === active ? 'active' : ''}">${n}</span>`;
  el_('vasScaleDisplay').innerHTML = html;
}

// -------------------------------------------------------------------------
// 12. BODY DIAGRAMS - interactive pain map (point 5 & 21)
// -------------------------------------------------------------------------
function initBodyDiagrams_() {
  state.form.painMarks = [];
  const wrap = el_('bodyDiagramsWrap');
  wrap.innerHTML = BODY_VIEWS.map(v => `
    <div class="body-view">
      <div class="body-svg-holder" data-view="${v.key}">
        <svg viewBox="0 0 200 480" class="body-svg-base" style="${v.mirror ? 'transform:scaleX(-1)' : ''}">${v.svg}</svg>
      </div>
      <div class="body-view-label">${v.label}</div>
    </div>`).join('') + `
    <div class="body-legend">
      <span><i style="background:#d1352f"></i> Pain Point</span>
      <span><i style="background:#2778b7"></i> Radiating Point</span>
    </div>`;

  wrap.querySelectorAll('.body-svg-holder').forEach(holder => {
    holder.addEventListener('click', e => onBodyDiagramClick_(e, holder));
  });

  // Marker-color toolbar
  document.querySelectorAll('.mark-tool[data-color]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mark-tool').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.form.activeMarkColor = btn.dataset.color;
      state.form.activeMarkType = btn.dataset.type;
    });
  });
  el_('markCustomColor').addEventListener('input', () => {
    el_('markCustomBtn').dataset.color = el_('markCustomColor').value;
  });
  el_('clearMarksBtn').addEventListener('click', () => {
    state.form.painMarks = [];
    redrawAllMarks_();
  });
}

function onBodyDiagramClick_(e, holder) {
  const svg = holder.querySelector('svg');
  const rect = svg.getBoundingClientRect();
  let xPx = e.clientX - rect.left;
  const view = holder.dataset.view;
  const isMirrored = view === 'left';
  if (isMirrored) xPx = rect.width - xPx; // undo the CSS mirror so stored % is anatomically consistent
  const xPct = Math.max(0, Math.min(100, (xPx / rect.width) * 100));
  const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

  // Clicking an existing dot removes it instead of adding a new one.
  const clickedDot = e.target.closest('.body-mark-dot');
  if (clickedDot) {
    const idx = Number(clickedDot.dataset.idx);
    state.form.painMarks.splice(idx, 1);
    redrawAllMarks_();
    return;
  }

  state.form.painMarks.push({ view: view, x: Math.round(xPct * 10) / 10, y: Math.round(yPct * 10) / 10, type: state.form.activeMarkType, color: state.form.activeMarkColor });
  redrawAllMarks_();
}

function redrawAllMarks_() {
  document.querySelectorAll('.body-svg-holder').forEach(holder => {
    const view = holder.dataset.view;
    holder.querySelectorAll('.body-mark-dot').forEach(d => d.remove());
    const svg = holder.querySelector('svg');
    state.form.painMarks.forEach((m, idx) => {
      if (m.view !== view) return;
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', m.x * 2); c.setAttribute('cy', m.y * 4.8); c.setAttribute('r', '5');
      c.setAttribute('fill', m.color); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1.2');
      c.setAttribute('class', 'body-mark-dot'); c.dataset.idx = idx;
      svg.appendChild(c);
    });
  });
}

// -------------------------------------------------------------------------
// 13. DYNAMIC ROWS - Special Tests / Treatment Goals / Treatment Plan
// -------------------------------------------------------------------------
function renderSpecialTests_() {
  el_('specialTestsRows').innerHTML = state.form.specialTests.map((t, i) => `
    <div class="dyn-row">
      <input placeholder="Test name" data-idx="${i}" data-field="test" class="st-input" value="${escapeHtml(t.test)}">
      <input placeholder="Result" data-idx="${i}" data-field="result" class="st-input" value="${escapeHtml(t.result)}">
      <button type="button" class="remove-row-btn" data-idx="${i}" data-kind="st">&times;</button>
    </div>`).join('');
  wireDynRowInputs_('.st-input', state.form.specialTests);
  wireDynRowRemove_('st', state.form.specialTests, renderSpecialTests_);
}
el_('addSpecialTestBtn').addEventListener('click', () => { state.form.specialTests.push({ test: '', result: '' }); renderSpecialTests_(); });

function renderGoalsPlan_() {
  el_('goalsRows').innerHTML = state.form.treatmentGoals.map((g, i) => `
    <div class="dyn-row"><input data-idx="${i}" class="goal-input" value="${escapeHtml(g)}" placeholder="Goal ${i + 1}">
      <button type="button" class="remove-row-btn" data-idx="${i}" data-kind="goal">&times;</button></div>`).join('');
  el_('planRows').innerHTML = state.form.treatmentPlan.map((p, i) => `
    <div class="dyn-row"><input data-idx="${i}" class="plan-input" value="${escapeHtml(p)}" placeholder="Plan item ${i + 1}">
      <button type="button" class="remove-row-btn" data-idx="${i}" data-kind="plan">&times;</button></div>`).join('');
  el_('goalsRows').querySelectorAll('.goal-input').forEach(inp => inp.addEventListener('input', () => { state.form.treatmentGoals[Number(inp.dataset.idx)] = inp.value; }));
  el_('planRows').querySelectorAll('.plan-input').forEach(inp => inp.addEventListener('input', () => { state.form.treatmentPlan[Number(inp.dataset.idx)] = inp.value; }));
  el_('goalsRows').querySelectorAll('.remove-row-btn').forEach(btn => btn.addEventListener('click', () => { state.form.treatmentGoals.splice(Number(btn.dataset.idx), 1); renderGoalsPlan_(); }));
  el_('planRows').querySelectorAll('.remove-row-btn').forEach(btn => btn.addEventListener('click', () => { state.form.treatmentPlan.splice(Number(btn.dataset.idx), 1); renderGoalsPlan_(); }));
}
el_('addGoalBtn').addEventListener('click', () => { state.form.treatmentGoals.push(''); renderGoalsPlan_(); });
el_('addPlanBtn').addEventListener('click', () => { state.form.treatmentPlan.push(''); renderGoalsPlan_(); });

function wireDynRowInputs_(selector, arr) {
  document.querySelectorAll(selector).forEach(inp => {
    inp.addEventListener('input', () => { arr[Number(inp.dataset.idx)][inp.dataset.field] = inp.value; });
  });
}
function wireDynRowRemove_(kind, arr, rerender) {
  document.querySelectorAll(`.remove-row-btn[data-kind="${kind}"]`).forEach(btn => {
    btn.addEventListener('click', () => { arr.splice(Number(btn.dataset.idx), 1); rerender(); });
  });
}

// -------------------------------------------------------------------------
// 14. ISSUE "ADD NEW" (from the form) + PATIENT MATCH LOOKUP
// -------------------------------------------------------------------------
el_('addIssueBtn').addEventListener('click', async () => {
  const name = prompt('New issue / diagnosis type:');
  if (!name || !name.trim()) return;
  const r = await apiPost('addIssue', { name: name.trim() });
  if (!r.ok) { toast(r.error || 'Could not add issue', 'error'); return; }
  if (!state.issues.find(i => i.issueId === r.issueId)) state.issues.push({ issueId: r.issueId, name: r.name, active: true });
  populateStaticDropdowns_();
  el_('f_issueType').value = r.name;
  toast('Issue added', 'success');
});

let patientLookupTimer_ = null;
function wirePatientLookup_() {
  const trigger = async () => {
    clearTimeout(patientLookupTimer_);
    patientLookupTimer_ = setTimeout(async () => {
      const phone = val_('f_phone').trim(), name = val_('f_patientName').trim();
      if (phone.length < 6 || !name) { el_('patientMatchHint').textContent = ''; return; }
      const r = await apiGet('findPatient', { phone, name });
      if (r.ok && r.found) {
        const p = r.patient;
        el_('patientMatchHint').className = 'field-hint match-found';
        el_('patientMatchHint').textContent = '\u2713 Matched existing patient' + (p.patientId ? ' (Patient ID: ' + p.patientId + ')' : '') + ' - other fields auto-filled below, review before saving.';
        if (!val_('f_age')) setVal_('f_age', p.age);
        if (!val_('f_sex')) setVal_('f_sex', p.sex);
        if (!val_('f_occupation')) setVal_('f_occupation', p.occupation);
        if (!val_('f_email')) setVal_('f_email', p.email);
        if (!val_('f_address')) setVal_('f_address', p.address);
        if (!val_('f_uhid')) setVal_('f_uhid', p.uhid);
        if (!val_('f_patientId')) setVal_('f_patientId', p.patientId);
        if (!val_('f_howKnow')) setVal_('f_howKnow', p.howKnow);
      } else {
        el_('patientMatchHint').className = 'field-hint match-new';
        el_('patientMatchHint').textContent = phone && name ? 'New patient - a patient record will be created automatically.' : '';
      }
    }, 500);
  };
  el_('f_phone').addEventListener('input', trigger);
  el_('f_patientName').addEventListener('input', trigger);
}
wirePatientLookup_();

// -------------------------------------------------------------------------
// 15. COLLECT / FILL FORM DATA
// -------------------------------------------------------------------------
function collectFormData_() {
  return {
    patientId: val_('f_patientId'), patientName: val_('f_patientName'), phone: val_('f_phone'),
    age: val_('f_age'), sex: val_('f_sex'), occupation: val_('f_occupation'), email: val_('f_email'),
    address: val_('f_address'), uhid: val_('f_uhid'),
    date: val_('f_date'), referredBy: val_('f_referredBy'), howKnow: val_('f_howKnow'),
    invoiceNumber: val_('f_invoiceNumber'), issueType: val_('f_issueType'),
    chiefComplaint: val_('f_chiefComplaint'), historyOfPresentIllness: val_('f_hpi'),
    posture: val_('f_posture'), obsGait: val_('f_obsGait'), deformitySwelling: val_('f_deformitySwelling'),
    vas: val_('f_vas'), natureOfPain: val_('f_natureOfPain'), aggravatingFactors: val_('f_aggravatingFactors'), relievingFactors: val_('f_relievingFactors'),
    pmhDM: checked_('f_pmhDM'), pmhHTN: checked_('f_pmhHTN'), pmhThyroid: checked_('f_pmhThyroid'), pmhCardiac: checked_('f_pmhCardiac'),
    surgeryFractureHospitalization: val_('f_surgeryFractureHospitalization'),
    romJson: JSON.stringify(state.form.romData), mmtJson: JSON.stringify(state.form.mmtData),
    painMarksJson: JSON.stringify(state.form.painMarks), specialTestsJson: JSON.stringify(state.form.specialTests.filter(t => t.test || t.result)),
    ambulation: val_('f_ambulation'), stairClimbing: val_('f_stairClimbing'), adls: val_('f_adls'),
    balanceSingleLegStance: val_('f_balanceSingleLegStance'), balanceRombergTest: val_('f_balanceRombergTest'),
    gaitPattern: val_('f_gaitPattern'), gaitCadence: val_('f_gaitCadence'), gaitLimping: val_('f_gaitLimping'),
    clinicalDiagnosis: val_('f_clinicalDiagnosis'),
    treatmentGoalsJson: JSON.stringify(state.form.treatmentGoals.filter(Boolean)),
    treatmentPlanJson: JSON.stringify(state.form.treatmentPlan.filter(Boolean)),
    followUpNotes: val_('f_followUpNotes'), nextReviewDate: val_('f_nextReviewDate')
  };
}

function fillFormFromAssessment_(a) {
  setVal_('f_patientId', a.patientId); setVal_('f_patientName', a.patientName); setVal_('f_phone', a.phone);
  setVal_('f_age', a.age); setVal_('f_sex', a.sex); setVal_('f_occupation', a.occupation); setVal_('f_email', a.email);
  setVal_('f_address', a.address); setVal_('f_uhid', a.uHID);
  setVal_('f_date', a.date); setVal_('f_referredBy', a.referredBy); setVal_('f_howKnow', a.howKnow);
  setVal_('f_invoiceNumber', a.invoiceNumber); setVal_('f_issueType', a.issueType);
  setVal_('f_chiefComplaint', a.chiefComplaint); setVal_('f_hpi', a.historyOfPresentIllness);
  setVal_('f_posture', a.posture); setVal_('f_obsGait', a.obsGait); setVal_('f_deformitySwelling', a.deformitySwelling);
  setVal_('f_vas', a.vAS || 0); renderVasScale_(Number(a.vAS) || 0);
  setVal_('f_natureOfPain', a.natureOfPain); setVal_('f_aggravatingFactors', a.aggravatingFactors); setVal_('f_relievingFactors', a.relievingFactors);
  setChecked_('f_pmhDM', truthyStr_(a.pMH_DM)); setChecked_('f_pmhHTN', truthyStr_(a.pMH_HTN));
  setChecked_('f_pmhThyroid', truthyStr_(a.pMH_Thyroid)); setChecked_('f_pmhCardiac', truthyStr_(a.pMH_Cardiac));
  setVal_('f_surgeryFractureHospitalization', a.surgeryFractureHospitalization);
  fillRomTableFromJson_(el_('romTable'), state.form.romData, a.romJson);
  fillRomTableFromJson_(el_('mmtTable'), state.form.mmtData, a.mmtJson);
  state.form.painMarks = safeParse_(a.painMarksJson, []); redrawAllMarks_();
  state.form.specialTests = safeParse_(a.specialTestsJson, []); renderSpecialTests_();
  setVal_('f_ambulation', a.ambulation); setVal_('f_stairClimbing', a.stairClimbing); setVal_('f_adls', a.aDLs);
  setVal_('f_balanceSingleLegStance', a.balanceSingleLegStance); setVal_('f_balanceRombergTest', a.balanceRombergTest);
  setVal_('f_gaitPattern', a.gaitPattern); setVal_('f_gaitCadence', a.gaitCadence); setVal_('f_gaitLimping', a.gaitLimping);
  setVal_('f_clinicalDiagnosis', a.clinicalDiagnosis);
  state.form.treatmentGoals = safeParse_(a.treatmentGoalsJson, []); state.form.treatmentPlan = safeParse_(a.treatmentPlanJson, []); renderGoalsPlan_();
  setVal_('f_followUpNotes', a.followUpNotes); setVal_('f_nextReviewDate', a.nextReviewDate);
}
function truthyStr_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function safeParse_(str, fallback) { try { return JSON.parse(str || JSON.stringify(fallback)); } catch (e) { return fallback; } }

function resetAssessmentForm_() {
  document.querySelectorAll('#assessmentFormWrap input[type=text], #assessmentFormWrap input[type=tel], #assessmentFormWrap input[type=email], #assessmentFormWrap input[type=number], #assessmentFormWrap textarea').forEach(i => i.value = '');
  document.querySelectorAll('#assessmentFormWrap select').forEach(s => s.value = '');
  document.querySelectorAll('#assessmentFormWrap input[type=checkbox]').forEach(c => c.checked = false);
  setVal_('f_date', todayStr_()); setVal_('f_vas', 0); renderVasScale_(0);
  state.form.romData = {}; state.form.mmtData = {}; state.form.painMarks = []; state.form.specialTests = [];
  state.form.treatmentGoals = []; state.form.treatmentPlan = [];
  initRomMmtTables_(); redrawAllMarks_(); renderSpecialTests_(); renderGoalsPlan_();
  el_('patientMatchHint').textContent = '';
  state.editingVisitId = null;
  el_('assessmentHeading').textContent = 'New Assessment';
  el_('resetFormBtn').style.display = 'none';
  el_('assessmentFormWrap').classList.remove('hidden');
  el_('recordPreviewWrap').classList.add('hidden');
}
el_('resetFormBtn').addEventListener('click', resetAssessmentForm_);

// -------------------------------------------------------------------------
// 16. SAVE / UPDATE ASSESSMENT
// -------------------------------------------------------------------------
el_('saveAssessmentBtn').addEventListener('click', saveAssessment_);
async function saveAssessment_() {
  const patientName = val_('f_patientName').trim(), phone = val_('f_phone').trim(), date = val_('f_date');
  clearFieldErrors_();
  let hasError = false;
  if (!patientName) { markFieldError_('f_patientName'); hasError = true; }
  if (!phone) { markFieldError_('f_phone'); hasError = true; }
  if (!date) hasError = true;
  if (hasError) { toast('Please fill in all required fields.', 'error'); return; }

  let physioId, physioPassword;
  if (state.session.role === 'physio') {
    physioId = state.session.physioId;
    physioPassword = val_('f_physioOwnPassword');
    if (!physioPassword) { toast('Please confirm your password to sign this record.', 'error'); return; }
  } else {
    physioId = val_('f_physioId');
    physioPassword = val_('f_physioPassword');
    if (!physioId || !physioPassword) { toast('Select a physiotherapist and enter their password.', 'error'); return; }
  }

  const btn = el_('saveAssessmentBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  const statusEl = el_('physioStatus');
  try {
    const data = collectFormData_();
    let r;
    if (state.editingVisitId) {
      // Editing reuses the exact same physiotherapist-authorization fields
      // as creating a new record (physioId + a freshly-typed password) -
      // Code.gs's authorizeAssessmentEdit_ accepts either Super Admin
      // credentials or any valid physiotherapist's credentials, so Super
      // Admin can authorize an edit the same way here without this form
      // needing a second, separate "Super Admin password" box.
      r = await apiPost('updateAssessment', { visitId: state.editingVisitId, physioId, physioPassword, data });
    } else {
      r = await apiPost('saveAssessment', { physioId, physioPassword, data });
    }
    if (!r.ok) { statusEl.textContent = r.error || 'Could not save'; statusEl.className = 'biller-status err'; return; }

    statusEl.textContent = ''; statusEl.className = 'biller-status';
    setVal_('f_physioPassword', ''); setVal_('f_physioOwnPassword', ''); // never linger in the DOM either
    toast(state.editingVisitId ? 'Record updated' : 'Assessment saved', 'success');

    const visitId = state.editingVisitId || r.visitId;
    const full = await apiGet('getAssessment', { visitId });
    if (full.ok) {
      state.lastSavedAssessment = full.assessment;
      showRecordPreview_(full.assessment);
    }
  } catch (err) {
    statusEl.textContent = 'Network error while saving.'; statusEl.className = 'biller-status err';
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Generate Record';
  }
}
function markFieldError_(id) { const f = el_(id).closest('.field'); if (f) f.classList.add('has-error'); }
function clearFieldErrors_() { document.querySelectorAll('.field.has-error').forEach(f => f.classList.remove('has-error')); }

// -------------------------------------------------------------------------
// 17. RECORD DOCUMENT RENDERING (client-side mirror of buildAssessmentHtmlForPdf_
//     in Code.gs - same structure/classes, so on-screen preview, Print and
//     Save-as-PDF all look identical to the emailed PDF).
// -------------------------------------------------------------------------
function fld(label, value) {
  const labelHtml = label ? `<span class="fl-label" style="color:${state.settings.ThemeFieldLabelColor || '#0f6e5c'}">${escapeHtml(label)}: </span>` : '';
  return `<div class="doc-field">${labelHtml}<span class="fl-value" style="color:${state.settings.ThemeFieldValueColor || '#182322'}">${escapeHtml(value || '-')}</span></div>`;
}
function romTableHtmlClient_(jsonStr) {
  const dataObj = safeParse_(jsonStr, {});
  let rows = '';
  Object.keys(ROM_STRUCTURE).forEach(joint => {
    const movements = ROM_STRUCTURE[joint];
    movements.forEach((m, idx) => {
      const cell = (dataObj[joint] && dataObj[joint][m]) || { R: '', L: '' };
      rows += `<tr>${idx === 0 ? `<td class="doc-rom-joint" rowspan="${movements.length}">${escapeHtml(joint)}</td>` : ''}` +
        `<td>${escapeHtml(m)}</td><td class="num">${escapeHtml(cell.R)}</td><td class="num">${escapeHtml(cell.L)}</td></tr>`;
    });
  });
  return `<table class="doc-rom-table"><thead><tr><th colspan="2">Movement</th><th>Right</th><th>Left</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function specialTestsHtmlClient_(jsonStr) {
  const rows = safeParse_(jsonStr, []);
  if (!rows.length) return '<table class="doc-special-table"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody><tr><td colspan="2" class="muted">No special tests recorded</td></tr></tbody></table>';
  return '<table class="doc-special-table"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody>' +
    rows.map(r => `<tr><td>${escapeHtml(r.test)}</td><td>${escapeHtml(r.result)}</td></tr>`).join('') + '</tbody></table>';
}
function listHtmlClient_(jsonStr) {
  const items = safeParse_(jsonStr, []);
  if (!items.length) return '<div class="muted" style="color:var(--muted);font-style:italic;">None recorded</div>';
  return '<ol class="doc-list">' + items.map(i => `<li>${escapeHtml(i)}</li>`).join('') + '</ol>';
}
function checkboxHtmlClient_(label, checked) {
  return `<span style="margin-right:14px;"><span style="font-size:14px;">${checked ? '&#9745;' : '&#9744;'}</span> ` +
    `<span style="color:${state.settings.ThemeFieldLabelColor || '#0f6e5c'};font-weight:700;">${escapeHtml(label)}</span></span>`;
}
function bodyDiagramsHtmlClient_(painMarksJson) {
  const marks = safeParse_(painMarksJson, []);
  const cells = BODY_VIEWS.map(v => {
    const dots = marks.filter(m => m.view === v.key).map(m => `<circle cx="${m.x * 2}" cy="${m.y * 4.8}" r="4.2" fill="${m.color}" stroke="#fff" stroke-width="1"/>`).join('');
    return `<div class="doc-body-view"><svg viewBox="0 0 200 480" style="${v.mirror ? 'transform:scaleX(-1)' : ''}">${v.svg}${dots}</svg>` +
      `<div class="doc-body-view-label">${v.label.toUpperCase()}</div></div>`;
  }).join('');
  return `<div class="doc-body-diagrams">${cells}</div>` +
    `<div class="body-legend"><span><i style="background:#d1352f"></i>Pain Point</span><span><i style="background:#2778b7"></i>Radiating Point</span></div>`;
}
function docHeaderHtmlClient_() {
  const s = state.settings;
  const logo = s.PrintLogoURL || s.LogoURL;
  const nameStyle = `font-weight:${truthyStr_(s.ThemeDocCompanyNameBold) ? 'bold' : 'normal'};font-style:${truthyStr_(s.ThemeDocCompanyNameItalic) ? 'italic' : 'normal'};text-decoration:${truthyStr_(s.ThemeDocCompanyNameUnderline) ? 'underline' : 'none'}`;
  const infoStyle = `font-weight:${truthyStr_(s.ThemeDocCompanyInfoBold) ? 'bold' : 'normal'};font-style:${truthyStr_(s.ThemeDocCompanyInfoItalic) ? 'italic' : 'normal'};text-decoration:${truthyStr_(s.ThemeDocCompanyInfoUnderline) ? 'underline' : 'none'}`;
  return `<div class="doc-header">${logo ? `<img class="doc-logo" src="${escapeHtml(logo)}">` : ''}<div>` +
    `<div class="doc-company-name" style="${nameStyle}">${escapeHtml(s.ClinicName)}</div>` +
    `<div class="doc-company-info" style="${infoStyle}">${escapeHtml(s.Address)}</div>` +
    `<div class="doc-company-info" style="${infoStyle}">${escapeHtml(s.Phone)}${truthyStr_(s.ShowClinicEmail) && s.ClinicEmail ? ' &nbsp;|&nbsp; ' + escapeHtml(s.ClinicEmail) : ''}${s.Website ? ' &nbsp;|&nbsp; ' + escapeHtml(s.Website) : ''}</div>` +
    `</div></div>`;
}

function buildAssessmentDocHtml_(a) {
  const s = state.settings;
  const pmh = [checkboxHtmlClient_('DM', truthyStr_(a.pMH_DM)), checkboxHtmlClient_('HTN', truthyStr_(a.pMH_HTN)),
    checkboxHtmlClient_('Thyroid', truthyStr_(a.pMH_Thyroid)), checkboxHtmlClient_('Cardiac', truthyStr_(a.pMH_Cardiac))].join(' ');
  let vasScale = '';
  for (let n = 0; n <= 10; n++) {
    const active = String(n) === String(a.vAS);
    vasScale += `<span style="width:22px;height:22px;border-radius:50%;border:1px solid #999;display:inline-flex;align-items:center;justify-content:center;font-size:11px;${active ? 'background:#d1352f;color:#fff;border-color:#d1352f;font-weight:700;' : ''}">${n}</span>`;
  }
  const signatureImg = a.signatureUrl ? `<img class="doc-sig-img" src="${escapeHtml(a.signatureUrl)}">` : '<div class="doc-sig-line"></div>';

  return `${docHeaderHtmlClient_()}
    <div class="doc-title-bar">PHYSIOTHERAPY ASSESSMENT SHEET</div>
    <div class="section-band">Patient Details</div>
    <div class="doc-grid-4">
      ${fld('Patient Name', a.patientName)}${fld('Date', a.date)}${fld('Referred By', a.referredBy)}${fld('Age / Sex', (a.age || '-') + ' / ' + (a.sex || '-'))}
      ${fld('UHID / File No.', a.uHID)}${fld('Contact No.', a.phone)}${fld('Occupation', a.occupation)}${fld('Email ID', a.email)}
      ${fld('Address', a.address)}${fld('How They Knew Us', a.howKnow)}${fld('Invoice No.', a.invoiceNumber)}${fld('Issue Type', a.issueType)}
    </div>
    <div class="doc-grid-2">${fld('Chief Complaint', a.chiefComplaint)}${fld('History of Present Illness', a.historyOfPresentIllness)}</div>

    <div class="section-band">Observation &amp; Pain Assessment</div>
    <div class="doc-grid-3">${fld('Posture', a.posture)}${fld('Gait', a.obsGait)}${fld('Deformity / Swelling', a.deformitySwelling)}</div>
    <div class="doc-field"><span class="fl-label" style="color:${s.ThemeFieldLabelColor || '#0f6e5c'}">Pain Assessment (VAS):</span></div>
    <div style="display:flex;justify-content:space-between;max-width:420px;margin:4px 0 10px;">${vasScale}</div>
    <div class="doc-grid-3">${fld('Nature of Pain', a.natureOfPain)}${fld('Aggravating Factors', a.aggravatingFactors)}${fld('Relieving Factors', a.relievingFactors)}</div>

    <div class="section-band">Past Medical History</div>
    <div style="font-size:12.5px;margin-bottom:6px;">${pmh}</div>
    ${fld('Surgery / Fracture / Hospitalization', a.surgeryFractureHospitalization)}

    <div class="section-band">Range of Motion (ROM)</div>${romTableHtmlClient_(a.romJson)}
    <div class="section-band">Muscle Strength (MMT)</div>${romTableHtmlClient_(a.mmtJson)}

    <div class="section-band">Mark Pain Point &amp; Radiating Pain</div>${bodyDiagramsHtmlClient_(a.painMarksJson)}

    <div class="section-band">Special Tests</div>${specialTestsHtmlClient_(a.specialTestsJson)}

    <div class="section-band">Functional Assessment</div>
    <div class="doc-grid-3">${fld('Ambulation', a.ambulation)}${fld('Stair Climbing', a.stairClimbing)}${fld('ADLs', a.aDLs)}</div>

    <div class="doc-page-break">
    ${docHeaderHtmlClient_()}
    <div class="doc-title-bar">PHYSIOTHERAPY ASSESSMENT SHEET (contd.)</div>

    <div class="section-band">Balance</div>
    <div class="doc-grid-2">${fld('Single Leg Stance', a.balanceSingleLegStance)}${fld('Romberg Test', a.balanceRombergTest)}</div>

    <div class="section-band">Gait</div>
    <div class="doc-grid-3">${fld('Pattern', a.gaitPattern)}${fld('Cadence', a.gaitCadence)}${fld('Limping', a.gaitLimping)}</div>

    <div class="section-band">Clinical Diagnosis</div>${fld('', a.clinicalDiagnosis)}

    <div class="doc-grid-2">
      <div><div class="doc-field"><span class="fl-label" style="color:${s.ThemeFieldLabelColor || '#0f6e5c'}">Treatment Goals</span></div>${listHtmlClient_(a.treatmentGoalsJson)}</div>
      <div><div class="doc-field"><span class="fl-label" style="color:${s.ThemeFieldLabelColor || '#0f6e5c'}">Treatment Plan</span></div>${listHtmlClient_(a.treatmentPlanJson)}</div>
    </div>

    <div class="section-band">Follow Up / Notes</div>
    <div class="doc-notes-box">${escapeHtml(a.followUpNotes || '')}</div>

    <div class="doc-footer-row">
      <div>${fld('Next Review Date', a.nextReviewDate)}</div>
      <div class="doc-sig-block">${signatureImg}<div class="doc-sig-caption">${escapeHtml(a.physioName || 'Physiotherapist')}<br><span style="color:var(--muted);">Physiotherapist Signature</span></div></div>
    </div>
    <div class="doc-record-ids">Visit ID: ${escapeHtml(a.visitId)} &nbsp;|&nbsp; Patient Visit ID: ${escapeHtml(a.patientVisitId)}</div>
    <div class="doc-tagline">Move Better. Live Better.</div>
    </div>`;
}

function showRecordPreview_(a) {
  const html = buildAssessmentDocHtml_(a);
  el_('docPaper').innerHTML = html;
  el_('printSnapshot').innerHTML = html;
  el_('assessmentFormWrap').classList.add('hidden');
  el_('recordPreviewWrap').classList.remove('hidden');
  fitDocScale_();
}
function fitDocScale_() {
  const outer = document.querySelector('.doc-scale-outer');
  const inner = el_('docPaper');
  if (!outer || !inner) return;
  const scale = Math.min(1, (outer.clientWidth - 4) / 800);
  inner.style.transform = 'scale(' + scale + ')';
  outer.style.height = (inner.scrollHeight * scale) + 'px';
}
window.addEventListener('resize', fitDocScale_);

el_('editRecordBtn').addEventListener('click', () => {
  if (!state.lastSavedAssessment) return;
  const a = state.lastSavedAssessment;
  state.editingVisitId = a.visitId;
  el_('assessmentHeading').textContent = 'Edit Record - ' + a.visitId;
  el_('resetFormBtn').style.display = '';
  fillFormFromAssessment_(a);
  el_('assessmentFormWrap').classList.remove('hidden');
  el_('recordPreviewWrap').classList.add('hidden');
});

// -------------------------------------------------------------------------
// 18. SHARE / PRINT / PDF / EMAIL / WHATSAPP
// -------------------------------------------------------------------------
let shareMethod = null;
el_('shareRecordBtn').addEventListener('click', () => {
  if (!state.lastSavedAssessment) return;
  const a = state.lastSavedAssessment;
  el_('shareRecordTitle').textContent = 'Share Record - ' + a.visitId;
  el_('shareEmailField').style.display = 'none';
  el_('shareWhatsappField').style.display = 'none';
  el_('share_send').style.display = 'none';
  el_('share_email').value = ''; el_('share_phone').value = '';
  el_('shareStatus').textContent = ''; el_('shareStatus').className = 'biller-status';
  shareMethod = null;
  el_('shareRecordModal').classList.add('show');
});
el_('share_cancel').addEventListener('click', () => el_('shareRecordModal').classList.remove('show'));

el_('sharePrintBtn').addEventListener('click', () => { document.body.setAttribute('data-print-target', 'printSnapshot'); window.print(); });
el_('shareDownloadPdfBtn').addEventListener('click', () => { document.body.setAttribute('data-print-target', 'printSnapshot'); window.print(); });

el_('shareViaEmailBtn').addEventListener('click', () => {
  shareMethod = 'email';
  el_('shareEmailField').style.display = 'block'; el_('shareWhatsappField').style.display = 'none';
  el_('share_send').style.display = 'inline-block'; el_('share_send').textContent = 'Send Email';
});
el_('shareEmailPreviewBtn').addEventListener('click', async () => {
  const a = state.lastSavedAssessment;
  const btn = el_('shareEmailPreviewBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Loading...';
  try {
    const r = await apiGet('getEmailPreview', { visitId: a.visitId });
    if (!r.ok) { toast(r.error || 'Could not load preview', 'error'); return; }
    el_('emailPreviewFrame').srcdoc = r.html;
    el_('emailPreviewModal').classList.add('show');
  } finally { btn.disabled = false; btn.textContent = orig; }
});
el_('emailPreview_close').addEventListener('click', () => el_('emailPreviewModal').classList.remove('show'));
el_('emailPreview_send').addEventListener('click', () => { el_('emailPreviewModal').classList.remove('show'); el_('share_send').click(); });

el_('shareViaWhatsappBtn').addEventListener('click', () => {
  shareMethod = 'whatsapp';
  el_('shareWhatsappField').style.display = 'block'; el_('shareEmailField').style.display = 'none';
  el_('share_send').style.display = 'inline-block'; el_('share_send').textContent = 'Open WhatsApp';
});

el_('share_send').addEventListener('click', async () => {
  const a = state.lastSavedAssessment;
  const statusEl = el_('shareStatus'); const btn = el_('share_send');
  if (shareMethod === 'email') {
    const email = val_('share_email').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { statusEl.textContent = 'Enter a valid email address.'; statusEl.className = 'biller-status err'; return; }
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      const r = await apiPost('emailAssessmentPdf', { visitId: a.visitId, email });
      if (r.ok) { statusEl.textContent = 'Emailed to ' + email + '.'; statusEl.className = 'biller-status ok'; toast('Record emailed successfully', 'success'); }
      else { statusEl.textContent = r.error || 'Could not send email.'; statusEl.className = 'biller-status err'; }
    } finally { btn.disabled = false; btn.textContent = 'Send Email'; }
  } else if (shareMethod === 'whatsapp') {
    const phone = val_('share_phone').trim();
    if (!/^\d{10}$/.test(phone.replace(/\D/g, '').slice(-10))) { statusEl.textContent = 'Enter a valid 10-digit number.'; statusEl.className = 'biller-status err'; return; }
    const text = `Hello ${a.patientName}, here is your physiotherapy assessment record (${a.visitId}) from ${state.settings.ClinicName}. Issue: ${a.issueType || '-'}. Next Review: ${a.nextReviewDate || '-'}.`;
    window.open('https://wa.me/91' + phone.replace(/\D/g, '').slice(-10) + '?text=' + encodeURIComponent(text), '_blank');
    statusEl.textContent = 'WhatsApp opened in a new tab.'; statusEl.className = 'biller-status ok';
  }
});

window.addEventListener('afterprint', () => document.body.removeAttribute('data-print-target'));

// -------------------------------------------------------------------------
// 19. FIND / EDIT RECORD (lookup)
// -------------------------------------------------------------------------
el_('lookupBtn').addEventListener('click', doLookupSearch_);
el_('lookupQuery').addEventListener('keydown', e => { if (e.key === 'Enter') doLookupSearch_(); });
async function doLookupSearch_() {
  const q = val_('lookupQuery').trim();
  if (!q) return;
  const r = await apiGet('searchAssessments', { q });
  if (!r.ok) { toast(r.error || 'Search failed', 'error'); return; }
  if (!r.results.length) { el_('lookupResults').innerHTML = '<p class="field-hint">No matching records found.</p>'; return; }
  el_('lookupResults').innerHTML = r.results.map(row => `
    <div class="lookup-result-row">
      <div class="lookup-result-meta">
        <b>${escapeHtml(row.patientName)}</b> &nbsp;|&nbsp; ${escapeHtml(row.visitId)} &nbsp;|&nbsp; ${escapeHtml(row.date)} &nbsp;|&nbsp;
        ${escapeHtml(row.issueType || '-')} &nbsp;|&nbsp; Phone: ${escapeHtml(row.phone)} &nbsp;|&nbsp; Physio: ${escapeHtml(row.physioName)}
        ${row.invoiceNumber ? ' &nbsp;|&nbsp; Invoice: ' + escapeHtml(row.invoiceNumber) : ' &nbsp;|&nbsp; <i>Invoice not yet filled</i>'}
      </div>
      <button class="btn btn-outline btn-sm lookup-open-btn" data-visit="${escapeHtml(row.visitId)}">Open</button>
    </div>`).join('');
  document.querySelectorAll('.lookup-open-btn').forEach(btn => btn.addEventListener('click', () => openLookupRecord_(btn.dataset.visit)));
}
async function openLookupRecord_(visitId) {
  const r = await apiGet('getAssessment', { visitId });
  if (!r.ok) { toast(r.error || 'Could not load record', 'error'); return; }
  state.lastSavedAssessment = r.assessment;
  document.querySelector('[data-view="assessment"]').click();
  showRecordPreview_(r.assessment);
}

// -------------------------------------------------------------------------
// 20. REPORTS - Universal Report + Daily Report. Live, filterable,
//     column-choosable, downloadable as a real Excel file (same
//     SpreadsheetML technique as the billing app - no library needed).
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
      { key: 'createdAt', label: 'Created At' }
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
el_('refreshReportBtn').addEventListener('click', () => loadReport(reportState.active, true));

function canDownloadReports_() { return state.session.role !== 'physio' || state.session.canAccessReportDownload; }

async function loadReport(key, forceReload) {
  if (!canDownloadReports_() && !forceReload) { /* still viewable, download just hidden */ }
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
  renderReportTable_(key);
}

function filterReportRows_(rows, filters, config) {
  const activeFilters = Object.keys(filters).filter(k => filters[k]);
  if (!activeFilters.length) return rows;
  return rows.filter(row => activeFilters.every(k => String(row[k] || '').toLowerCase().includes(filters[k].toLowerCase())));
}

function renderReportTable_(key) {
  const config = REPORT_CONFIGS[key];
  const cols = config.columns.filter(c => reportState.visibleCols[key].has(c.key));
  const rows = filterReportRows_(reportState.data[key], reportState.filters[key], config);

  el_('reportHeaderRow').innerHTML = cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
  el_('reportFilterRow').innerHTML = cols.map(c =>
    `<th><input type="text" class="report-filter-input" data-key="${c.key}" placeholder="Filter..." value="${escapeHtml(reportState.filters[key][c.key] || '')}"></th>`).join('');
  document.querySelectorAll('.report-filter-input').forEach(inp => {
    inp.addEventListener('input', () => { reportState.filters[key][inp.dataset.key] = inp.value; renderReportTable_(key); });
  });

  el_('reportTableBody').innerHTML = rows.map(row => '<tr>' + cols.map(c => `<td>${escapeHtml(row[c.key])}</td>`).join('') + '</tr>').join('');
  el_('reportRowCount').textContent = rows.length.toLocaleString() + ' row' + (rows.length === 1 ? '' : 's') +
    (reportState.truncated[key] ? ' (server capped at most recent 5,000)' : '');
  el_('reportEmptyHint').style.display = rows.length ? 'none' : '';
}

el_('reportClearFiltersBtn').addEventListener('click', () => { reportState.filters[reportState.active] = {}; renderReportTable_(reportState.active); });

el_('reportColumnsBtn').addEventListener('click', () => {
  const key = reportState.active; const config = REPORT_CONFIGS[key];
  el_('reportColumnsList').innerHTML = config.columns.map(c =>
    `<label class="pmh-check" style="display:flex;"><input type="checkbox" class="rc-check" data-key="${c.key}" ${reportState.visibleCols[key].has(c.key) ? 'checked' : ''}> ${escapeHtml(c.label)}</label>`).join('');
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
  const rows = filterReportRows_(reportState.data[key], reportState.filters[key], config);
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
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeSheetName = esc(sheetLabel).slice(0, 31) || 'Report';
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
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// -------------------------------------------------------------------------
// 21. DASHBOARD
// -------------------------------------------------------------------------
el_('dashApplyFilterBtn').addEventListener('click', loadDashboard);
el_('dashClearFilterBtn').addEventListener('click', () => { setVal_('dash_dateFrom', ''); setVal_('dash_dateTo', ''); loadDashboard(); });
el_('refreshDashboardBtn').addEventListener('click', loadDashboard);

async function loadDashboard() {
  const params = { dateFrom: val_('dash_dateFrom'), dateTo: val_('dash_dateTo') };
  const r = await apiGet('getDashboardData', params);
  if (!r.ok) { toast(r.error || 'Could not load dashboard', 'error'); return; }
  el_('kpiTotalVisits').textContent = r.totalVisits.toLocaleString();
  el_('kpiTotalPatients').textContent = r.totalPatients.toLocaleString();
  drawGenericBarChart_(el_('issueBarChart'), r.issueTotals.map(i => i.name), r.issueTotals.map(i => i.count));
  drawGenericDonutChart_(el_('howKnowDonutChart'), r.howKnowTotals);
  drawGenericDonutChart_(el_('physioDonutChart'), r.physioTotals);
  el_('addCustomChartBtn').style.display = state.session.role !== 'physio' ? '' : 'none';
  loadCustomCharts_();
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
    const color = palette[idx % palette.length];
    const labelX = x + barW / 2, labelY = chartH + 6;
    bars += `<g><rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="6" fill="${color}"></rect>
      <text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" font-size="12" font-weight="700" fill="#182322">${v}</text>
      <text x="${labelX}" y="${labelY}" text-anchor="start" transform="rotate(90 ${labelX} ${labelY})" font-size="10" fill="#4B5A57">${escapeHtml(truncate(label, 18))}</text></g>`;
  });
  container.innerHTML = `<svg viewBox="0 0 ${width} ${chartH + labelSpace}" width="100%" style="max-width:${width}px; overflow:visible;">${bars}</svg>`;
}

function drawGenericDonutChart_(container, items) {
  if (!container) return;
  const palette = state.themeChartPalette;
  const withColor = items.map((it, idx) => ({ label: it.name, value: it.count, color: palette[idx % palette.length] }));
  const total = withColor.reduce((s, i) => s + i.value, 0);
  if (!total) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">No data yet.</p>'; return; }
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
    <span style="width:10px;height:10px;border-radius:3px;background:${it.color};display:inline-block;"></span>
    ${escapeHtml(it.label)}: ${it.value} (${Math.round(it.value / total * 100)}%)</div>`).join('');
  container.innerHTML = `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;"><svg width="180" height="180" viewBox="0 0 180 180">${paths}</svg><div>${legend}</div></div>`;
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
// 22. CUSTOM DASHBOARD CHARTS
// -------------------------------------------------------------------------
const VISIT_CHART_DIMENSIONS = [
  ['IssueType', 'Issue Type'], ['HowKnow', 'How Known'], ['PhysioName', 'Physiotherapist'], ['Sex', 'Sex'],
  ['Ambulation', 'Ambulation'], ['StairClimbing', 'Stair Climbing'], ['ADLs', 'ADLs'], ['ReferredBy', 'Referred By'], ['Date', 'Date']
];
async function loadCustomCharts_() {
  const r = await apiGet('getCustomCharts', {});
  if (!r.ok) return;
  state.customCharts = r.charts || [];
  renderCustomChartsGrid_();
}
function renderCustomChartsGrid_() {
  const grid = el_('customChartsGrid');
  el_('customChartsEmptyHint').style.display = state.customCharts.length ? 'none' : '';
  const isAdmin = state.session.role !== 'physio';
  grid.innerHTML = state.customCharts.map(c => `
    <div class="dash-card chart-card wide">
      <div class="dash-card-main">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h4>${escapeHtml(c.name)}</h4>
          ${isAdmin ? `<div style="display:flex;gap:6px;">
            <button class="btn btn-outline btn-sm cc-edit" data-id="${c.chartId}">Edit</button>
            <button class="btn btn-danger btn-sm cc-del" data-id="${c.chartId}">Delete</button></div>` : ''}
        </div>
        <div id="cc_${c.chartId}"></div>
      </div>
    </div>`).join('');
  state.customCharts.forEach(c => loadOneCustomChartData_(c));
  document.querySelectorAll('.cc-edit').forEach(btn => btn.addEventListener('click', () => openChartBuilder_(state.customCharts.find(c => String(c.chartId) === btn.dataset.id))));
  document.querySelectorAll('.cc-del').forEach(btn => btn.addEventListener('click', () => deleteCustomChart_(btn.dataset.id)));
}
async function loadOneCustomChartData_(def) {
  const container = el_('cc_' + def.chartId);
  if (!container) return;
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
function formatChartNumber_(n) { n = Number(n) || 0; return Math.round(n * 100) / 100 === Math.round(n) ? String(Math.round(n)) : n.toFixed(1); }

async function deleteCustomChart_(chartId) {
  if (!confirm('Delete this chart?')) return;
  const auth = promptSuperAdminAuth_();
  if (!auth) return;
  const r = await apiPost('deleteCustomChart', { chartId, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not delete', 'error'); return; }
  toast('Chart deleted', 'success'); loadCustomCharts_();
}
function promptSuperAdminAuth_() {
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
  setVal_('cb_color', existing ? existing.color : '#0f6e5c');
  updateChartBuilderDynamicFields_();
  setVal_('cb_dimension', existing ? existing.dimension : '');
  setVal_('cb_metricField', existing ? existing.metricField : 'VAS');
  el_('chartBuilderStatus').textContent = ''; el_('chartBuilderStatus').className = 'biller-status';
  el_('chartBuilderModal').classList.add('show');
}
function updateChartBuilderDynamicFields_() {
  const ds = val_('cb_dataSource');
  const dimSel = el_('cb_dimension');
  if (ds === 'visits') {
    dimSel.innerHTML = VISIT_CHART_DIMENSIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    el_('cb_dimensionField').style.display = ''; el_('cb_dataSourceHint').textContent = 'One bar/slice per visit-level field you choose below.';
  } else {
    el_('cb_dimensionField').style.display = 'none';
    el_('cb_dataSourceHint').textContent = ds === 'patients' ? 'Shows a single running total of all patients - best as a Number Card.' : 'Shows a single running total of active issue types - best as a Number Card.';
  }
  const isNumber = val_('cb_type') === 'number';
  el_('cb_topNField').style.display = isNumber ? 'none' : '';
  el_('cb_sortDirField').style.display = isNumber ? 'none' : '';
}
el_('cb_dataSource').addEventListener('change', updateChartBuilderDynamicFields_);
el_('cb_type').addEventListener('change', updateChartBuilderDynamicFields_);
el_('cb_cancel').addEventListener('click', () => el_('chartBuilderModal').classList.remove('show'));
el_('cb_save').addEventListener('click', async () => {
  const auth = promptSuperAdminAuth_();
  if (!auth) return;
  const payload = {
    chartId: val_('cb_chartId') || undefined, name: val_('cb_name'), type: val_('cb_type'),
    dataSource: val_('cb_dataSource'), dimension: val_('cb_dimension'), metric: val_('cb_metric'),
    metricField: val_('cb_metricField'), topN: val_('cb_topN'), sortDir: val_('cb_sortDir'), color: val_('cb_color'),
    superAdminUser: auth.user, superAdminPass: auth.pass
  };
  const r = await apiPost('saveCustomChart', payload);
  const statusEl = el_('chartBuilderStatus');
  if (!r.ok) { statusEl.textContent = r.error || 'Could not save'; statusEl.className = 'biller-status err'; return; }
  el_('chartBuilderModal').classList.remove('show');
  toast('Chart saved', 'success');
  loadCustomCharts_();
});

// -------------------------------------------------------------------------
// 23. ADMIN SETTINGS - tab switching
// -------------------------------------------------------------------------
document.querySelectorAll('.admin-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
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
  el_('accountAdminPane').style.display = state.session.role !== 'physio' ? '' : 'none';
  el_('accountPhysioPane').style.display = state.session.role === 'physio' ? '' : 'none';
  if (state.session.role === 'physio') loadMySignature_();
}

// ---- Physiotherapists ----
function renderPhysioTable_() {
  el_('physioTableBody').innerHTML = state.physios.map(p => `
    <tr>
      <td>${escapeHtml(p.physioId)}</td><td>${escapeHtml(p.name)}</td>
      <td><label class="pmh-check"><input type="checkbox" class="py-toggle" data-id="${p.physioId}" ${p.active ? 'checked' : ''}></label></td>
      <td><label class="pmh-check"><input type="checkbox" class="py-access" data-id="${p.physioId}" data-field="canAccessFindEdit" ${p.canAccessFindEdit ? 'checked' : ''}></label></td>
      <td><label class="pmh-check"><input type="checkbox" class="py-access" data-id="${p.physioId}" data-field="canAccessReportDownload" ${p.canAccessReportDownload ? 'checked' : ''}></label></td>
      <td><label class="pmh-check"><input type="checkbox" class="py-access" data-id="${p.physioId}" data-field="canAccessDashboard" ${p.canAccessDashboard ? 'checked' : ''}></label></td>
      <td>${p.signatureUrl ? '<img src="' + escapeHtml(p.signatureUrl) + '" style="height:26px;">' : '<span class="field-hint">Not uploaded</span>'}</td>
      <td><button class="btn btn-outline btn-sm py-edit" data-id="${p.physioId}">Edit</button> <button class="btn btn-danger btn-sm py-del" data-id="${p.physioId}">Delete</button></td>
    </tr>`).join('');
  document.querySelectorAll('.py-toggle').forEach(cb => cb.addEventListener('change', () => togglePhysio_(cb.dataset.id)));
  document.querySelectorAll('.py-access').forEach(cb => cb.addEventListener('change', () => setPhysioAccess_(cb.dataset.id, cb.dataset.field, cb.checked)));
  document.querySelectorAll('.py-edit').forEach(btn => btn.addEventListener('click', () => openPhysioModal_(state.physios.find(p => p.physioId === btn.dataset.id))));
  document.querySelectorAll('.py-del').forEach(btn => btn.addEventListener('click', () => deletePhysio_(btn.dataset.id)));
}
function superAdminFromFields_() { return { user: val_('admin_su_user'), pass: val_('admin_su_pass') }; }

async function togglePhysio_(id) {
  const auth = superAdminFromFields_();
  const r = await apiPost('togglePhysio', { physioId: id, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Enter Super Admin credentials above first', 'error'); renderPhysioTable_(); return; }
  toast('Updated', 'success'); await reloadPhysios_();
}
async function setPhysioAccess_(id, field, value) {
  const auth = superAdminFromFields_();
  const r = await apiPost('setPhysioAccess', { physioId: id, field, value, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Enter Super Admin credentials above first', 'error'); renderPhysioTable_(); return; }
  toast('Updated', 'success'); await reloadPhysios_();
}
async function deletePhysio_(id) {
  if (!confirm('Delete this physiotherapist account? This cannot be undone.')) return;
  const auth = superAdminFromFields_();
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
  el_('physioModalStatus').textContent = ''; el_('physioModalStatus').className = 'biller-status';
  el_('physioModal').classList.add('show');
}
el_('pm_cancel').addEventListener('click', () => el_('physioModal').classList.remove('show'));
el_('pm_save').addEventListener('click', async () => {
  const auth = superAdminFromFields_();
  const editId = val_('pm_editId');
  const payload = { name: val_('pm_name'), password: val_('pm_password'), editPhysioId: editId || undefined, superAdminUser: auth.user, superAdminPass: auth.pass };
  if (!payload.name) { el_('physioModalStatus').textContent = 'Name is required'; el_('physioModalStatus').className = 'biller-status err'; return; }
  if (!editId && !payload.password) { el_('physioModalStatus').textContent = 'Password is required for a new account'; el_('physioModalStatus').className = 'biller-status err'; return; }
  const r = await apiPost('savePhysio', payload);
  if (!r.ok) { el_('physioModalStatus').textContent = r.error || 'Could not save'; el_('physioModalStatus').className = 'biller-status err'; return; }
  el_('physioModal').classList.remove('show');
  toast('Saved', 'success'); await reloadPhysios_();
});

// ---- Issues List ----
function renderIssueTable_() {
  el_('issueTableBody').innerHTML = state.issues.map(i => `
    <tr>
      <td>${escapeHtml(i.issueId)}</td>
      <td><input type="text" class="issue-name-input" data-id="${i.issueId}" value="${escapeHtml(i.name)}"></td>
      <td><label class="pmh-check"><input type="checkbox" class="issue-active-toggle" data-id="${i.issueId}" ${i.active ? 'checked' : ''}></label></td>
      <td><button class="btn btn-outline btn-sm issue-save" data-id="${i.issueId}">Save</button> <button class="btn btn-danger btn-sm issue-del" data-id="${i.issueId}">Delete</button></td>
    </tr>`).join('');
  document.querySelectorAll('.issue-save').forEach(btn => btn.addEventListener('click', () => saveIssueEdit_(btn.dataset.id)));
  document.querySelectorAll('.issue-del').forEach(btn => btn.addEventListener('click', () => deleteIssue_(btn.dataset.id)));
}
async function saveIssueEdit_(id) {
  const nameInput = document.querySelector(`.issue-name-input[data-id="${id}"]`);
  const activeInput = document.querySelector(`.issue-active-toggle[data-id="${id}"]`);
  const auth = superAdminFromFields_();
  const r = await apiPost('updateIssue', { issueId: id, name: nameInput.value, active: activeInput.checked, superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Enter Super Admin credentials above first', 'error'); return; }
  toast('Saved', 'success'); await reloadIssues_();
}
async function deleteIssue_(id) {
  if (!confirm('Delete this issue type?')) return;
  const auth = superAdminFromFields_();
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
  if (!name) return;
  const r = await apiPost('addIssue', { name });
  if (!r.ok) { toast(r.error || 'Could not add', 'error'); return; }
  setVal_('newIssueName', ''); toast('Added', 'success'); await reloadIssues_();
});

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
  const auth = superAdminFromFields_();
  const payload = {
    ClinicName: val_('s_clinicName'), Address: val_('s_address'), Phone: val_('s_phone'), Website: val_('s_website'),
    ClinicEmail: val_('s_clinicEmail'), RegistrationNo: val_('s_registrationNo'), LogoURL: val_('s_logo'), PrintLogoURL: val_('s_printLogo'),
    SocialWhatsapp: val_('s_socialWhatsapp'), SocialInstagram: val_('s_socialInstagram'), SocialFacebook: val_('s_socialFacebook'),
    SocialLinkedin: val_('s_socialLinkedin'), SocialYoutube: val_('s_socialYoutube'),
    superAdminUser: auth.user, superAdminPass: auth.pass
  };
  const r = await apiPost('updateSettings', payload);
  const statusEl = el_('clinicStatus');
  if (!r.ok) { statusEl.textContent = r.error || 'Could not save'; statusEl.className = 'biller-status err'; return; }
  statusEl.textContent = 'Saved.'; statusEl.className = 'biller-status ok';
  Object.assign(state.settings, payload); applyTheme_(state.settings); toast('Clinic details saved', 'success');
});

// ---- Theme ----
const THEME_FIELD_DEFS = [
  ['ThemeButtonFrom', 'color', 'Button - From'], ['ThemeButtonTo', 'color', 'Button - To'], ['ThemeButtonText', 'color', 'Button Text'],
  ['ThemeButtonHoverFrom', 'color', 'Button Hover - From'], ['ThemeButtonHoverTo', 'color', 'Button Hover - To'],
  ['ThemeSidebarFrom', 'color', 'Sidebar - From'], ['ThemeSidebarTo', 'color', 'Sidebar - To'], ['ThemeSidebarText', 'color', 'Sidebar Text'],
  ['ThemeNavActiveBg', 'color', 'Sidebar Active Item Background'], ['ThemeNavActiveText', 'color', 'Sidebar Active Item Text'],
  ['ThemeHeadingColor', 'color', 'Page Heading Color'], ['ThemeMutedColor', 'color', 'Muted / Secondary Text'],
  ['ThemeBgColor', 'color', 'App Background'], ['ThemeSurfaceColor', 'color', 'Card / Panel Background'], ['ThemeBorderColor', 'color', 'Border Color'],
  ['ThemeOutlineText', 'color', 'Outline Button Text'], ['ThemeOutlineBorder', 'color', 'Outline Button Border'],
  ['ThemeLoginBgFrom', 'color', 'Login Background - From'], ['ThemeLoginBgTo', 'color', 'Login Background - To'],
  ['ThemeLoginCardBg', 'color', 'Login Card Background'], ['ThemeLoginHeadingColor', 'color', 'Login Heading'], ['ThemeLoginTextColor', 'color', 'Login Text'],
  ['ThemeDocHeaderColor', 'color', 'Printed Sheet - Header/Brand Color'],
  ['ThemeFieldLabelColor', 'color', 'Printed Sheet - Field NAME Color'], ['ThemeFieldValueColor', 'color', 'Printed Sheet - Field VALUE Color'],
  ['ThemeSectionBandColor', 'color', 'Printed Sheet - Section Band Background'],
  ['ThemeDocLogoWidth', 'text', 'Printed Sheet - Logo Width (px)'], ['ThemeDocLogoHeight', 'text', 'Printed Sheet - Logo Height (px)']
];
function renderThemeGrid_() {
  const s = state.settings;
  el_('themeGrid').innerHTML = THEME_FIELD_DEFS.map(([key, type, label]) => `
    <div class="theme-item">
      <label>${escapeHtml(label)}</label>
      <input type="${type}" id="th_${key}" value="${escapeHtml(s[key] || '')}">
    </div>`).join('');
}
el_('saveThemeBtn').addEventListener('click', async () => {
  const auth = superAdminFromFields_();
  const payload = { superAdminUser: auth.user, superAdminPass: auth.pass };
  THEME_FIELD_DEFS.forEach(([key]) => { payload[key] = val_('th_' + key); });
  const r = await apiPost('updateTheme', payload);
  const statusEl = el_('themeStatus');
  if (!r.ok) { statusEl.textContent = r.error || 'Could not save'; statusEl.className = 'biller-status err'; return; }
  statusEl.textContent = 'Theme saved.'; statusEl.className = 'biller-status ok';
  Object.assign(state.settings, payload); applyTheme_(state.settings); toast('Theme updated', 'success');
});
el_('resetThemeBtn').addEventListener('click', async () => {
  if (!confirm('Reset all theme colors to default?')) return;
  const auth = superAdminFromFields_();
  const r = await apiPost('resetTheme', { superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not reset', 'error'); return; }
  const boot = await apiGet('getSettings', {});
  state.settings = boot.settings; applyTheme_(state.settings); renderThemeGrid_(); fillClinicForm_();
  toast('Theme reset to default', 'success');
});

// ---- Database status ----
async function loadDbStatus_() {
  const r = await apiGet('getDbStatus', {});
  if (!r.ok) return;
  el_('dbStatusGrid').innerHTML = `
    <div class="dash-card kpi-card c-teal"><div class="dash-card-main"><div class="icon">&#128197;</div><div class="label">Total Visits</div><div class="value">${r.totalVisits.toLocaleString()}</div></div></div>
    <div class="dash-card kpi-card c-violet"><div class="dash-card-main"><div class="icon">&#128101;</div><div class="label">Total Patients</div><div class="value">${r.totalPatients.toLocaleString()}</div></div></div>
    <div class="dash-card kpi-card c-teal"><div class="dash-card-main"><div class="icon">&#128218;</div><div class="label">Cell Usage</div><div class="value">${r.percentUsed}%</div></div></div>`;
  el_('dbStatusTableBody').innerHTML = r.sheets.map(sh => `<tr><td>${escapeHtml(sh.name)}</td><td>${sh.rows.toLocaleString()}</td><td>${sh.cols}</td><td>${sh.cells.toLocaleString()}</td></tr>`).join('');
}
el_('refreshDbStatusBtn').addEventListener('click', loadDbStatus_);

// ---- My Login ----
el_('saveAdminLoginBtn').addEventListener('click', async () => {
  const auth = superAdminFromFields_();
  const r = await apiPost('updateSuperAdminLogin', { currentUser: auth.user, currentPass: auth.pass, newUser: val_('acc_newUser'), newPass: val_('acc_newPass') });
  const statusEl = el_('adminLoginStatus');
  if (!r.ok) { statusEl.textContent = r.error || 'Could not update'; statusEl.className = 'biller-status err'; return; }
  statusEl.textContent = 'Login updated. Use the new credentials next time.'; statusEl.className = 'biller-status ok';
  toast('Super Admin login updated', 'success');
});
el_('savePhysioPassBtn').addEventListener('click', async () => {
  const r = await apiPost('updateOwnPassword', { physioId: state.session.physioId, currentPassword: val_('acc_currentPass'), newPassword: val_('acc_physioNewPass') });
  const statusEl = el_('physioPassStatus');
  setVal_('acc_currentPass', ''); setVal_('acc_physioNewPass', '');
  if (!r.ok) { statusEl.textContent = r.error || 'Could not update'; statusEl.className = 'biller-status err'; return; }
  statusEl.textContent = 'Password updated.'; statusEl.className = 'biller-status ok'; toast('Password updated', 'success');
});

el_('signatureFileInput').addEventListener('change', () => {
  const file = el_('signatureFileInput').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { el_('mySignaturePreview').src = reader.result; el_('mySignaturePreview').style.display = ''; };
  reader.readAsDataURL(file);
});
el_('uploadSignatureBtn').addEventListener('click', async () => {
  const file = el_('signatureFileInput').files[0];
  const statusEl = el_('signatureStatus');
  if (!file) { statusEl.textContent = 'Choose a PNG file first.'; statusEl.className = 'biller-status err'; return; }
  const password = val_('acc_sigPassword');
  if (!password) { statusEl.textContent = 'Confirm your password.'; statusEl.className = 'biller-status err'; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    const r = await apiPost('uploadSignature', { physioId: state.session.physioId, password, base64Png: reader.result });
    setVal_('acc_sigPassword', '');
    if (!r.ok) { statusEl.textContent = r.error || 'Could not upload'; statusEl.className = 'biller-status err'; return; }
    statusEl.textContent = 'Signature uploaded and will now auto-fill on every record you sign.'; statusEl.className = 'biller-status ok';
    toast('Signature uploaded', 'success');
    const p = state.physios.find(p => p.physioId === state.session.physioId);
    if (p) p.signatureUrl = r.signatureUrl;
  };
  reader.readAsDataURL(file);
});
async function loadMySignature_() {
  const r = await apiGet('getPhysios', {});
  if (!r.ok) return;
  const me = r.physios.find(p => p.physioId === state.session.physioId);
  if (me && me.signatureUrl) { el_('mySignaturePreview').src = me.signatureUrl; el_('mySignaturePreview').style.display = ''; }
}

// -------------------------------------------------------------------------
// 24. MODAL / POPOVER DISMISS HELPERS
// -------------------------------------------------------------------------
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });
});
document.addEventListener('click', e => {
  const popover = el_('reportColumnsPopover');
  const btn = el_('reportColumnsBtn');
  if (popover && popover.style.display === 'block' && !popover.contains(e.target) && e.target !== btn) {
    popover.style.display = 'none';
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
});

// -------------------------------------------------------------------------
// 25. STARTUP - if a session token from earlier in this browser tab is
//     still valid (page refresh), skip straight past the login screen.
//     Re-validates against the server (bootstrap requires a real session)
//     rather than trusting anything cached client-side.
// -------------------------------------------------------------------------
(async function initOnLoad_() {
  const existingToken = sessionStorage.getItem('SJP_token');
  if (existingToken) {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    await bootstrapApp();
    if (!state.bootstrapped) {
      // token turned out to be invalid/expired - bounce back to login
      document.getElementById('loginScreen').classList.remove('hidden');
      document.getElementById('appShell').classList.add('hidden');
    }
    return;
  }
  // Not logged in yet - still theme the login screen from Admin Settings
  // (clinic name/logo/colors) via the one action that doesn't require a
  // session token.
  try {
    const r = await apiGet('getSettings', {});
    if (r.ok) { state.settings = r.settings; applyTheme_(state.settings); }
  } catch (e) { /* offline or first run before setupDatabase() - login screen still works with defaults */ }
})();
