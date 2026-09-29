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
// Switches which .view section is showing and resets scroll to the top -
// without this, a view switch after scrolling deep into a long form (e.g.
// New Assessment) leaves the newly-shown view scrolled out of sight until
// the user manually scrolls up, which looked like a blank screen.
function switchToView_(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById(viewId);
  if (target) target.classList.add('active');
  document.getElementById('sidebar').classList.remove('open');
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    switchToView_('view-' + btn.dataset.view);
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
// 7. BODY VIEW IMAGES - the clinic's own real reference photos/artwork,
//    used exactly as provided. Must stay identical to BODY_VIEW_IMAGES in
//    Code.gs, since the same percentage coordinates place a mark on top of
//    the same image both on screen and in the printed PDF.
// -------------------------------------------------------------------------
const BODY_VIEWS = [
  { key: 'front', label: 'Front View', url: 'http://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Front-View.png' },
  { key: 'back', label: 'Back View', url: 'http://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Back-View.png' },
  { key: 'right', label: 'Right Side View', url: 'http://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Right-Facing-View.png' },
  { key: 'left', label: 'Left Side View', url: 'http://sjphysiotherapy.in/patient-record/HUMAN%20AVATAR/Left-Facing-View.png' }
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
  checkCapacityAndWarn_();
}

// Proactive, non-blocking heads-up - the real enforcement (refusing to
// save once the database is genuinely full) happens server-side in
// apiSaveAssessment regardless of whether this toast was seen.
async function checkCapacityAndWarn_() {
  try {
    const r = await apiGet('getCapacityStatus', {});
    if (!r.ok) return;
    if (r.blocked) {
      toast('This database is full (' + r.percentUsed + '%). Ask Super Admin to add a new database from Admin Settings \u2192 Database before saving more records.', 'error');
    } else if (r.warning) {
      toast('Heads up: this database is ' + r.percentUsed + '% full. Super Admin can add a new one anytime from Admin Settings \u2192 Database.', '');
    }
  } catch (e) { /* non-critical - never block the app over this check */ }
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
  updateFormSignaturePreview_();
}

// -------------------------------------------------------------------------
// PHYSIOTHERAPIST SIGNATURE PREVIEW (point 3) - shown live on the
// assessment form itself, not just after saving, so whoever is signing can
// see their signature will actually be attached before they commit. Pulled
// straight from state.physios (refreshed from the server, never something
// typed or drawn here) - a logged-in physio always sees their own; Super
// Admin's preview follows whichever physiotherapist is picked in the
// dropdown below.
// -------------------------------------------------------------------------
function currentFormPhysioId_() {
  return state.session.role === 'physio' ? state.session.physioId : val_('f_physioId');
}
function updateFormSignaturePreview_() {
  const img = el_('formSignaturePreview'), empty = el_('formSignatureEmpty'), caption = el_('formSignatureCaption');
  if (!img) return; // panel not in the DOM yet (very first bootstrap tick)
  const physioId = currentFormPhysioId_();
  const physio = state.physios.find(p => p.physioId === physioId);

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
el_('f_physioId').addEventListener('change', updateFormSignaturePreview_);

function populateStaticDropdowns_() {
  const howKnowSel = el_('f_howKnow');
  howKnowSel.innerHTML = '<option value="">Select...</option>' + state.howKnowOptions.map(o => `<option>${escapeHtml(o)}</option>`).join('');

  const issueSel = el_('f_issueType');
  issueSel.innerHTML = '<option value="">Select issue...</option>' + state.issues.map(i => `<option>${escapeHtml(i.name)}</option>`).join('');

  const physioSel = el_('f_physioId');
  physioSel.innerHTML = '<option value="">Select physiotherapist...</option>' +
    state.physios.filter(p => p.active).map(p => `<option value="${escapeHtml(p.physioId)}">${escapeHtml(p.name)} (${escapeHtml(p.physioId)})</option>`).join('');
  updateFormSignaturePreview_();
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
// 12. BODY DIAGRAMS - interactive pain map (point 5 & 21), drawn on top of
//     the clinic's real reference images. A mark is stored as nothing more
//     than {view, x%, y%, type, color} - never a picture - and redrawn as a
//     small absolutely-positioned dot over the image, at whatever size the
//     image happens to render at. Since dedicated Left/Right images are
//     used, no mirroring math is needed anywhere.
// -------------------------------------------------------------------------
function initBodyDiagrams_() {
  state.form.painMarks = [];
  const wrap = el_('bodyDiagramsWrap');
  wrap.innerHTML = BODY_VIEWS.map(v => `
    <div class="body-view">
      <div class="body-img-holder" data-view="${v.key}">
        <span class="body-img-inner">
          <img src="${v.url}" alt="${v.label}" draggable="false"
               onload="redrawAllMarks_()"
               onerror="this.closest('.body-img-holder').classList.add('img-broken')">
        </span>
      </div>
      <div class="body-view-label">${v.label}</div>
    </div>`).join('') + `
    <div class="body-legend">
      <span><i style="background:#d1352f"></i> Pain Point</span>
      <span><i style="background:#2778b7"></i> Radiating Point</span>
    </div>`;

  wrap.querySelectorAll('.body-img-inner').forEach(inner => {
    inner.addEventListener('click', e => onBodyDiagramClick_(e, inner));
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

function onBodyDiagramClick_(e, inner) {
  // Clicking an existing dot removes it instead of adding a new one.
  const clickedDot = e.target.closest('.body-mark-dot');
  if (clickedDot) {
    const idx = Number(clickedDot.dataset.idx);
    state.form.painMarks.splice(idx, 1);
    redrawAllMarks_();
    return;
  }

  const img = inner.querySelector('img');
  if (!img || !img.complete || !img.naturalWidth) return; // image still loading - nothing reliable to click on yet
  const rect = inner.getBoundingClientRect(); // exactly the rendered image box - inner shrink-wraps to it
  if (!rect.width || !rect.height) return;
  const view = inner.closest('.body-img-holder').dataset.view;
  const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

  state.form.painMarks.push({ view: view, x: Math.round(xPct * 10) / 10, y: Math.round(yPct * 10) / 10, type: state.form.activeMarkType, color: state.form.activeMarkColor });
  redrawAllMarks_();
}

function redrawAllMarks_() {
  document.querySelectorAll('.body-img-inner').forEach(inner => {
    const view = inner.closest('.body-img-holder').dataset.view;
    inner.querySelectorAll('.body-mark-dot').forEach(d => d.remove());
    state.form.painMarks.forEach((m, idx) => {
      if (m.view !== view) return;
      const dot = document.createElement('span');
      dot.className = 'body-mark-dot';
      dot.style.left = m.x + '%';
      dot.style.top = m.y + '%';
      dot.style.background = m.color;
      dot.dataset.idx = idx;
      dot.title = 'Click to remove';
      inner.appendChild(dot);
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
  if (state.session.role !== 'physio' && a.physioId) setVal_('f_physioId', a.physioId); // default the dropdown to whoever it's currently assigned to - admin can still change it
  updateFormSignaturePreview_();
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
  updateFormSignaturePreview_();
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
      showRecordPreview_(full.assessment, 'assessment');
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
// Point 7/8: field NAME color #2778b7, value plain black - falls back to
// those exact spec colors if Settings hasn't been resaved with the new keys.
function fld(label, value) {
  const labelHtml = label ? `<span class="fl-label" style="color:${state.settings.ThemeFieldLabelColor || '#2778b7'}">${escapeHtml(label)}: </span>` : '';
  return `<div class="doc-field">${labelHtml}<span class="fl-value" style="color:${state.settings.ThemeFieldValueColor || '#000000'}">${escapeHtml(value || '-')}</span></div>`;
}
// Class names below (rom-table/special-tests-table/doc-list/etc.) are kept
// IDENTICAL to their Code.gs counterparts (romTableHtml_/specialTestsTableHtml_/
// listHtml_) - point 8's "print/PDF/email must be ditto" requirement, so the
// on-screen preview and the browser Print/Save-as-PDF output (both built from
// this client-side HTML) are structurally the same document as the server PDF
// used for email.
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
    `<span style="color:${state.settings.ThemeFieldLabelColor || '#2778b7'}">${escapeHtml(label)}</span></span>`;
}
// Point 4/7: background-color (not the background shorthand) so a custom
// mark color survives print-color-adjust and prints exactly as saved.
function bodyDiagramsHtmlClient_(painMarksJson) {
  const marks = safeParse_(painMarksJson, []);
  const cells = BODY_VIEWS.map(v => {
    const dots = marks.filter(m => m.view === v.key).map(m =>
      `<span class="doc-mark-dot" style="left:${m.x}%;top:${m.y}%;background-color:${m.color}"></span>`).join('');
    return `<div class="doc-body-view"><span class="doc-body-img-wrap"><img src="${v.url}">${dots}</span>` +
      `<div class="doc-body-view-label">${v.label.toUpperCase()}</div></div>`;
  }).join('');
  return `<div class="doc-body-diagrams">${cells}</div>` +
    `<div class="body-legend"><span><i style="background-color:#d1352f"></i>Pain Point</span><span><i style="background-color:#2778b7"></i>Radiating Point</span></div>`;
}
// Point 7: diagonal gradient header band (ThemeDocHeaderColor -> ...ColorTo),
// clinic-info text hardcoded white, logo unchanged - mirrors docHeaderHtml_
// in Code.gs exactly.
function docHeaderHtmlClient_() {
  const s = state.settings;
  const logo = s.PrintLogoURL || s.LogoURL;
  const headerFrom = s.ThemeDocHeaderColor || '#2778b7';
  const headerTo = s.ThemeDocHeaderColorTo || '#a8d339';
  const nameStyle = `font-weight:${truthyStr_(s.ThemeDocCompanyNameBold) ? 'bold' : 'normal'};font-style:${truthyStr_(s.ThemeDocCompanyNameItalic) ? 'italic' : 'normal'};text-decoration:${truthyStr_(s.ThemeDocCompanyNameUnderline) ? 'underline' : 'none'}`;
  const infoStyle = `font-weight:${truthyStr_(s.ThemeDocCompanyInfoBold) ? 'bold' : 'normal'};font-style:${truthyStr_(s.ThemeDocCompanyInfoItalic) ? 'italic' : 'normal'};text-decoration:${truthyStr_(s.ThemeDocCompanyInfoUnderline) ? 'underline' : 'none'}`;
  return `<div class="doc-header-band" style="background-image:linear-gradient(135deg,${headerFrom} 0%,${headerTo} 100%)">${logo ? `<img class="doc-logo" src="${escapeHtml(logo)}">` : ''}<div class="doc-header-text">` +
    `<div class="doc-company-name" style="color:#FFFFFF;${nameStyle}">${escapeHtml(s.ClinicName)}</div>` +
    `<div class="doc-company-info" style="color:#FFFFFF;${infoStyle}">${escapeHtml(s.Address)}</div>` +
    `<div class="doc-company-info" style="color:#FFFFFF;${infoStyle}">${escapeHtml(s.Phone)}${truthyStr_(s.ShowClinicEmail) && s.ClinicEmail ? ' &nbsp;|&nbsp; ' + escapeHtml(s.ClinicEmail) : ''}${s.Website ? ' &nbsp;|&nbsp; ' + escapeHtml(s.Website) : ''}</div>` +
    `</div></div>`;
}

// Point 5/6/8: single continuous document, ONE header at the top (no
// repeat), fields grouped into same-line rows via .doc-row.cols-N. This is
// the byte-for-byte structural mirror of buildAssessmentHtmlForPdf_ in
// Code.gs - same class names, same section order - used for the on-screen
// preview AND (via #printSnapshot) the browser's own Print/Save-as-PDF.
function buildAssessmentDocHtml_(a) {
  const s = state.settings;
  const headerFrom = s.ThemeDocHeaderColor || '#2778b7';
  const pmh = [checkboxHtmlClient_('DM', truthyStr_(a.pMH_DM)), checkboxHtmlClient_('HTN', truthyStr_(a.pMH_HTN)),
    checkboxHtmlClient_('Thyroid', truthyStr_(a.pMH_Thyroid)), checkboxHtmlClient_('Cardiac', truthyStr_(a.pMH_Cardiac))].join(' &nbsp; ');
  let vasScale = '';
  for (let n = 0; n <= 10; n++) {
    const active = String(n) === String(a.vAS);
    vasScale += `<span class="vas-num${active ? ' vas-active' : ''}">${n}</span>`;
  }
  const signatureImg = a.signatureUrl ? `<img class="sig-img" src="${escapeHtml(a.signatureUrl)}">` : '<div class="sig-line"></div>';

  return `${docHeaderHtmlClient_()}
    <div class="doc-title-bar" style="background-image:linear-gradient(135deg,${headerFrom} 0%,${s.ThemeDocHeaderColorTo || '#a8d339'} 100%)">PHYSIOTHERAPY ASSESSMENT SHEET</div>

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
    <div class="doc-field"><span class="fl-label" style="color:${s.ThemeFieldLabelColor || '#2778b7'}">Pain Assessment (VAS): </span></div>
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
      <div><div class="doc-field"><span class="fl-label" style="color:${s.ThemeFieldLabelColor || '#2778b7'}">Treatment Goals</span></div>${listHtmlClient_(a.treatmentGoalsJson)}</div>
      <div><div class="doc-field"><span class="fl-label" style="color:${s.ThemeFieldLabelColor || '#2778b7'}">Treatment Plan</span></div>${listHtmlClient_(a.treatmentPlanJson)}</div>
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
    <div class="doc-footer-section tagline" style="color:${headerFrom}">Move Better. Live Better.</div>
    </div>`;
}

// Point 2 fix: activates the record-preview view (its own independent
// top-level .view section now, see index.html) directly - it no longer
// needs to route through the New Assessment nav-item/view to be shown, so
// opening a record from Find/Edit no longer jumps the user to New
// Assessment. `returnTo` remembers which view Close should go back to.
function showRecordPreview_(a, returnTo) {
  state.previewReturnView = returnTo || 'assessment';
  const html = buildAssessmentDocHtml_(a);
  el_('docPaper').innerHTML = html;
  el_('printSnapshot').innerHTML = html;

  el_('recordPreviewHeading').textContent = a.patientName ? ('Record - ' + a.patientName) : 'Record';
  el_('recordPreviewSub').textContent = 'Visit ' + (a.visitId || '') + (a.date ? ' \u00B7 ' + a.date : '');

  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  switchToView_('view-record-preview');

  const badge = el_('previewSavedBadge');
  if (a.archived) {
    badge.textContent = '\u{1F5C4}\uFE0F Archived - Read Only' + (a.dbLabel ? ' (' + a.dbLabel + ')' : '');
    badge.className = 'badge badge-archived';
    el_('editRecordBtn').style.display = 'none';
  } else {
    badge.textContent = '\u2713 Saved';
    badge.className = 'badge badge-ok';
    el_('editRecordBtn').style.display = '';
  }
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

// Point 2: "Close" returns to wherever the record was opened from - Find/
// Edit if that's how it was opened, or New Assessment after a fresh save.
el_('closePreviewBtn').addEventListener('click', () => {
  const target = state.previewReturnView || 'assessment';
  const navBtn = document.querySelector('.nav-item[data-view="' + target + '"]');
  if (navBtn) { navBtn.click(); return; }
  switchToView_('view-assessment');
});

el_('editRecordBtn').addEventListener('click', () => {
  if (!state.lastSavedAssessment || state.lastSavedAssessment.archived) return;
  const a = state.lastSavedAssessment;
  state.editingVisitId = a.visitId;
  el_('assessmentHeading').textContent = 'Edit Record - ' + a.visitId;
  el_('resetFormBtn').style.display = '';
  fillFormFromAssessment_(a);
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector('.nav-item[data-view="assessment"]').classList.add('active');
  switchToView_('view-assessment');
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
        ${row.archived ? ' &nbsp;<span class="badge badge-archived" style="font-size:10.5px;">Archived</span>' : ''}
      </div>
      <button class="btn btn-outline btn-sm lookup-open-btn" data-visit="${escapeHtml(row.visitId)}">Open</button>
    </div>`).join('');
  document.querySelectorAll('.lookup-open-btn').forEach(btn => btn.addEventListener('click', () => openLookupRecord_(btn.dataset.visit)));
}
async function openLookupRecord_(visitId) {
  const r = await apiGet('getAssessment', { visitId });
  if (!r.ok) { toast(r.error || 'Could not load record', 'error'); return; }
  state.lastSavedAssessment = r.assessment;
  // Point 2 fix: no longer clicks the "New Assessment" nav button first -
  // showRecordPreview_ now activates its own independent view directly, so
  // "Open" stays in place and shows the record, with a Close button to
  // return to Find/Edit.
  showRecordPreview_(r.assessment, 'lookup');
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
      { key: 'createdAt', label: 'Created At' }, { key: 'dbLabel', label: 'Database' }
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
// 21. DASHBOARD - every KPI card and chart carries its OWN independent
//     Filter By / Filter Value / Date Range (never one global filter for
//     the whole page). The server hands over one flattened per-visit
//     dataset once per "Refresh All"; each widget filters + aggregates its
//     own slice of that same array, instantly and without another
//     round-trip, exactly like the billing app's dashboard cards.
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
Object.keys(DASH_WIDGETS).forEach(k => { state.dashFilters = state.dashFilters || {}; state.dashFilters[k] = { filterBy: '', filterValue: '', dateFrom: '', dateTo: '' }; });
state.dashRaw = state.dashRaw || [];

el_('refreshDashboardBtn').addEventListener('click', loadDashboard);

async function loadDashboard() {
  const r = await apiGet('getDashboardRaw', {});
  if (!r.ok) { toast(r.error || 'Could not load dashboard', 'error'); return; }
  state.dashRaw = r.rows || [];
  renderDashCardFilters_();
  renderAllDashWidgets_();
  el_('addCustomChartBtn').style.display = state.session.role !== 'physio' ? '' : 'none';
  loadCustomCharts_();
}

function dashFilterToolbarHtml_(widgetKey, f, idPrefix) {
  return `
    <div class="dcf-row"><span class="dcf-pill">Filter By</span>
      <select class="dcf-filterby" data-widget="${widgetKey}">
        <option value="">None</option>
        ${DASH_FILTER_DIMENSIONS.map(([k, l]) => `<option value="${k}" ${f.filterBy === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="dcf-row"><span class="dcf-pill">Filter Value</span>
      <select class="dcf-filterval" data-widget="${widgetKey}" ${!f.filterBy ? 'disabled' : ''}>
        <option value="">${f.filterBy ? 'All' : 'Select Filter By first'}</option>
      </select>
    </div>
    <div class="dcf-row"><span class="dcf-pill">Date Range</span>
      <div class="dcf-daterange">
        <input type="date" class="dcf-datefrom" data-widget="${widgetKey}" value="${f.dateFrom}">
        <input type="date" class="dcf-dateto" data-widget="${widgetKey}" value="${f.dateTo}">
      </div>
    </div>`;
}

function renderDashCardFilters_() {
  Object.keys(DASH_WIDGETS).forEach(key => {
    const container = document.querySelector(`[data-widget-filters="${key}"]`);
    if (!container) return;
    container.innerHTML = dashFilterToolbarHtml_(key, state.dashFilters[key]);
    populateDashFilterValueOptions_(key);
  });
  wireDashFilterToolbar_(document.querySelectorAll('.dash-card-filters'), state.dashFilters, key => computeAndRenderWidget_(key));
}

// Shared wiring for both the 5 default widgets AND any custom "visits"
// chart's filter toolbar - `filterState` maps widget/chart id -> its own
// {filterBy, filterValue, dateFrom, dateTo}, `onChange(id)` recomputes.
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
function populateDashFilterValueOptions_(key) { populateDashFilterValueOptionsIn_(document, key, state.dashFilters[key]); }
function populateDashFilterValueOptionsIn_(scope, key, f) {
  const sel = scope.querySelector(`.dcf-filterval[data-widget="${key}"]`);
  if (!sel) return;
  if (!f.filterBy) { sel.innerHTML = '<option value="">Select Filter By first</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const values = Array.from(new Set(state.dashRaw.map(r => r[f.filterBy]))).filter(Boolean).sort();
  sel.innerHTML = '<option value="">All</option>' + values.map(v => `<option value="${escapeHtml(v)}" ${f.filterValue === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

function applyDashFilters_(rows, f) {
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
// 22. CUSTOM DASHBOARD CHARTS - built by Super Admin on top of the 5
//     defaults above. Charts built on "Visits" get the exact same
//     independent Filter By / Filter Value / Date Range toolbar, computed
//     from the same client-side dataset; "Patients" / "Issues" charts are
//     simple running totals with no per-visit date axis to filter by, so
//     they stay as plain number cards fetched from the server.
// -------------------------------------------------------------------------
const CHART_DIM_TO_RAW_KEY = { IssueType: 'issueType', HowKnow: 'howKnow', PhysioName: 'physioName', Sex: 'sex',
  Ambulation: 'ambulation', StairClimbing: 'stairClimbing', ADLs: 'adls', ReferredBy: 'referredBy', Date: 'date' };
const CHART_METRIC_TO_RAW_KEY = { VAS: 'vas', Age: 'age' };
const VISIT_CHART_DIMENSIONS = [
  ['IssueType', 'Issue Type'], ['HowKnow', 'How Known'], ['PhysioName', 'Physiotherapist'], ['Sex', 'Sex'],
  ['Ambulation', 'Ambulation'], ['StairClimbing', 'Stair Climbing'], ['ADLs', 'ADLs'], ['ReferredBy', 'Referred By'], ['Date', 'Date']
];
async function loadCustomCharts_() {
  const r = await apiGet('getCustomCharts', {});
  if (!r.ok) return;
  state.customCharts = r.charts || [];
  state.customChartFilters = state.customChartFilters || {};
  state.customCharts.forEach(c => {
    const id = 'cc_' + c.chartId;
    if (!state.customChartFilters[id]) state.customChartFilters[id] = { filterBy: '', filterValue: '', dateFrom: '', dateTo: '' };
  });
  renderCustomChartsGrid_();
}
function renderCustomChartsGrid_() {
  const grid = el_('customChartsGrid');
  el_('customChartsEmptyHint').style.display = state.customCharts.length ? 'none' : '';
  const isAdmin = state.session.role !== 'physio';
  grid.innerHTML = state.customCharts.map(c => {
    const id = 'cc_' + c.chartId;
    const filterable = c.dataSource === 'visits';
    return `
    <div class="dash-card chart-card wide dash-card-filterable">
      <div class="dash-card-main">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h4>${escapeHtml(c.name)}</h4>
          ${isAdmin ? `<div style="display:flex;gap:6px;">
            <button class="btn btn-outline btn-sm cc-edit" data-id="${c.chartId}">Edit</button>
            <button class="btn btn-danger btn-sm cc-del" data-id="${c.chartId}">Delete</button></div>` : ''}
        </div>
        <div id="${id}"></div>
      </div>
      ${filterable ? `<div class="dash-card-filters cc-filters" data-cc-filters="${id}"></div>` : ''}
    </div>`;
  }).join('');

  state.customCharts.filter(c => c.dataSource === 'visits').forEach(c => {
    const id = 'cc_' + c.chartId;
    const container = document.querySelector(`[data-cc-filters="${id}"]`);
    if (container) { container.innerHTML = dashFilterToolbarHtml_(id, state.customChartFilters[id]); populateDashFilterValueOptionsIn_(container, id, state.customChartFilters[id]); }
  });
  wireDashFilterToolbar_(document.querySelectorAll('.cc-filters'), state.customChartFilters, id => renderOneCustomChart_(state.customCharts.find(c => 'cc_' + c.chartId === id)));

  state.customCharts.forEach(c => renderOneCustomChart_(c));
  document.querySelectorAll('.cc-edit').forEach(btn => btn.addEventListener('click', () => openChartBuilder_(state.customCharts.find(c => String(c.chartId) === btn.dataset.id))));
  document.querySelectorAll('.cc-del').forEach(btn => btn.addEventListener('click', () => deleteCustomChart_(btn.dataset.id)));
}

function renderOneCustomChart_(def) {
  if (!def) return;
  const container = el_('cc_' + def.chartId);
  if (!container) return;

  if (def.dataSource !== 'visits') { loadOneCustomChartDataFromServer_(def, container); return; }

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
  setVal_('pm_signatureUrl', existing ? (existing.signatureUrl || '') : '');
  updatePmSignaturePreview_();
  el_('physioModalStatus').textContent = ''; el_('physioModalStatus').className = 'biller-status';
  el_('physioModal').classList.add('show');
}
function updatePmSignaturePreview_() {
  const url = val_('pm_signatureUrl').trim();
  const img = el_('pm_signaturePreview'), empty = el_('pm_signatureEmpty');
  if (url) { img.src = url; img.style.display = ''; empty.style.display = 'none'; }
  else { img.style.display = 'none'; empty.style.display = ''; }
}
el_('pm_signatureUrl').addEventListener('input', updatePmSignaturePreview_);
el_('pm_cancel').addEventListener('click', () => el_('physioModal').classList.remove('show'));
el_('pm_save').addEventListener('click', async () => {
  const auth = superAdminFromFields_();
  const editId = val_('pm_editId');
  const payload = {
    name: val_('pm_name'), password: val_('pm_password'), signatureUrl: val_('pm_signatureUrl').trim(),
    editPhysioId: editId || undefined, superAdminUser: auth.user, superAdminPass: auth.pass
  };
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
// Every key here matches a Settings row 1:1 (see THEME_SETTING_DEFAULTS in
// Code.gs) - this tab is just a friendlier face on those same rows, split
// into the same sections the billing app uses, each with its own live
// preview that recomputes on every keystroke/click, entirely client-side.
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

function renderThemeGrid_() {
  const s = state.settings;
  THEME_COLOR_FIELDS.forEach(key => { const el = el_('th_' + key); if (el) el.value = s[key] || '#000000'; });
  THEME_STYLE_SELECT_FIELDS.forEach(key => { const el = el_('th_' + key); if (el) el.value = s[key] || el.options[0].value; });
  THEME_CHECKBOX_FIELDS.forEach(key => { const el = el_('th_' + key); if (el) el.checked = truthyStr_(s[key]); });
  THEME_NUMBER_FIELDS.forEach(key => { const el = el_('th_' + key); if (el) el.value = s[key] || ''; });

  const palette = (s.ThemeChartPalette || '').split(',').map(c => c.trim()).filter(Boolean);
  while (palette.length < 12) palette.push('#888888');
  el_('themeChartSwatches').innerHTML = palette.slice(0, 12).map((c, i) =>
    `<input type="color" class="th-chart-swatch" id="th_chart_${i}" value="${c}">`).join('');

  wireThemeLivePreview_();
  updateAllThemePreviews_();
}

function wireThemeLivePreview_() {
  document.querySelectorAll('.th-input, .th-style-select').forEach(el => {
    el.oninput = () => updateAllThemePreviews_();
  });
  document.querySelectorAll('#tab-theme input[type=checkbox]').forEach(el => { el.onchange = () => updateAllThemePreviews_(); });
  document.querySelectorAll('.th-chart-swatch').forEach(el => { el.oninput = () => updateAllThemePreviews_(); });
  document.querySelectorAll('.logo-preset-btn').forEach(btn => {
    btn.onclick = () => { setVal_('th_ThemeDocLogoWidth', btn.dataset.w); setVal_('th_ThemeDocLogoHeight', btn.dataset.h); updateAllThemePreviews_(); };
  });
}

// Reads every field on the Theme tab into one plain object - the single
// source of truth for both "what do the previews show right now" and
// "what gets sent to the server on Save".
function readThemeFormValues_() {
  const v = {};
  THEME_COLOR_FIELDS.forEach(key => { v[key] = val_('th_' + key); });
  THEME_STYLE_SELECT_FIELDS.forEach(key => { v[key] = val_('th_' + key); });
  THEME_CHECKBOX_FIELDS.forEach(key => { v[key] = checked_('th_' + key) ? 'TRUE' : 'FALSE'; });
  THEME_NUMBER_FIELDS.forEach(key => { v[key] = val_('th_' + key); });
  v.ThemeChartPalette = Array.from(document.querySelectorAll('.th-chart-swatch')).map(el => el.value).join(',');
  return v;
}

function updateAllThemePreviews_() {
  const v = readThemeFormValues_();

  // Login
  el_('loginPreview').querySelector('.tp-login-bg').style.background = gradientCss_(v.ThemeLoginBgStyle, v.ThemeLoginBgFrom, v.ThemeLoginBgTo);
  const loginCard = el_('loginPreview').querySelector('.tp-login-card');
  loginCard.style.background = v.ThemeLoginCardBg;
  loginCard.querySelector('.tp-login-name').style.color = v.ThemeLoginHeadingColor;
  loginCard.querySelector('.tp-login-sub').style.color = v.ThemeLoginTextColor;

  // Sidebar
  const sb = el_('sidebarPreview').querySelector('.tp-sidebar');
  sb.style.background = gradientCss_(v.ThemeSidebarStyle, v.ThemeSidebarFrom, v.ThemeSidebarTo);
  sb.querySelectorAll('.tp-sidebar-item').forEach(item => { item.style.color = v.ThemeSidebarText; });
  const activeItem = sb.querySelector('.tp-active');
  activeItem.style.background = v.ThemeNavActiveBg; activeItem.style.color = v.ThemeNavActiveText;

  // Buttons
  const bp = el_('buttonPreview');
  const fillNormal = bp.querySelectorAll('.tp-btn-fill')[0], fillHover = bp.querySelectorAll('.tp-btn-fill')[1];
  fillNormal.style.background = gradientCss_(v.ThemeButtonStyle, v.ThemeButtonFrom, v.ThemeButtonTo); fillNormal.style.color = v.ThemeButtonText;
  fillHover.style.background = gradientCss_(v.ThemeButtonStyle, v.ThemeButtonHoverFrom, v.ThemeButtonHoverTo); fillHover.style.color = v.ThemeButtonText;
  const outNormal = bp.querySelectorAll('.tp-btn-outline')[0], outHover = bp.querySelectorAll('.tp-btn-outline')[1];
  outNormal.style.color = v.ThemeOutlineText; outNormal.style.borderColor = v.ThemeOutlineBorder || v.ThemeOutlineText;
  outHover.style.background = v.ThemeOutlineHoverBg; outHover.style.color = v.ThemeOutlineHoverText; outHover.style.borderColor = v.ThemeOutlineBorder || v.ThemeOutlineText;

  // Headings
  const hp = el_('headingPreview');
  hp.querySelector('.tp-page-heading').style.color = v.ThemePageHeadingColor;
  hp.querySelector('.tp-page-sub').style.color = v.ThemePageSubheadingColor;
  hp.querySelector('.tp-section-heading').style.color = v.ThemeSectionHeadingColor;

  // Tabs
  const tp = el_('tabsPreview');
  tp.querySelectorAll('.tp-tab').forEach(t => { t.style.color = v.ThemeTabInactiveTextColor; });
  const activeTab = tp.querySelector('.tp-tab-active');
  activeTab.style.color = v.ThemeTabActiveTextColor;
  activeTab.style.borderImage = `${gradientCss_(v.ThemeTabIndicatorStyle, v.ThemeTabIndicatorFrom, v.ThemeTabIndicatorTo)} 1`;
  activeTab.style.borderBottomColor = v.ThemeTabIndicatorTo;

  // Gate / authorization box
  const gp = el_('gatePreview').querySelector('.tp-gate');
  gp.style.background = v.ThemeGateBgColor; gp.style.borderColor = v.ThemeGateBorderColor; gp.style.color = v.ThemeGateTitleColor;

  // Assessment sheet design
  const dp = el_('docPreview');
  dp.style.fontFamily = v.ThemeDocFontFamily;
  dp.querySelector('.tp-doc-header').style.borderBottomColor = v.ThemeDocHeaderColor;
  dp.querySelector('.tp-doc-name').style.color = v.ThemeDocHeaderColor;
  dp.querySelector('.tp-doc-id').style.color = v.ThemeDocHeaderColor;
  dp.querySelector('.tp-doc-name').style.fontWeight = truthyStr_(v.ThemeDocCompanyNameBold) ? '800' : '400';
  dp.querySelector('.tp-doc-name').style.fontStyle = truthyStr_(v.ThemeDocCompanyNameItalic) ? 'italic' : 'normal';
  dp.querySelector('.tp-doc-name').style.textDecoration = truthyStr_(v.ThemeDocCompanyNameUnderline) ? 'underline' : 'none';
  dp.querySelector('.tp-doc-info').style.fontWeight = truthyStr_(v.ThemeDocCompanyInfoBold) ? '700' : '400';
  dp.querySelector('.tp-doc-info').style.fontStyle = truthyStr_(v.ThemeDocCompanyInfoItalic) ? 'italic' : 'normal';
  dp.querySelector('.tp-doc-info').style.textDecoration = truthyStr_(v.ThemeDocCompanyInfoUnderline) ? 'underline' : 'none';
  const docHeaderEl = dp.querySelector('.tp-doc-header');
  docHeaderEl.style.flexDirection = v.ThemeDocHeaderLayout === 'logo-top' ? 'column' : 'row';
  docHeaderEl.style.alignItems = v.ThemeDocHeaderLayout === 'logo-top' ? 'flex-start' : 'center';
  dp.querySelector('.tp-doc-band').style.background = v.ThemeSectionBandColor;
  dp.querySelector('.tp-doc-fl').style.color = v.ThemeFieldLabelColor;
  dp.querySelector('.tp-doc-fv').style.color = v.ThemeFieldValueColor;
  const logoW = Math.max(20, Math.min(70, Number(v.ThemeDocLogoWidth) || 40));
  const logoH = Math.max(20, Math.min(70, Number(v.ThemeDocLogoHeight) || 40));
  const docLogo = dp.querySelector('.tp-doc-logo'); docLogo.style.width = logoW + 'px'; docLogo.style.height = logoH + 'px';

  // Text & backgrounds
  const txp = el_('textPreview');
  txp.querySelector('.tp-text-outer').style.background = v.ThemeBgColor;
  const txCard = txp.querySelector('.tp-text-card');
  txCard.style.background = v.ThemeSurfaceColor; txCard.style.border = '1px solid ' + v.ThemeBorderColor;
  txCard.querySelector('.tp-text-heading').style.color = v.ThemeHeadingColor;
  txCard.querySelector('.tp-text-muted').style.color = v.ThemeMutedColor;

  // Chart palette
  const palette = v.ThemeChartPalette.split(',').map(c => c.trim()).filter(Boolean);
  const heights = [62, 38, 50, 28, 44, 20, 56, 32, 46, 24, 40, 30];
  el_('tpChartBars').innerHTML = palette.map((c, i) => `<span style="height:${heights[i % heights.length]}px;background:${c}"></span>`).join('');
  el_('tpNumberCards').innerHTML = palette.slice(0, 4).map(c => `<span style="background:${c}">128</span>`).join('');
}

el_('saveThemeBtn').addEventListener('click', async () => {
  const auth = superAdminFromFields_();
  const payload = Object.assign({ superAdminUser: auth.user, superAdminPass: auth.pass }, readThemeFormValues_());
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

// ---- Database(s) Status - "Add New Database", capacity bars, archives ----
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
  const cards = [dbCardHtml_(r.active, true)].concat(r.archives.map(a => dbCardHtml_(a, false)));
  el_('dataStatusResult').innerHTML = `<div class="ds-db-list">${cards.join('')}</div>`;
}
el_('checkDataStatusBtn').addEventListener('click', loadDbStatus_);

el_('addNewDatabaseBtn').addEventListener('click', async () => {
  const auth = superAdminFromFields_();
  if (!auth.user || !auth.pass) { toast('Enter Super Admin credentials above first', 'error'); return; }
  if (!confirm('This creates a brand-new spreadsheet, copies your clinic settings, physiotherapist accounts, ' +
    'issues list and patients into it, and switches every new assessment there from now on. The current database ' +
    'is kept exactly as-is (nothing is deleted) and stays readable from Find/Edit, Reports and the Dashboard as ' +
    'archived history. Continue?')) return;
  const btn = el_('addNewDatabaseBtn');
  btn.disabled = true; btn.textContent = 'Creating new database...';
  try {
    const r = await apiPost('autoExpandDatabase', { superAdminUser: auth.user, superAdminPass: auth.pass });
    const resultBox = el_('dbExpandResult');
    if (!r.ok) {
      resultBox.style.display = ''; resultBox.innerHTML = `<b style="color:var(--danger)">Could not create a new database:</b> ${escapeHtml(r.error || 'Unknown error')}`;
      toast(r.error || 'Could not create new database', 'error');
      return;
    }
    resultBox.style.display = '';
    resultBox.innerHTML = `<b>New database created and is now active:</b> ${escapeHtml(r.newSpreadsheetName)}<br>` +
      `<a href="${escapeHtml(r.newSpreadsheetUrl)}" target="_blank" rel="noopener">Open the new spreadsheet &#8599;</a><br>` +
      `The previous database is now archived ("${escapeHtml(r.archivedLabel)}") and still fully readable from Find/Edit, Reports and the Dashboard.`;
    toast('New database created and switched to', 'success');
    await loadDbStatus_();
  } finally {
    btn.disabled = false; btn.textContent = '\u2795 Add New Database Now';
  }
});

el_('resetToActiveOnlyBtn').addEventListener('click', async () => {
  const auth = superAdminFromFields_();
  if (!auth.user || !auth.pass) { toast('Enter Super Admin credentials above first', 'error'); return; }
  if (!confirm('This forgets every archived database link (they are NOT deleted - just unlinked from this app) ' +
    'and re-bases Visit ID / Issue ID numbering on only what is actually in the active spreadsheet right now. ' +
    'Use this only to fix numbering after manually editing the sheet, or to undo a test "Add New Database". Continue?')) return;
  const r = await apiPost('resetToActiveOnly', { superAdminUser: auth.user, superAdminPass: auth.pass });
  if (!r.ok) { toast(r.error || 'Could not reset', 'error'); return; }
  toast('Numbering reset. Next Visit ID will be ' + r.nextVisitId, 'success');
  await loadDbStatus_();
});

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
    updateFormSignaturePreview_();
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
