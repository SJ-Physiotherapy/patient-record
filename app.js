/* =========================================================================
   SJ PHYSIOTHERAPY - BILLING SYSTEM
   Frontend logic (vanilla JS only - no third-party scripts)
   ========================================================================= */

// -------------------------------------------------------------------------
// 0. CONFIG - paste your Apps Script Web App URL here after deployment.
//    Guide: SETUP_GUIDE.md, Step 4.
// -------------------------------------------------------------------------
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwUofsGxBICKgnvmt7MSN5oFcXnjhCfjWXDOHdlSQM6pxZ8FrewULzR-dmpmMM6t_Vg/exec'
};

// Bump this whenever you redeploy app.js - printed on load so you can
// confirm in the browser console (F12) that the page is actually running
// the file you think it's running, not a cached older copy.
const FRONTEND_BUILD = 'SJP-2026-10-10-35-FAMILY';
const EXPECTED_BACKEND_BUILD = 'SJP-2026-10-10-01-FAMILY'; // must match BACKEND_BUILD in Code.gs
console.log('SJP billing app.js build', FRONTEND_BUILD);

// Shows a impossible-to-miss banner at the top of the app the moment we can
// prove the live Apps Script deployment is NOT running the latest Code.gs -
// this is the #1 cause of "I fixed the code but nothing changed" for Apps
// Script Web Apps, because saving the script file does NOT update the live
// /exec URL. Only a NEW deployment does that.
function checkBackendBuild_(serverBuild) {
  const bar = document.getElementById('staleBackendBar');
  if (!bar) return;
  if (serverBuild && serverBuild === EXPECTED_BACKEND_BUILD) {
    bar.classList.remove('show');
    bar.innerHTML = '';
    return;
  }

  // The live Apps Script deployment is running an OLDER Code.gs than this
  // website expects. This is the #1 cause of "I fixed/changed something but
  // it's not showing up" - saving the script file does NOT update the live
  // /exec URL your website calls; only Deploy -> Manage deployments -> New
  // version -> Deploy does that. Surface it loudly rather than let a stale
  // backend silently produce confusing, seemingly-random bugs.
  bar.innerHTML =
    '&#9888;&#65039; This website\'s backend (Apps Script) is running an OLDER version than expected ' +
    '(server says: <code>' + escapeHtml(serverBuild || 'unknown') + '</code>, expected <code>' + escapeHtml(EXPECTED_BACKEND_BUILD) + '</code>). ' +
    'Some fixes/features may not actually be live yet. In Apps Script: Deploy &rarr; Manage deployments &rarr; edit the deployment your site uses &rarr; ' +
    '"New version" &rarr; Deploy. Saving the file alone is not enough.';
  bar.classList.add('show');
}

// -------------------------------------------------------------------------
// 1. STATE
// -------------------------------------------------------------------------
const state = {
  settings: {},
  products: [],
  billers: [],
  customers: [],
  bootstrapped: false,
  currentQrId: null,
  qrPollTimer: null,
  lastSavedBill: null,
  customCharts: [],
  themeChartPalette: ['#E1341E', '#a8d339', '#AE2314', '#F2A65A', '#8C2F39', '#4B5A57', '#2E86AB', '#6C4FB6', '#1F9E78', '#D4A017', '#7A5C61', '#3D5A80'],
  session: { role: null, billerId: '', billerName: '', billerPassword: '', canAccessTax: false, canAccessBank: false, canAccessFindEdit: false, canAccessStockView: false, canAccessStockEdit: false, canAccessReportDownload: false, canAccessLetterpad: false }
};

// -------------------------------------------------------------------------
// 2. API HELPER  (text/plain POST avoids CORS preflight on Apps Script)
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

// All the sessionStorage keys a login/logout ever needs to touch. Kept as
// one shared list so login-clearing and logout-clearing can never drift
// out of sync with each other.
const SESSION_STORAGE_KEYS = [
  'SJP_user', 'SJP_displayName', 'SJP_role', 'SJP_token',
  'SJP_billerId', 'SJP_billerName', 'SJP_billerPass',
  'SJP_canAccessTax', 'SJP_canAccessBank', 'SJP_canAccessFindEdit',
  'SJP_canAccessStockView', 'SJP_canAccessStockEdit', 'SJP_canAccessReportDownload',
  'SJP_canAccessDiscount', 'SJP_canAccessDashboard', 'SJP_canAccessLetterpad'
];

// The server marks any auth failure caused by a missing/expired session
// token with sessionExpired:true (see requireSession_ in Code.gs). When
// that happens mid-use (e.g. the person stepped away for a few hours),
// silently clear the stale session and bounce back to the same login
// screen that's already in the app - no new UI, no confusing error toast.
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
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// =========================================================================
// 3b. INPUT RULES
//
// One place that decides what every field in the app may contain. Mirrors
// section "1c. INPUT RULES" in Code.gs exactly - the browser stops bad input
// as it's typed/pasted (instant feedback), the server re-checks every save
// (the guarantee, since a browser can always be bypassed).
//
// Three layers, all driven by INPUT_RULES below:
//   1. While typing/pasting - disallowed characters simply never appear
//      (letters in a phone number, digits in a name, "e" or "-" in a price).
//   2. On leaving a field - spaces tidied, numbers clamped into range.
//   3. On Save - full check with a clear message right under the field.
//
// Nothing here rewrites stored data. Older values are only ever tidied when
// a person opens and saves that exact record again.
// =========================================================================
const VR = {
  PERSON_NAME: /^[\p{L}\p{M}][\p{L}\p{M} .'\-]*$/u,
  PRODUCT_NAME: /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ()\-\/.,&+'%#:]*$/u,
  ADDRESS: /^[\p{L}\p{M}\p{N} \n,.\-\/#():'&]*$/u,
  ORG_NAME: /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,&'()\-]*$/u,
  EMAIL: /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/,
  GSTIN: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  IFSC: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  ACCOUNT_NO: /^\d{9,18}$/,
  WEBSITE: /^(https?:\/\/)?[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+(\/[^\s<>"']*)?$/,
  URL: /^https?:\/\/[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+(:\d+)?(\/[^\s<>"']*)?$/,
  ADMIN_USER: /^[\p{L}\p{N}][\p{L}\p{N} ._\-@]*$/u
};
const VLIMIT = {
  MONEY_MAX: 10000000, QTY_MAX: 9999, STOCK_MAX: 999999, THRESHOLD_MAX: 99999,
  ITEMS_MAX: 100, ADDRESS_MAX: 250, NOTE_MAX: 200
};

// ---- Validators (same names, same behaviour as Code.gs) -----------------
function vRes_(value, error) { return { value: value, error: error || '' }; }
function vText_(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‍﻿]/g, '');
}
function vLine_(v) { return vText_(v).replace(/\s+/g, ' ').trim(); }
function vMulti_(v) {
  return vText_(v).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// "+91 98765 43210", "919876543210" and "09876543210" all mean 9876543210.
function normalizeMobile_(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
  else if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
  return d;
}
function normalizeShopPhone_(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
  return d;
}
function vMobile_(raw, label, required) {
  if (!String(raw == null ? '' : raw).trim()) return vRes_('', required ? label + ' is required.' : '');
  const d = normalizeMobile_(raw);
  if (!/^[6-9]\d{9}$/.test(d)) return vRes_(d, label + ' must be a 10-digit mobile number starting with 6, 7, 8 or 9.');
  return vRes_(d);
}
function vShopPhone_(raw, label) {
  if (!String(raw == null ? '' : raw).trim()) return vRes_('');
  const d = normalizeShopPhone_(raw);
  if (!/^(\d{10}|0\d{10})$/.test(d)) return vRes_(d, label + ' must be 10 digits (or 11 for a landline starting with 0).');
  return vRes_(d);
}
function vPersonName_(raw, label, required) {
  const v = vLine_(raw);
  if (!v) return vRes_(v, required ? label + ' is required.' : '');
  if (v.length < 2 || v.length > 60) return vRes_(v, label + ' must be 2 to 60 characters.');
  if (!VR.PERSON_NAME.test(v)) return vRes_(v, label + ' can only contain letters, spaces, dot (.), apostrophe (\') and hyphen (-).');
  return vRes_(v);
}
function vEmail_(raw, label, required) {
  const v = vLine_(raw).replace(/\s/g, '');
  if (!v) return vRes_(v, required ? label + ' is required.' : '');
  if (v.length > 100 || v.indexOf('..') !== -1 || !VR.EMAIL.test(v)) return vRes_(v, label + ' is not a valid email address (e.g. name@example.com).');
  return vRes_(v);
}
function vAddress_(raw, label) {
  const v = vMulti_(raw);
  if (!v) return vRes_(v);
  if (v.length > VLIMIT.ADDRESS_MAX) return vRes_(v, label + ' must be at most ' + VLIMIT.ADDRESS_MAX + ' characters.');
  if (!VR.ADDRESS.test(v)) return vRes_(v, label + ' can only contain letters, numbers, spaces and , . - / # ( ) : \' &');
  if (!/[\p{L}\p{N}]/u.test(v)) return vRes_(v, label + ' must contain letters or numbers.');
  return vRes_(v);
}
function vProductName_(raw, label) {
  const v = vLine_(raw);
  if (!v) return vRes_(v, label + ' is required.');
  if (v.length < 2 || v.length > 80) return vRes_(v, label + ' must be 2 to 80 characters.');
  if (!VR.PRODUCT_NAME.test(v)) return vRes_(v, label + ' must start with a letter or number and can only use letters, numbers, spaces and ( ) - / . , & + \' % # :');
  return vRes_(v);
}
function vFreeText_(raw, label, maxLen, required, minLen) {
  const v = vLine_(raw).replace(/[<>]/g, '');
  if (!v) return vRes_(v, required ? label + ' is required.' : '');
  if (minLen && v.length < minLen) return vRes_(v, label + ' must be at least ' + minLen + ' characters.');
  if (v.length > maxLen) return vRes_(v, label + ' must be at most ' + maxLen + ' characters.');
  return vRes_(v);
}
function vPattern_(raw, label, re, maxLen, hint, transform) {
  let v = vLine_(raw);
  if (transform) v = transform(v);
  if (!v) return vRes_(v);
  if (v.length > maxLen || !re.test(v)) return vRes_(v, label + ' ' + hint);
  return vRes_(v);
}
function vUrl_(raw, label) {
  let v = vLine_(raw).replace(/\s/g, '');
  if (!v) return vRes_(v);
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  if (v.length > 300 || !VR.URL.test(v)) return vRes_(v, label + ' is not a valid link (e.g. https://example.com/page).');
  return vRes_(v);
}
function vNumber_(raw, label, opts) {
  opts = opts || {};
  const min = opts.min != null ? opts.min : 0;
  const max = opts.max != null ? opts.max : VLIMIT.MONEY_MAX;
  if (raw === '' || raw == null) {
    if (opts.required) return vRes_(null, label + ' is required.');
    return vRes_(opts.blank !== undefined ? opts.blank : 0);
  }
  const s = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s) && typeof raw !== 'number') return vRes_(null, label + ' must be a number.');
  const n = Number(raw);
  if (!isFinite(n)) return vRes_(null, label + ' must be a number.');
  if (opts.integer && Math.floor(n) !== n) return vRes_(null, label + ' must be a whole number.');
  if (n < min) return vRes_(null, label + ' cannot be less than ' + min + '.');
  if (n > max) return vRes_(null, label + ' cannot be more than ' + max + '.');
  return vRes_(opts.integer ? n : Math.round(n * 100) / 100);
}
function vMoney_(raw, label, required) { return vNumber_(raw, label, { min: 0, max: VLIMIT.MONEY_MAX, required: required }); }
function vPercent_(raw, label) { return vNumber_(raw, label, { min: 0, max: 100 }); }
function vInt_(raw, label, min, max, required, blank) {
  return vNumber_(raw, label, { min: min, max: max, integer: true, required: required, blank: blank });
}
function vPassword_(raw, label, minLen, required) {
  const v = String(raw == null ? '' : raw);
  if (!v) return vRes_(v, required ? label + ' is required.' : '');
  if (/\s/.test(v)) return vRes_(v, label + ' cannot contain spaces.');
  if (v.length < minLen || v.length > 30) return vRes_(v, label + ' must be ' + minLen + ' to 30 characters.');
  return vRes_(v);
}
function vDate_(raw, label) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return vRes_(v, label + ' is required.');
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  if (!d || d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return vRes_(v, label + ' must be a valid date.');
  }
  if (v < '2000-01-01') return vRes_(v, label + ' is too far in the past.');
  if (v > todayLocalStr_()) return vRes_(v, label + ' cannot be in the future.');
  return vRes_(v);
}
// "12", "sjp12", "SJP-12" -> "SJP-000012", so a Bill ID can be found however it's typed.
function normalizeBillId_(raw) {
  const v = String(raw == null ? '' : raw).toUpperCase().replace(/\s/g, '');
  const m = v.match(/^(?:SJP-?)?(\d{1,9})$/);
  return m ? 'SJP-' + String(Number(m[1])).padStart(6, '0') : v;
}
// WhatsApp needs the country code - a bare 10-digit Indian number gets 91.
function waNumber_(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length === 10 ? '91' + d : d;
}

// ---- Typing filters: what each kind of field lets through as you type ----
const TYPE_FILTERS_ = {
  mobile: v => { let d = v.replace(/\D/g, ''); if (d.length > 10) d = normalizeMobile_(d).slice(0, 10); return d; },
  shopPhone: v => normalizeShopPhone_(v).slice(0, 11),
  whatsappIntl: v => v.replace(/\D/g, '').slice(0, 15),
  digits: v => v.replace(/\D/g, ''),
  personName: v => v.replace(/[^\p{L}\p{M} .'\-]/gu, '').replace(/^[ .'\-]+/u, '').replace(/ {2,}/g, ' '),
  productName: v => v.replace(/[^\p{L}\p{M}\p{N} ()\-\/.,&+'%#:]/gu, '').replace(/^[^\p{L}\p{M}\p{N}]+/u, '').replace(/ {2,}/g, ' '),
  orgName: v => v.replace(/[^\p{L}\p{M}\p{N} .,&'()\-]/gu, '').replace(/^[^\p{L}\p{M}\p{N}]+/u, '').replace(/ {2,}/g, ' '),
  address: v => v.replace(/[^\p{L}\p{M}\p{N} \n,.\-\/#():'&]/gu, '').replace(/[ \t]{2,}/g, ' '),
  email: v => v.replace(/[^A-Za-z0-9._%+\-@]/g, ''),
  noSpace: v => v.replace(/\s/g, ''),
  upperAlnum: v => v.toUpperCase().replace(/[^A-Z0-9]/g, ''),
  billId: v => v.toUpperCase().replace(/[^A-Z0-9\-]/g, ''),
  adminUser: v => v.replace(/[^\p{L}\p{N} ._\-@]/gu, '').replace(/^[^\p{L}\p{N}]+/u, ''),
  freeText: v => v.replace(/[<>]/g, '')
};
const DIGIT_FILTERS_ = ['mobile', 'shopPhone', 'whatsappIntl', 'digits'];

// selector -> rule. `filter` = typing filter above, `max` = max length,
// `num` = numeric field { decimals, min, max }, plus keyboard hints for phones.
const INPUT_RULES = [
  // Patient (Create Bill + Find/Edit)
  ['#f_customerName, #edit_customerName', { filter: 'personName', max: 60, autocomplete: 'off' }],
  ['#f_phone, #edit_phone', { filter: 'mobile', inputmode: 'numeric', autocomplete: 'off' }],
  ['#f_email, #edit_email, #share_email, #s_companyEmail', { filter: 'email', max: 100, inputmode: 'email' }],
  ['#f_address, #f_deliveryAddress, #edit_address, #edit_deliveryAddress, #s_address', { filter: 'address', max: VLIMIT.ADDRESS_MAX, multiline: true }],
  ['#edit_note', { filter: 'freeText', max: VLIMIT.NOTE_MAX }],
  // Line items
  ['.row-product-input, .erow-name, #np_name, .pt-name', { filter: 'productName', max: 80 }],
  ['.row-price, .erow-price, #np_price, .pt-price', { num: { decimals: 2, min: 0, max: VLIMIT.MONEY_MAX } }],
  ['.row-qty, .erow-qty', { num: { decimals: 0, min: 1, max: VLIMIT.QTY_MAX } }],
  ['.row-discount, .erow-discount, #f_totalDiscountPct, #edit_totalDiscountPct, #s_cgst, #s_sgst', { num: { decimals: 2, min: 0, max: 100 } }],
  // Inventory
  ['#np_stock, .inv-stock-input', { num: { decimals: 0, min: 0, max: VLIMIT.STOCK_MAX } }],
  ['.inv-threshold-input', { num: { decimals: 0, min: 0, max: VLIMIT.THRESHOLD_MAX } }],
  // Sharing / lookup
  ['#share_phone', { filter: 'whatsappIntl', inputmode: 'numeric' }],
  ['#lookupBillId', { filter: 'billId', max: 20, autocomplete: 'off' }],
  // Admin - billers & login
  ['#bm_name', { filter: 'personName', max: 60 }],
  ['#bm_password, #acc_newPass, #acc_confirmPass', { filter: 'noSpace', max: 30 }],
  ['#acc_newUser', { filter: 'adminUser', max: 40 }],
  ['#loginUser, #loginPass, #admin_su_user, #admin_su_pass, #inv_su_user, #inv_su_pass, #edit_su_user, #edit_su_pass', { max: 60 }],
  // Admin - shop / invoice settings
  ['#s_companyName', { filter: 'freeText', max: 80 }],
  ['#s_phone', { filter: 'shopPhone', inputmode: 'numeric' }],
  ['#s_socialWhatsapp', { filter: 'mobile', inputmode: 'numeric' }],
  ['#s_website', { filter: 'noSpace', max: 100, inputmode: 'url' }],
  ['#s_logo, #s_printLogo, #s_socialInstagram, #s_socialFacebook, #s_socialLinkedin, #s_socialYoutube', { filter: 'noSpace', max: 300, inputmode: 'url' }],
  ['#s_gst', { filter: 'upperAlnum', max: 15 }],
  ['#s_bankIFSC', { filter: 'upperAlnum', max: 11 }],
  ['#s_bankAccountNo', { filter: 'digits', max: 18, inputmode: 'numeric' }],
  ['#s_bankName', { filter: 'orgName', max: 60 }],
  ['#s_bankAccountHolder', { filter: 'orgName', max: 80 }],
  ['#s_signatoryLabel', { filter: 'freeText', max: 40 }],
  // Dashboard chart builder / theme
  ['#cb_name', { filter: 'freeText', max: 60 }],
  ['#cb_topN', { num: { decimals: 0, min: 0, max: 100 } }],
  ['#theme_billLogoWidth, #theme_billLogoHeight', { num: { decimals: 0, min: 20, max: 400 } }]
];

function ruleFor_(el) {
  if (!el || !el.matches) return null;
  for (let i = 0; i < INPUT_RULES.length; i++) {
    if (el.matches(INPUT_RULES[i][0])) return INPUT_RULES[i][1];
  }
  return null;
}

// Adds keyboard hints (numeric keypad on phones, length caps) to every
// matching field under `root`. Called once at load and again whenever rows
// are drawn on the fly (bill lines, Find/Edit form, inventory, products).
// Phone fields deliberately get NO maxlength attribute: the browser would
// chop a pasted "+91 98765 43210" to "+91 98765 " BEFORE the filter could
// turn it into the right 10 digits.
function decorateInputs_(root) {
  (root || document).querySelectorAll('input, textarea').forEach(el => {
    const rule = ruleFor_(el);
    if (!rule || el.dataset.ruled) return;
    el.dataset.ruled = '1';
    if (rule.inputmode) el.setAttribute('inputmode', rule.inputmode);
    if (rule.autocomplete) el.setAttribute('autocomplete', rule.autocomplete);
    if (rule.max && !(rule.filter && DIGIT_FILTERS_.indexOf(rule.filter) !== -1 && rule.filter !== 'digits')) el.setAttribute('maxlength', rule.max);
    if (rule.num) {
      el.setAttribute('min', rule.num.min);
      el.setAttribute('max', rule.num.max);
      el.setAttribute('step', rule.num.decimals ? '0.01' : '1');
      el.setAttribute('inputmode', rule.num.decimals ? 'decimal' : 'numeric');
    }
  });
}

// Layer 1a - block keys that can never be valid, before they appear.
document.addEventListener('keydown', e => {
  const rule = ruleFor_(e.target);
  if (!rule || e.ctrlKey || e.metaKey || e.altKey || !e.key || e.key.length !== 1) return;
  if (rule.num) {
    if (/[eE+\-]/.test(e.key) || (!rule.num.decimals && /[.,]/.test(e.key))) e.preventDefault();
  } else if (rule.filter && DIGIT_FILTERS_.indexOf(rule.filter) !== -1 && !/\d/.test(e.key)) {
    e.preventDefault();
  }
}, true);

// Mobile keyboards often skip keydown, so the same block runs on beforeinput.
document.addEventListener('beforeinput', e => {
  const rule = ruleFor_(e.target);
  if (!rule || !rule.num || typeof e.data !== 'string') return;
  if (/[eE+\-]/.test(e.data) || (!rule.num.decimals && /[.,]/.test(e.data))) e.preventDefault();
}, true);

// Layer 1b - filter whatever got through (paste, autofill, drag-drop).
// Registered in the CAPTURE phase so it runs BEFORE each field's own input
// listeners - totals, preview and stock badges always see the clean value.
document.addEventListener('input', e => {
  const el = e.target;
  clearFieldError_(el); // any edit clears that field's error message
  const rule = ruleFor_(el);
  if (!rule) return;
  if (rule.filter) {
    const before = el.value;
    const filter = TYPE_FILTERS_[rule.filter];
    let after = filter(before);
    if (rule.max && after.length > rule.max) after = after.slice(0, rule.max);
    if (after !== before) {
      // Keep the caret where the person was typing, not at the end.
      let caret = null;
      try { caret = el.selectionStart; } catch (err) { caret = null; }
      el.value = after;
      if (caret != null) {
        const pos = Math.min(filter(before.slice(0, caret)).length, after.length);
        try { el.setSelectionRange(pos, pos); } catch (err) { /* not a text field */ }
      }
    }
  } else if (rule.num && el.value !== '') {
    // An in-progress value ("12.") reads as '' on a number field and is left
    // alone; only complete numbers are corrected.
    const n = Number(el.value);
    if (!isFinite(n)) return;
    let fixed = el.value;
    if (n > rule.num.max) fixed = String(rule.num.max);
    else if (n < 0) fixed = String(Math.abs(n));
    else if (rule.num.decimals === 0 && /\./.test(fixed)) fixed = String(Math.trunc(n));
    else if (rule.num.decimals) fixed = fixed.replace(new RegExp('(\\.\\d{' + rule.num.decimals + '})\\d+$'), '$1');
    if (fixed !== el.value) el.value = fixed;
  }
}, true);

// Date pickers and dropdowns report changes via "change", not "input".
document.addEventListener('change', e => clearFieldError_(e.target), true);

// Layer 2 - tidy up when leaving a field (spaces, out-of-range numbers).
document.addEventListener('focusout', e => {
  const el = e.target;
  const rule = ruleFor_(el);
  if (!rule) return;
  const before = el.value;
  let after = before;
  if (rule.num) {
    if (before !== '' && isFinite(Number(before))) {
      const n = Number(before);
      if (n < rule.num.min) after = String(rule.num.min);
      else if (n > rule.num.max) after = String(rule.num.max);
    }
  } else if (rule.filter && rule.filter !== 'noSpace' && DIGIT_FILTERS_.indexOf(rule.filter) === -1) {
    after = rule.multiline ? vMulti_(before) : vLine_(before);
  }
  if (after !== before) {
    el.value = after;
    el.dispatchEvent(new Event('input', { bubbles: true })); // let totals / preview refresh
  }
}, true);

// ---- Inline errors (Layer 3) --------------------------------------------
// Uses the field's existing ".field-error" line if it has one, otherwise
// adds one under the field. Inputs that aren't inside a .field (bill line
// cells, inventory cells) get a red outline and the message as a tooltip.
function setFieldError_(el, msg) {
  if (!el) return;
  const field = el.closest('.field');
  if (field) {
    let err = field.querySelector(':scope > .field-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'field-error';
      err.dataset.dynamic = '1';
      field.appendChild(err);
    }
    err.textContent = msg;
    field.classList.add('has-error');
  }
  el.classList.add('input-invalid');
  el.setAttribute('aria-invalid', 'true');
  el.title = msg;
}
function clearFieldError_(el) {
  if (!el || !el.classList || !el.classList.contains('input-invalid')) {
    const field0 = el && el.closest ? el.closest('.field.has-error') : null;
    if (field0) field0.classList.remove('has-error');
    return;
  }
  el.classList.remove('input-invalid');
  el.removeAttribute('aria-invalid');
  el.title = '';
  const field = el.closest('.field');
  if (field) field.classList.remove('has-error');
}
function clearErrorsIn_(root) {
  (root || document).querySelectorAll('.input-invalid').forEach(clearFieldError_);
  (root || document).querySelectorAll('.field.has-error').forEach(f => f.classList.remove('has-error'));
}
// Runs a list of [elementOrId, result] checks; marks EVERY failing field (so
// the person sees all problems at once), focuses the first, and returns
// { ok, values, firstError }.
function applyChecks_(checks) {
  const values = {};
  let firstEl = null, firstError = '';
  checks.forEach(([target, res, key]) => {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (res.error) {
      setFieldError_(el, res.error);
      if (!firstEl) { firstEl = el; firstError = res.error; }
    } else if (key) {
      values[key] = res.value;
    }
  });
  if (firstEl) {
    try { firstEl.focus({ preventScroll: true }); firstEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { /* ignore */ }
  }
  return { ok: !firstEl, values: values, firstError: firstError };
}

// A one-time token per bill form, so a Save that's retried after a dropped
// connection can never create the same bill twice (see apiSaveBill).
function newSaveToken_() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (err) { /* fall through */ }
  return 'st-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}
let billSaveToken_ = newSaveToken_();

// -------------------------------------------------------------------------
// 4. LOGIN
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
    if (r.ok) {
      sessionStorage.setItem('SJP_user', username);
      sessionStorage.setItem('SJP_displayName', r.displayName || username);
      sessionStorage.setItem('SJP_role', r.role || 'admin');
      sessionStorage.setItem('SJP_token', r.sessionToken || '');
      if (r.role === 'biller') {
        sessionStorage.setItem('SJP_billerId', r.billerId || '');
        sessionStorage.setItem('SJP_billerName', r.billerName || '');
        sessionStorage.setItem('SJP_billerPass', password);
        sessionStorage.setItem('SJP_canAccessTax', r.canAccessTax ? '1' : '0');
        sessionStorage.setItem('SJP_canAccessBank', r.canAccessBank ? '1' : '0');
        sessionStorage.setItem('SJP_canAccessFindEdit', r.canAccessFindEdit ? '1' : '0');
        sessionStorage.setItem('SJP_canAccessStockView', r.canAccessStockView ? '1' : '0');
        sessionStorage.setItem('SJP_canAccessStockEdit', r.canAccessStockEdit ? '1' : '0');
        sessionStorage.setItem('SJP_canAccessReportDownload', r.canAccessReportDownload ? '1' : '0');
        sessionStorage.setItem('SJP_canAccessDiscount', r.canAccessDiscount ? '1' : '0');
        sessionStorage.setItem('SJP_canAccessDashboard', r.canAccessDashboard ? '1' : '0');
        sessionStorage.setItem('SJP_canAccessLetterpad', r.canAccessLetterpad ? '1' : '0');
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
    if (btn.dataset.view === 'inventory') loadInventory();
    if (btn.dataset.view === 'reports') loadReport(reportState.active);
    if (btn.dataset.view === 'admin') checkSpreadsheetCapacity_();
    if (btn.dataset.view === 'billing') checkBillingCapacityGate_();
    if (btn.dataset.view === 'letterpad') initLetterpad_();
  });
});
document.getElementById('hamburgerBtn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// -------------------------------------------------------------------------
// 6. BOOTSTRAP (load settings/products/billers, generate first product row)
// -------------------------------------------------------------------------
async function bootstrapApp() {
  try {
    const r = await apiGet('bootstrap');
    if (!r.ok) { toast('Failed to load data: ' + r.error, 'error'); return; }
    checkBackendBuild_(r.serverBuild);
    console.log('Bootstrap OK - server build:', r.serverBuild || '(not present - old backend)',
      '| products:', (r.products || []).length, '| customers:', (r.customers || []).length);
    state.settings = r.settings;
    state.products = r.products;
    state.billers = r.billers;
    state.customers = r.customers || [];
    applyTheme_(state.settings);
    applySettingsToUI();
    styleFieldLabelHints_();
    populateBillerDropdown();
    document.getElementById('f_billId').value = r.nextBillId;
    setBillDateToday_();
    addProductRow();
    loadSessionRole_();
    syncBillerPermissionsFromRoster_();
    applyRoleToUI();
    state.bootstrapped = true;
    // Billing is the default screen after login for both roles - check
    // right away whether the database is full, so the popup shows before
    // anyone starts typing a bill, not just after they hit Save.
    checkBillingCapacityGate_();
  } catch (err) {
    toast('Could not load app data. Check API_URL.', 'error');
  }
}

function applySettingsToUI() {
  const s = state.settings;
  ['loginLogo', 'sidebarLogo', 'topbarLogo'].forEach(id => {
    const el = document.getElementById(id);
    if (el && s.LogoURL) el.src = s.LogoURL;
  });
  document.getElementById('sidebarCompanyName').textContent = s.CompanyName || 'SJ Physiotherapy';
  // admin shop tab prefill
  document.getElementById('s_logo').value = s.LogoURL || '';
  const printLogoEl = document.getElementById('s_printLogo');
  if (printLogoEl) printLogoEl.value = s.PrintLogoURL || '';
  document.getElementById('s_companyName').value = s.CompanyName || '';
  // Phones are shown as plain digits (the same form they'll be saved in) -
  // an older "+91 96294 95946" displays as 9629495946.
  document.getElementById('s_phone').value = normalizeShopPhone_(s.Phone || '');
  document.getElementById('s_address').value = s.Address || '';
  document.getElementById('s_website').value = s.Website || '';
  document.getElementById('s_gst').value = s.GSTNumber || '';
  document.getElementById('s_socialWhatsapp').value = normalizeMobile_(s.SocialWhatsApp || '');
  document.getElementById('s_socialInstagram').value = s.SocialInstagram || '';
  document.getElementById('s_socialFacebook').value = s.SocialFacebook || '';
  document.getElementById('s_socialLinkedin').value = s.SocialLinkedIn || '';
  document.getElementById('s_socialYoutube').value = s.SocialYouTube || '';
  // invoice / tax tab prefill
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('s_companyEmail', s.CompanyEmail || '');
  setVal('s_cgst', s.CGSTPercent != null ? s.CGSTPercent : 0);
  setVal('s_sgst', s.SGSTPercent != null ? s.SGSTPercent : 0);
  setVal('s_bankName', s.BankName || '');
  setVal('s_bankAccountNo', s.BankAccountNo || '');
  setVal('s_bankIFSC', s.BankIFSC || '');
  setVal('s_bankAccountHolder', s.BankAccountHolder || '');
  setVal('s_signatoryLabel', s.AuthorizedSignatoryLabel || 'Authorized Signatory');
  setVal('s_showCompanyEmail', s.ShowCompanyEmail !== false ? 'TRUE' : 'FALSE');
  setVal('s_showTaxOnBill', s.ShowTaxOnBill !== false ? 'TRUE' : 'FALSE');
  setVal('s_showBankDetails', s.ShowBankDetails !== false ? 'TRUE' : 'FALSE');
  setVal('s_showDiscountOption', s.ShowDiscountOption !== false ? 'TRUE' : 'FALSE');
  setVal('s_showAuthorizedSignatory', s.ShowAuthorizedSignatory !== false ? 'TRUE' : 'FALSE');
}

// -------------------------------------------------------------------------
// THEME CUSTOMIZATION - pushes the shop's chosen colors into real CSS
// custom properties on <html>, so the whole site (sidebar, buttons, bill
// header, text, background) re-themes instantly, everywhere, with zero
// per-component code. Gradients are written as FULLY-RESOLVED strings
// (not left for CSS to compose from two separate sub-variables) - some
// browsers don't reliably re-resolve a var() containing another var() when
// used inside things like border-image, so composing the final value once
// here and writing it straight in avoids that whole class of "changed the
// color but one specific spot didn't update" bug.
// Chart colors aren't pure CSS (SVG fills are generated in JS) so those get
// stashed on state instead, for the chart-drawing functions to read.
// -------------------------------------------------------------------------
function applyTheme_(s) {
  const root = document.documentElement;

  // --- Menubar/sidebar, buttons, active-menu-item (existing) ---
  const buttonStyle = s.ThemeButtonStyle || 'gradient-diagonal';
  const buttonFrom = s.ThemeButtonFrom || '#2778b7';
  const buttonTo = buttonStyle === 'solid' ? buttonFrom : (s.ThemeButtonTo || '#a8d339');
  const buttonText = s.ThemeButtonText || '#FFFFFF';
  const sidebarStyle = s.ThemeSidebarStyle || 'gradient-vertical';
  const sidebarFrom = s.ThemeSidebarFrom || '#2778b7';
  const sidebarTo = sidebarStyle === 'solid' ? sidebarFrom : (s.ThemeSidebarTo || '#a8d339');
  const sidebarText = s.ThemeSidebarText || '#FFFFFF';
  const navActiveBg = s.ThemeNavActiveBg || '#FFFFFF';
  const navActiveText = s.ThemeNavActiveText || buttonFrom;
  const billHeader = s.ThemeBillHeaderColor || '#E1341E';
  const heading = s.ThemeHeadingColor || '#182322';
  const mutedText = s.ThemeMutedColor || '#4B5A57';
  const bgColor = s.ThemeBgColor || '#F6F4F3';
  const surfaceColor = s.ThemeSurfaceColor || '#FFFFFF';
  const borderColor = s.ThemeBorderColor || '#E7DCD8';

  // --- Login screen ---
  const loginBgStyle = s.ThemeLoginBgStyle || 'gradient-diagonal';
  const loginBgFrom = s.ThemeLoginBgFrom || '#2778b7';
  const loginBgTo = loginBgStyle === 'solid' ? loginBgFrom : (s.ThemeLoginBgTo || '#a8d339');
  const loginCardBg = s.ThemeLoginCardBg || '#FFFFFF';
  const loginHeading = s.ThemeLoginHeadingColor || '#182322';
  const loginText = s.ThemeLoginTextColor || '#4B5A57';

  // --- Page / section headings ---
  const pageHeading = s.ThemePageHeadingColor || '#182322';
  const pageSubheading = s.ThemePageSubheadingColor || '#4B5A57';
  const sectionHeading = s.ThemeSectionHeadingColor || '#182322';

  // --- Tabs (Admin Settings tabs + Reports tabs share the same styling) ---
  const tabActiveText = s.ThemeTabActiveTextColor || '#2778b7';
  const tabInactiveText = s.ThemeTabInactiveTextColor || '#4B5A57';
  const tabIndicatorStyle = s.ThemeTabIndicatorStyle || 'gradient-diagonal';
  const tabIndicatorFrom = s.ThemeTabIndicatorFrom || '#2778b7';
  const tabIndicatorTo = tabIndicatorStyle === 'solid' ? tabIndicatorFrom : (s.ThemeTabIndicatorTo || '#a8d339');

  // --- Find/Edit "gate" box (Super Admin - Edit This Bill, etc.) ---
  const gateBg = s.ThemeGateBgColor || '#FBF1DC';
  const gateBorder = s.ThemeGateBorderColor || '#E8C766';
  const gateTitle = s.ThemeGateTitleColor || '#C68A1E';

  // --- Bill/PDF design - shared by preview, print, and the emailed PDF ---
  const billFont = s.ThemeBillFontFamily || "Georgia, 'Times New Roman', Times, serif";
  const billDiscount = s.ThemeBillDiscountColor || '#B23A2E';
  const billLogoW = (Number(s.ThemeBillLogoWidth) || 96) + 'px';
  const billLogoH = (Number(s.ThemeBillLogoHeight) || 58) + 'px';

  // --- Buttons - hover states ---
  const buttonHoverFrom = s.ThemeButtonHoverFrom || buttonFrom;
  const buttonHoverTo = buttonStyle === 'solid' ? buttonHoverFrom : (s.ThemeButtonHoverTo || buttonTo);
  const outlineText = s.ThemeOutlineText || buttonFrom;
  const outlineBorder = s.ThemeOutlineBorder || outlineText;
  const outlineHoverBg = s.ThemeOutlineHoverBg || '#FCE2DC';
  const outlineHoverText = s.ThemeOutlineHoverText || outlineText;

  root.style.setProperty('--theme-bill-font', billFont);
  root.style.setProperty('--theme-bill-discount', billDiscount);
  root.style.setProperty('--theme-bill-logo-w', billLogoW);
  root.style.setProperty('--theme-bill-logo-h', billLogoH);
  root.style.setProperty('--theme-outline-text', outlineText);
  root.style.setProperty('--theme-outline-border', outlineBorder);
  root.style.setProperty('--theme-outline-hover-bg', outlineHoverBg);
  root.style.setProperty('--theme-outline-hover-text', outlineHoverText);

  root.style.setProperty('--theme-button-from', buttonFrom);
  root.style.setProperty('--theme-button-to', buttonTo);
  root.style.setProperty('--theme-button-text', buttonText);
  root.style.setProperty('--theme-sidebar-from', sidebarFrom);
  root.style.setProperty('--theme-sidebar-to', sidebarTo);
  root.style.setProperty('--theme-sidebar-text', sidebarText);
  root.style.setProperty('--theme-nav-active-bg', navActiveBg);
  root.style.setProperty('--theme-nav-active-text', navActiveText);
  root.style.setProperty('--theme-bill-header', billHeader);
  root.style.setProperty('--theme-heading', heading);
  root.style.setProperty('--theme-muted', mutedText);
  root.style.setProperty('--theme-bg', bgColor);
  root.style.setProperty('--theme-surface', surfaceColor);
  root.style.setProperty('--theme-border', borderColor);

  root.style.setProperty('--theme-login-card-bg', loginCardBg);
  root.style.setProperty('--theme-login-heading', loginHeading);
  root.style.setProperty('--theme-login-text', loginText);
  root.style.setProperty('--theme-login-gradient', gradientCss_(loginBgStyle, loginBgFrom, loginBgTo));

  root.style.setProperty('--theme-page-heading', pageHeading);
  root.style.setProperty('--theme-page-subheading', pageSubheading);
  root.style.setProperty('--theme-section-heading', sectionHeading);

  root.style.setProperty('--theme-tab-active-text', tabActiveText);
  root.style.setProperty('--theme-tab-inactive-text', tabInactiveText);
  root.style.setProperty('--theme-tab-indicator', gradientCss_(tabIndicatorStyle, tabIndicatorFrom, tabIndicatorTo));

  root.style.setProperty('--theme-gate-bg', gateBg);
  root.style.setProperty('--theme-gate-border', gateBorder);
  root.style.setProperty('--theme-gate-title', gateTitle);

  // Fully-resolved derived values - see the big comment above for why.
  root.style.setProperty('--primary', buttonFrom);
  root.style.setProperty('--primary-dark', darkenHex_(buttonFrom, 0.28));
  const buttonGradientCss = gradientCss_(buttonStyle, buttonFrom, buttonTo);
  root.style.setProperty('--brand-gradient', buttonGradientCss);
  root.style.setProperty('--brand-gradient-hover', gradientCss_(buttonStyle, buttonHoverFrom, buttonHoverTo));
  root.style.setProperty('--sidebar-gradient', gradientCss_(sidebarStyle, sidebarFrom, sidebarTo));

  state.themeChartPalette = (s.ThemeChartPalette || DEFAULT_CHART_PALETTE_.join(','))
    .split(',').map(c => c.trim()).filter(Boolean);
  if (!state.themeChartPalette.length) state.themeChartPalette = DEFAULT_CHART_PALETTE_.slice();

  // The 4 fixed KPI "number card" colors (Dashboard's 4 cards + Inventory's
  // 3 cards all reuse these same 4 CSS classes) now come from the first 4
  // Chart Colors, instead of being hardcoded - so a shop that customizes its
  // chart palette sees that same palette reflected on every number card too.
  const kpiClassColors = state.themeChartPalette.length >= 4
    ? state.themeChartPalette.slice(0, 4)
    : DEFAULT_CHART_PALETTE_.slice(0, 4);
  ['c-teal', 'c-gold', 'c-green', 'c-violet'].forEach((cls, i) => {
    root.style.setProperty('--kpi-color-' + cls, kpiClassColors[i]);
    root.style.setProperty('--kpi-color-soft-' + cls, lightenHex_(kpiClassColors[i], 0.85));
  });

  // Prefill the Theme tab's inputs (Admin Settings), if it's on the page.
  const setColor = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setColor('theme_buttonStyle', buttonStyle);
  setColor('theme_buttonFrom', buttonFrom);
  setColor('theme_buttonTo', s.ThemeButtonTo || '#a8d339');
  setColor('theme_buttonText', buttonText);
  setColor('theme_sidebarStyle', sidebarStyle);
  setColor('theme_sidebarFrom', sidebarFrom);
  setColor('theme_sidebarTo', s.ThemeSidebarTo || '#a8d339');
  setColor('theme_sidebarText', sidebarText);
  setColor('theme_navActiveBg', navActiveBg);
  setColor('theme_navActiveText', navActiveText);
  setColor('theme_billHeader', billHeader);
  setColor('theme_heading', heading);
  setColor('theme_muted', mutedText);
  setColor('theme_bg', bgColor);
  setColor('theme_surface', surfaceColor);
  setColor('theme_border', borderColor);
  state.themeChartPalette.forEach((c, i) => setColor('theme_chart' + i, c));

  setColor('theme_loginBgStyle', loginBgStyle);
  setColor('theme_loginBgFrom', loginBgFrom);
  setColor('theme_loginBgTo', s.ThemeLoginBgTo || '#a8d339');
  setColor('theme_loginCardBg', loginCardBg);
  setColor('theme_loginHeading', loginHeading);
  setColor('theme_loginText', loginText);

  setColor('theme_pageHeading', pageHeading);
  setColor('theme_pageSubheading', pageSubheading);
  setColor('theme_sectionHeading', sectionHeading);

  setColor('theme_tabActiveText', tabActiveText);
  setColor('theme_tabInactiveText', tabInactiveText);
  setColor('theme_tabIndicatorStyle', tabIndicatorStyle);
  setColor('theme_tabIndicatorFrom', tabIndicatorFrom);
  setColor('theme_tabIndicatorTo', s.ThemeTabIndicatorTo || '#a8d339');

  setColor('theme_gateBg', gateBg);
  setColor('theme_gateBorder', gateBorder);
  setColor('theme_gateTitle', gateTitle);

  setColor('theme_billFont', billFont);
  setColor('theme_billDiscount', billDiscount);
  setColor('theme_billLogoWidth', Number(s.ThemeBillLogoWidth) || 96);
  setColor('theme_billLogoHeight', Number(s.ThemeBillLogoHeight) || 58);

  setColor('theme_buttonHoverFrom', buttonHoverFrom);
  setColor('theme_buttonHoverTo', s.ThemeButtonHoverTo || buttonTo);
  setColor('theme_outlineText', outlineText);
  setColor('theme_outlineBorder', outlineBorder);
  setColor('theme_outlineHoverBg', outlineHoverBg);
  setColor('theme_outlineHoverText', outlineHoverText);

  const setChecked = (id, v) => { const el = document.getElementById(id); if (el) el.checked = String(v).toUpperCase() === 'TRUE'; };
  setChecked('theme_billNameBold', s.ThemeBillCompanyNameBold === undefined ? true : s.ThemeBillCompanyNameBold);
  setChecked('theme_billNameItalic', s.ThemeBillCompanyNameItalic);
  setChecked('theme_billNameUnderline', s.ThemeBillCompanyNameUnderline);
  setChecked('theme_billInfoBold', s.ThemeBillCompanyInfoBold);
  setChecked('theme_billInfoItalic', s.ThemeBillCompanyInfoItalic);
  setChecked('theme_billInfoUnderline', s.ThemeBillCompanyInfoUnderline);
  setColor('theme_billLayout', s.ThemeBillHeaderLayout || 'logo-side');

  toggleThemeGradientFields_();
  renderAllThemePreviews_();
}

// Every gradient-capable color pair in the Theme tab (buttons, sidebar,
// login background, tab indicator) shares this one helper - 'solid' just
// returns the single color, otherwise it composes a linear-gradient string
// in the chosen direction. Centralizing this means "add a new gradient
// direction option" is a one-line change instead of four repeated ones.
function gradientCss_(style, from, to) {
  if (style === 'solid') return from;
  const angle = style === 'gradient-vertical' ? '180deg' : style === 'gradient-horizontal' ? '90deg' : '135deg';
  return `linear-gradient(${angle}, ${from} 0%, ${to} 100%)`;
}

const DEFAULT_CHART_PALETTE_ = ['#E1341E', '#a8d339', '#AE2314', '#F2A65A', '#8C2F39', '#4B5A57', '#2E86AB', '#6C4FB6', '#1F9E78', '#D4A017', '#7A5C61', '#3D5A80'];

// Multiplies each RGB channel toward black by `amount` (0-1) - a small,
// dependable way to get a matching "dark" shade from any single color the
// shop picks, without asking them to pick a second, harder-to-coordinate color.
function darkenHex_(hex, amount) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return hex;
  const r = Math.round(parseInt(h.slice(0, 2), 16) * (1 - amount));
  const g = Math.round(parseInt(h.slice(2, 4), 16) * (1 - amount));
  const b = Math.round(parseInt(h.slice(4, 6), 16) * (1 - amount));
  const clamp = v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return '#' + clamp(r) + clamp(g) + clamp(b);
}

// The opposite of darkenHex_ - mixes each RGB channel toward white by
// `amount` (0-1). Used to derive a soft/tinted background for a KPI number
// card automatically from its one main color, the same way the app already
// derives --primary-dark from --primary, without asking the shop to pick a
// second "soft" color for every chart color.
function lightenHex_(hex, amount) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return hex;
  const r = Math.round(parseInt(h.slice(0, 2), 16) + (255 - parseInt(h.slice(0, 2), 16)) * amount);
  const g = Math.round(parseInt(h.slice(2, 4), 16) + (255 - parseInt(h.slice(2, 4), 16)) * amount);
  const b = Math.round(parseInt(h.slice(4, 6), 16) + (255 - parseInt(h.slice(4, 6), 16)) * amount);
  const clamp = v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return '#' + clamp(r) + clamp(g) + clamp(b);
}

// Standard relative-luminance contrast ratio (WCAG formula) between two hex
// colors - used only to warn when a text/background combo picked on the
// Theme tab would be hard or impossible to read, BEFORE saving it.
function contrastRatio_(hex1, hex2) {
  function luminance(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return 1;
    const chan = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const r = chan(parseInt(h.slice(0, 2), 16)), g = chan(parseInt(h.slice(2, 4), 16)), b = chan(parseInt(h.slice(4, 6), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const l1 = luminance(hex1) + 0.05, l2 = luminance(hex2) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

// Every Admin Settings field label that ends in a parenthetical example/note
// - e.g. "App Logo URL (sidebar / login - square works best)" - gets that
// note visually separated from the actual field name, so the label itself
// (what to fill in) reads clearly at a glance and the note (how/why) doesn't
// compete with it for attention. Runs once against the static markup, so a
// new field just needs "(...)" at the end of its label text and this picks
// it up automatically - nothing else to wire up.
function styleFieldLabelHints_() {
  document.querySelectorAll('.admin-pane label, .theme-section label').forEach(label => {
    if (label.querySelector('.field-label-hint')) return; // already processed
    const text = label.textContent;
    const m = text.match(/^(.*?)\s*(\([^)]*\))\s*$/);
    if (!m) return;
    label.textContent = '';
    label.appendChild(document.createTextNode(m[1] + ' '));
    const hint = document.createElement('span');
    hint.className = 'field-label-hint';
    hint.textContent = m[2];
    label.appendChild(hint);
  });
}

// Show/hide the "End Color" pickers depending on Gradient vs Solid choice -
// covers all 4 gradient-capable controls (Buttons, Sidebar, Login
// Background, Tab Indicator). Any style value other than 'solid' is some
// flavor of gradient (diagonal/vertical/horizontal), so it needs the End
// Color field shown.
function toggleThemeGradientFields_() {
  [
    ['theme_buttonStyle', 'theme_buttonToWrap'],
    ['theme_sidebarStyle', 'theme_sidebarToWrap'],
    ['theme_loginBgStyle', 'theme_loginBgToWrap'],
    ['theme_tabIndicatorStyle', 'theme_tabIndicatorToWrap']
  ].forEach(([styleId, wrapId]) => {
    const styleEl = document.getElementById(styleId);
    const wrapEl = document.getElementById(wrapId);
    if (!styleEl || !wrapEl) return;
    wrapEl.style.display = styleEl.value === 'solid' ? 'none' : '';
  });
}

// One small live preview per section - each reads only the inputs it needs,
// so picking a color updates its own preview instantly without having to
// scroll to a single combined box elsewhere on the page.
function renderAllThemePreviews_() {
  const v = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const checked = id => { const el = document.getElementById(id); return el ? el.checked : false; };

  // --- Sidebar ---
  const sidebarBox = document.getElementById('preview_sidebar');
  if (sidebarBox) {
    const style = v('theme_sidebarStyle');
    const from = v('theme_sidebarFrom'), to = style === 'solid' ? from : v('theme_sidebarTo');
    const text = v('theme_sidebarText');
    sidebarBox.innerHTML = `
      <div style="width:100%;max-width:130px;border-radius:8px;overflow:hidden;box-shadow:var(--shadow-sm);background:${gradientCss_(style, from, to)};padding:10px 8px;">
        <div style="color:${text};font-size:11px;font-weight:700;opacity:.8;padding:6px 4px;">&#128230; Inventory</div>
        <div style="color:${text};font-size:11px;font-weight:700;opacity:.8;padding:6px 4px;">&#128269; Find / Edit</div>
      </div>`;
  }

  // --- Active menu item ---
  const navBox = document.getElementById('preview_navActive');
  if (navBox) {
    const style = v('theme_sidebarStyle');
    const from = v('theme_sidebarFrom'), to = style === 'solid' ? from : v('theme_sidebarTo');
    const activeBg = v('theme_navActiveBg'), activeText = v('theme_navActiveText');
    navBox.innerHTML = `
      <div style="width:100%;max-width:130px;border-radius:8px;overflow:hidden;box-shadow:var(--shadow-sm);background:${gradientCss_(style, from, to)};padding:10px 8px;">
        <div style="background:${activeBg};color:${activeText};font-size:11px;font-weight:700;padding:6px 8px;border-radius:6px;">&#128202; Dashboard</div>
      </div>`;
  }

  // --- Buttons (normal + hover, primary + outline) ---
  const btnBox = document.getElementById('preview_buttons');
  if (btnBox) {
    const style = v('theme_buttonStyle');
    const from = v('theme_buttonFrom'), to = style === 'solid' ? from : v('theme_buttonTo');
    const text = v('theme_buttonText');
    const hFrom = v('theme_buttonHoverFrom'), hTo = style === 'solid' ? hFrom : v('theme_buttonHoverTo');
    const outText = v('theme_outlineText'), outBorder = v('theme_outlineBorder');
    const outHoverBg = v('theme_outlineHoverBg'), outHoverText = v('theme_outlineHoverText');
    btnBox.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
        <button type="button" disabled style="pointer-events:none;padding:10px 18px;border:none;border-radius:8px;color:${text};font-weight:700;font-size:13px;background:${gradientCss_(style, from, to)};">Save &amp; Generate Bill</button>
        <button type="button" disabled style="pointer-events:none;padding:10px 18px;border:none;border-radius:8px;color:${text};font-weight:700;font-size:13px;background:${gradientCss_(style, hFrom, hTo)};">on hover</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:10px;">
        <button type="button" disabled style="pointer-events:none;padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;background:transparent;color:${outText};border:1.5px solid ${outBorder};">&#8635; Refresh</button>
        <button type="button" disabled style="pointer-events:none;padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;background:${outHoverBg};color:${outHoverText};border:1.5px solid ${outHoverText};">on hover</button>
      </div>`;
  }

  // --- Bill header + typography + layout ---
  const billBox = document.getElementById('preview_billHeader');
  if (billBox) {
    const color = v('theme_billHeader');
    const font = v('theme_billFont') || "Georgia, 'Times New Roman', Times, serif";
    const logoW = Math.max(20, Number(v('theme_billLogoWidth')) || 96);
    const logoH = Math.max(20, Number(v('theme_billLogoHeight')) || 58);
    const nameStyle = 'font-weight:' + (checked('theme_billNameBold') ? '800' : '400') +
      ';font-style:' + (checked('theme_billNameItalic') ? 'italic' : 'normal') +
      ';text-decoration:' + (checked('theme_billNameUnderline') ? 'underline' : 'none') + ';';
    const infoStyle = 'font-weight:' + (checked('theme_billInfoBold') ? '700' : '400') +
      ';font-style:' + (checked('theme_billInfoItalic') ? 'italic' : 'normal') +
      ';text-decoration:' + (checked('theme_billInfoUnderline') ? 'underline' : 'none') + ';';
    const layout = v('theme_billLayout') || 'logo-side';
    // Scaled down to fit the preview box while keeping the true aspect ratio.
    const scale = Math.min(1, 64 / logoW, 44 / logoH);
    const logoBadge = `<div style="width:${Math.round(logoW * scale)}px;height:${Math.round(logoH * scale)}px;border-radius:4px;background:#fff;border:1px dashed ${color};display:flex;align-items:center;justify-content:center;font-size:9px;color:${color};flex-shrink:0;">LOGO</div>`;
    const nameBlock = `<div style="${nameStyle}font-family:${font};font-size:16px;color:${color};">SJ Physiotherapy</div><div style="${infoStyle}font-family:${font};font-size:10.5px;color:${color};opacity:.85;margin-top:2px;">Bharathiyar Rd, Coimbatore &middot; +91 97897 31317</div>`;
    billBox.innerHTML = layout === 'logo-top'
      ? `<div style="display:flex;justify-content:space-between;align-items:flex-start;">${logoBadge}<div style="font-weight:800;font-size:14px;letter-spacing:1px;color:${color};font-family:${font};">SJP-000001</div></div><div style="margin-top:6px;">${nameBlock}</div>`
      : `<div style="display:flex;gap:10px;align-items:flex-start;">${logoBadge}<div style="flex:1;">${nameBlock}</div><div style="font-weight:800;font-size:14px;letter-spacing:1px;color:${color};font-family:${font};">SJP-000001</div></div>`;
  }

  // --- Text & backgrounds (the "real" combined preview + contrast check) ---
  const tbBox = document.getElementById('preview_textBg');
  const tbWarning = document.getElementById('preview_textBg_warning');
  if (tbBox) {
    const heading = v('theme_heading'), muted = v('theme_muted'), surface = v('theme_surface'), bg = v('theme_bg'), border = v('theme_border');
    tbBox.innerHTML = `
      <div style="background:${bg};border-radius:8px;padding:14px;">
        <div style="background:${surface};border:1px solid ${border};border-radius:8px;padding:12px 14px;">
          <div style="font-weight:800;font-size:14px;color:${heading};margin-bottom:4px;">Grinder - 750W</div>
          <div style="font-size:12px;color:${muted};">Qty: 2 &middot; \u20B9 3,000.00 each</div>
        </div>
      </div>`;
    if (tbWarning) {
      const warnings = [];
      const headingRatio = contrastRatio_(heading, surface);
      const mutedRatio = contrastRatio_(muted, surface);
      if (headingRatio < 3) warnings.push('Heading text is hard to read against the Card Background you picked.');
      if (mutedRatio < 2.2) warnings.push('Muted/Secondary text is hard to read against the Card Background you picked.');
      if (warnings.length) {
        tbWarning.textContent = '\u26A0\uFE0F ' + warnings.join(' ');
        tbWarning.classList.add('show');
      } else {
        tbWarning.classList.remove('show');
      }
    }
  }

  // --- Login screen ---
  const loginBox = document.getElementById('preview_loginScreen');
  if (loginBox) {
    const style = v('theme_loginBgStyle');
    const from = v('theme_loginBgFrom'), to = style === 'solid' ? from : v('theme_loginBgTo');
    const cardBg = v('theme_loginCardBg'), headingC = v('theme_loginHeading'), textC = v('theme_loginText');
    loginBox.innerHTML = `
      <div style="border-radius:10px;overflow:hidden;background:${gradientCss_(style, from, to)};padding:22px 14px;display:flex;justify-content:center;">
        <div style="background:${cardBg};border-radius:8px;padding:14px 18px;text-align:center;width:150px;box-shadow:var(--shadow-sm);">
          <div style="width:34px;height:34px;border-radius:50%;background:${gradientCss_(style, from, to)};margin:0 auto 8px;"></div>
          <div style="font-weight:800;font-size:12px;color:${headingC};">SJ Physiotherapy</div>
          <div style="font-size:9.5px;color:${textC};margin-top:2px;">Billing System</div>
        </div>
      </div>`;
  }

  // --- Page & section headings ---
  const headingBox = document.getElementById('preview_headings');
  if (headingBox) {
    const pageH = v('theme_pageHeading'), pageSub = v('theme_pageSubheading'), sectionH = v('theme_sectionHeading');
    headingBox.innerHTML = `
      <div style="font-weight:800;font-size:17px;color:${pageH};">Create Bill</div>
      <div style="font-size:12px;color:${pageSub};margin:2px 0 12px;">Add products, review the live preview, and save.</div>
      <div style="font-weight:800;font-size:12.5px;text-transform:uppercase;letter-spacing:.4px;color:${sectionH};">Products</div>`;
  }

  // --- Tabs (Admin Settings tabs / Reports tabs) ---
  const tabsBox = document.getElementById('preview_tabs');
  if (tabsBox) {
    const style = v('theme_tabIndicatorStyle');
    const from = v('theme_tabIndicatorFrom'), to = style === 'solid' ? from : v('theme_tabIndicatorTo');
    const activeText = v('theme_tabActiveText'), inactiveText = v('theme_tabInactiveText');
    tabsBox.innerHTML = `
      <div style="display:flex;gap:14px;border-bottom:1px solid var(--line);">
        <div style="padding:7px 2px;font-size:12px;font-weight:700;color:${activeText};border-bottom:2.5px solid;border-image:${gradientCss_(style, from, to)} 1;">Billers</div>
        <div style="padding:7px 2px;font-size:12px;font-weight:600;color:${inactiveText};">Shop Details</div>
        <div style="padding:7px 2px;font-size:12px;font-weight:600;color:${inactiveText};">Theme</div>
      </div>`;
  }

  // --- Find/Edit gate box ---
  const gateBox = document.getElementById('preview_gate');
  if (gateBox) {
    const bg = v('theme_gateBg'), border = v('theme_gateBorder'), title = v('theme_gateTitle');
    gateBox.innerHTML = `
      <div style="background:${bg};border:1.5px dashed ${border};border-radius:8px;padding:10px 12px;">
        <div style="font-weight:700;font-size:12px;color:${title};">&#128274; Super Admin - Edit This Bill</div>
      </div>`;
  }

  // --- Charts (up to 12 colors) ---
  const chartBox = document.getElementById('preview_charts');
  if (chartBox) {
    const heights = [55, 85, 40, 70, 30, 60, 48, 90, 35, 65, 50, 78];
    const count = document.getElementById('theme_chart11') ? 12 : 6;
    const swatches = Array.from({ length: count }, (_, i) => v('theme_chart' + i)).filter(Boolean);
    chartBox.innerHTML = `
      <div style="display:flex;align-items:flex-end;gap:5px;height:90px;flex-wrap:wrap;">
        ${swatches.map((c, i) => `<div style="width:13px;height:${heights[i % heights.length]}%;background:${c};border-radius:3px 3px 0 0;"></div>`).join('')}
      </div>`;
  }

  // --- KPI / number cards (Dashboard + Inventory reuse chart colors 1-4) ---
  const kpiBox = document.getElementById('preview_kpi');
  if (kpiBox) {
    const kpiColors = [0, 1, 2, 3].map(i => v('theme_chart' + i)).filter(Boolean);
    kpiBox.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${kpiColors.map(c => `<div style="width:64px;padding:10px 8px;border-radius:8px;background:linear-gradient(155deg, ${lightenHex_(c, 0.85)} 0%, #fff 62%);border:1px solid ${lightenHex_(c, 0.85)};">
          <div style="width:20px;height:20px;border-radius:6px;background:${c};margin-bottom:6px;"></div>
          <div style="font-weight:800;font-size:14px;color:${c};">128</div>
        </div>`).join('')}
      </div>`;
  }
}

function populateBillerDropdown() {
  const sel = document.getElementById('f_billerId');
  sel.innerHTML = '<option value="">Select biller...</option>';
  state.billers.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.billerId; opt.textContent = b.billerId + ' - ' + b.name;
    sel.appendChild(opt);
  });
}

// -------------------------------------------------------------------------
// 6b. ROLE / SESSION - Super Admin sees everything; a Biller who logs in
//     with their own ID+password only gets Create Bill (plus Find/Edit Bill
//     and the Tax/Bank toggles if the super admin has granted them).
// -------------------------------------------------------------------------
function loadSessionRole_() {
  const role = sessionStorage.getItem('SJP_role') || 'admin';
  state.session.role = role;
  if (role === 'biller') {
    state.session.billerId = sessionStorage.getItem('SJP_billerId') || '';
    state.session.billerName = sessionStorage.getItem('SJP_billerName') || '';
    state.session.billerPassword = sessionStorage.getItem('SJP_billerPass') || '';
    state.session.canAccessTax = sessionStorage.getItem('SJP_canAccessTax') === '1';
    state.session.canAccessBank = sessionStorage.getItem('SJP_canAccessBank') === '1';
    state.session.canAccessFindEdit = sessionStorage.getItem('SJP_canAccessFindEdit') === '1';
    state.session.canAccessStockView = sessionStorage.getItem('SJP_canAccessStockView') === '1';
    state.session.canAccessStockEdit = sessionStorage.getItem('SJP_canAccessStockEdit') === '1';
    state.session.canAccessReportDownload = sessionStorage.getItem('SJP_canAccessReportDownload') === '1';
    state.session.canAccessDiscount = sessionStorage.getItem('SJP_canAccessDiscount') === '1';
    state.session.canAccessDashboard = sessionStorage.getItem('SJP_canAccessDashboard') === '1';
    state.session.canAccessLetterpad = sessionStorage.getItem('SJP_canAccessLetterpad') === '1';
  }
}

// The permissions cached in sessionStorage at login time go stale the
// moment Super Admin changes a biller's access on another screen - the
// logged-in biller's tab has no way to know until it talks to the server
// again. Every bootstrap() call already brings back the live billers
// roster (state.billers), so use that as the up-to-date source of truth
// for the current biller's own access flags instead of trusting whatever
// was cached at login. This is what makes a revoked toggle disappear the
// next time the biller's screen refreshes/reloads, without needing to
// log out and back in. (The save itself is enforced server-side too, so
// even a still-stale tab can never persist tax/bank it isn't allowed.)
function syncBillerPermissionsFromRoster_() {
  if (state.session.role !== 'biller') return;
  const me = (state.billers || []).find(b => b.billerId === state.session.billerId);
  if (!me) return;
  state.session.canAccessTax = !!me.canAccessTax;
  state.session.canAccessBank = !!me.canAccessBank;
  state.session.canAccessFindEdit = !!me.canAccessFindEdit;
  state.session.canAccessStockView = !!me.canAccessStockView;
  state.session.canAccessStockEdit = !!me.canAccessStockEdit;
  state.session.canAccessReportDownload = !!me.canAccessReportDownload;
  state.session.canAccessDiscount = !!me.canAccessDiscount;
  state.session.canAccessDashboard = !!me.canAccessDashboard;
  state.session.canAccessLetterpad = !!me.canAccessLetterpad;
  sessionStorage.setItem('SJP_canAccessTax', state.session.canAccessTax ? '1' : '0');
  sessionStorage.setItem('SJP_canAccessBank', state.session.canAccessBank ? '1' : '0');
  sessionStorage.setItem('SJP_canAccessFindEdit', state.session.canAccessFindEdit ? '1' : '0');
  sessionStorage.setItem('SJP_canAccessStockView', state.session.canAccessStockView ? '1' : '0');
  sessionStorage.setItem('SJP_canAccessStockEdit', state.session.canAccessStockEdit ? '1' : '0');
  sessionStorage.setItem('SJP_canAccessReportDownload', state.session.canAccessReportDownload ? '1' : '0');
  sessionStorage.setItem('SJP_canAccessDiscount', state.session.canAccessDiscount ? '1' : '0');
  sessionStorage.setItem('SJP_canAccessDashboard', state.session.canAccessDashboard ? '1' : '0');
  sessionStorage.setItem('SJP_canAccessLetterpad', state.session.canAccessLetterpad ? '1' : '0');
}

// True if the signed-in user is allowed to see the Inventory menu at all
// (Super Admin always can; a biller needs either the View or Edit toggle).
function canSeeInventoryMenu_() {
  if (state.session.role !== 'biller') return true;
  return state.session.canAccessStockView || state.session.canAccessStockEdit;
}
// True if the signed-in user is allowed to change stock values.
function canEditInventory_() {
  if (state.session.role !== 'biller') return true;
  return state.session.canAccessStockEdit;
}
// True if the signed-in user is allowed to download reports as Excel.
// Reports themselves stay visible to everyone (see REPORTS section below) -
// this only gates the Download Excel button. Super Admin always has it.
function canDownloadReports_() {
  if (state.session.role !== 'biller') return true;
  return !!state.session.canAccessReportDownload;
}
// True if the signed-in user is allowed to see the Dashboard menu.
function canSeeDashboardMenu_() {
  if (state.session.role !== 'biller') return true;
  return !!state.session.canAccessDashboard;
}
// True if the signed-in user is allowed to see the Letterpad menu. Super
// Admin always can; a biller needs their own Letterpad toggle. Nothing on
// the Letterpad is ever sent to the server, so unlike Tax/Bank/Discount
// there is no second, server-side enforcement to mirror this - hiding the
// menu IS the whole permission.
function canSeeLetterpadMenu_() {
  if (state.session.role !== 'biller') return true;
  return !!state.session.canAccessLetterpad;
}
// True if discounts can be used at all right now - needs BOTH the admin's
// master "Show Discount Option" switch in Settings AND this specific
// biller's own Discount access toggle. Super Admin can always use it as
// long as the master switch is on.
function canUseDiscount_() {
  if (state.settings.ShowDiscountOption === false) return false;
  if (state.session.role !== 'biller') return true;
  return !!state.session.canAccessDiscount;
}

function setToggleState_(btnId, labelId, on) {
  const btn = document.getElementById(btnId);
  const label = document.getElementById(labelId);
  if (!btn) return;
  btn.classList.toggle('on', !!on);
  if (label) label.textContent = on ? 'Shown' : 'Hidden';
}

// Shows/hides the per-bill Tax/Bank toggle rows on the Create Bill form so
// they always match the admin's current ShowTaxOnBill/ShowBankDetails
// settings (and, for billers, their individual access flags). Pulled out of
// applyRoleToUI so it can also be re-run right after Admin Settings are
// saved, without re-running the rest of applyRoleToUI's nav/role setup or
// resetting toggles on a bill already in progress.
function refreshBillToggleVisibility_() {
  const taxField = document.getElementById('billTaxToggleField');
  const bankField = document.getElementById('billBankToggleField');
  if (!taxField || !bankField) return;
  if (state.session.role === 'biller') {
    taxField.style.display = (state.session.canAccessTax && state.settings.ShowTaxOnBill !== false) ? '' : 'none';
    bankField.style.display = (state.session.canAccessBank && state.settings.ShowBankDetails !== false) ? '' : 'none';
  } else {
    taxField.style.display = state.settings.ShowTaxOnBill !== false ? '' : 'none';
    bankField.style.display = state.settings.ShowBankDetails !== false ? '' : 'none';
  }
}

function applyRoleToUI() {
  const role = state.session.role;
  const navDash = document.querySelector('.nav-item[data-view="dashboard"]');
  const navLookup = document.querySelector('.nav-item[data-view="lookup"]');
  const navAdmin = document.querySelector('.nav-item[data-view="admin"]');
  const navInventory = document.querySelector('.nav-item[data-view="inventory"]');
  const navLetterpad = document.querySelector('.nav-item[data-view="letterpad"]');
  const reportDownloadBtn = document.getElementById('reportDownloadBtn');
  if (reportDownloadBtn) reportDownloadBtn.style.display = canDownloadReports_() ? '' : 'none';

  if (role === 'biller') {
    if (navDash) navDash.style.display = canSeeDashboardMenu_() ? '' : 'none';
    if (navAdmin) navAdmin.style.display = 'none';
    if (navLookup) navLookup.style.display = state.session.canAccessFindEdit ? '' : 'none';
    if (navInventory) navInventory.style.display = canSeeInventoryMenu_() ? '' : 'none';
    if (navLetterpad) navLetterpad.style.display = canSeeLetterpadMenu_() ? '' : 'none';

    document.getElementById('billerAuthFields').style.display = 'none';
    document.getElementById('billerLockedField').style.display = '';
    document.getElementById('billerLockedText').value = state.session.billerId + ' - ' + state.session.billerName;

    refreshBillToggleVisibility_();
    document.getElementById('billDiscountToggleField').style.display = canUseDiscount_() ? '' : 'none';

    // Guard against a stale tab landing on a now-restricted view after reload.
    const activeBtn = document.querySelector('.nav-item.active');
    const activeView = activeBtn ? activeBtn.dataset.view : 'billing';
    const blocked = (activeView === 'dashboard' && !canSeeDashboardMenu_()) || activeView === 'admin' ||
      (activeView === 'lookup' && !state.session.canAccessFindEdit) ||
      (activeView === 'inventory' && !canSeeInventoryMenu_()) ||
      (activeView === 'letterpad' && !canSeeLetterpadMenu_());
    if (blocked) {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-item[data-view="billing"]').classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-billing').classList.add('active');
    }
  } else {
    if (navDash) navDash.style.display = '';
    if (navAdmin) navAdmin.style.display = '';
    if (navLookup) navLookup.style.display = '';
    if (navInventory) navInventory.style.display = '';
    if (navLetterpad) navLetterpad.style.display = '';

    document.getElementById('billerAuthFields').style.display = 'contents';
    document.getElementById('billerLockedField').style.display = 'none';

    refreshBillToggleVisibility_();
    document.getElementById('billDiscountToggleField').style.display = canUseDiscount_() ? '' : 'none';
  }

  // The "Confirm Identity" re-auth box only makes sense for Super Admin -
  // a biller's own stored session credentials authorize their stock edits
  // silently, same as they already do for Find/Edit Bill.
  const invAuthPanel = document.getElementById('invAdminAuthPanel');
  if (invAuthPanel) invAuthPanel.style.display = (role !== 'biller' && canEditInventory_()) ? '' : 'none';

  // Tax and Discount default OFF on every bill - deliberately NOT inherited
  // from the admin's global settings. Each is asked for, per bill, only to
  // whoever has access. Bank details keep their old "on by default,
  // toggle to hide" behaviour, since that was never the issue raised.
  setToggleState_('f_showTaxToggle', 'f_showTaxLabel', false);
  setToggleState_('f_showBankToggle', 'f_showBankLabel', state.settings.ShowBankDetails !== false);
  setToggleState_('f_showDiscountToggle', 'f_showDiscountLabel', false);
  toggleDiscountFieldsVisibility_(false);
  renderPreview();
}

document.getElementById('f_showTaxToggle').addEventListener('click', () => {
  setToggleState_('f_showTaxToggle', 'f_showTaxLabel', !document.getElementById('f_showTaxToggle').classList.contains('on'));
  renderPreview();
});
document.getElementById('f_showBankToggle').addEventListener('click', () => {
  setToggleState_('f_showBankToggle', 'f_showBankLabel', !document.getElementById('f_showBankToggle').classList.contains('on'));
  renderPreview();
});
document.getElementById('f_showDiscountToggle').addEventListener('click', () => {
  const nowOn = !document.getElementById('f_showDiscountToggle').classList.contains('on');
  setToggleState_('f_showDiscountToggle', 'f_showDiscountLabel', nowOn);
  toggleDiscountFieldsVisibility_(nowOn);
  if (!nowOn) {
    // Switching discount off again clears any values already entered, so
    // nothing lingers half-applied if the biller changes their mind.
    document.getElementById('f_totalDiscountPct').value = '';
    document.querySelectorAll('.row-discount').forEach(inp => { inp.value = ''; });
  }
  renderPreview();
});

// Shows/hides every per-item discount cell plus the bill-level discount
// field in one place - called on toggle click and on initial render.
function toggleDiscountFieldsVisibility_(show) {
  document.querySelectorAll('.row-discount-wrap').forEach(el => { el.style.display = show ? '' : 'none'; });
  const totalDiscWrap = document.getElementById('f_totalDiscountWrap');
  if (totalDiscWrap) totalDiscWrap.style.display = show ? '' : 'none';
}

// -------------------------------------------------------------------------
// 7. PRODUCT ROWS
// -------------------------------------------------------------------------
let rowCounter = 0;
function addProductRow() {
  rowCounter++;
  const id = 'row_' + rowCounter;
  const wrap = document.createElement('div');
  wrap.className = 'product-row';
  wrap.id = id;

  const optionsHtml = state.products.map(p =>
    `<option value="${escapeHtml(p.name)}" data-price="${p.defaultPrice}">${escapeHtml(p.name)}</option>`
  ).join('');

  wrap.innerHTML = `
    <div class="autocomplete-wrap">
      <div class="row-label-line">
        <span class="mini-label">Service/Treatment</span>
        <span class="row-stock-badge"></span>
      </div>
      <input type="text" class="row-product-input" placeholder="Type product name..." autocomplete="off">
      <div class="row-product-dropdown"></div>
    </div>
    <div>
      <span class="mini-label">Price (₹)</span>
      <input type="number" class="row-price" min="0" step="0.01" value="0">
    </div>
    <div>
      <span class="mini-label">Qty</span>
      <input type="number" class="row-qty" min="1" step="1" value="1">
    </div>
    <div class="row-discount-wrap" style="display:none;">
      <span class="mini-label">Discount %</span>
      <input type="number" class="row-discount" min="0" max="100" step="0.01" value="0" placeholder="0">
    </div>
    <div>
      <span class="mini-label">Line Total</span>
      <div class="line-total">₹0.00</div>
    </div>
    <button class="remove-row" title="Remove">✕</button>
  `;
  document.getElementById('productRows').appendChild(wrap);
  decorateInputs_(wrap);

  const nameInput = wrap.querySelector('.row-product-input');
  const dropdown = wrap.querySelector('.row-product-dropdown');
  const priceInput = wrap.querySelector('.row-price');
  const qtyInput = wrap.querySelector('.row-qty');
  const discountInput = wrap.querySelector('.row-discount');
  const lineTotalEl = wrap.querySelector('.line-total');
  const removeBtn = wrap.querySelector('.remove-row');

  // A freshly added row respects whatever the discount toggle is currently
  // set to (so adding a new product line mid-bill doesn't reset it back to hidden).
  const discountToggleOn = document.getElementById('f_showDiscountToggle').classList.contains('on');
  wrap.querySelector('.row-discount-wrap').style.display = discountToggleOn ? '' : 'none';

  function openDropdown(query) {
    const q = query.trim().toLowerCase();
    // Only ACTIVE services are offered while billing. (state.products can
    // also hold inactive ones once Inventory/Admin has loaded the full list.)
    const matches = state.products.filter(p => p.active !== false && String(p.name).toLowerCase().includes(q));
    let html = '';

    if (!q) {
      html = matches.map(p => `<div class="dropdown-item" data-name="${escapeHtml(p.name)}" data-price="${p.defaultPrice}">${escapeHtml(p.name)}</div>`).join('');
    } else {
      html = matches.map(p => `<div class="dropdown-item" data-name="${escapeHtml(p.name)}" data-price="${p.defaultPrice}">${escapeHtml(p.name)}</div>`).join('');
      // Compared against ALL products, so an inactive one is never offered
      // to be "added" again as a duplicate.
      const exactMatch = state.products.some(p => String(p.name).trim().toLowerCase() === q);
      if (!exactMatch) {
        html += `<div class="dropdown-item add-new" data-newname="${escapeHtml(query.trim())}">+ Add "${escapeHtml(query.trim())}" to product list</div>`;
      }
    }

    if (!html) html = '<div class="dropdown-item no-match">No products found</div>';
    dropdown.innerHTML = html;
    dropdown.classList.add('show');
  }

  function closeDropdown() { dropdown.classList.remove('show'); }

  nameInput.addEventListener('focus', () => openDropdown(nameInput.value));
  nameInput.addEventListener('input', () => openDropdown(nameInput.value));
  nameInput.addEventListener('input', refreshAllStockBadges);

  nameInput.addEventListener('blur', () => setTimeout(closeDropdown, 150));

  dropdown.addEventListener('mousedown', async (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;

    if (item.classList.contains('add-new')) {
      const check = vProductName_(item.dataset.newname, 'Service/Treatment name');
      if (check.error) { setFieldError_(nameInput, check.error); toast(check.error, 'error'); closeDropdown(); return; }
      const newName = check.value;
      const r = await apiPost('addProduct', { name: newName, defaultPrice: 0 });
      if (r.ok) {
        state.products.push({ id: r.productId, name: newName, defaultPrice: 0, active: true, stock: null, lowStockThreshold: 5 });
        toast('Product added to the list', 'success');
        nameInput.value = newName;
        priceInput.value = 0;
        closeDropdown();
        recalcRow();
        refreshAllStockBadges();
      } else {
        toast(r.error || 'Failed to add product', 'error');
      }
      return;
    }

    if (item.classList.contains('no-match')) return;

    nameInput.value = item.dataset.name;
    if (item.dataset.price) priceInput.value = item.dataset.price;
    closeDropdown();
    recalcRow();
    refreshAllStockBadges();
  });

  priceInput.addEventListener('input', recalcRow);
  qtyInput.addEventListener('input', recalcRow);
  qtyInput.addEventListener('input', refreshAllStockBadges);
  discountInput.addEventListener('input', recalcRow);
  removeBtn.addEventListener('click', () => { wrap.remove(); recalcTotals(); renderPreview(); refreshAllStockBadges(); });


  function recalcRow() {
    const gross = (Number(priceInput.value) || 0) * (Number(qtyInput.value) || 0);
    const discPct = Math.min(100, Math.max(0, Number(discountInput.value) || 0));
    const total = gross - (gross * discPct / 100);
    lineTotalEl.textContent = formatMoney(total);
    recalcTotals();
    renderPreview();
  }

  refreshAllStockBadges();
}
document.getElementById('addRowBtn').addEventListener('click', addProductRow);

// -------------------------------------------------------------------------
// 7b. LIVE STOCK BADGE (billing screen) - shows "X in stock" next to each
//     product row and updates it *before* the bill is saved, so the biller
//     can see availability drop live as they type quantities. This is a
//     client-side preview only; the real stock number in the sheet is only
//     touched when the bill is actually saved (see saveBill()).
// -------------------------------------------------------------------------
function findProductByName_(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  return state.products.find(p => String(p.name).trim().toLowerCase() === q) || null;
}

function refreshAllStockBadges() {
  const rows = document.querySelectorAll('#productRows .product-row');
  if (!rows.length) return;

  // Sum up requested qty per product name across every row first, since two
  // rows can reference the same product and both need to see the combined
  // draw against stock, not just their own qty.
  const requestedByName = {};
  rows.forEach(row => {
    const name = row.querySelector('.row-product-input').value.trim();
    const qty = Number(row.querySelector('.row-qty').value) || 0;
    if (!name) return;
    const key = name.toLowerCase();
    requestedByName[key] = (requestedByName[key] || 0) + qty;
  });

  rows.forEach(row => {
    const badge = row.querySelector('.row-stock-badge');
    const name = row.querySelector('.row-product-input').value.trim();
    if (!badge) return;
    if (!name) { badge.className = 'row-stock-badge'; badge.textContent = ''; return; }

    const product = findProductByName_(name);
    if (!product || product.stock === null || product.stock === undefined) {
      badge.className = 'row-stock-badge show na';
      badge.textContent = 'Not tracked';
      return;
    }

    const requested = requestedByName[name.toLowerCase()] || 0;
    const remaining = product.stock - requested;
    badge.classList.add('show');
    if (remaining < 0) {
      badge.className = 'row-stock-badge show out';
      badge.textContent = 'Only ' + product.stock + ' in stock (short by ' + Math.abs(remaining) + ')';
    } else if (remaining === 0) {
      badge.className = 'row-stock-badge show out';
      badge.textContent = 'Last ' + product.stock + ' - will be 0 after this bill';
    } else if (remaining <= (product.lowStockThreshold != null ? product.lowStockThreshold : 5)) {
      badge.className = 'row-stock-badge show low';
      badge.textContent = remaining + ' left after this bill';
    } else {
      badge.className = 'row-stock-badge show ok';
      badge.textContent = product.stock + ' in stock';
    }
  });
}

document.getElementById('newProductBtn').addEventListener('click', async () => {
  const rawName = prompt('New service/treatment name:');
  if (rawName === null || !rawName.trim()) return;
  const nameCheck = vProductName_(rawName, 'Service/Treatment name');
  if (nameCheck.error) { toast(nameCheck.error, 'error'); return; }
  const name = nameCheck.value;
  if (findProductByName_(name)) { toast('"' + name + '" is already in the list.', 'error'); return; }
  const rawPrice = prompt('Default price for "' + name + '" (₹):', '0');
  if (rawPrice === null) return;
  const priceCheck = vMoney_(String(rawPrice).trim().replace(/[₹,\s]/g, ''), 'Default price', false);
  if (priceCheck.error) { toast(priceCheck.error, 'error'); return; }
  const r = await apiPost('addProduct', { name, defaultPrice: priceCheck.value });
  if (r.ok) {
    state.products.push({ id: r.productId, name, defaultPrice: priceCheck.value, active: true, stock: null, lowStockThreshold: 5 });
    toast('Product added to the permanent list', 'success');
  } else {
    toast(r.error || 'Failed to add product', 'error');
  }
});

function getLineItems() {
  const discountsOn = document.getElementById('f_showDiscountToggle').classList.contains('on');
  const items = [];
  document.querySelectorAll('#productRows .product-row').forEach(row => {
    const name = row.querySelector('.row-product-input').value.trim();
    const price = Number(row.querySelector('.row-price').value) || 0;
    const qty = Number(row.querySelector('.row-qty').value) || 0;
    const discInput = row.querySelector('.row-discount');
    const discountPercent = (discountsOn && discInput) ? Math.min(100, Math.max(0, Number(discInput.value) || 0)) : 0;
    if (name && qty > 0) items.push({ name, price, qty, discountPercent });
  });
  return items;
}

// The bill-level "additional discount" %, applied on top of any per-item
// discounts - 0 whenever the discount toggle is off, regardless of what's
// sitting in the input (so switching the toggle off always means "no
// discount", not "whatever was last typed there").
function getBillLevelDiscountPct_() {
  const discountsOn = document.getElementById('f_showDiscountToggle').classList.contains('on');
  if (!discountsOn) return 0;
  const el = document.getElementById('f_totalDiscountPct');
  return el ? Math.min(100, Math.max(0, Number(el.value) || 0)) : 0;
}

function recalcTotals() {
  const items = getLineItems();
  const taxOverride = getToggleOverrideForPreview_('billTaxToggleField', 'f_showTaxToggle');
  const totalDiscPct = getBillLevelDiscountPct_();
  const totals = computeBillTotals(items, totalDiscPct, taxOverride);
  document.getElementById('totalQty').textContent = totals.items.reduce((s, i) => s + i.qty, 0);
  document.getElementById('totalAmount').textContent = formatMoney(totals.grandTotal);
  return totals;
}
document.getElementById('f_totalDiscountPct') && document.getElementById('f_totalDiscountPct').addEventListener('input', () => { recalcTotals(); renderPreview(); });

// -------------------------------------------------------------------------
// 8. PATIENT AUTO-MATCH
// -------------------------------------------------------------------------
// A patient = PHONE + NAME together. The same number with a different name
// (e.g. a child on a parent's number) is a different patient and gets its
// own Patient ID. Matching runs once BOTH a valid number and a name are in.
let custLookupTimer = null;
let lastCustLookupKey_ = '';
let matchedKey_ = '';
['f_phone', 'f_customerName'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('blur', () => {
    clearTimeout(custLookupTimer);
    custLookupTimer = setTimeout(tryMatchCustomer, 250);
  });
  // The moment the phone OR the name stops being the one that was matched,
  // the auto-filled Patient ID no longer belongs to this person - clear it,
  // so a bill can never be saved against another family member's ID.
  el.addEventListener('input', () => {
    const idEl = document.getElementById('f_customerId');
    if (currentCustLookupKey_() === matchedKey_ && idEl.value) return;
    if (idEl.value) { idEl.value = ''; renderPreview(); }
    matchedKey_ = '';
    lastCustLookupKey_ = '';
    document.getElementById('custMatchHint').textContent = '';
  });
});

// "9876543210|ramesh kumar" - phone normalised to 10 digits, name compared
// ignoring capitals and extra spaces (same rule as the server).
function currentCustLookupKey_() {
  const phone = normalizeMobile_(document.getElementById('f_phone').value);
  const name = vLine_(document.getElementById('f_customerName').value).toLowerCase();
  return phone + '|' + name;
}

// Shows "already on this number: [Name] [Name]" - tapping a name picks that
// existing patient, so a slightly different spelling never creates a
// duplicate by accident. Built with DOM nodes (names are never parsed as HTML).
function showSamePhoneHint_(hint, list) {
  hint.textContent = '';
  hint.style.color = 'var(--muted)';
  hint.appendChild(document.createTextNode('New patient on this number - a new Patient ID will be created. Already registered on this number: '));
  list.forEach((p, i) => {
    if (i) hint.appendChild(document.createTextNode(', '));
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = p.name + ' (' + p.customerId + ')';
    link.style.color = 'var(--primary)';
    link.style.fontWeight = '600';
    link.addEventListener('click', e => {
      e.preventDefault();
      document.getElementById('f_customerName').value = p.name;
      lastCustLookupKey_ = '';
      tryMatchCustomer();
    });
    hint.appendChild(link);
  });
  hint.appendChild(document.createTextNode(' - tap a name if it is the same person.'));
}

async function tryMatchCustomer() {
  const phoneRaw = document.getElementById('f_phone').value.trim();
  const phone = normalizeMobile_(phoneRaw);
  const name = vLine_(document.getElementById('f_customerName').value);
  // Both are needed to identify a patient. A half-typed number can never
  // match anyone, so wait until it's a complete, valid mobile number.
  if (!/^[6-9]\d{9}$/.test(phone) || name.length < 2) return;
  const key = currentCustLookupKey_();
  // Leaving the second field after a match used to fire the exact same
  // lookup again - skip a repeat of the last lookup.
  if (key === lastCustLookupKey_) return;
  lastCustLookupKey_ = key;
  const hint = document.getElementById('custMatchHint');
  try {
    const r = await apiGet('findCustomer', { phone, name });
    // The person may have kept typing while this was in flight - an answer
    // for an older phone/name must not overwrite the current form.
    if (currentCustLookupKey_() !== key) return;
    if (r.ok && r.found) {
      const c = r.customer;
      document.getElementById('f_customerId').value = c.customerId;
      matchedKey_ = key;
      document.getElementById('f_email').value = c.email || document.getElementById('f_email').value;
      document.getElementById('f_address').value = c.address || document.getElementById('f_address').value;
      document.getElementById('f_deliveryAddress').value = c.deliveryAddress || document.getElementById('f_deliveryAddress').value;
      hint.textContent = 'Existing patient ' + c.customerId + ' matched and auto-filled.';
      hint.style.color = 'var(--success)';
    } else if (r.ok) {
      document.getElementById('f_customerId').value = '';
      matchedKey_ = '';
      if (r.samePhone && r.samePhone.length) {
        showSamePhoneHint_(hint, r.samePhone);
      } else {
        hint.textContent = 'New patient - a Patient ID will be created on save.';
        hint.style.color = 'var(--muted)';
      }
    } else {
      lastCustLookupKey_ = ''; // let the next blur try again
    }
    renderPreview();
  } catch (e) { lastCustLookupKey_ = ''; /* silent - next blur retries */ }
}

// -------------------------------------------------------------------------
// 9. PAYMENT METHOD TOGGLE
// -------------------------------------------------------------------------
document.getElementById('f_paymentMethod').addEventListener('change', updatePaymentNote);
function updatePaymentNote() {
  const method = document.getElementById('f_paymentMethod').value;
  document.getElementById('cashNote').style.display = method === 'Cash' ? 'block' : 'none';
  document.getElementById('bankNote').style.display = method === 'Bank' ? 'block' : 'none';
  renderPreview();
}

// -------------------------------------------------------------------------
// 10. LIVE BILL PREVIEW
// -------------------------------------------------------------------------
['f_date', 'f_customerName', 'f_phone', 'f_email', 'f_address', 'f_deliveryAddress', 'f_paymentMethod']
  .forEach(id => document.getElementById(id).addEventListener('input', renderPreview));

// Every date/time shown in this app is the shop's IST time, not whatever
// timezone the viewing device happens to be set to. Reading the parts back
// out through Intl with timeZone:'Asia/Kolkata' guarantees that even if a
// laptop/phone's own clock or TZ setting is wrong (or someone opens this
// while traveling abroad), the bill's date/time is still correctly IST -
// this is more robust than new Date().getFullYear() etc, which silently
// use whatever timezone the device itself claims to be in.
function getISTParts_(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const get = t => (parts.find(p => p.type === t) || {}).value || '00';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function formatBillDate(val) {
  if (!val) return '-';
  const str = String(val);
  // Already YYYY-MM-DD from date input
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // ISO / Sheet datetime → IST calendar date (not the device's local date)
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    const p = getISTParts_(d);
    return `${p.year}-${p.month}-${p.day}`;
  }
  return str;
}

// Exact IST date + time, e.g. "13 Sep 2026, 06:45 PM IST" - used for real
// event timestamps (bill created/edited) where the time itself matters,
// as opposed to formatBillDate() above which is only ever a calendar date.
const IST_MONTH_NAMES_ = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatISTDateTime_(val) {
  if (!val) return '-';
  const d = new Date(val);
  if (isNaN(d.getTime())) return String(val);
  const p = getISTParts_(d);
  let h = Number(p.hour);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${Number(p.day)} ${IST_MONTH_NAMES_[Number(p.month) - 1]} ${p.year}, ${String(h).padStart(2, '0')}:${p.minute} ${ampm} IST`;
}

function paymentMethodLabel(method) {
  if (method === 'Cash') return 'Cash in Hand';
  if (method === 'Bank') return 'Bank Transaction';
  return method || '-';
}

function buildCompanyHeadHtml(s, billId) {
  const printLogo = s.PrintLogoURL || s.LogoURL || 'https://via.placeholder.com/160x60.png?text=LOGO';
  // Values only - no "Phone:" / "Email:" / "Website:" label words (keeps header neat).
  const metaLines = [];
  if (s.Address) metaLines.push(escapeHtml(s.Address));
  const contactBits = [];
  if (s.Phone) contactBits.push(escapeHtml(s.Phone));
  if (s.ShowCompanyEmail !== false && s.CompanyEmail) contactBits.push(escapeHtml(s.CompanyEmail));
  if (contactBits.length) metaLines.push(contactBits.join(' | '));
  if (s.Website) metaLines.push(escapeHtml(s.Website));
  if (s.GSTNumber) metaLines.push('GSTIN: ' + escapeHtml(s.GSTNumber));

  // Bill typography/layout - same Theme settings this class list is styled
  // by are also read here as inline classes, so the on-screen preview,
  // print, and "Save as PDF" (which all reuse this exact markup - see
  // renderPreview()/renderLookupResult() callers below) always match.
  const isOn = v => String(v == null ? '' : v).trim().toUpperCase() === 'TRUE';
  const nameClasses = ['co-name'];
  if (isOn(s.ThemeBillCompanyNameBold === undefined ? true : s.ThemeBillCompanyNameBold)) nameClasses.push('bill-font-bold');
  if (isOn(s.ThemeBillCompanyNameItalic)) nameClasses.push('bill-font-italic');
  if (isOn(s.ThemeBillCompanyNameUnderline)) nameClasses.push('bill-font-underline');
  const infoClasses = ['co-meta'];
  if (isOn(s.ThemeBillCompanyInfoBold)) infoClasses.push('bill-font-bold');
  if (isOn(s.ThemeBillCompanyInfoItalic)) infoClasses.push('bill-font-italic');
  if (isOn(s.ThemeBillCompanyInfoUnderline)) infoClasses.push('bill-font-underline');
  const layoutTop = (s.ThemeBillHeaderLayout === 'logo-top');

  const nameInfoHtml = `
        <p class="${nameClasses.join(' ')}">${escapeHtml(s.CompanyName || 'SJ Physiotherapy')}</p>
        <div class="${infoClasses.join(' ')}">${metaLines.join('<br>')}</div>`;

  if (layoutTop) {
    return `
    <div class="bill-head bill-head-stacked">
      <div class="bill-head-top">
        <img class="bill-logo" src="${escapeHtml(printLogo)}" alt="logo">
        <div class="bill-tag">
          <div class="bill-tag-label">Invoice</div>
          <div class="big">${escapeHtml(String(billId))}</div>
        </div>
      </div>
      <div class="bill-head-info">${nameInfoHtml}</div>
    </div>`;
  }

  return `
    <div class="bill-head">
      <img class="bill-logo" src="${escapeHtml(printLogo)}" alt="logo">
      <div class="bill-head-info">${nameInfoHtml}</div>
      <div class="bill-tag">
        <div class="bill-tag-label">Invoice</div>
        <div class="big">${escapeHtml(String(billId))}</div>
      </div>
    </div>`;
}

function buildCustomerMetaHtml(opts) {
  const left = [];
  left.push(`<div>Date: <b>${escapeHtml(opts.date)}</b></div>`);
  left.push(`<div>Patient: <b>${escapeHtml(opts.custName)}</b></div>`);
  left.push(`<div>Patient ID: <b>${escapeHtml(opts.custId)}</b></div>`);
  left.push(`<div>Phone: <b>${escapeHtml(opts.phone)}</b></div>`);
  if (opts.email) left.push(`<div>Email: <b>${escapeHtml(opts.email)}</b></div>`);

  const right = [];
  right.push(`<div>Payment Method: <b>${escapeHtml(opts.paymentLabel)}</b></div>`);
  if (opts.address) right.push(`<div>Billing Address: <b>${escapeHtml(opts.address)}</b></div>`);
  if (opts.deliveryAddress) right.push(`<div>Delivery Address: <b>${escapeHtml(opts.deliveryAddress)}</b></div>`);

  return `
    <div class="bill-meta-grid">
      <div class="bill-meta-col">${left.join('')}</div>
      <div class="bill-meta-col">${right.join('')}</div>
    </div>`;
}

function getToggleOverrideForPreview_(fieldId, btnId) {
  const field = document.getElementById(fieldId);
  // No permission = no toggle shown = this bill must never show it, full
  // stop - regardless of what the shop-wide default in Admin Settings
  // says. Returning an explicit false here (not undefined) is what makes
  // this bind correctly: it's not just hiding the control, it's the actual
  // value used both in the live preview AND in what gets permanently saved
  // to this specific bill (see the taxOverride/bankOverride payload built
  // from this same function at save time), so the shop-wide default can
  // never leak through for a biller who was denied access.
  if (!field || field.style.display === 'none') return false;
  return document.getElementById(btnId).classList.contains('on');
}

function renderPreview() {
  const totals = recalcTotals();
  const totalQty = totals.items.reduce((s, i) => s + i.qty, 0);
  const s = state.settings || {};
  const billId = document.getElementById('f_billId').value || '(will be generated on save)';
  const date = formatBillDate(document.getElementById('f_date').value);
  const custName = document.getElementById('f_customerName').value || '-';
  const custId = document.getElementById('f_customerId').value || '(new)';
  const phone = document.getElementById('f_phone').value || '-';
  const email = document.getElementById('f_email').value || '';
  const address = document.getElementById('f_address').value || '';
  const deliveryAddress = document.getElementById('f_deliveryAddress').value || '';
  const paymentMethod = document.getElementById('f_paymentMethod').value;

  const billerSel = document.getElementById('f_billerId');
  const billerName = state.session.role === 'biller'
    ? state.session.billerName
    : (billerSel && billerSel.value
        ? ((state.billers.find(b => b.billerId === billerSel.value) || {}).name || billerSel.value)
        : '-');

  const bankOverride = getToggleOverrideForPreview_('billBankToggleField', 'f_showBankToggle');
  const { totalsHtml, footHtml } = buildBillTotalsAndFooterHtml(totals, totalQty, s, billerName, '', bankOverride);

  const paper = document.getElementById('billPaper');
  paper.innerHTML = `
    ${buildCompanyHeadHtml(s, billId)}
    ${buildCustomerMetaHtml({
      date, custName, custId, phone, email,
      paymentLabel: paymentMethodLabel(paymentMethod),
      address, deliveryAddress
    })}
    ${buildBillItemsTableHtml(totals)}
    ${totalsHtml}
    ${footHtml}
  `;
  fitBillScale_('billScaleOuter', 'billPaper');
}

// -------------------------------------------------------------------------
// 11. SAVE BILL
// -------------------------------------------------------------------------
document.getElementById('saveBillBtn').addEventListener('click', saveBill);

function checkStockShortages_(items) {
  const requested = {};
  (items || []).forEach(it => {
    const key = String(it.name).trim().toLowerCase();
    requested[key] = (requested[key] || 0) + (Number(it.qty) || 0);
  });
  const shortages = [];
  Object.keys(requested).forEach(key => {
    const product = findProductByName_(key);
    if (product && product.stock !== null && product.stock !== undefined && requested[key] > product.stock) {
      shortages.push({ name: product.name, available: product.stock, requested: requested[key] });
    }
  });
  return shortages;
}

// Mirrors the backend's stock deduction locally so every screen (the
// billing row badges, and the Inventory menu) reflects the new numbers
// immediately, without waiting for a fresh fetch from the sheet.
function applyLocalStockDeduction_(items) {
  (items || []).forEach(it => {
    const product = findProductByName_(it.name);
    if (product && product.stock !== null && product.stock !== undefined) {
      // Not clamped to zero on purpose - if a shortage warning was
      // overridden, the Inventory menu should honestly show the resulting
      // negative count as an "oversold" flag rather than hide it.
      product.stock = product.stock - (Number(it.qty) || 0);
    }
  });
}

// Full check of the Create Bill form. Marks every problem field at once and
// returns the cleaned values that actually get sent (trimmed, phone reduced
// to 10 digits, etc.) - the server re-checks the same rules on its side.
function validateBillForm() {
  clearErrorsIn_(document.getElementById('view-billing'));
  const discountsOn = document.getElementById('f_showDiscountToggle').classList.contains('on');
  const checks = [
    ['f_date', vDate_(document.getElementById('f_date').value, 'Date'), 'date'],
    ['f_customerName', vPersonName_(document.getElementById('f_customerName').value, 'Patient Name', true), 'customerName'],
    ['f_phone', vMobile_(document.getElementById('f_phone').value, 'Phone Number', true), 'phone'],
    ['f_email', vEmail_(document.getElementById('f_email').value, 'Email', false), 'email'],
    ['f_address', vAddress_(document.getElementById('f_address').value, 'Address'), 'address'],
    ['f_deliveryAddress', vAddress_(document.getElementById('f_deliveryAddress').value, 'Delivery Address'), 'deliveryAddress']
  ];
  if (discountsOn) checks.push(['f_totalDiscountPct', vPercent_(document.getElementById('f_totalDiscountPct').value, 'Additional Discount %'), 'discountPercent']);

  // Line items - every filled-in row must be complete and sensible. A row
  // left completely untouched (no service, price 0) is simply ignored, as
  // before. A row with a price but no service is flagged instead of being
  // silently dropped from the bill.
  const items = [];
  let n = 0;
  document.querySelectorAll('#productRows .product-row').forEach(row => {
    n++;
    const nameEl = row.querySelector('.row-product-input');
    const priceEl = row.querySelector('.row-price');
    const qtyEl = row.querySelector('.row-qty');
    const discEl = row.querySelector('.row-discount');
    const nameRaw = vLine_(nameEl.value);
    const priceRaw = priceEl.value;
    if (!nameRaw) {
      if (Number(priceRaw) > 0) checks.push([nameEl, vRes_('', 'Line ' + n + ': choose a service/treatment, or remove this line with ✕.')]);
      return;
    }
    const known = findProductByName_(nameRaw);
    const nameRes = known ? vRes_(nameRaw) : vProductName_(nameRaw, 'Line ' + n + ' service/treatment');
    const priceRes = vMoney_(priceRaw, 'Line ' + n + ' price', true);
    const qtyRes = vInt_(qtyEl.value, 'Line ' + n + ' qty', 1, VLIMIT.QTY_MAX, true);
    const discRes = discountsOn ? vPercent_(discEl ? discEl.value : 0, 'Line ' + n + ' discount %') : vRes_(0);
    checks.push([nameEl, nameRes], [priceEl, priceRes], [qtyEl, qtyRes]);
    if (discountsOn && discEl) checks.push([discEl, discRes]);
    if (!nameRes.error && !priceRes.error && !qtyRes.error && !discRes.error) {
      items.push({ name: nameRes.value, price: priceRes.value, qty: qtyRes.value, discountPercent: discRes.value });
    }
  });

  const result = applyChecks_(checks);
  if (!result.ok) { toast(result.firstError, 'error'); return null; }
  if (!items.length) { toast('Add at least one service/treatment line.', 'error'); return null; }
  if (items.length > VLIMIT.ITEMS_MAX) { toast('A bill can have at most ' + VLIMIT.ITEMS_MAX + ' lines.', 'error'); return null; }
  result.values.items = items;
  if (!discountsOn) result.values.discountPercent = 0;
  return result.values;
}

async function saveBill() {
  const statusEl = document.getElementById('billerStatus');
  statusEl.textContent = ''; statusEl.className = 'biller-status';

  const clean = validateBillForm();
  if (!clean) return;

  let billerId, billerPassword;
  if (state.session.role === 'biller') {
    billerId = state.session.billerId;
    billerPassword = state.session.billerPassword;
  } else {
    billerId = document.getElementById('f_billerId').value;
    billerPassword = document.getElementById('f_billerPassword').value;
    if (!billerId || !billerPassword) {
      statusEl.textContent = 'Biller ID and password are required to save the bill.';
      statusEl.className = 'biller-status err';
      return;
    }
  }

  const taxOverride = getToggleOverrideForPreview_('billTaxToggleField', 'f_showTaxToggle');
  const bankOverride = getToggleOverrideForPreview_('billBankToggleField', 'f_showBankToggle');

  const payload = {
    date: clean.date,
    customerId: document.getElementById('f_customerId').value || '',
    customerName: clean.customerName,
    phone: clean.phone,
    email: clean.email,
    address: clean.address,
    deliveryAddress: clean.deliveryAddress,
    paymentMethod: document.getElementById('f_paymentMethod').value,
    items: clean.items,
    billerId, billerPassword,
    taxOverride: taxOverride === undefined ? '' : (taxOverride ? 'TRUE' : 'FALSE'),
    bankOverride: bankOverride === undefined ? '' : (bankOverride ? 'TRUE' : 'FALSE'),
    discountPercent: clean.discountPercent,
    saveToken: billSaveToken_
  };

  // Soft stock-shortage guard: warn (don't silently block) if this bill
  // would take a tracked product below zero - the biller can still choose
  // to proceed (e.g. counting error, or stock arriving same day).
  const shortages = checkStockShortages_(payload.items);
  if (shortages.length) {
    const msg = shortages.map(s => s.name + ': only ' + s.available + ' in stock, this bill needs ' + s.requested).join('\n');
    if (!confirm('Stock warning - this bill goes below available stock for:\n\n' + msg + '\n\nSave the bill anyway?')) {
      return;
    }
  }

  const btn = document.getElementById('saveBillBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const r = await apiPost('saveBill', payload);
    if (!r.ok) {
      statusEl.textContent = r.error || 'Failed to save bill.';
      statusEl.className = 'biller-status err';
      if (r.dbFull) {
        openDbFullModal_({ percentUsed: null });
      } else {
        markServerFieldError_(r, BILL_FIELD_IDS_);
        toast(r.error || 'Failed to save bill', 'error');
      }
      return;
    }
    statusEl.textContent = 'Bill saved successfully as ' + r.billId + '.';
    statusEl.className = 'biller-status ok';
    document.getElementById('f_billId').value = r.billId;
    document.getElementById('f_customerId').value = r.customerId;
    document.getElementById('footBilledBy') && (document.getElementById('footBilledBy').textContent =
      billerId + ' (' + (state.billers.find(b => b.billerId === billerId) || {}).name + ')');
    state.lastSavedBill = r;

    // Mirror the backend's stock deduction locally so the badges on this
    // screen - and the Inventory menu, if the biller flips over to it -
    // reflect the new numbers immediately, without a round trip.
    applyLocalStockDeduction_(payload.items);
    refreshAllStockBadges();
    if (document.getElementById('view-inventory').classList.contains('active')) renderInventoryTable();

    const badge = document.getElementById('statusBadge');
    badge.style.display = 'inline-block';
    badge.textContent = 'Cash Collected'; badge.className = 'badge cash';
    toast('Bill ' + r.billId + ' saved!', 'success');
    renderPreview();
    document.getElementById('footBilledBy') && (document.getElementById('footBilledBy').textContent = billerId);

    // Freeze exactly what's on screen right now into the print snapshot,
    // and point printing at it. This is what actually gets printed/PDF'd
    // from the Share popup - even minutes from now, even after the form
    // below has already reset itself for the next bill.
    document.getElementById('printSnapshot').innerHTML = document.getElementById('billPaper').innerHTML;
    document.body.setAttribute('data-print-target', 'printSnapshot');

    openShareModal(r.billId, 'Bill ' + r.billId + ' saved! Share it?', {
      customerName: payload.customerName,
      date: formatBillDate(payload.date),
      items: payload.items,
      totalDiscountPct: payload.discountPercent || 0,
      taxOverride: payload.taxOverride === 'TRUE',
      paymentMethod: payload.paymentMethod,
      phone: payload.phone,
      email: payload.email
    });

    setTimeout(resetBillingForm, 1500);
  } catch (err) {
    // Safe to retry: the same saveToken goes with it, so if the first
    // attempt DID reach the server, the retry returns that same bill
    // instead of creating a duplicate.
    statusEl.textContent = 'Could not confirm the save (connection problem). Press Save again - it will not create a duplicate bill.';
    statusEl.className = 'biller-status err';
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Generate Bill';
  }
}




// Server-side rejections name the field they're about (r.field) - show the
// message right under that field, the same as a browser-side check would.
const BILL_FIELD_IDS_ = {
  date: 'f_date', customerName: 'f_customerName', phone: 'f_phone', email: 'f_email',
  address: 'f_address', deliveryAddress: 'f_deliveryAddress', discountPercent: 'f_totalDiscountPct'
};
function markServerFieldError_(r, idMap) {
  if (!r || !r.field || !idMap || !idMap[r.field]) return;
  const el = document.getElementById(idMap[r.field]);
  if (el) { setFieldError_(el, r.error || 'Please check this field.'); try { el.focus(); } catch (e) { /* ignore */ } }
}

async function resetBillingForm() {
  // clear all product rows
  document.getElementById('productRows').innerHTML = '';
  rowCounter = 0;

  // clear customer & bill detail fields
  document.getElementById('f_customerName').value = '';
  document.getElementById('f_phone').value = '';
  document.getElementById('f_email').value = '';
  document.getElementById('f_address').value = '';
  document.getElementById('f_deliveryAddress').value = '';
  document.getElementById('f_customerId').value = '';
  document.getElementById('custMatchHint').textContent = '';
  document.getElementById('f_paymentMethod').value = 'Cash';
  document.getElementById('f_billerPassword').value = '';
  document.getElementById('f_totalDiscountPct').value = '';

  // clear any red "required field" highlights
  document.querySelectorAll('.field.has-error').forEach(f => f.classList.remove('has-error'));

  // clear status message and badge from the previous bill
  document.getElementById('billerStatus').textContent = '';
  document.getElementById('billerStatus').className = 'biller-status';
  document.getElementById('statusBadge').style.display = 'none';

  // fetch a fresh Bill ID for the next bill - also picks up any access
  // changes Super Admin made mid-session (e.g. revoking this biller's
  // tax/bank access), so the very next bill already reflects it.
  try {
    const r = await apiGet('bootstrap');
    if (r.ok) {
      state.products = r.products;
      state.customers = r.customers || [];
      state.billers = r.billers;
      document.getElementById('f_billId').value = r.nextBillId;
      syncBillerPermissionsFromRoster_();
    }
  } catch (err) { /* keep old bill id shown if this fails */ }

  setBillDateToday_();
  billSaveToken_ = newSaveToken_(); // the next bill is a different bill
  lastCustLookupKey_ = ''; matchedKey_ = '';
  clearErrorsIn_(document.getElementById('view-billing'));
  applyRoleToUI(); // also resets Tax/Bank/Discount toggles to their per-bill defaults
  addProductRow();
  recalcTotals();
  renderPreview();
}






// -------------------------------------------------------------------------
// 12. (Download/Print PDF from the Create Bill screen was removed here -
//     it now lives in the post-save Share Bill popup, see SHARE BILL
//     section below. This closes the "print an unsaved bill" gap: nothing
//     can be printed or PDF'd until a bill actually has a BillID.)
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// 13. DASHBOARD - six independent widgets, each with its own filter
//     (Filter By: Customer ID / Product, Filter Value with live-search
//     autocomplete, and an optional Date Range). A widget only sends a
//     dimension filter (customerId/product) to the server once BOTH
//     "Filter By" and "Filter Value" are set; until then it behaves as
//     unfiltered on that dimension. Date Range can be applied on its own
//     at any time. A "Clear Filter" button appears once any filter
//     (dimension and/or date) is active on that widget.
// -------------------------------------------------------------------------
const DASH_WIDGET_KEYS = ['sc', 'sa', 'qs', 'uc', 'pc', 'bb', 'pm'];

document.getElementById('refreshDashboardBtn').addEventListener('click', loadDashboard);

function todayLocalStr_() {
  const p = getISTParts_(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

// A bill can be back-dated but never future-dated: the date picker itself
// stops at today (IST), and the save check enforces the same.
function setBillDateToday_() {
  const el = document.getElementById('f_date');
  const today = todayLocalStr_();
  el.value = today;
  el.setAttribute('max', today);
  el.setAttribute('min', '2000-01-01');
}

function chartFilterTemplate_(key) {
  return `
    <div class="cf-row">
      <span class="cf-pill">Filter By</span>
      <select class="cf-select" id="${key}_filterBy">
        <option value="">None</option>
        <option value="customer">Patient ID</option>
        <option value="product">Service / Treatment</option>
      </select>
    </div>
    <div class="cf-row">
      <span class="cf-pill">Filter Value</span>
      <div class="cf-input-wrap">
        <input type="text" class="cf-input" id="${key}_filterValueInput" placeholder="Select Filter By first" disabled autocomplete="off">
        <input type="hidden" id="${key}_filterValueHidden">
        <div class="cf-dropdown" id="${key}_filterDropdown"></div>
      </div>
    </div>
    <div class="cf-row cf-daterow">
      <span class="cf-pill">Date Range</span>
    </div>
    <div class="cf-date-inputs">
      <input type="date" class="cf-date" id="${key}_dateFrom" title="From date">
      <input type="date" class="cf-date" id="${key}_dateTo" title="To date">
    </div>
    <button type="button" class="cf-clear" id="${key}_clearBtn">&#10005; Clear Filter</button>
  `;
}

function initDashboardFilters() {
  document.querySelectorAll('.chart-filter[data-key]').forEach(panel => {
    const key = panel.dataset.key;
    panel.innerHTML = chartFilterTemplate_(key);
    wireChartFilter_(key);
  });
}

function wireChartFilter_(key) {
  const byEl = document.getElementById(key + '_filterBy');
  const valInput = document.getElementById(key + '_filterValueInput');
  const valHidden = document.getElementById(key + '_filterValueHidden');
  const dropdown = document.getElementById(key + '_filterDropdown');
  const fromEl = document.getElementById(key + '_dateFrom');
  const toEl = document.getElementById(key + '_dateTo');
  const clearBtn = document.getElementById(key + '_clearBtn');
  const today = todayLocalStr_();
  fromEl.setAttribute('max', today);
  toEl.setAttribute('max', today);

  function openFilterDropdown(query) {
    const mode = byEl.value;
    if (!mode) { dropdown.classList.remove('show'); return; }
    const raw = query.trim();
    const q = raw.toLowerCase();
    let html = '';
    if (mode === 'customer') {
      const customers = state.customers || [];
      const matches = !q ? customers : customers.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        String(c.id || '').toLowerCase().includes(q) ||
        String(c.phone || '').includes(q));
      html = matches.slice(0, 40).map(c =>
        `<div class="dropdown-item" data-value="${escapeHtml(String(c.id))}" data-label="${escapeHtml(String(c.id))} - ${escapeHtml(c.name)}">
           <b>${escapeHtml(String(c.id))}</b> - ${escapeHtml(c.name)}${c.phone ? ' &middot; ' + escapeHtml(String(c.phone)) : ''}
         </div>`).join('');
      // Always offer a manual fallback so the filter never gets stuck -
      // whether the patient list is still loading, genuinely empty, or
      // simply doesn't contain what was typed (e.g. an exact Patient ID
      // the user already knows, like "PAT-0001").
      if (raw) {
        const exact = customers.some(c => String(c.id).toLowerCase() === q);
        if (!exact) {
          html += `<div class="dropdown-item add-new" data-value="${escapeHtml(raw)}" data-label="${escapeHtml(raw)}">Use "${escapeHtml(raw)}" as Patient ID</div>`;
        }
      }
      if (!html) html = '<div class="dropdown-item no-match">Start typing a patient name, ID or phone…</div>';
    } else if (mode === 'product') {
      const products = state.products || [];
      const matches = !q ? products : products.filter(p => p.name.toLowerCase().includes(q));
      html = matches.slice(0, 40).map(p =>
        `<div class="dropdown-item" data-value="${escapeHtml(p.name)}" data-label="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>`).join('');
      if (raw) {
        const exact = products.some(p => p.name.toLowerCase() === q);
        if (!exact) {
          html += `<div class="dropdown-item add-new" data-value="${escapeHtml(raw)}" data-label="${escapeHtml(raw)}">Use "${escapeHtml(raw)}" as Product</div>`;
        }
      }
      if (!html) html = '<div class="dropdown-item no-match">Start typing a product name…</div>';
    }
    dropdown.innerHTML = html;
    dropdown.classList.add('show');
  }

  byEl.addEventListener('change', () => {
    valInput.value = ''; valHidden.value = '';
    dropdown.classList.remove('show');
    if (byEl.value) {
      valInput.disabled = false;
      valInput.placeholder = byEl.value === 'customer' ? 'Type patient name, ID or phone…' : 'Type product name…';
    } else {
      valInput.disabled = true;
      valInput.placeholder = 'Select Filter By first';
    }
    fetchAndRenderWidget(key);
  });

  valInput.addEventListener('focus', () => { if (byEl.value) openFilterDropdown(valInput.value); });
  valInput.addEventListener('input', () => { valHidden.value = ''; openFilterDropdown(valInput.value); });
  valInput.addEventListener('blur', () => setTimeout(() => dropdown.classList.remove('show'), 150));

  dropdown.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item || !item.dataset.value) return;
    valInput.value = item.dataset.label;
    valHidden.value = item.dataset.value;
    dropdown.classList.remove('show');
    fetchAndRenderWidget(key);
  });

  function clampFuture(el) {
    if (el.value && el.value > today) el.value = today;
  }
  fromEl.addEventListener('change', () => {
    clampFuture(fromEl);
    if (toEl.value && fromEl.value && fromEl.value > toEl.value) toEl.value = fromEl.value;
    fetchAndRenderWidget(key);
  });
  toEl.addEventListener('change', () => {
    clampFuture(toEl);
    if (fromEl.value && toEl.value && toEl.value < fromEl.value) fromEl.value = toEl.value;
    fetchAndRenderWidget(key);
  });

  clearBtn.addEventListener('click', () => {
    byEl.value = '';
    valInput.value = ''; valHidden.value = '';
    valInput.disabled = true; valInput.placeholder = 'Select Filter By first';
    fromEl.value = ''; toEl.value = '';
    dropdown.classList.remove('show');
    fetchAndRenderWidget(key);
  });
}

// Reads one widget's filter panel into the request params the server expects.
// Returns null if the panel isn't built yet.
function widgetParams_(key) {
  const byEl = document.getElementById(key + '_filterBy');
  if (!byEl) return null;
  const filterBy = byEl.value;
  const filterValue = document.getElementById(key + '_filterValueHidden').value;
  const dateFrom = document.getElementById(key + '_dateFrom').value;
  const dateTo = document.getElementById(key + '_dateTo').value;
  const params = {};
  if (dateFrom) params.dateFrom = dateFrom;
  if (dateTo) params.dateTo = dateTo;
  if (filterBy === 'customer' && filterValue) params.customerId = filterValue;
  if (filterBy === 'product' && filterValue) params.product = filterValue;
  const active = !!(dateFrom || dateTo || (filterBy && filterValue));
  document.getElementById(key + '_clearBtn').classList.toggle('show', active);
  return params;
}

// Each widget remembers its latest request. If filters are changed quickly,
// an older (slower) answer arriving last can no longer overwrite the newer one.
const widgetRequestSeq_ = {};

// Fetches once for a GROUP of widgets that share identical filters, then
// renders each of them from that single answer.
async function fetchWidgetGroup_(keys, params) {
  const seqs = {};
  keys.forEach(key => {
    seqs[key] = (widgetRequestSeq_[key] = (widgetRequestSeq_[key] || 0) + 1);
    const card = document.querySelector('.dash-card[data-widget="' + key + '"]');
    if (card) card.classList.add('loading');
  });
  console.log('[dashboard]', keys.join(','), 'requesting with params:', params);
  try {
    const r = await apiGet('getDashboardData', params);
    if (!r.ok) { toast('Failed to load dashboard data', 'error'); return; }
    checkBackendBuild_(r.serverBuild);
    console.log('[dashboard]', keys.join(','), 'server saw:', r.data && r.data.debug, '| mode:', r.data && r.data.mode);
    keys.forEach(key => { if (widgetRequestSeq_[key] === seqs[key]) renderWidgetResult_(key, r.data); });
  } catch (err) {
    toast('Failed to load dashboard data', 'error');
  } finally {
    keys.forEach(key => {
      if (widgetRequestSeq_[key] !== seqs[key]) return; // a newer request owns the spinner now
      const card = document.querySelector('.dash-card[data-widget="' + key + '"]');
      if (card) card.classList.remove('loading');
    });
  }
}

async function fetchAndRenderWidget(key) {
  const params = widgetParams_(key);
  if (!params) return; // panels not yet initialized
  return fetchWidgetGroup_([key], params);
}

function renderWidgetResult_(key, d) {
  if (key === 'sc') setKpi('kpiSalesCount', d.totalSalesCount);
  else if (key === 'sa') setKpi('kpiSalesAmount', '₹' + (d.totalSalesAmount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }));
  else if (key === 'qs') setKpi('kpiQtySold', d.totalQtySold);
  else if (key === 'uc') setKpi('kpiCustomers', d.uniqueCustomers);
  else if (key === 'pc') drawBarChart(d.productChart || []);
  else if (key === 'bb') drawDonutChart(d.billerChart || []);
  else if (key === 'pm') {
    const pal = (state.themeChartPalette && state.themeChartPalette.length) ? state.themeChartPalette : ['#E1341E', '#a8d339', '#AE2314'];
    drawPieChart([
      { label: 'Cash', value: d.cashAmount || 0, color: pal[0] },
      { label: 'Bank', value: d.bankAmount || 0, color: pal[1] }
    ]);
  }
}

function setKpi(elId, value) {
  document.getElementById(elId).textContent = value;
}

// Opening the Dashboard used to send SEVEN identical requests at once (one
// per widget) - each making the server re-read every bill and bill line.
// Widgets with the same filters (normally all of them) now share ONE
// request; only a widget with its own filter gets its own.
function loadDashboard() {
  const groups = {};
  DASH_WIDGET_KEYS.forEach(key => {
    const params = widgetParams_(key);
    if (!params) return;
    const sig = JSON.stringify(Object.keys(params).sort().map(k => [k, params[k]]));
    (groups[sig] = groups[sig] || { params: params, keys: [] }).keys.push(key);
  });
  Object.keys(groups).forEach(sig => fetchWidgetGroup_(groups[sig].keys, groups[sig].params));
  loadCustomCharts();
}

function drawBarChart(items) {
  const container = document.getElementById('productBarChart');
  if (!items.length) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">No data for this filter.</p>'; return; }

  const palette = (state.themeChartPalette && state.themeChartPalette.length) ? state.themeChartPalette : ['#E1341E', '#a8d339', '#AE2314', '#F2A65A', '#8C2F39', '#4B5A57'];
  function colorForIndex(i) { return palette[i % palette.length]; }
  const maxQty = Math.max(...items.map(i => i.qty), 1);
  const barW = 46, gap = 22, chartH = 200, leftPad = 10;
  const labelSpace = 120; // room below the bars for the vertical product-name label
  const width = items.length * (barW + gap) + leftPad * 2;
  let bars = '';
  items.forEach((it, idx) => {
    const h = Math.max(4, (it.qty / maxQty) * (chartH - 40));
    const x = leftPad + idx * (barW + gap);
    const y = chartH - h - 24;
    const color = colorForIndex(idx);
    const labelX = x + barW / 2;
    const labelY = chartH + 6;
    bars += `
      <g>
        <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="6" fill="${color}"></rect>
        <text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" font-size="12" font-weight="700" fill="#182322">${it.qty}</text>
        <text x="${x + barW / 2}" y="${chartH - 6}" text-anchor="middle" font-size="10" fill="#8A9A96">₹${Math.round(it.amount)}</text>
        <text x="${labelX}" y="${labelY}" text-anchor="start" transform="rotate(90 ${labelX} ${labelY})" font-size="10" fill="#4B5A57">${escapeHtml(truncate(String(it.name), 18))}</text>
      </g>`;
  });
  container.innerHTML = `<svg viewBox="0 0 ${width} ${chartH + labelSpace}" width="100%" style="max-width:${width}px; overflow:visible;">${bars}</svg>`;
}

function drawPieChart(items) {
  const container = document.getElementById('paymentPieChart');
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">No payment data yet.</p>'; return; }
  const r = 70, cx = 90, cy = 90;
  let angleStart = -90, paths = '';
  // A slice that is the ONLY non-zero one (100% share) has its arc start
  // and end point land on the exact same spot, which draws an invisible
  // zero-length path. Draw a plain full circle for that case instead.
  const nonZero = items.filter(i => i.value > 0);
  if (nonZero.length === 1) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${nonZero[0].color}"></circle>`;
  } else {
    items.forEach(it => {
      if (it.value <= 0) return;
      const frac = it.value / total;
      const angleEnd = angleStart + frac * 360;
      paths += describeArc(cx, cy, r, angleStart, angleEnd, it.color);
      angleStart = angleEnd;
    });
  }
  const legend = items.map(it =>
    `<div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:4px;">
      <span style="width:10px;height:10px;border-radius:3px;background:${it.color};display:inline-block;"></span>
      ${escapeHtml(it.label)}: ₹${it.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${Math.round(it.value / total * 100)}%)
    </div>`).join('');
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
      <svg width="180" height="180" viewBox="0 0 180 180">${paths}</svg>
      <div>${legend}</div>
    </div>`;
}

function drawDonutChart(items) {
  const container = document.getElementById('billerDonutChart');
  if (!container) return;
  const palette = (state.themeChartPalette && state.themeChartPalette.length) ? state.themeChartPalette : ['#E1341E', '#a8d339', '#AE2314', '#F2A65A', '#8C2F39', '#4B5A57', '#2E86AB', '#6C4FB6'];
  const withColor = items.map((it, idx) => ({ label: it.label, value: it.value, amount: it.amount || 0, color: palette[idx % palette.length] }));
  const total = withColor.reduce((s, i) => s + i.value, 0);
  if (!total) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">No biller data yet.</p>'; return; }
  const r = 70, hole = 40, cx = 90, cy = 90;
  let angleStart = -90, paths = '';
  // Same single-slice edge case as the pie chart above.
  const nonZero = withColor.filter(i => i.value > 0);
  if (nonZero.length === 1) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${nonZero[0].color}"></circle>`;
  } else {
    withColor.forEach(it => {
      if (it.value <= 0) return;
      const frac = it.value / total;
      const angleEnd = angleStart + frac * 360;
      paths += describeArc(cx, cy, r, angleStart, angleEnd, it.color);
      angleStart = angleEnd;
    });
  }
  // Punch a hole in the middle so the pie reads as a donut.
  paths += `<circle cx="${cx}" cy="${cy}" r="${hole}" fill="#FFFFFF"></circle>`;
  const legend = withColor.map(it =>
    `<div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:4px;">
      <span style="width:10px;height:10px;border-radius:3px;background:${it.color};display:inline-block;"></span>
      ${escapeHtml(it.label)}: ₹${it.amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })} - ${it.value} bill${it.value === 1 ? '' : 's'} (${Math.round(it.value / total * 100)}%)
    </div>`).join('');
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
      <svg width="180" height="180" viewBox="0 0 180 180">${paths}</svg>
      <div>${legend}</div>
    </div>`;
}

function describeArc(cx, cy, r, startAngle, endAngle, color) {
  const s = polarToCartesian(cx, cy, r, endAngle);
  const e = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `<path d="M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 0 ${e.x} ${e.y} Z" fill="${color}"></path>`;
}
function polarToCartesian(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

// -------------------------------------------------------------------------
// 13b. CUSTOM DASHBOARD CHARTS - Super Admin builds these on top of the
// fixed default widgets above. See apiGetCustomChartData in Code.gs for the
// actual aggregation; everything here is just fetching + drawing + the
// builder form. Reuses the exact same SVG techniques as the default bar/
// pie/donut charts (describeArc/polarToCartesian above), just generalized
// to work off plain labels[]/values[] instead of the default widgets'
// specific data shape.
// -------------------------------------------------------------------------
function formatChartNumber_(n, isMoney) {
  n = Number(n) || 0;
  const rounded = Math.round(n);
  return (isMoney ? '\u20B9' : '') + rounded.toLocaleString('en-IN');
}

function drawGenericBarChart(container, labels, values, isMoney) {
  if (!labels.length) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">No data yet.</p>'; return; }
  const palette = (state.themeChartPalette && state.themeChartPalette.length) ? state.themeChartPalette : ['#E1341E', '#a8d339', '#AE2314', '#F2A65A', '#8C2F39', '#4B5A57'];
  const maxVal = Math.max.apply(null, values.concat([1]));
  const barW = 46, gap = 22, chartH = 200, leftPad = 10;
  const labelSpace = 120;
  const width = labels.length * (barW + gap) + leftPad * 2;
  let bars = '';
  labels.forEach((label, idx) => {
    const val = values[idx];
    const h = Math.max(4, (val / maxVal) * (chartH - 40));
    const x = leftPad + idx * (barW + gap);
    const y = chartH - h - 24;
    const color = palette[idx % palette.length];
    const labelX = x + barW / 2;
    const labelY = chartH + 6;
    bars += `
      <g>
        <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="6" fill="${color}"></rect>
        <text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" font-size="11" font-weight="700" fill="#182322">${formatChartNumber_(val, isMoney)}</text>
        <text x="${labelX}" y="${labelY}" text-anchor="start" transform="rotate(90 ${labelX} ${labelY})" font-size="10" fill="#4B5A57">${escapeHtml(truncate(label, 18))}</text>
      </g>`;
  });
  container.innerHTML = `<svg viewBox="0 0 ${width} ${chartH + labelSpace}" width="100%" style="max-width:${width}px; overflow:visible;">${bars}</svg>`;
}

function drawGenericPieOrDonut_(container, labels, values, isDonut, isMoney) {
  const palette = (state.themeChartPalette && state.themeChartPalette.length) ? state.themeChartPalette : ['#E1341E', '#a8d339', '#AE2314', '#F2A65A', '#8C2F39', '#4B5A57'];
  const total = values.reduce((s, v) => s + v, 0);
  if (!total) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;">No data yet.</p>'; return; }
  const items = labels.map((label, i) => ({ label, value: values[i], color: palette[i % palette.length] }));
  const r = 70, hole = isDonut ? 40 : 0, cx = 90, cy = 90;
  let angleStart = -90, paths = '';
  const nonZero = items.filter(i => i.value > 0);
  if (nonZero.length === 1) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${nonZero[0].color}"></circle>`;
  } else {
    items.forEach(it => {
      if (it.value <= 0) return;
      const frac = it.value / total;
      const angleEnd = angleStart + frac * 360;
      paths += describeArc(cx, cy, r, angleStart, angleEnd, it.color);
      angleStart = angleEnd;
    });
  }
  if (isDonut) paths += `<circle cx="${cx}" cy="${cy}" r="${hole}" fill="#FFFFFF"></circle>`;
  const legend = items.map(it =>
    `<div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:4px;">
      <span style="width:10px;height:10px;border-radius:3px;background:${it.color};display:inline-block;"></span>
      ${escapeHtml(it.label)}: ${formatChartNumber_(it.value, isMoney)} (${Math.round(it.value / total * 100)}%)
    </div>`).join('');
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
      <svg width="180" height="180" viewBox="0 0 180 180">${paths}</svg>
      <div>${legend}</div>
    </div>`;
}

function drawNumberCard_(container, total, isMoney, color) {
  const safeColor = /^#[0-9A-Fa-f]{6}$/.test(String(color || '')) ? color : 'var(--primary)';
  container.innerHTML = `<div style="font-size:38px;font-weight:800;color:${safeColor};line-height:1.2;">${formatChartNumber_(total, isMoney)}</div>`;
}

async function loadCustomCharts() {
  const r = await apiGet('getCustomCharts');
  if (!r.ok) return;
  state.customCharts = r.charts;
  renderCustomChartsGrid_();
}

function renderCustomChartsGrid_() {
  const grid = document.getElementById('customChartsGrid');
  const emptyHint = document.getElementById('customChartsEmptyHint');
  const addBtn = document.getElementById('addCustomChartBtn');
  if (!grid) return;
  const isAdmin = state.session.role !== 'biller';
  addBtn.style.display = isAdmin ? '' : 'none';

  if (!state.customCharts.length) {
    grid.innerHTML = '';
    emptyHint.style.display = isAdmin ? 'block' : 'none';
    return;
  }
  emptyHint.style.display = 'none';

  grid.innerHTML = state.customCharts.map((c, idx) => `
    <div class="dash-card chart-card wide">
      <div class="dash-card-main">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <h4>${escapeHtml(c.name)}</h4>
          ${isAdmin ? `
            <div style="display:flex;gap:4px;flex-shrink:0;">
              <button class="icon-btn" data-action="moveUp" data-id="${c.chartId}" title="Move up" ${idx === 0 ? 'disabled' : ''}>&#8593;</button>
              <button class="icon-btn" data-action="moveDown" data-id="${c.chartId}" title="Move down" ${idx === state.customCharts.length - 1 ? 'disabled' : ''}>&#8595;</button>
              <button class="icon-btn icon-btn-edit" data-action="editChart" data-id="${c.chartId}" title="Edit">&#9998;</button>
              <button class="icon-btn icon-btn-danger" data-action="deleteChart" data-id="${c.chartId}" title="Delete">&#128465;</button>
            </div>` : ''}
        </div>
        <div id="customChart_${c.chartId}"><p style="color:var(--muted);font-size:13px;">Loading...</p></div>
      </div>
    </div>
  `).join('');

  state.customCharts.forEach(c => loadOneCustomChartData_(c));

  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleCustomChartAction_(btn.dataset.action, btn.dataset.id));
  });
}

async function loadOneCustomChartData_(def) {
  const container = document.getElementById('customChart_' + def.chartId);
  if (!container) return;
  const r = await apiGet('getCustomChartData', { chartId: def.chartId });
  if (!r.ok) { container.innerHTML = '<p style="color:var(--danger);font-size:13px;">' + escapeHtml(r.error || 'Could not load') + '</p>'; return; }
  const isMoney = def.metric === 'sum' && (def.metricField === 'TotalAmount' || def.metricField === 'LineTotal');
  if (r.type === 'number') drawNumberCard_(container, r.total, isMoney, def.color);
  else if (r.type === 'bar') drawGenericBarChart(container, r.labels, r.values, isMoney);
  else if (r.type === 'pie') drawGenericPieOrDonut_(container, r.labels, r.values, false, isMoney);
  else if (r.type === 'donut') drawGenericPieOrDonut_(container, r.labels, r.values, true, isMoney);
}

async function handleCustomChartAction_(action, chartId) {
  const chart = state.customCharts.find(c => c.chartId === chartId);
  if (!chart) return;

  if (action === 'editChart') { openChartBuilder_(chart); return; }

  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter Super Admin credentials in Admin Settings first.', 'error');
    return;
  }

  if (action === 'deleteChart') {
    if (!confirm('Delete chart "' + chart.name + '"? This cannot be undone.')) return;
    const r = await apiPost('deleteCustomChart', Object.assign({ chartId }, creds));
    if (r.ok) { toast('Chart deleted', 'success'); loadCustomCharts(); }
    else toast(r.error, 'error');
    return;
  }

  if (action === 'moveUp' || action === 'moveDown') {
    const idx = state.customCharts.findIndex(c => c.chartId === chartId);
    const swapWith = action === 'moveUp' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= state.customCharts.length) return;
    const newOrder = state.customCharts.map(c => c.chartId);
    const tmp = newOrder[idx]; newOrder[idx] = newOrder[swapWith]; newOrder[swapWith] = tmp;
    const r = await apiPost('reorderCustomCharts', Object.assign({ orderedChartIds: newOrder }, creds));
    if (r.ok) loadCustomCharts();
    else toast(r.error, 'error');
  }
}

const CHART_DIMENSION_OPTIONS_ = {
  bills: [['BillerName', 'Biller'], ['PaymentMethod', 'Payment Method'], ['PaymentStatus', 'Payment Status'], ['CustomerName', 'Patient'], ['Date', 'Date (day)'], ['Month', 'Month'], ['Year', 'Year']],
  billitems: [['ProductName', 'Product']],
  customers: [], products: []
};
const CHART_DIMENSION_LABELS_ = Object.assign.apply(null, [{}].concat(
  Object.keys(CHART_DIMENSION_OPTIONS_).map(k => Object.fromEntries(CHART_DIMENSION_OPTIONS_[k]))
));
const CHART_METRIC_FIELD_OPTIONS_ = {
  bills: [['TotalAmount', 'Total Amount (\u20B9)'], ['TotalQty', 'Total Quantity']],
  billitems: [['LineTotal', 'Line Total (\u20B9)'], ['Qty', 'Quantity']],
  customers: [], products: []
};
const CHART_METRIC_FIELD_LABELS_ = Object.assign.apply(null, [{}].concat(
  Object.keys(CHART_METRIC_FIELD_OPTIONS_).map(k => Object.fromEntries(CHART_METRIC_FIELD_OPTIONS_[k]))
));
const CHART_DATASOURCE_HINTS_ = {
  bills: 'Best for anything about a whole sale: which biller sold it, how it was paid, which patient bought it, or when. <b>Tip:</b> for "Top 10 Patients by amount spent", pick Bills &rarr; Group By: Patient &rarr; Sum of Total Amount.',
  billitems: 'Best for product-level questions - which products sell the most, by quantity or by revenue. <b>Tip:</b> for "Top 10 Products Sold", pick Bill Items &rarr; Group By: Product &rarr; Sum of Quantity (or Sum of Line Total for revenue instead of quantity).',
  customers: 'The Patients list itself only has names/contacts, not sales history - so this only supports a simple running total ("Total Patients"). For anything involving how much a patient spent or bought, use <b>Bills</b> above instead, grouped by Patient.',
  products: 'The Products list itself only has names/prices, not sales history - so this only supports a simple running total ("Total Products"). For anything involving how much of a product sold, use <b>Bill Items</b> above instead, grouped by Product.'
};

function updateChartBuilderDynamicFields_() {
  const dataSource = document.getElementById('cb_dataSource').value;
  const isNumberOnlySource = dataSource === 'customers' || dataSource === 'products';
  const typeSelect = document.getElementById('cb_type');
  const metricSelect = document.getElementById('cb_metric');

  document.getElementById('cb_dataSourceHint').innerHTML = CHART_DATASOURCE_HINTS_[dataSource] || '';

  if (isNumberOnlySource) {
    typeSelect.value = 'number'; typeSelect.disabled = true;
    metricSelect.value = 'count'; metricSelect.disabled = true;
  } else {
    typeSelect.disabled = false; metricSelect.disabled = false;
  }

  const dimSelect = document.getElementById('cb_dimension');
  dimSelect.innerHTML = (CHART_DIMENSION_OPTIONS_[dataSource] || []).map(o => `<option value="${o[0]}">${o[1]}</option>`).join('');

  const metricFieldSelect = document.getElementById('cb_metricField');
  metricFieldSelect.innerHTML = (CHART_METRIC_FIELD_OPTIONS_[dataSource] || []).map(o => `<option value="${o[0]}">${o[1]}</option>`).join('');

  const isNumberType = typeSelect.value === 'number';
  document.getElementById('cb_dimensionField').style.display = isNumberType ? 'none' : '';
  document.getElementById('cb_topNField').style.display = isNumberType ? 'none' : '';
  document.getElementById('cb_sortDirField').style.display = isNumberType ? 'none' : '';
  document.getElementById('cb_metricFieldWrap').style.display = (metricSelect.value === 'sum' || metricSelect.value === 'average') ? '' : 'none';
  // Color only makes sense for a Number Card - bar/pie/donut charts already
  // cycle through the full Chart Colors palette automatically.
  const colorField = document.getElementById('cb_colorField');
  if (colorField) colorField.style.display = isNumberType ? '' : 'none';
  renderChartBuilderDescription_();
}

// A one-sentence, plain-English readout of exactly what the chart being
// built will show - updates on every change, so there's never any guessing
// about what a combination of dropdowns actually means before saving it.
function renderChartBuilderDescription_() {
  const box = document.getElementById('cb_description');
  if (!box) return;
  const type = document.getElementById('cb_type').value;
  const dataSource = document.getElementById('cb_dataSource').value;
  const metric = document.getElementById('cb_metric').value;
  const metricField = document.getElementById('cb_metricField').value;
  const dimension = document.getElementById('cb_dimension').value;
  const topN = Number(document.getElementById('cb_topN').value) || 0;
  const sortDir = document.getElementById('cb_sortDir').value;

  const sourceLabel = { bills: 'Bills', billitems: 'Bill Items', customers: 'Patients', products: 'Products' }[dataSource] || dataSource;
  const fieldLabel = CHART_METRIC_FIELD_LABELS_[metricField] || metricField;
  const dimLabel = CHART_DIMENSION_LABELS_[dimension] || dimension;

  let measurePhrase;
  if (metric === 'count') measurePhrase = `the number of ${sourceLabel.toLowerCase()}`;
  else if (metric === 'average') measurePhrase = `the average ${fieldLabel}`;
  else measurePhrase = `the total ${fieldLabel}`;

  let sentence;
  if (type === 'number') {
    sentence = `This will show one number: ${measurePhrase}, across every ${sourceLabel.toLowerCase()} record.`;
  } else {
    const rankPhrase = topN > 0 ? `the ${topN} ${dimLabel.toLowerCase()}s with the ${sortDir === 'asc' ? 'lowest' : 'highest'} ${metric === 'average' ? 'average' : 'total'}` : `every ${dimLabel.toLowerCase()}`;
    sentence = `This will show ${measurePhrase}, broken down by ${dimLabel}, for ${rankPhrase}, as a ${type} chart.`;
  }
  box.textContent = sentence;
}
['cb_name', 'cb_dimension', 'cb_metricField', 'cb_topN', 'cb_sortDir'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderChartBuilderDescription_);
  document.getElementById(id).addEventListener('change', renderChartBuilderDescription_);
});
['cb_dataSource', 'cb_type', 'cb_metric'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateChartBuilderDynamicFields_);
});

function openChartBuilder_(existing) {
  document.getElementById('chartBuilderTitle').textContent = existing ? 'Edit Chart' : 'New Chart';
  document.getElementById('cb_chartId').value = existing ? existing.chartId : '';
  document.getElementById('cb_name').value = existing ? existing.name : '';
  document.getElementById('cb_dataSource').value = existing ? existing.dataSource : 'bills';
  document.getElementById('cb_type').value = existing ? existing.type : 'bar';
  document.getElementById('cb_type').disabled = false;
  document.getElementById('cb_metric').value = existing ? existing.metric : 'sum';
  document.getElementById('cb_metric').disabled = false;
  updateChartBuilderDynamicFields_();
  if (existing) {
    document.getElementById('cb_dimension').value = existing.dimension || '';
    document.getElementById('cb_metricField').value = existing.metricField || '';
    document.getElementById('cb_topN').value = existing.topN || '';
    document.getElementById('cb_sortDir').value = existing.sortDir || 'desc';
  } else {
    document.getElementById('cb_topN').value = '';
    document.getElementById('cb_sortDir').value = 'desc';
  }
  const colorEl = document.getElementById('cb_color');
  if (colorEl) colorEl.value = (existing && existing.color) || (state.themeChartPalette && state.themeChartPalette[0]) || '#E1341E';
  document.getElementById('chartBuilderStatus').textContent = '';
  clearErrorsIn_(document.getElementById('chartBuilderModal'));
  document.getElementById('chartBuilderModal').classList.add('show');
}

document.getElementById('addCustomChartBtn').addEventListener('click', () => openChartBuilder_(null));
document.getElementById('cb_cancel').addEventListener('click', () => document.getElementById('chartBuilderModal').classList.remove('show'));

document.getElementById('cb_save').addEventListener('click', async () => {
  const statusEl = document.getElementById('chartBuilderStatus');
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    statusEl.textContent = 'Enter Super Admin credentials in Admin Settings first.';
    statusEl.className = 'biller-status err';
    return;
  }
  clearErrorsIn_(document.getElementById('chartBuilderModal'));
  const isNumberCard = document.getElementById('cb_type').value === 'number';
  const chartCheck = applyChecks_([
    ['cb_name', vFreeText_(document.getElementById('cb_name').value, 'Chart name', 60, true, 2), 'name'],
    ['cb_topN', isNumberCard ? vRes_(0) : vInt_(document.getElementById('cb_topN').value.trim(), 'Show Top', 0, 100, false, 0), 'topN']
  ]);
  if (!chartCheck.ok) {
    statusEl.textContent = chartCheck.firstError;
    statusEl.className = 'biller-status err';
    return;
  }
  const name = chartCheck.values.name;
  const chartIdVal = document.getElementById('cb_chartId').value;
  const colorEl = document.getElementById('cb_color');
  const payload = Object.assign({
    name,
    type: document.getElementById('cb_type').value,
    dataSource: document.getElementById('cb_dataSource').value,
    dimension: document.getElementById('cb_dimension').value,
    metric: document.getElementById('cb_metric').value,
    metricField: document.getElementById('cb_metricField').value,
    topN: chartCheck.values.topN,
    sortDir: document.getElementById('cb_sortDir').value,
    color: (document.getElementById('cb_type').value === 'number' && colorEl) ? colorEl.value : ''
  }, chartIdVal ? { chartId: chartIdVal } : {}, creds);
  const r = await apiPost('saveCustomChart', payload);
  if (r.ok) {
    toast('Chart saved', 'success');
    document.getElementById('chartBuilderModal').classList.remove('show');
    loadCustomCharts();
  } else {
    statusEl.textContent = r.error || 'Could not save chart';
    statusEl.className = 'biller-status err';
  }
});

initDashboardFilters();


// -------------------------------------------------------------------------
// 14. LOOKUP / EDIT BILL
// -------------------------------------------------------------------------
document.getElementById('lookupBtn').addEventListener('click', doLookup);
document.getElementById('lookupBillId').addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });

async function doLookup() {
  // "12", "sjp12" or "SJP-000012" all find the same bill.
  const inputEl = document.getElementById('lookupBillId');
  const billId = normalizeBillId_(inputEl.value);
  const resultBox = document.getElementById('lookupResult');
  if (!billId) return;
  inputEl.value = billId;
  resultBox.innerHTML = '<p>Searching...</p>';
  const r = await apiGet('getBill', { billId });
  if (!r.ok) { resultBox.innerHTML = `<p style="color:var(--danger);">${escapeHtml(r.error)}</p>`; return; }
  renderLookupResult(r.bill);
}




let editRowCounter = 0;

function addEditProductRow(item) {
  editRowCounter++;
  const wrap = document.createElement('div');
  wrap.className = 'product-row';
  wrap.id = 'editrow_' + editRowCounter;

  wrap.innerHTML = `
    <div>
      <span class="mini-label">Service/Treatment</span>
      <input type="text" class="erow-name" value="${escapeHtml(item ? item.name : '')}">
    </div>
    <div>
      <span class="mini-label">Price (₹)</span>
      <input type="number" class="erow-price" min="0" step="0.01" value="${item ? Number(item.price) : 0}">
    </div>
    <div>
      <span class="mini-label">Qty</span>
      <input type="number" class="erow-qty" min="1" step="1" value="${item ? Number(item.qty) : 1}">
    </div>
    <div class="erow-discount-wrap" style="display:none;">
      <span class="mini-label">Discount %</span>
      <input type="number" class="erow-discount" min="0" max="100" step="0.01" value="${item && item.discountPercent ? Number(item.discountPercent) : 0}" placeholder="0">
    </div>
    <div>
      <span class="mini-label">Line Total</span>
      <div class="line-total">₹0.00</div>
    </div>
    <button class="remove-row" title="Remove">✕</button>
  `;
  document.getElementById('editProductRows').appendChild(wrap);
  decorateInputs_(wrap);

  const priceInput = wrap.querySelector('.erow-price');
  const qtyInput = wrap.querySelector('.erow-qty');
  const discountInput = wrap.querySelector('.erow-discount');
  const lineTotalEl = wrap.querySelector('.line-total');
  const removeBtn = wrap.querySelector('.remove-row');

  const discToggleOn = document.getElementById('edit_showDiscountToggle') && document.getElementById('edit_showDiscountToggle').classList.contains('on');
  wrap.querySelector('.erow-discount-wrap').style.display = discToggleOn ? '' : 'none';

  function recalcRow() {
    const gross = (Number(priceInput.value) || 0) * (Number(qtyInput.value) || 0);
    const discPct = Math.min(100, Math.max(0, Number(discountInput.value) || 0));
    const total = gross - (gross * discPct / 100);
    lineTotalEl.textContent = formatMoney(total);
    recalcEditTotals();
  }
  priceInput.addEventListener('input', recalcRow);
  qtyInput.addEventListener('input', recalcRow);
  discountInput.addEventListener('input', recalcRow);
  removeBtn.addEventListener('click', () => { wrap.remove(); recalcEditTotals(); });

  recalcRow();
}

function getEditLineItems() {
  const discOn = document.getElementById('edit_showDiscountToggle') && document.getElementById('edit_showDiscountToggle').classList.contains('on');
  return Array.from(document.querySelectorAll('#editProductRows .product-row')).map(row => {
    const name = row.querySelector('.erow-name').value.trim();
    const price = Number(row.querySelector('.erow-price').value) || 0;
    const qty = Number(row.querySelector('.erow-qty').value) || 0;
    const discInput = row.querySelector('.erow-discount');
    const discountPercent = (discOn && discInput) ? Math.min(100, Math.max(0, Number(discInput.value) || 0)) : 0;
    return { name, price, qty, discountPercent };
  }).filter(i => i.name && i.qty > 0);
}

function getEditToggleOverride_(fieldId, btnId) {
  const field = document.getElementById(fieldId);
  if (!field || field.style.display === 'none') return false;
  const btn = document.getElementById(btnId);
  return btn ? btn.classList.contains('on') : false;
}

function getEditBillLevelDiscountPct_() {
  const discOn = document.getElementById('edit_showDiscountToggle') && document.getElementById('edit_showDiscountToggle').classList.contains('on');
  if (!discOn) return 0;
  const el = document.getElementById('edit_totalDiscountPct');
  return el ? Math.min(100, Math.max(0, Number(el.value) || 0)) : 0;
}

function recalcEditTotals() {
  const items = getEditLineItems();
  const taxOverride = getEditToggleOverride_('editTaxToggleField', 'edit_showTaxToggle');
  const totalDiscPct = getEditBillLevelDiscountPct_();
  const totals = computeBillTotals(items, totalDiscPct, taxOverride);
  document.getElementById('editTotalQty').textContent = totals.items.reduce((s, i) => s + i.qty, 0);
  document.getElementById('editTotalAmount').textContent = formatMoney(totals.grandTotal);
  return totals;
}





// Makes a bill preview show at its TRUE fixed-width design (matching print/
// PDF/email exactly - see .bill-scale-inner's 800px width in style.css)
// instead of reflowing narrower on a phone, which used to make it look like
// a cramped, differently-designed mini version rather than a small photo of
// the real document. Shrinks the whole thing down with a CSS transform
// (which preserves every proportion exactly) and then sets the OUTER
// wrapper's height to match, since a transform doesn't affect layout flow
// on its own and would otherwise leave a tall gap of blank space below.
function fitBillScale_(outerId, innerId) {
  const outer = document.getElementById(outerId);
  const inner = document.getElementById(innerId);
  if (!outer || !inner) return;
  const apply = () => {
    const scale = Math.min(1, outer.clientWidth / 800);
    inner.style.transform = 'scale(' + scale + ')';
    outer.style.height = (inner.scrollHeight * scale) + 'px';
  };
  apply();
  // Re-fit on resize/rotate - rAF-throttled so a drag-resize doesn't spam layout work.
  if (!outer._fitBillScaleBound) {
    outer._fitBillScaleBound = true;
    let raf = null;
    window.addEventListener('resize', () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    });
  }
}

function renderLookupBillPaper(bill) {
  const s = state.settings || {};
  const taxOverride = bill.taxOverride === 'TRUE';
  const bankOverride = bill.bankOverride === 'TRUE' ? true : (bill.bankOverride === 'FALSE' ? false : undefined);
  const items = (bill.items || []).map(i => ({ name: i.name, price: Number(i.price), qty: Number(i.qty), discountPercent: Number(i.discountPercent) || 0 }));
  const totals = computeBillTotals(items, Number(bill.discountPercent) || 0, taxOverride);
  const { totalsHtml, footHtml } = buildBillTotalsAndFooterHtml(totals, bill.totalQty, s, bill.billerName || '', bill.versionNote || '', bankOverride);

  return `
    <div class="bill-paper bill-scale-inner" id="lookupBillPaper">
      ${buildCompanyHeadHtml(s, bill.billId)}
      ${buildCustomerMetaHtml({
        date: formatBillDate(bill.date),
        custName: bill.customerName || '-',
        custId: bill.customerId || '-',
        phone: bill.phone || '-',
        email: bill.email || '',
        paymentLabel: paymentMethodLabel(bill.paymentMethod),
        address: bill.address || '',
        deliveryAddress: bill.deliveryAddress || ''
      })}
      ${buildBillItemsTableHtml(totals)}
      ${totalsHtml}
      ${footHtml}
    </div>
  `;
}






function renderLookupResult(bill) {
  const resultBox = document.getElementById('lookupResult');
  const isBillerEditor = state.session.role === 'biller';
  const isEditable = bill.editable !== false; // absent/undefined = editable, for back-compat
  const rowsHtml = bill.items.map(i => `
    <tr><td>${escapeHtml(i.name)}</td><td>₹${Number(i.price).toFixed(2)}</td><td>${i.qty}</td><td>₹${Number(i.total).toFixed(2)}</td></tr>
  `).join('');

  const gateHeaderHtml = isBillerEditor
    ? `<h4>&#9999;&#65039; Edit This Bill</h4>
       <p class="field-hint" style="margin:-4px 0 12px;">Editing as <b>${escapeHtml(state.session.billerName)}</b> (${escapeHtml(state.session.billerId)}) - no extra login needed, you're already signed in.</p>`
    : `<h4>&#128274; Super Admin - Edit This Bill</h4>`;
  const gateCredsHtml = isBillerEditor ? '' : `
    <div class="form-grid">
      <div class="field"><label>Super Admin Username</label><input id="edit_su_user" type="text"></div>
      <div class="field"><label>Super Admin Password</label><input id="edit_su_pass" type="password"></div>
    </div>`;

  // A bill living in an archived spreadsheet (see the Reports & Row Limits
  // note in Admin Settings) is intentionally read-only - same principle as
  // not editing a closed financial year's books. Everything else about it
  // (view, download, print, share) still works exactly the same.
  const archivedNoticeHtml = !isEditable ? `
    <div class="superadmin-gate">
      <h4>&#128274; Read-Only - Archived Invoice</h4>
      <p class="field-hint" style="margin:-4px 0 0;">
        This invoice lives in <b>${escapeHtml(bill.source || 'an archived spreadsheet')}</b> and can no longer be edited.
        You can still view, download, print, or share it above.
      </p>
    </div>` : '';

  const canEditTax = isBillerEditor ? (!!state.session.canAccessTax && state.settings.ShowTaxOnBill !== false) : (state.settings.ShowTaxOnBill !== false);
  const canEditBank = isBillerEditor ? (!!state.session.canAccessBank && state.settings.ShowBankDetails !== false) : (state.settings.ShowBankDetails !== false);
  const canEditDiscount = isBillerEditor ? (!!state.session.canAccessDiscount && state.settings.ShowDiscountOption !== false) : (state.settings.ShowDiscountOption !== false);

  const editSectionHtml = isEditable ? `
      <div class="superadmin-gate">
        ${gateHeaderHtml}
        ${gateCredsHtml}

        <div class="form-grid" style="margin-top:12px;">
          <div class="field"><label>Patient Name</label><input id="edit_customerName" type="text" value="${escapeHtml(bill.customerName || '')}"></div>
          <div class="field"><label>Phone Number</label><input id="edit_phone" type="tel" value="${escapeHtml(normalizeMobile_(bill.phone) || '')}"></div>
          <div class="field"><label>Email</label><input id="edit_email" type="email" value="${escapeHtml(bill.email || '')}"></div>
          <div class="field"><label>Payment Method</label>
            <select id="edit_paymentMethod">
              <option value="Cash" ${bill.paymentMethod === 'Cash' ? 'selected' : ''}>Cash in Hand</option>
              <option value="Bank" ${bill.paymentMethod === 'Bank' ? 'selected' : ''}>Bank Transaction</option>
            </select>
          </div>
          <div class="field span-2"><label>Address</label><textarea id="edit_address" rows="2">${escapeHtml(bill.address || '')}</textarea></div>
          <div class="field span-2"><label>Delivery Address</label><textarea id="edit_deliveryAddress" rows="2">${escapeHtml(bill.deliveryAddress || '')}</textarea></div>
          <div class="field"><label>Payment Status</label>
            <select id="edit_status">
              <option value="Cash Collected" ${bill.paymentStatus === 'Cash Collected' ? 'selected' : ''}>Cash Collected</option>
              <option value="Pending" ${bill.paymentStatus === 'Pending' ? 'selected' : ''}>Pending</option>
              <option value="Paid" ${bill.paymentStatus === 'Paid' ? 'selected' : ''}>Paid</option>
              <option value="Failed" ${bill.paymentStatus === 'Failed' ? 'selected' : ''}>Failed</option>
            </select>
          </div>
          <div class="field span-2"><label>Reason For Change <span style="color:var(--warn);">*required</span></label><input id="edit_note" type="text" placeholder="e.g. Patient requested address correction" required></div>
        </div>

        <div class="bill-toggles-wrap" style="margin-top:14px;">
          <div class="field" id="editTaxToggleField" style="display:${canEditTax ? '' : 'none'};">
            <label>Apply Tax to this bill?</label>
            <button type="button" class="toggle" id="edit_showTaxToggle"></button>
            <span id="edit_showTaxLabel" class="field-hint"></span>
          </div>
          <div class="field" id="editBankToggleField" style="display:${canEditBank ? '' : 'none'};">
            <label>Show Bank Details?</label>
            <button type="button" class="toggle" id="edit_showBankToggle"></button>
            <span id="edit_showBankLabel" class="field-hint"></span>
          </div>
          <div class="field" id="editDiscountToggleField" style="display:${canEditDiscount ? '' : 'none'};">
            <label>Apply Discount?</label>
            <button type="button" class="toggle" id="edit_showDiscountToggle"></button>
            <span id="edit_showDiscountLabel" class="field-hint"></span>
          </div>
          <div class="field" id="edit_totalDiscountWrap" style="display:none;min-width:140px;">
            <label>Additional Discount %</label>
            <input id="edit_totalDiscountPct" type="number" min="0" max="100" step="0.01" value="${Number(bill.discountPercent) || 0}" placeholder="0">
          </div>
        </div>

        <h4 style="margin-top:18px;">Products</h4>
        <div id="editProductRows"></div>
        <button id="addEditRowBtn" class="btn btn-outline btn-sm" style="margin-top:6px;">+ Add Product Row</button>
        <div class="totals-strip" style="margin-top:12px;">
          <div class="t-item">
            <div class="t-label">Total Qty</div>
            <div class="t-value" id="editTotalQty">0</div>
          </div>
          <div class="t-item">
            <div class="t-label">Total Amount</div>
            <div class="t-value" id="editTotalAmount">₹0.00</div>
          </div>
        </div>

        <button id="saveEditBtn" class="btn btn-primary btn-sm" style="margin-top:14px;">Save Correction</button>
      </div>` : archivedNoticeHtml;

  resultBox.innerHTML = `
    <div class="panel">
      <h3>Bill ${escapeHtml(bill.billId)} ${bill.versionNote ? '<span style="color:var(--warn);font-weight:600;font-size:11px;">(edited)</span>' : ''}${!isEditable ? ' <span class="report-chip">' + escapeHtml(bill.source || 'Archived') + '</span>' : ''}</h3>
      <div class="bill-meta-grid" style="margin-bottom:14px;">
        <div>Date: <b>${escapeHtml(formatBillDate(bill.date))}</b></div>
        <div>Payment: <b>${escapeHtml(bill.paymentMethod)}</b> - <b>${escapeHtml(bill.paymentStatus)}</b></div>
        <div>Patient: <b>${escapeHtml(bill.customerName)}</b> (${escapeHtml(bill.customerId)})</div>
        <div>Phone: <b>${escapeHtml(bill.phone)}</b></div>
        <div>Billed by: <b>${escapeHtml(bill.billerName || '')}</b></div>
        <div>Total: <b>₹${Number(bill.totalAmount).toFixed(2)}</b> (Qty ${bill.totalQty})</div>
        <div>Created: <b>${escapeHtml(formatISTDateTime_(bill.createdAt))}</b></div>
        ${bill.updatedBy ? `<div>Last Edited: <b>${escapeHtml(formatISTDateTime_(bill.updatedAt))}</b> by <b>${escapeHtml(bill.updatedBy)}</b></div>` : ''}
      </div>
      <div class="table-scroll">
        <table class="lookup-table" style="min-width:500px;">
          <thead><tr><th>Service/Treatment</th><th>Price</th><th>Qty</th><th>Total</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${bill.versionNote ? `<p style="margin-top:10px;color:var(--warn);font-size:12.5px;font-weight:600;">${escapeHtml(bill.versionNote)}</p>` : ''}

      ${editSectionHtml}
    </div>

    <div class="panel" style="margin-top:16px;">
      <h3>PDF Version</h3>
      <p class="field-hint" style="margin:-4px 0 12px;">Shown at the exact size and proportions it will print, download or email at - scaled to fit your screen, not reflowed to it.</p>
      <button id="lookupDownloadPdfBtn" class="btn btn-accent btn-sm print-hide" style="margin-bottom:14px;">&#11015;&#65039; Download / Print PDF</button>
      <button id="lookupShareBtn" class="btn btn-outline btn-sm print-hide" style="margin-bottom:14px; margin-left:8px;">&#128228; Share Bill</button>
      <div class="bill-scale-outer" id="lookupBillScaleOuter">${renderLookupBillPaper(bill)}</div>
    </div>
  `;

  // From this point on, Print/Save-as-PDF (in the Share popup below) should
  // print THIS bill, not whatever was last saved on the Create Bill screen.
  document.body.setAttribute('data-print-target', 'lookupBillPaper');
  fitBillScale_('lookupBillScaleOuter', 'lookupBillPaper');

  if (!isEditable) {
    document.getElementById('lookupDownloadPdfBtn').addEventListener('click', () => window.print());
    document.getElementById('lookupShareBtn').addEventListener('click', () => {
      openShareModal(bill.billId, 'Share Bill ' + bill.billId, {
        customerName: bill.customerName,
        date: formatBillDate(bill.date),
        items: (bill.items || []).map(i => ({ name: i.name, price: Number(i.price), qty: Number(i.qty), discountPercent: Number(i.discountPercent) || 0 })),
        totalDiscountPct: Number(bill.discountPercent) || 0,
        taxOverride: bill.taxOverride === 'TRUE',
        paymentMethod: bill.paymentMethod,
        phone: bill.phone,
        email: bill.email
      });
    });
    return; // no edit form was rendered, so nothing else below applies
  }

  decorateInputs_(resultBox);
  document.getElementById('editProductRows').innerHTML = '';
  bill.items.forEach(it => addEditProductRow(it));

  // Initialize the Tax / Bank / Discount toggles from what was actually
  // saved on this bill - not from the shop-wide defaults - so re-opening
  // an edit shows exactly what the customer's copy shows.
  setToggleState_('edit_showTaxToggle', 'edit_showTaxLabel', bill.taxOverride === 'TRUE');
  setToggleState_('edit_showBankToggle', 'edit_showBankLabel', bill.bankOverride !== 'FALSE');
  const hasExistingDiscount = (Number(bill.discountPercent) || 0) > 0 || (bill.items || []).some(i => (Number(i.discountPercent) || 0) > 0);
  setToggleState_('edit_showDiscountToggle', 'edit_showDiscountLabel', hasExistingDiscount);
  document.getElementById('edit_totalDiscountWrap').style.display = hasExistingDiscount ? '' : 'none';
  document.querySelectorAll('#editProductRows .erow-discount-wrap').forEach(el => { el.style.display = hasExistingDiscount ? '' : 'none'; });
  recalcEditTotals();

  document.getElementById('edit_showTaxToggle').addEventListener('click', () => {
    setToggleState_('edit_showTaxToggle', 'edit_showTaxLabel', !document.getElementById('edit_showTaxToggle').classList.contains('on'));
    recalcEditTotals();
  });
  document.getElementById('edit_showBankToggle').addEventListener('click', () => {
    setToggleState_('edit_showBankToggle', 'edit_showBankLabel', !document.getElementById('edit_showBankToggle').classList.contains('on'));
  });
  document.getElementById('edit_showDiscountToggle').addEventListener('click', () => {
    const nowOn = !document.getElementById('edit_showDiscountToggle').classList.contains('on');
    setToggleState_('edit_showDiscountToggle', 'edit_showDiscountLabel', nowOn);
    document.getElementById('edit_totalDiscountWrap').style.display = nowOn ? '' : 'none';
    document.querySelectorAll('#editProductRows .erow-discount-wrap').forEach(el => { el.style.display = nowOn ? '' : 'none'; });
    if (!nowOn) {
      document.getElementById('edit_totalDiscountPct').value = '';
      document.querySelectorAll('#editProductRows .erow-discount').forEach(inp => { inp.value = ''; });
    }
    recalcEditTotals();
  });
  document.getElementById('edit_totalDiscountPct').addEventListener('input', recalcEditTotals);

  document.getElementById('addEditRowBtn').addEventListener('click', () => addEditProductRow(null));

  document.getElementById('lookupDownloadPdfBtn').addEventListener('click', () => {
    window.print();
  });

  document.getElementById('lookupShareBtn').addEventListener('click', () => {
    const shareItems = (bill.items || []).map(i => ({ name: i.name, price: Number(i.price), qty: Number(i.qty), discountPercent: Number(i.discountPercent) || 0 }));
    openShareModal(bill.billId, 'Share Bill ' + bill.billId, {
      customerName: bill.customerName,
      date: formatBillDate(bill.date),
      items: shareItems,
      totalDiscountPct: Number(bill.discountPercent) || 0,
      taxOverride: bill.taxOverride === 'TRUE',
      paymentMethod: bill.paymentMethod,
      phone: bill.phone,
      email: bill.email
    });
  });

  document.getElementById('saveEditBtn').addEventListener('click', async () => {
    const editRoot = document.getElementById('lookupResult');
    clearErrorsIn_(editRoot);
    const val = id => document.getElementById(id).value;

    // Same rules as Create Bill, but - exactly like the server - only for
    // fields that were actually changed, so an older bill whose stored
    // value predates these rules can still be corrected elsewhere.
    const checks = [];
    const ifChanged = (id, original, validator) => {
      if (vLine_(val(id)) !== vLine_(original)) checks.push([id, validator(val(id))]);
    };
    ifChanged('edit_customerName', bill.customerName, v => vPersonName_(v, 'Patient Name', true));
    if (normalizeMobile_(val('edit_phone')) !== normalizeMobile_(bill.phone)) checks.push(['edit_phone', vMobile_(val('edit_phone'), 'Phone Number', true)]);
    ifChanged('edit_email', bill.email, v => vEmail_(v, 'Email', false));
    ifChanged('edit_address', bill.address, v => vAddress_(v, 'Address'));
    ifChanged('edit_deliveryAddress', bill.deliveryAddress, v => vAddress_(v, 'Delivery Address'));
    const noteRes = vFreeText_(val('edit_note'), 'Reason For Change', VLIMIT.NOTE_MAX, true, 3);
    checks.push(['edit_note', noteRes.error && !vLine_(val('edit_note')) ? vRes_('', 'Please enter a reason for this change before saving.') : noteRes]);

    const discOn = document.getElementById('edit_showDiscountToggle').classList.contains('on');
    if (discOn) checks.push(['edit_totalDiscountPct', vPercent_(val('edit_totalDiscountPct'), 'Additional Discount %')]);

    const knownNames = {};
    (bill.items || []).forEach(i => { knownNames[vLine_(i.name).toLowerCase()] = true; });
    const items = [];
    let n = 0;
    document.querySelectorAll('#editProductRows .product-row').forEach(row => {
      n++;
      const nameEl = row.querySelector('.erow-name');
      const priceEl = row.querySelector('.erow-price');
      const qtyEl = row.querySelector('.erow-qty');
      const discEl = row.querySelector('.erow-discount');
      const nameRaw = vLine_(nameEl.value);
      if (!nameRaw) {
        if (Number(priceEl.value) > 0) checks.push([nameEl, vRes_('', 'Line ' + n + ': enter a service/treatment, or remove this line with ✕.')]);
        return;
      }
      const isKnown = knownNames[nameRaw.toLowerCase()] || findProductByName_(nameRaw);
      const nameRes = isKnown ? vRes_(nameRaw) : vProductName_(nameRaw, 'Line ' + n + ' service/treatment');
      const priceRes = vMoney_(priceEl.value, 'Line ' + n + ' price', true);
      const qtyRes = vInt_(qtyEl.value, 'Line ' + n + ' qty', 1, VLIMIT.QTY_MAX, true);
      const discRes = discOn ? vPercent_(discEl ? discEl.value : 0, 'Line ' + n + ' discount %') : vRes_(0);
      checks.push([nameEl, nameRes], [priceEl, priceRes], [qtyEl, qtyRes]);
      if (discOn && discEl) checks.push([discEl, discRes]);
      if (!nameRes.error && !priceRes.error && !qtyRes.error && !discRes.error) {
        items.push({ name: nameRes.value, price: priceRes.value, qty: qtyRes.value, discountPercent: discRes.value });
      }
    });

    const result = applyChecks_(checks);
    if (!result.ok) { toast(result.firstError, 'error'); return; }
    if (!items.length) { toast('Add at least one service/treatment line.', 'error'); return; }

    const authPayload = isBillerEditor
      ? { billerId: state.session.billerId, billerPassword: state.session.billerPassword }
      : { superAdminUser: document.getElementById('edit_su_user').value, superAdminPass: document.getElementById('edit_su_pass').value };

    const taxOverride = getEditToggleOverride_('editTaxToggleField', 'edit_showTaxToggle') ? 'TRUE' : 'FALSE';
    const bankOverride = getEditToggleOverride_('editBankToggleField', 'edit_showBankToggle') ? 'TRUE' : 'FALSE';
    const totalDiscountPct = getEditBillLevelDiscountPct_();

    const saveBtn = document.getElementById('saveEditBtn');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    let r;
    try {
      r = await apiPost('updateBill', Object.assign({
        billId: bill.billId,
        versionNote: noteRes.value,
        fields: {
          customerName: vLine_(val('edit_customerName')),
          phone: val('edit_phone').trim(),
          email: vLine_(val('edit_email')),
          address: vMulti_(val('edit_address')),
          deliveryAddress: vMulti_(val('edit_deliveryAddress')),
          paymentMethod: val('edit_paymentMethod'),
          paymentStatus: val('edit_status'),
          taxOverride: taxOverride,
          bankOverride: bankOverride,
          discountPercent: totalDiscountPct,
          items: items
        }
      }, authPayload));
    } catch (err) {
      toast('Network error while saving the correction - please try again.', 'error');
      return;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Correction';
    }
    if (r.ok) {
      toast('Bill updated' + (isBillerEditor ? '' : ' by super admin'), 'success');
      doLookup();
      // Editing a bill's items can change tracked stock on the backend
      // (old quantities restored, new ones deducted) - re-sync the local
      // product list so it's not left showing stale numbers anywhere.
      refreshProductsFromServer_();
    } else {
      markServerFieldError_(r, {
        customerName: 'edit_customerName', phone: 'edit_phone', email: 'edit_email', address: 'edit_address',
        deliveryAddress: 'edit_deliveryAddress', versionNote: 'edit_note', discountPercent: 'edit_totalDiscountPct'
      });
      toast(r.error || 'Update failed', 'error');
    }
  });
}

// Light re-fetch of just the products list (with live stock) - used after
// any action where the backend may have changed stock without the frontend
// having computed the exact new numbers itself (e.g. editing a saved bill).
async function refreshProductsFromServer_() {
  try {
    const r = await apiGet('getProducts');
    if (r.ok) {
      state.products = r.products;
      refreshAllStockBadges();
      if (document.getElementById('view-inventory').classList.contains('active')) renderInventoryTable();
    }
  } catch (err) { /* non-critical - next natural refresh will catch up */ }
}

// -------------------------------------------------------------------------
// 15. ADMIN SETTINGS
// -------------------------------------------------------------------------
document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.admin-pane').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'billers') renderBillerTable();
    if (tab.dataset.tab === 'products') {
      renderProductTable();
      // The start-up list only has ACTIVE products - fetch the full list so
      // an inactive product is visible here and can be switched back on.
      refreshProductsFromServer_().then(() => { if (tab.classList.contains('active') && productEditingId === null) renderProductTable(); });
    }
    if (tab.dataset.tab === 'theme') renderAllThemePreviews_();
  });
});

// -------------------------------------------------------------------------
// 15b. THEME - live preview on every color pick, Save/Reset call the
// dedicated theme endpoints (see apiUpdateTheme / apiResetTheme in Code.gs).
// -------------------------------------------------------------------------
const THEME_LIVE_PREVIEW_COLOR_IDS_ = [
  'theme_sidebarFrom', 'theme_sidebarTo', 'theme_sidebarText', 'theme_navActiveBg', 'theme_navActiveText',
  'theme_buttonFrom', 'theme_buttonTo', 'theme_buttonText', 'theme_buttonHoverFrom', 'theme_buttonHoverTo',
  'theme_outlineText', 'theme_outlineBorder', 'theme_outlineHoverBg', 'theme_outlineHoverText',
  'theme_billHeader', 'theme_heading', 'theme_muted', 'theme_bg', 'theme_surface', 'theme_border',
  'theme_loginBgFrom', 'theme_loginBgTo', 'theme_loginCardBg', 'theme_loginHeading', 'theme_loginText',
  'theme_pageHeading', 'theme_pageSubheading', 'theme_sectionHeading',
  'theme_tabActiveText', 'theme_tabInactiveText', 'theme_tabIndicatorFrom', 'theme_tabIndicatorTo',
  'theme_gateBg', 'theme_gateBorder', 'theme_gateTitle', 'theme_billLayout',
  'theme_billNameBold', 'theme_billNameItalic', 'theme_billNameUnderline',
  'theme_billInfoBold', 'theme_billInfoItalic', 'theme_billInfoUnderline',
  'theme_billFont', 'theme_billDiscount', 'theme_billLogoWidth', 'theme_billLogoHeight'
].concat(Array.from({ length: 12 }, (_, i) => 'theme_chart' + i));

THEME_LIVE_PREVIEW_COLOR_IDS_.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
  el.addEventListener(evt, renderAllThemePreviews_);
});
['theme_sidebarStyle', 'theme_buttonStyle', 'theme_loginBgStyle', 'theme_tabIndicatorStyle'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { toggleThemeGradientFields_(); renderAllThemePreviews_(); });
});

// Logo size quick-presets (Square / Wide rectangle / Tall rectangle) - just
// fill in the same two Width/Height number fields a manual entry would, so
// there's exactly one code path (no separate "preset mode" to keep in sync).
document.querySelectorAll('.theme-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('theme_billLogoWidth').value = btn.dataset.w;
    document.getElementById('theme_billLogoHeight').value = btn.dataset.h;
    renderAllThemePreviews_();
  });
});

// Reads a checkbox as the 'TRUE'/'FALSE' strings the backend Settings sheet
// stores everywhere else (see ShowTaxOnBill etc.) - keeps every boolean in
// this app consistent, rather than inventing a JS-boolean-only field just
// for the new bill typography switches.
function boolFieldVal_(id) {
  const el = document.getElementById(id);
  return el && el.checked ? 'TRUE' : 'FALSE';
}

function collectThemeFieldsFromForm_() {
  const fv = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  return {
    ThemeSidebarStyle: fv('theme_sidebarStyle'),
    ThemeSidebarFrom: fv('theme_sidebarFrom'),
    ThemeSidebarTo: fv('theme_sidebarTo'),
    ThemeSidebarText: fv('theme_sidebarText'),
    ThemeNavActiveBg: fv('theme_navActiveBg'),
    ThemeNavActiveText: fv('theme_navActiveText'),
    ThemeButtonStyle: fv('theme_buttonStyle'),
    ThemeButtonFrom: fv('theme_buttonFrom'),
    ThemeButtonTo: fv('theme_buttonTo'),
    ThemeButtonText: fv('theme_buttonText'),
    ThemeBillHeaderColor: fv('theme_billHeader'),
    ThemeHeadingColor: fv('theme_heading'),
    ThemeMutedColor: fv('theme_muted'),
    ThemeBgColor: fv('theme_bg'),
    ThemeSurfaceColor: fv('theme_surface'),
    ThemeBorderColor: fv('theme_border'),
    ThemeChartPalette: Array.from({ length: 12 }, (_, i) => fv('theme_chart' + i)).filter(Boolean).join(','),

    ThemeLoginBgStyle: fv('theme_loginBgStyle'),
    ThemeLoginBgFrom: fv('theme_loginBgFrom'),
    ThemeLoginBgTo: fv('theme_loginBgTo'),
    ThemeLoginCardBg: fv('theme_loginCardBg'),
    ThemeLoginHeadingColor: fv('theme_loginHeading'),
    ThemeLoginTextColor: fv('theme_loginText'),

    ThemePageHeadingColor: fv('theme_pageHeading'),
    ThemePageSubheadingColor: fv('theme_pageSubheading'),
    ThemeSectionHeadingColor: fv('theme_sectionHeading'),

    ThemeTabActiveTextColor: fv('theme_tabActiveText'),
    ThemeTabInactiveTextColor: fv('theme_tabInactiveText'),
    ThemeTabIndicatorStyle: fv('theme_tabIndicatorStyle'),
    ThemeTabIndicatorFrom: fv('theme_tabIndicatorFrom'),
    ThemeTabIndicatorTo: fv('theme_tabIndicatorTo'),

    ThemeGateBgColor: fv('theme_gateBg'),
    ThemeGateBorderColor: fv('theme_gateBorder'),
    ThemeGateTitleColor: fv('theme_gateTitle'),

    ThemeBillCompanyNameBold: boolFieldVal_('theme_billNameBold'),
    ThemeBillCompanyNameItalic: boolFieldVal_('theme_billNameItalic'),
    ThemeBillCompanyNameUnderline: boolFieldVal_('theme_billNameUnderline'),
    ThemeBillCompanyInfoBold: boolFieldVal_('theme_billInfoBold'),
    ThemeBillCompanyInfoItalic: boolFieldVal_('theme_billInfoItalic'),
    ThemeBillCompanyInfoUnderline: boolFieldVal_('theme_billInfoUnderline'),
    ThemeBillHeaderLayout: fv('theme_billLayout'),

    ThemeBillFontFamily: fv('theme_billFont'),
    ThemeBillDiscountColor: fv('theme_billDiscount'),
    // Clamped to the same 20-400px the field allows, so an emptied or
    // out-of-range box can never save a broken logo size.
    ThemeBillLogoWidth: String(Math.min(400, Math.max(20, Math.round(Number(fv('theme_billLogoWidth')) || 96)))),
    ThemeBillLogoHeight: String(Math.min(400, Math.max(20, Math.round(Number(fv('theme_billLogoHeight')) || 58)))),

    ThemeButtonHoverFrom: fv('theme_buttonHoverFrom'),
    ThemeButtonHoverTo: fv('theme_buttonHoverTo'),
    ThemeOutlineText: fv('theme_outlineText'),
    ThemeOutlineBorder: fv('theme_outlineBorder'),
    ThemeOutlineHoverBg: fv('theme_outlineHoverBg'),
    ThemeOutlineHoverText: fv('theme_outlineHoverText')
  };
}

document.getElementById('saveThemeBtn').addEventListener('click', async () => {
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter Super Admin username & password above first.', 'error');
    return;
  }
  const themeFields = collectThemeFieldsFromForm_();
  const r = await apiPost('updateTheme', Object.assign({}, themeFields, creds));
  if (r.ok) {
    toast('Theme saved - applying now for everyone.', 'success');
    Object.assign(state.settings, themeFields);
    applyTheme_(state.settings);
    if (document.getElementById('view-dashboard').classList.contains('active')) loadDashboard(); // only redraw if it is on screen
    renderPreview();
  } else {
    toast(r.error || 'Could not save theme', 'error');
  }
});

document.getElementById('resetThemeBtn').addEventListener('click', async () => {
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter Super Admin username & password above first.', 'error');
    return;
  }
  if (!confirm('Reset the theme back to the original default colors for everyone?')) return;
  const r = await apiPost('resetTheme', creds);
  if (r.ok) {
    toast('Theme reset to default.', 'success');
    // Pull every Theme* field back from the server (see apiGetSettingsPublic
    // in Code.gs, which serves them from the same THEME_SETTING_DEFAULTS
    // list Reset just wrote) rather than duplicating every default value
    // here a second time - one source of truth for "what is default".
    const sr = await apiGet('getSettings');
    if (sr.ok) Object.assign(state.settings, sr.settings);
    applyTheme_(state.settings);
    if (document.getElementById('view-dashboard').classList.contains('active')) loadDashboard();
    renderPreview();
  } else {
    toast(r.error || 'Could not reset theme', 'error');
  }
});

// This is what actually answers "how will I know when it's time to
// archive?" - runs automatically every time Super Admin opens Admin
// Settings (billers never see this; they can't reach this screen at all).
// The live percentage itself is shown per-database in the "Database(s)
// Status" cards (see renderDatabaseStatus_) - this function's job is just
// the proactive warning toast, fired once per sitting so it informs
// without nagging on every click.
let capacityWarningShownThisSession_ = false;
async function checkSpreadsheetCapacity_() {
  if (state.session.role === 'biller') return;
  try {
    const r = await apiGet('getCapacityStatus');
    if (!r.ok || capacityWarningShownThisSession_) return;
    if (r.blocked) {
      capacityWarningShownThisSession_ = true;
      toast('This database is full - click "Add New Database" in Admin Settings to keep billing.', 'error');
    } else if (r.warning) {
      capacityWarningShownThisSession_ = true;
      toast('This spreadsheet is at ' + r.percentUsed + '% capacity - see "Data Continuity & Row Limits" in Admin Settings.', 'error');
    }
  } catch (err) {
    // Non-critical - the per-database cards still show the real number
    // once Admin Settings actually loads, even if this proactive check fails.
  }
}

// -------------------------------------------------------------------------
// 6c. DATABASE-FULL GATE - shown on the Create Bill screen (both roles).
//     Runs whenever that screen is opened, and also fires as a fallback if
//     saveBill() itself ever gets rejected server-side for the same reason
//     (belt-and-braces: the UI check should always catch it first, this
//     just guarantees billing can never silently fail instead).
// -------------------------------------------------------------------------
async function checkBillingCapacityGate_() {
  try {
    const r = await apiGet('getCapacityStatus');
    if (!r.ok) return;
    const saveBtn = document.getElementById('saveBillBtn');
    if (r.blocked) {
      if (saveBtn) saveBtn.disabled = true;
      openDbFullModal_(r);
    } else {
      if (saveBtn) saveBtn.disabled = false;
      closeDbFullModal_();
    }
  } catch (err) {
    // Non-critical - if this check itself fails, saveBill()'s own
    // server-side check still has the final say.
  }
}

function openDbFullModal_(capacityInfo) {
  const modal = document.getElementById('dbFullModal');
  if (!modal) return;
  const isAdmin = state.session.role !== 'biller';
  document.getElementById('dbFullAdminActions').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('dbFullBillerNote').style.display = isAdmin ? 'none' : 'block';
  const pctEl = document.getElementById('dbFullPercentText');
  if (pctEl && capacityInfo && capacityInfo.percentUsed != null) {
    pctEl.textContent = capacityInfo.percentUsed + '% full';
  }
  modal.classList.add('show');
}

function closeDbFullModal_() {
  const modal = document.getElementById('dbFullModal');
  if (modal) modal.classList.remove('show');
}

document.getElementById('dbFullCloseBtn') && document.getElementById('dbFullCloseBtn').addEventListener('click', closeDbFullModal_);

document.getElementById('dbFullGoToAdminBtn') && document.getElementById('dbFullGoToAdminBtn').addEventListener('click', () => {
  closeDbFullModal_();
  document.querySelector('.nav-item[data-view="admin"]').click();
});

// -------------------------------------------------------------------------
// 6d. ONE-CLICK "ADD NEW DATABASE" - calls the automatic backend endpoint
//     (apiAutoExpandDatabase in Code.gs). No spreadsheet ID to copy, no
//     Apps Script editor involved - this is the entire enhancement from
//     the Super Admin's side: type the credentials already on this screen,
//     click one button, wait a few seconds.
// -------------------------------------------------------------------------
async function addNewDatabaseAutomatic_(triggerBtn) {
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter your Super Admin username and password above first.', 'error');
    return;
  }
  if (!confirm(
    'This will:\n\n' +
    '1. Create a brand-new database (Google Spreadsheet)\n' +
    '2. Copy your Settings, Billers, Products and Patients into it\n' +
    '3. Archive the current database as read-only\n' +
    '4. Switch all new billing to the new database - immediately\n\n' +
    'This cannot be easily undone once new bills are saved against the new database. Continue?'
  )) return;

  const originalLabel = triggerBtn ? triggerBtn.textContent : '';
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = 'Creating new database…'; }
  try {
    const r = await apiPost('autoExpandDatabase', creds);
    if (!r.ok) {
      toast(r.error || 'Could not create the new database.', 'error');
      return;
    }
    toast('New database created and switched - billing continues normally.', 'success');
    const resultBox = document.getElementById('dbExpandResult');
    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.innerHTML =
        '<b>Done!</b> New database: <b>' + escapeHtml(r.newSpreadsheetName || '') + '</b><br>' +
        'Old database archived as: <b>' + escapeHtml(r.archivedLabel || '') + '</b><br>' +
        '<a href="' + escapeHtml(r.newSpreadsheetUrl || '') + '" target="_blank" rel="noopener">Open the new spreadsheet &rarr;</a>';
    }
    closeDbFullModal_();
    checkSpreadsheetCapacity_();
    checkBillingCapacityGate_();
  } catch (err) {
    toast('Network error while creating the new database.', 'error');
  } finally {
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = originalLabel; }
  }
}

document.getElementById('addNewDatabaseBtn') && document.getElementById('addNewDatabaseBtn').addEventListener('click', (e) => addNewDatabaseAutomatic_(e.currentTarget));
document.getElementById('dbFullAddNewDatabaseBtn') && document.getElementById('dbFullAddNewDatabaseBtn').addEventListener('click', (e) => addNewDatabaseAutomatic_(e.currentTarget));

// -------------------------------------------------------------------------
// DATA STATUS & RESET TOOLS - see apiGetDataDiagnostics / apiResetToActiveOnly
// in Code.gs for exactly why invoice/customer/product numbering can drift
// from what's actually in the spreadsheet, and what "Reset" actually does.
// -------------------------------------------------------------------------
document.getElementById('checkDataStatusBtn') && document.getElementById('checkDataStatusBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter your Super Admin username and password above first.', 'error');
    return;
  }
  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Checking...';
  try {
    const r = await apiPost('getDataDiagnostics', creds);
    const box = document.getElementById('dataStatusResult');
    if (!r.ok) {
      box.innerHTML = '<div class="ds-db-card ds-db-error">' + escapeHtml(r.error || 'Could not check status') + '</div>';
      return;
    }
    box.innerHTML = renderDatabaseStatus_(r);
  } catch (err) {
    toast('Network error while checking status.', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
});

// One card per database this app knows about (the active one, plus every
// archive) - a colored name pill, an Active/Archived badge, a capacity
// progress bar, row counts, and (active only) the Next ID predictions.
// Shared by both the Refresh button and the "reset done" confirmation.
function renderDatabaseStatus_(r) {
  const cards = [renderDbCard_(r.active, true)].concat((r.archives || []).map(a => renderDbCard_(a, false)));
  return '<div class="ds-db-list">' + cards.join('') + '</div>';
}

function renderDbCard_(db, isActive) {
  if (db.reachable === false) {
    return `
      <div class="ds-db-card ds-db-archived">
        <div class="ds-db-top">
          <div class="ds-db-name-pill ds-db-pill-muted">${escapeHtml(db.label || 'Archive')}</div>
          <span class="ds-db-badge ds-db-badge-archived">Archived</span>
        </div>
        <div class="ds-db-unreachable">&#9888;&#65039; Not reachable right now - deleted or unshared.</div>
      </div>`;
  }
  const pct = Math.min(100, Math.round((db.percentUsed || 0) * 10) / 10);
  const counts = db.rowCounts;

  // Active: capacity bar, then a plain 2-column list - "Bills / Customers /
  // Products" on the left, "Next Bill / Next Customer / Next Product" on
  // the right, lined up row by row. Archived: just the row counts, single
  // column, no capacity bar and no Next IDs (a frozen database has neither).
  const progressHtml = isActive ? `
      <div class="ds-db-progress">
        <div class="ds-db-progress-bar"><div class="ds-db-progress-fill" style="width:${pct}%;"></div></div>
        <span class="ds-db-progress-text">${pct}% / 100%</span>
      </div>` : '';

  const rowsHtml = !counts ? '' : isActive ? `
      <div class="ds-db-rows">
        <div class="ds-db-row"><span class="ds-db-row-label">Bills</span><span class="ds-db-row-value">${counts.bills}</span></div>
        <div class="ds-db-row"><span class="ds-db-row-label">Next Bills</span><span class="ds-db-row-value">${escapeHtml(db.nextBillId)}</span></div>
        <div class="ds-db-row"><span class="ds-db-row-label">Patients</span><span class="ds-db-row-value">${counts.customers}</span></div>
        <div class="ds-db-row"><span class="ds-db-row-label">Next Patients</span><span class="ds-db-row-value">${escapeHtml(db.nextCustomerId)}</span></div>
        <div class="ds-db-row"><span class="ds-db-row-label">Products</span><span class="ds-db-row-value">${counts.products}</span></div>
        <div class="ds-db-row"><span class="ds-db-row-label">Next Products</span><span class="ds-db-row-value">${escapeHtml(db.nextProductId)}</span></div>
      </div>` : `
      <div class="ds-db-rows ds-db-rows-single">
        <div class="ds-db-row"><span class="ds-db-row-label">Bills</span><span class="ds-db-row-value">${counts.bills}</span></div>
        <div class="ds-db-row"><span class="ds-db-row-label">Patients</span><span class="ds-db-row-value">${counts.customers}</span></div>
        <div class="ds-db-row"><span class="ds-db-row-label">Products</span><span class="ds-db-row-value">${counts.products}</span></div>
      </div>`;

  return `
    <div class="ds-db-card ${isActive ? 'ds-db-active' : 'ds-db-archived'}">
      <div class="ds-db-top">
        <div class="ds-db-name-pill ${isActive ? '' : 'ds-db-pill-muted'}">${escapeHtml(db.name)}</div>
        <span class="ds-db-badge ${isActive ? 'ds-db-badge-active' : 'ds-db-badge-archived'}">${isActive ? 'Active' : 'Archived'}</span>
      </div>
      ${db.url ? '<div class="ds-db-sheetname"><a href="' + escapeHtml(db.url) + '" target="_blank" rel="noopener">Open sheet &rarr;</a></div>' : ''}
      ${progressHtml}
      ${rowsHtml}
    </div>`;
}

document.getElementById('resetToActiveOnlyBtn') && document.getElementById('resetToActiveOnlyBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter your Super Admin username and password above first.', 'error');
    return;
  }
  if (!confirm(
    'This will:\n\n' +
    '1. Forget any archive spreadsheets currently linked (they are NOT deleted - just unlinked, so Reports and Find Bill stop including them)\n' +
    '2. Reset the next Invoice / Patient / Product numbers to match ONLY what\'s actually in THIS spreadsheet right now\n\n' +
    'Use this after manually clearing rows directly in the sheet, or after testing "Add New Database" and deciding to start over. Continue?'
  )) return;

  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Resetting...';
  try {
    const r = await apiPost('resetToActiveOnly', creds);
    if (!r.ok) { toast(r.error || 'Reset failed', 'error'); return; }
    toast('Reset done - numbering now matches this spreadsheet only.', 'success');
    document.getElementById('checkDataStatusBtn').click();
    checkSpreadsheetCapacity_();
  } catch (err) {
    toast('Network error while resetting.', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
});

// Non-destructive counterpart to Reset above: re-syncs the Invoice/Patient/
// Product counters to what's actually in the sheet (active spreadsheet +
// any linked archives) WITHOUT forgetting or unlinking those archives. Use
// this after hand-editing an id directly in the sheet.
document.getElementById('refreshNumberingBtn') && document.getElementById('refreshNumberingBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter your Super Admin username and password above first.', 'error');
    return;
  }
  if (!confirm(
    'This will re-check the Invoice / Patient / Product numbers against what\'s actually in the spreadsheet ' +
    '(including any linked archives) and update the next-number counters to match - useful after hand-editing an ' +
    'id directly in the sheet.\n\nLinked archives are kept exactly as they are - nothing is forgotten or deleted. Continue?'
  )) return;

  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Refreshing...';
  try {
    const r = await apiPost('refreshNumbering', creds);
    if (!r.ok) { toast(r.error || 'Refresh failed', 'error'); return; }
    toast(
      'Numbering refreshed' + (r.archivesScanned ? ' (scanned ' + r.archivesScanned + ' linked archive' + (r.archivesScanned === 1 ? '' : 's') + ')' : '') + '.',
      'success'
    );
    document.getElementById('checkDataStatusBtn').click();
    checkSpreadsheetCapacity_();
  } catch (err) {
    toast('Network error while refreshing numbering.', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
});

function getSuperAdminCreds() {
  return {
    superAdminUser: document.getElementById('admin_su_user').value,
    superAdminPass: document.getElementById('admin_su_pass').value
  };
}

function renderBillerTable() {
  const tbody = document.getElementById('billerTableBody');
  tbody.innerHTML = state.billers.map(b => `
    <tr>
      <td>${escapeHtml(b.billerId)}</td>
      <td>${escapeHtml(b.name)}</td>
      <td><button class="toggle ${b.active ? 'on' : ''}" data-id="${b.billerId}" data-action="toggle"></button></td>
      <td><button class="toggle ${b.canAccessTax ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessTax"></button></td>
      <td><button class="toggle ${b.canAccessBank ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessBank"></button></td>
      <td><button class="toggle ${b.canAccessDiscount ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessDiscount" title="Can apply discounts per bill"></button></td>
      <td><button class="toggle ${b.canAccessDashboard ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessDashboard" title="Can view the Dashboard menu"></button></td>
      <td><button class="toggle ${b.canAccessFindEdit ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessFindEdit"></button></td>
      <td><button class="toggle ${b.canAccessStockView ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessStockView" title="Can view the Inventory menu"></button></td>
      <td><button class="toggle ${b.canAccessStockEdit ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessStockEdit" title="Can add / edit stock quantities"></button></td>
      <td><button class="toggle ${b.canAccessReportDownload ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessReportDownload" title="Can download Reports as Excel"></button></td>
      <td><button class="toggle ${b.canAccessLetterpad ? 'on' : ''}" data-id="${b.billerId}" data-action="access" data-field="canAccessLetterpad" title="Can open the Letterpad menu (type + print only, nothing is saved)"></button></td>
      <td class="row-actions">
        <button class="icon-btn icon-btn-edit" data-id="${b.billerId}" data-action="edit" title="Edit ${escapeHtml(b.name)}" aria-label="Edit">&#9998;</button>
        <button class="icon-btn icon-btn-danger" data-id="${b.billerId}" data-action="delete" title="Delete ${escapeHtml(b.name)}" aria-label="Delete">&#128465;</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => handleBillerAction(btn.dataset.action, btn.dataset.id, btn.dataset.field, btn));
  });
}

async function handleBillerAction(action, billerId, field, btnEl) {
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter Super Admin username & password above first.', 'error');
    return;
  }

  if (action === 'toggle' || action === 'access') {
    // Optimistic update: flip the switch (and the underlying data) the
    // instant it's clicked, so it feels as snappy as any normal toggle -
    // then confirm with the server in the background and quietly revert
    // if the save didn't actually go through. Two Apps Script round trips
    // (save, then re-fetch the whole table) were what made this feel slow
    // before; now there's zero visible wait for the common case.
    const b = state.billers.find(x => x.billerId === billerId);
    if (!b) return;
    const key = action === 'toggle' ? 'active' : field;
    const previousValue = !!b[key];
    const newValue = !previousValue;

    b[key] = newValue;
    if (btnEl) btnEl.classList.toggle('on', newValue);

    const apiAction = action === 'toggle' ? 'toggleBiller' : 'setBillerAccess';
    const payload = action === 'toggle' ? { billerId, ...creds } : { billerId, field, value: newValue, ...creds };
    const r = await apiPost(apiAction, payload);

    if (!r.ok) {
      b[key] = previousValue;
      if (btnEl) btnEl.classList.toggle('on', previousValue);
      toast(r.error || 'Update failed', 'error');
      return;
    }

    if (action === 'toggle') {
      toast('Biller status updated', 'success');
    } else if (field === 'canAccessStockEdit' && newValue) {
      // Stock Edit auto-grants Stock View server-side - that OTHER toggle
      // may have just changed too, so this one case still needs a quiet
      // background refresh to pick it up (doesn't block the click itself).
      toast('Stock Edit access granted (Stock View enabled automatically)', 'success');
      refreshBillers();
    } else if (field === 'canAccessStockView' && !newValue) {
      toast('Stock View access removed (Stock Edit disabled automatically)', 'success');
      refreshBillers();
    } else {
      toast('Access updated', 'success');
    }
  } else if (action === 'delete') {
    if (!confirm('Delete biller ' + billerId + '?')) return;
    const r = await apiPost('deleteBiller', { billerId, ...creds });
    if (r.ok) { await refreshBillers(); toast('Biller deleted', 'success'); }
    else toast(r.error, 'error');
  } else if (action === 'edit') {
    const b = state.billers.find(x => x.billerId === billerId);
    openBillerModal(b);
  }
}

async function refreshBillers() {
  const r = await apiGet('getBillers');
  if (r.ok) { state.billers = r.billers; renderBillerTable(); populateBillerDropdown(); }
}

document.getElementById('addBillerBtn').addEventListener('click', () => openBillerModal(null));

function openBillerModal(biller) {
  document.getElementById('billerModalTitle').textContent = biller ? 'Edit Biller' : 'Add Biller';
  document.getElementById('bm_editId').value = biller ? biller.billerId : '';
  document.getElementById('bm_name').value = biller ? biller.name : '';
  document.getElementById('bm_password').value = '';
  clearErrorsIn_(document.getElementById('billerModal'));
  document.getElementById('billerModal').classList.add('show');
}
document.getElementById('bm_cancel').addEventListener('click', () => document.getElementById('billerModal').classList.remove('show'));
document.getElementById('bm_save').addEventListener('click', async () => {
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) { toast('Enter Super Admin credentials above first.', 'error'); return; }
  const editId = document.getElementById('bm_editId').value;
  const existing = editId ? state.billers.find(x => x.billerId === editId) : null;
  clearErrorsIn_(document.getElementById('billerModal'));
  const rawName = document.getElementById('bm_name').value;
  // An existing biller's unchanged name is always accepted as-is.
  const nameRes = (existing && vLine_(rawName) === vLine_(existing.name)) ? vRes_(vLine_(rawName)) : vPersonName_(rawName, 'Biller Name', true);
  const passRes = vPassword_(document.getElementById('bm_password').value, 'Password', 4, !editId);
  const check = applyChecks_([['bm_name', nameRes, 'name'], ['bm_password', passRes, 'password']]);
  if (!check.ok) { toast(check.firstError, 'error'); return; }
  const btn = document.getElementById('bm_save');
  btn.disabled = true;
  try {
    const r = await apiPost('saveBiller', { editBillerId: editId || null, name: check.values.name, password: check.values.password, ...creds });
    if (r.ok) {
      document.getElementById('billerModal').classList.remove('show');
      await refreshBillers();
      toast('Biller saved', 'success');
    } else {
      markServerFieldError_(r, { name: 'bm_name', password: 'bm_password' });
      toast(r.error, 'error');
    }
  } catch (err) {
    toast('Network error while saving the biller.', 'error');
  } finally {
    btn.disabled = false;
  }
});

// Shop settings save


document.getElementById('refreshDashboardSheetBtn').addEventListener('click', async () => {
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) { toast('Enter Super Admin credentials above first.', 'error'); return; }
  const r = await apiPost('refreshDashboardSheet', creds);
  if (r.ok) toast('Dashboard sheet & charts refreshed', 'success');
  else toast(r.error || 'Refresh failed', 'error');
});





// Validates a group of Settings inputs - [inputId, settingsKey, validator].
// Like the server, only fields that were actually CHANGED are checked, so a
// value saved before these rules existed never blocks saving something
// else. Each changed field is shown back in its cleaned form (e.g. a link
// gets its missing https:// added). Returns the values to send, or null.
function collectSettings_(fields) {
  const checks = [], out = {};
  fields.forEach(([id, key, validate]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const raw = el.value;
    const stored = state.settings[key];
    if (vLine_(raw) === vLine_(stored == null ? '' : stored)) { out[key] = raw.trim(); return; }
    const res = validate(raw);
    checks.push([el, res]);
    if (!res.error) { out[key] = res.value; el.value = res.value; }
  });
  const result = applyChecks_(checks);
  if (!result.ok) { toast(result.firstError, 'error'); return null; }
  return out;
}
const upperNoSpace_ = v => v.toUpperCase().replace(/\s/g, '');

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) { toast('Enter Super Admin credentials above first.', 'error'); return; }
  clearErrorsIn_(document.getElementById('tab-shop'));
  const values = collectSettings_([
    ['s_logo', 'LogoURL', v => vUrl_(v, 'App Logo URL')],
    ['s_printLogo', 'PrintLogoURL', v => vUrl_(v, 'Print Bill Logo URL')],
    ['s_companyName', 'CompanyName', v => vFreeText_(v, 'Company Name', 80, true, 2)],
    ['s_phone', 'Phone', v => vShopPhone_(v, 'Phone')],
    ['s_address', 'Address', v => vAddress_(v, 'Address')],
    ['s_website', 'Website', v => vPattern_(v, 'Website', VR.WEBSITE, 100, 'is not a valid website (e.g. www.example.com).', x => x.replace(/\s/g, ''))],
    ['s_gst', 'GSTNumber', v => vPattern_(v, 'GST Number', VR.GSTIN, 15, 'must be a valid 15-character GSTIN (e.g. 33ABCDE1234F1Z5).', upperNoSpace_)],
    ['s_socialWhatsapp', 'SocialWhatsApp', v => vMobile_(v, 'WhatsApp Number', false)],
    ['s_socialInstagram', 'SocialInstagram', v => vUrl_(v, 'Instagram URL')],
    ['s_socialFacebook', 'SocialFacebook', v => vUrl_(v, 'Facebook URL')],
    ['s_socialLinkedin', 'SocialLinkedIn', v => vUrl_(v, 'LinkedIn URL')],
    ['s_socialYoutube', 'SocialYouTube', v => vUrl_(v, 'YouTube URL')]
  ]);
  if (!values) return;
  const payload = Object.assign({}, creds, values);
  const btn = document.getElementById('saveSettingsBtn');
  btn.disabled = true;
  try {
    const r = await apiPost('updateSettings', payload);
    if (r.ok) {
      toast('Shop details saved', 'success');
      // Keep local state in sync even if a stale backend omits a field
      state.settings = Object.assign({}, state.settings, values);
      const boot = await apiGet('getSettings');
      if (boot.ok && boot.settings) {
        state.settings = Object.assign({}, state.settings, boot.settings);
      }
      applySettingsToUI();
      renderPreview();
    } else {
      markServerFieldError_(r, SETTINGS_FIELD_IDS_);
      toast(r.error, 'error');
    }
  } catch (err) {
    toast('Network error while saving shop details.', 'error');
  } finally {
    btn.disabled = false;
  }
});

const SETTINGS_FIELD_IDS_ = {
  LogoURL: 's_logo', PrintLogoURL: 's_printLogo', CompanyName: 's_companyName', Phone: 's_phone',
  Address: 's_address', Website: 's_website', GSTNumber: 's_gst', SocialWhatsApp: 's_socialWhatsapp',
  SocialInstagram: 's_socialInstagram', SocialFacebook: 's_socialFacebook', SocialLinkedIn: 's_socialLinkedin',
  SocialYouTube: 's_socialYoutube', CompanyEmail: 's_companyEmail', CGSTPercent: 's_cgst', SGSTPercent: 's_sgst',
  BankName: 's_bankName', BankAccountNo: 's_bankAccountNo', BankIFSC: 's_bankIFSC',
  BankAccountHolder: 's_bankAccountHolder', AuthorizedSignatoryLabel: 's_signatoryLabel',
  newSuperAdminUser: 'acc_newUser', newSuperAdminPass: 'acc_newPass'
};

document.getElementById('saveInvoiceSettingsBtn').addEventListener('click', async () => {
  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) { toast('Enter Super Admin credentials above first.', 'error'); return; }
  clearErrorsIn_(document.getElementById('tab-invoice'));
  const values = collectSettings_([
    ['s_companyEmail', 'CompanyEmail', v => vEmail_(v, 'Company Email', false)],
    ['s_cgst', 'CGSTPercent', v => vPercent_(v, 'CGST %')],
    ['s_sgst', 'SGSTPercent', v => vPercent_(v, 'SGST %')],
    ['s_bankName', 'BankName', v => vPattern_(v, 'Bank Name', VR.ORG_NAME, 60, 'can only contain letters, numbers, spaces and . , & \' ( ) -')],
    ['s_bankAccountNo', 'BankAccountNo', v => vPattern_(v, 'Account Number', VR.ACCOUNT_NO, 18, 'must be 9 to 18 digits (digits only).', x => x.replace(/\s/g, ''))],
    ['s_bankIFSC', 'BankIFSC', v => vPattern_(v, 'IFSC Code', VR.IFSC, 11, 'must be a valid 11-character IFSC (e.g. YESB0000123).', upperNoSpace_)],
    ['s_bankAccountHolder', 'BankAccountHolder', v => vPattern_(v, 'Account Holder Name', VR.ORG_NAME, 80, 'can only contain letters, numbers, spaces and . , & \' ( ) -')],
    ['s_signatoryLabel', 'AuthorizedSignatoryLabel', v => vFreeText_(v, 'Signatory Label', 40, false)]
  ]);
  if (!values) return;
  const payload = Object.assign({}, creds, values, {
    CGSTPercent: Number(values.CGSTPercent) || 0,
    SGSTPercent: Number(values.SGSTPercent) || 0,
    AuthorizedSignatoryLabel: values.AuthorizedSignatoryLabel || 'Authorized Signatory',
    ShowCompanyEmail: document.getElementById('s_showCompanyEmail').value,
    ShowTaxOnBill: document.getElementById('s_showTaxOnBill').value,
    ShowBankDetails: document.getElementById('s_showBankDetails').value,
    ShowDiscountOption: document.getElementById('s_showDiscountOption').value,
    ShowAuthorizedSignatory: document.getElementById('s_showAuthorizedSignatory').value
  });
  const btn = document.getElementById('saveInvoiceSettingsBtn');
  btn.disabled = true;
  try {
    const r = await apiPost('updateSettings', payload);
    if (r.ok) {
      toast('Invoice / Tax settings saved', 'success');
      const boot = await apiGet('getSettings');
      if (boot.ok) { state.settings = boot.settings; applySettingsToUI(); refreshBillToggleVisibility_(); renderPreview(); }
    } else {
      markServerFieldError_(r, SETTINGS_FIELD_IDS_);
      toast(r.error, 'error');
    }
  } catch (err) {
    toast('Network error while saving invoice settings.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('saveAccountBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('accountStatus');
  statusEl.textContent = ''; statusEl.className = 'biller-status';

  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    statusEl.textContent = 'Enter your CURRENT Super Admin username & password above first.';
    statusEl.className = 'biller-status err';
    return;
  }
  clearErrorsIn_(document.getElementById('tab-account'));
  const newUser = vLine_(document.getElementById('acc_newUser').value);
  const newPass = document.getElementById('acc_newPass').value;
  const confirmPass = document.getElementById('acc_confirmPass').value;

  if (!newUser && !newPass) {
    statusEl.textContent = 'Enter a new username and/or a new password to change.';
    statusEl.className = 'biller-status err';
    return;
  }
  const checks = [];
  if (newUser) {
    checks.push(['acc_newUser', (newUser.length < 3 || newUser.length > 40 || !VR.ADMIN_USER.test(newUser))
      ? vRes_(newUser, 'New username must be 3 to 40 characters - letters, numbers, spaces and . _ - @ only.')
      : vRes_(newUser)]);
  }
  if (newPass) {
    checks.push(['acc_newPass', vPassword_(newPass, 'New password', 6, true)]);
    checks.push(['acc_confirmPass', newPass === confirmPass ? vRes_(confirmPass) : vRes_(confirmPass, 'New password and confirmation do not match.')]);
  }
  const accCheck = applyChecks_(checks);
  if (!accCheck.ok) {
    statusEl.textContent = accCheck.firstError;
    statusEl.className = 'biller-status err';
    return;
  }

  const btn = document.getElementById('saveAccountBtn');
  btn.disabled = true; btn.textContent = 'Updating...';
  try {
    const r = await apiPost('updateSettings', {
      ...creds,
      newSuperAdminUser: newUser || undefined,
      newSuperAdminPass: newPass || undefined
    });
    if (r.ok) {
      toast('Login updated - please log in again with your new credentials', 'success');
      // Shared key list (includes the session token, which this hand-typed
      // list used to miss - the old login's token lingered in the tab).
      SESSION_STORAGE_KEYS.forEach(k => sessionStorage.removeItem(k));
      setTimeout(() => location.reload(), 1200);
    } else {
      markServerFieldError_(r, SETTINGS_FIELD_IDS_);
      statusEl.textContent = r.error || 'Could not update login.';
      statusEl.className = 'biller-status err';
    }
  } catch (err) {
    statusEl.textContent = 'Network error while updating login.';
    statusEl.className = 'biller-status err';
  } finally {
    btn.disabled = false; btn.textContent = 'Update My Login';
  }
});

// Products tab - locked by default. Clicking the pencil icon enables that
// row's Name/Price for editing; Save/Cancel then commit or discard. Active/
// Inactive is a one-click toggle (auto-saves immediately, like Billers).
// All edits/deletes require Super Admin credentials entered above.
let productEditingId = null;

function renderProductTable() {
  const tbody = document.getElementById('productTableBody');
  tbody.innerHTML = state.products.map(p => productRowHtml_(p)).join('');
  decorateInputs_(tbody);
  tbody.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => handleProductRowAction_(btn.dataset.action, btn.dataset.id));
  });
}

function productRowHtml_(p) {
  const editing = String(p.id) === String(productEditingId);
  const activeToggle = `<button class="toggle ${p.active ? 'on' : ''}" data-id="${p.id}" data-action="toggleActive" title="${p.active ? 'Active' : 'Inactive'}"></button>`;
  const stockCell = (p.stock === null || p.stock === undefined)
    ? '<span style="color:var(--muted);">Not tracked</span>'
    : `<b>${p.stock}</b>`;

  if (editing) {
    return `
      <tr data-id="${p.id}" class="editing">
        <td><input type="text" class="pt-name" value="${escapeHtml(p.name)}"></td>
        <td><input type="number" class="pt-price" min="0" step="0.01" value="${Number(p.defaultPrice)}"></td>
        <td>${stockCell}</td>
        <td>${activeToggle}</td>
        <td class="row-actions">
          <button class="btn btn-primary btn-sm" data-id="${p.id}" data-action="save">Save</button>
          <button class="btn btn-outline btn-sm" data-id="${p.id}" data-action="cancel">Cancel</button>
        </td>
      </tr>`;
  }
  return `
    <tr data-id="${p.id}">
      <td>${escapeHtml(p.name)}</td>
      <td>&#8377;${Number(p.defaultPrice).toFixed(2)}</td>
      <td>${stockCell}</td>
      <td>${activeToggle}</td>
      <td class="row-actions">
        <button class="btn btn-outline btn-sm icon-btn" data-id="${p.id}" data-action="edit" title="Edit">&#9998;</button>
        <button class="btn btn-danger btn-sm icon-btn" data-id="${p.id}" data-action="delete" title="Delete">&#128465;</button>
      </td>
    </tr>`;
}

async function handleProductRowAction_(action, productId) {
  const p = state.products.find(x => String(x.id) === String(productId));
  if (!p) return;

  if (action === 'edit') {
    productEditingId = productId;
    renderProductTable();
    return;
  }

  if (action === 'cancel') {
    productEditingId = null;
    renderProductTable();
    return;
  }

  const creds = getSuperAdminCreds();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter Super Admin username & password above first.', 'error');
    return;
  }

  if (action === 'toggleActive') {
    const r = await apiPost('updateProduct', { productId, name: p.name, defaultPrice: p.defaultPrice, active: !p.active, ...creds });
    if (r.ok) { p.active = !p.active; toast('Product status updated', 'success'); renderProductTable(); }
    else toast(r.error || 'Failed to update', 'error');
    return;
  }

  if (action === 'save') {
    const row = document.querySelector('#productTableBody tr[data-id="' + productId + '"]');
    const nameEl = row.querySelector('.pt-name');
    const priceEl = row.querySelector('.pt-price');
    // Unchanged (older) names are accepted as-is; a renamed one must follow
    // the rules and must not clash with another product - stock and sales
    // are matched by name, so two identical names would mix them up.
    const nameRes = vLine_(nameEl.value) === vLine_(p.name) ? vRes_(vLine_(nameEl.value)) : vProductName_(nameEl.value, 'Service/Treatment name');
    const clash = !nameRes.error && state.products.find(x => String(x.id) !== String(productId) && vLine_(x.name).toLowerCase() === nameRes.value.toLowerCase());
    const check = applyChecks_([
      [nameEl, clash ? vRes_(nameRes.value, '"' + clash.name + '" already exists in the list.') : nameRes, 'name'],
      [priceEl, vMoney_(priceEl.value, 'Default Price', true), 'price']
    ]);
    if (!check.ok) { toast(check.firstError, 'error'); return; }
    const name = check.values.name, defaultPrice = check.values.price;
    const r = await apiPost('updateProduct', { productId, name, defaultPrice, active: p.active, ...creds });
    if (r.ok) {
      p.name = name; p.defaultPrice = defaultPrice;
      productEditingId = null;
      toast('Product updated', 'success');
      renderProductTable();
    } else toast(r.error || 'Failed to update', 'error');
    return;
  }

  if (action === 'delete') {
    if (!confirm('Delete product "' + p.name + '"? This cannot be undone.')) return;
    const r = await apiPost('deleteProduct', { productId, ...creds });
    if (r.ok) {
      state.products = state.products.filter(x => String(x.id) !== String(productId));
      if (productEditingId === productId) productEditingId = null;
      toast('Product deleted', 'success');
      renderProductTable();
    } else toast(r.error || 'Failed to delete', 'error');
  }
}

document.getElementById('addProductBtnAdmin').addEventListener('click', async () => {
  clearErrorsIn_(document.getElementById('tab-products'));
  const nameRes = vProductName_(document.getElementById('np_name').value, 'Service/Treatment name');
  const clash = !nameRes.error && state.products.find(x => vLine_(x.name).toLowerCase() === nameRes.value.toLowerCase());
  const check = applyChecks_([
    ['np_name', clash ? vRes_(nameRes.value, '"' + clash.name + '" already exists in the list.') : nameRes, 'name'],
    ['np_price', vMoney_(document.getElementById('np_price').value, 'Default Price', false), 'price'],
    ['np_stock', vInt_(document.getElementById('np_stock').value.trim(), 'Starting Stock', 0, VLIMIT.STOCK_MAX, false, ''), 'stock']
  ]);
  if (!check.ok) { toast(check.firstError, 'error'); return; }
  const { name, price } = check.values;
  const hasStock = check.values.stock !== '';
  const payload = { name, defaultPrice: price };
  if (hasStock) payload.stock = check.values.stock;
  const btn = document.getElementById('addProductBtnAdmin');
  btn.disabled = true;
  try {
    const r = await apiPost('addProduct', payload);
    if (r.ok) {
      state.products.push({ id: r.productId, name, defaultPrice: price, active: true, stock: hasStock ? check.values.stock : null, lowStockThreshold: 5 });
      renderProductTable();
      document.getElementById('np_name').value = ''; document.getElementById('np_price').value = ''; document.getElementById('np_stock').value = '';
      toast('Product added', 'success');
    } else {
      markServerFieldError_(r, { name: 'np_name', defaultPrice: 'np_price', stock: 'np_stock' });
      toast(r.error, 'error');
    }
  } catch (err) {
    toast('Network error while adding the product.', 'error');
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------------------------------------------------
// 15b. INVENTORY (LIVE STOCK) VIEW
// -------------------------------------------------------------------------
async function loadInventory() {
  try {
    const r = await apiGet('getProducts');
    if (r.ok) state.products = r.products;
  } catch (err) { /* fall back to whatever is already in state.products */ }
  renderInventoryTable();
  loadInventoryLog_();
}

document.getElementById('refreshInventoryBtn').addEventListener('click', loadInventory);
document.getElementById('invSearch').addEventListener('input', renderInventoryTable);

function inventoryStockStatus_(p) {
  if (p.stock === null || p.stock === undefined) return { cls: 'na', label: 'Not Tracked' };
  const threshold = p.lowStockThreshold != null ? p.lowStockThreshold : 5;
  if (p.stock <= 0) return { cls: 'out', label: p.stock < 0 ? 'Oversold' : 'Out of Stock' };
  if (p.stock <= threshold) return { cls: 'low', label: 'Low Stock' };
  return { cls: 'ok', label: 'In Stock' };
}

function renderInventoryTable() {
  const canEdit = canEditInventory_();
  const actionsHeader = document.getElementById('invActionsHeader');
  if (actionsHeader) actionsHeader.style.display = canEdit ? '' : 'none';

  const q = (document.getElementById('invSearch').value || '').trim().toLowerCase();
  const list = state.products
    .filter(p => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  let tracked = 0, low = 0, out = 0;
  state.products.forEach(p => {
    if (p.stock === null || p.stock === undefined) return;
    tracked++;
    const threshold = p.lowStockThreshold != null ? p.lowStockThreshold : 5;
    if (p.stock <= 0) out++;
    else if (p.stock <= threshold) low++;
  });
  document.getElementById('invTrackedCount').textContent = tracked;
  document.getElementById('invLowCount').textContent = low;
  document.getElementById('invOutCount').textContent = out;

  const tbody = document.getElementById('inventoryTableBody');
  document.getElementById('invEmptyHint').style.display = list.length ? 'none' : 'block';

  tbody.innerHTML = list.map(p => {
    const status = inventoryStockStatus_(p);
    const isTracked = p.stock !== null && p.stock !== undefined;
    const stockDisplay = isTracked ? p.stock : '-';
    const thresholdDisplay = p.lowStockThreshold != null ? p.lowStockThreshold : 5;

    let actionsCell = '';
    if (canEdit) {
      if (!isTracked) {
        actionsCell = `<button class="btn btn-outline btn-sm inv-track-btn" data-id="${p.id}" data-action="startTracking">+ Start Tracking</button>`;
      } else {
        actionsCell = `
          <div class="inv-edit-row">
            <button type="button" class="inv-step-btn" data-id="${p.id}" data-action="step" data-delta="-1" title="Decrease by 1">&minus;</button>
            <input type="number" class="inv-stock-input" data-id="${p.id}" value="${p.stock}" min="0">
            <button type="button" class="inv-step-btn" data-id="${p.id}" data-action="step" data-delta="1" title="Increase by 1">+</button>
            <button class="btn btn-primary btn-sm" data-id="${p.id}" data-action="saveStock">Save</button>
          </div>`;
      }
    }

    return `
      <tr data-id="${p.id}">
        <td>${escapeHtml(p.name)}${p.active === false ? ' <span style="color:var(--muted);font-size:11px;">(inactive)</span>' : ''}</td>
        <td class="inv-stock-cell">${stockDisplay}</td>
        <td>${(canEdit && isTracked) ? `<input type="number" class="inv-threshold-input" data-id="${p.id}" value="${thresholdDisplay}" min="0">` : thresholdDisplay}</td>
        <td><span class="inv-status-badge ${status.cls}">${status.label}</span></td>
        ${canEdit ? `<td>${actionsCell}</td>` : ''}
      </tr>`;
  }).join('');

  if (!canEdit) return;
  decorateInputs_(tbody);
  tbody.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleInventoryAction_(btn.dataset.action, btn.dataset.id, btn.dataset.delta));
  });
}

// Biller stock edits are authorized silently with their own stored session
// credentials (same pattern as Find/Edit Bill); Super Admin must re-enter
// credentials in the panel at the top of the Inventory view, same as every
// other sensitive write elsewhere in Admin Settings.
function getStockAuthPayload_() {
  if (state.session.role === 'biller') {
    return { billerId: state.session.billerId, billerPassword: state.session.billerPassword };
  }
  return {
    superAdminUser: document.getElementById('inv_su_user').value,
    superAdminPass: document.getElementById('inv_su_pass').value
  };
}

function requireSuperAdminForInventory_() {
  if (state.session.role === 'biller') return true;
  const creds = getStockAuthPayload_();
  if (!creds.superAdminUser || !creds.superAdminPass) {
    toast('Enter Super Admin username & password above first.', 'error');
    return false;
  }
  return true;
}

async function handleInventoryAction_(action, productId, deltaAttr) {
  const p = state.products.find(x => String(x.id) === String(productId));
  if (!p) return;

  if (action === 'step') {
    // Local-only nudge - nothing is written until "Save" is pressed, so a
    // stray click never silently changes the sheet.
    const row = document.querySelector('#inventoryTableBody tr[data-id="' + productId + '"]');
    const input = row.querySelector('.inv-stock-input');
    const delta = Number(deltaAttr) || 0;
    input.value = Math.min(VLIMIT.STOCK_MAX, Math.max(0, (Number(input.value) || 0) + delta));
    clearFieldError_(input);
    return;
  }

  if (action === 'startTracking') {
    if (!requireSuperAdminForInventory_()) return;
    const val = prompt('Starting stock count for "' + p.name + '" (whole number):', '0');
    if (val === null) return;
    const res = vInt_(String(val).trim(), 'Starting stock', 0, VLIMIT.STOCK_MAX, true);
    if (res.error) { toast(res.error, 'error'); return; }
    const n = res.value;
    const r = await apiPost('setProductStock', Object.assign({ productId, mode: 'set', value: n }, getStockAuthPayload_()));
    if (r.ok) {
      p.stock = r.newStock;
      toast(p.name + ' is now tracked (' + r.newStock + ' in stock)', 'success');
      renderInventoryTable(); refreshAllStockBadges(); loadInventoryLog_();
    } else toast(r.error || 'Failed to set stock', 'error');
    return;
  }

  if (action === 'saveStock') {
    if (!requireSuperAdminForInventory_()) return;
    const row = document.querySelector('#inventoryTableBody tr[data-id="' + productId + '"]');
    const stockInput = row.querySelector('.inv-stock-input');
    const thresholdInput = row.querySelector('.inv-threshold-input');
    // An emptied box used to save as 0 stock without any warning.
    const checks = [[stockInput, vInt_(stockInput.value.trim(), 'Stock', 0, VLIMIT.STOCK_MAX, true), 'stock']];
    if (thresholdInput) checks.push([thresholdInput, vInt_(thresholdInput.value.trim(), 'Low stock alert', 0, VLIMIT.THRESHOLD_MAX, true), 'threshold']);
    const check = applyChecks_(checks);
    if (!check.ok) { toast(check.firstError, 'error'); return; }
    const newStock = check.values.stock;
    const payload = Object.assign({ productId, mode: 'set', value: newStock }, getStockAuthPayload_());
    if (thresholdInput) payload.lowStockThreshold = check.values.threshold;
    const r = await apiPost('setProductStock', payload);
    if (r.ok) {
      p.stock = r.newStock;
      if (thresholdInput) p.lowStockThreshold = check.values.threshold;
      toast('Stock updated for ' + p.name, 'success');
      renderInventoryTable(); refreshAllStockBadges(); loadInventoryLog_();
    } else toast(r.error || 'Failed to update stock', 'error');
  }
}

async function loadInventoryLog_() {
  const el = document.getElementById('inventoryLog');
  if (!el) return;
  try {
    const r = await apiGet('getStockLog');
    if (!r.ok || !r.log || !r.log.length) { el.innerHTML = '<div class="inv-log-empty">No stock activity yet.</div>'; return; }
    el.innerHTML = r.log.map(entry => {
      const deltaNum = Number(entry.delta) || 0;
      const deltaCls = deltaNum > 0 ? 'pos' : (deltaNum < 0 ? 'neg' : '');
      const deltaLabel = (deltaNum > 0 ? '+' : '') + deltaNum;
      return `<div class="inv-log-row">
        <span>${escapeHtml(entry.productName)} - ${escapeHtml(entry.changeType)}${entry.billId ? ' (' + escapeHtml(entry.billId) + ')' : ''}</span>
        <span class="inv-log-delta ${deltaCls}">${deltaLabel} &rarr; ${entry.newStock}</span>
      </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = '<div class="inv-log-empty">Could not load recent activity.</div>';
  }
}

// -------------------------------------------------------------------------
// 16. REPORTS - read-only, per-column-filterable data views. Accessible to
//     EVERY signed-in user (biller or Super Admin) with no permission gate
//     and no editing controls anywhere in this section, by design. All
//     filter/column-visibility state lives only in this browser tab's own
//     `reportState` object - nothing here is written back to the sheet or
//     shared with any other person's session, so two people filtering the
//     same report at the same time never affect each other.
// -------------------------------------------------------------------------
const REPORT_CONFIGS = {
  universal: {    label: 'Universal Report', apiAction: 'getUniversalReport', primaryKey: null,
    // One row per PRODUCT LINE SOLD - a customer who bought 10 products
    // across 3 bills shows up as 10 rows here, not 3. BillID repeats
    // across a bill's own rows on purpose (it has one row per product on
    // that bill) - that's not a duplicate, it's the same bill's line items.
    // No single column is unique per row here (that's expected at this
    // granularity), so unlike other reports there's no "primary key"
    // column locked/highlighted - every column is just a normal filter.
    columns: [
      { key: 'billId',           label: 'Bill ID',            type: 'text',   visible: true },
      { key: 'invoiceDate',      label: 'Invoice Date',       type: 'date',   visible: true },
      { key: 'invoiceTime',      label: 'Invoice Time',       type: 'text',   visible: true },
      { key: 'customerId',       label: 'Patient ID',        type: 'text',   visible: true },
      { key: 'customerName',     label: 'Patient Name',      type: 'text',   visible: true },
      { key: 'phone',            label: 'Phone',               type: 'text',   visible: true },
      { key: 'email',            label: 'Email',               type: 'text',   visible: false },
      { key: 'address',          label: 'Address',             type: 'text',   visible: false },
      { key: 'deliveryAddress',  label: 'Delivery Address',    type: 'text',   visible: false },
      { key: 'productName',      label: 'Service/Treatment',             type: 'text',   visible: true },
      { key: 'unitPrice',        label: 'Unit Price',          type: 'number', visible: true, format: 'money', noSum: true },
      { key: 'qty',              label: 'Qty',                 type: 'number', visible: true },
      { key: 'grossAmount',      label: 'Gross Amount',        type: 'number', visible: true, format: 'money' },
      // Discount breakdown - the item's own % discount first, then the
      // bill-level "additional discount" % on what's left (see
      // computeBillTotals_ on the server). The two "% " columns are rates
      // (not money) so they're marked noSum - averaging/summing a
      // percentage across rows isn't a meaningful number. The two "Amount"
      // columns ARE money and unique per row, so they sum correctly with
      // no double-counting even across a whole bill's product lines.
      { key: 'itemDiscountPercent', label: 'Item Discount %',      type: 'number', visible: true, format: 'percent', noSum: true },
      { key: 'itemDiscountAmount',  label: 'Item Discount Amount', type: 'number', visible: true, format: 'money' },
      { key: 'billDiscountPercent', label: 'Bill Discount %',      type: 'number', visible: true, format: 'percent', noSum: true },
      { key: 'billDiscountAmount',  label: 'Bill Discount Amount', type: 'number', visible: true, format: 'money' },
      { key: 'lineTotal',        label: 'Net Line Total',      type: 'number', visible: true, format: 'money' },
      { key: 'paymentMethod',    label: 'Payment Method',      type: 'text',   visible: true, format: 'chip' },
      { key: 'paymentStatus',    label: 'Payment Status',      type: 'text',   visible: true, format: 'chip' },
      // These two repeat once per product line on the same bill (they're
      // the WHOLE BILL's totals, not this line's) - summed naively they'd
      // over-count. dedupeBy tells the totals footer to count each BillID
      // only once, so the footer is always correct no matter what's filtered.
      { key: 'totalQty',         label: 'Bill Total Qty',      type: 'number', visible: false, dedupeBy: 'billId' },
      { key: 'totalAmount',      label: 'Bill Total Amount',   type: 'number', visible: true, format: 'money', dedupeBy: 'billId' },
      { key: 'billerId',         label: 'Biller ID',           type: 'text',   visible: false },
      { key: 'billerName',       label: 'Biller',              type: 'text',   visible: true },
      { key: 'createdAt',        label: 'Created At',          type: 'text',   visible: false },
      { key: 'updatedAt',        label: 'Last Updated',        type: 'text',   visible: false },
      { key: 'updatedBy',        label: 'Updated By',          type: 'text',   visible: false },
      { key: 'versionNote',      label: 'Version Note',        type: 'text',   visible: false },
      { key: 'razorpayQrId',     label: 'Razorpay QR ID',      type: 'text',   visible: false },
      { key: 'razorpayPaymentId',label: 'Razorpay Payment ID', type: 'text',   visible: false },
      { key: 'showTaxOverride',  label: 'Tax Shown Override',  type: 'text',   visible: false },
      { key: 'showBankOverride', label: 'Bank Shown Override', type: 'text',   visible: false },
      { key: 'isFirstLineOfBill',label: 'First Line Of Bill',  type: 'text',   visible: false },
      { key: 'source',           label: 'Source Spreadsheet',  type: 'text',   visible: false }
    ]
  },
  daily: {
    label: 'Daily Report', apiAction: 'getDailyReport', primaryKey: null,
    // One row per (Date, Product) - but ONLY on a day that product actually
    // had something happen to it (stock added, or it sold). A quiet day
    // for a product simply has no row; nothing is padded in to fill a
    // calendar grid.
    columns: [
      { key: 'date',          label: 'Date',            type: 'date',   visible: true },
      { key: 'product',       label: 'Service/Treatment',         type: 'text',   visible: true },
      { key: 'addedToStock',  label: 'Added To Stock',  type: 'number', visible: true },
      { key: 'qtySold',       label: 'Qty Sold',        type: 'number', visible: true },
      // Gross -> Item Discount -> Bill Discount -> Net, same breakdown as
      // the Universal Report (see computeBillTotals_ on the server). "Net
      // Revenue" is what was ACTUALLY EARNED that day, after BOTH discount
      // types are taken off Gross Revenue - read that column, not Gross
      // Revenue, as "the real revenue for the day".
      { key: 'grossRevenue',  label: 'Gross Revenue',       type: 'number', visible: true, format: 'money' },
      { key: 'itemDiscount',  label: 'Item Discount',       type: 'number', visible: true, format: 'money' },
      { key: 'billDiscount',  label: 'Bill Discount',       type: 'number', visible: true, format: 'money' },
      { key: 'revenue',       label: 'Net Revenue (Actually Earned)', type: 'number', visible: true, format: 'money' }
    ]
  },
  inventoryLog: {
    label: 'Inventory Log Report', apiAction: 'getInventoryLogReport', primaryKey: null,
    columns: [
      { key: 'date',        label: 'Date',      type: 'date',   visible: true },
      { key: 'time',        label: 'Time',      type: 'text',   visible: true },
      { key: 'billerId',    label: 'Biller ID',   type: 'text',   visible: true },
      { key: 'performedBy', label: 'Biller Name', type: 'text',   visible: true },
      { key: 'role',        label: 'Role',      type: 'text',   visible: false, format: 'chip' },
      { key: 'product',     label: 'Service/Treatment',   type: 'text',   visible: true },
      { key: 'action',      label: 'Action',    type: 'text',   visible: true, format: 'chip' },
      { key: 'change',      label: 'Change',    type: 'number', visible: true, format: 'signed' },
      { key: 'newStock',    label: 'New Stock', type: 'number', visible: true, noSum: true },
      { key: 'billId',      label: 'Bill ID',   type: 'text',   visible: false },
      { key: 'source',      label: 'Source Spreadsheet', type: 'text', visible: false }
    ]
  }
};

const reportState = { active: 'universal', data: {}, loaded: {}, sourceTruncated: {}, filters: {}, visibleCols: {} };
Object.keys(REPORT_CONFIGS).forEach(key => {
  reportState.filters[key] = {};
  reportState.visibleCols[key] = new Set(REPORT_CONFIGS[key].columns.filter(c => c.visible).map(c => c.key));
});

document.querySelectorAll('.report-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.report-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    reportState.active = tab.dataset.report;
    closeReportColumnsPopover();
    loadReport(reportState.active);
  });
});

document.getElementById('refreshReportBtn').addEventListener('click', () => loadReport(reportState.active, true));

document.getElementById('reportClearFiltersBtn').addEventListener('click', () => {
  reportState.filters[reportState.active] = {};
  renderReportShell();
  toast('Filters cleared', 'success');
});

async function loadReport(key, forceRefresh) {
  const config = REPORT_CONFIGS[key];
  const loadingHint = document.getElementById('reportLoadingHint');

  if (!reportState.loaded[key] || forceRefresh) {
    loadingHint.textContent = 'Loading ' + config.label + '…';
    loadingHint.style.display = 'block';
    try {
      const r = await apiGet(config.apiAction);
      if (r.ok) {
        reportState.data[key] = r.rows;
        reportState.loaded[key] = true;
        reportState.sourceTruncated[key] = !!r.truncated;
      } else {
        toast(r.error || 'Failed to load report', 'error');
        reportState.data[key] = reportState.data[key] || [];
      }
    } catch (err) {
      toast('Failed to load report', 'error');
      reportState.data[key] = reportState.data[key] || [];
    }
    loadingHint.style.display = 'none';
  }
  if (reportState.active === key) renderReportShell();
}

// Builds the header row + the per-column filter row (inputs carry over
// whatever's already in reportState.filters, so switching tabs and coming
// back - or toggling a column's visibility - never loses a typed filter).
// Only rebuilt on tab switch / column-visibility change, never on every
// keystroke, so the filter inputs never lose focus while typing.
function renderReportShell() {
  const key = reportState.active;
  const config = REPORT_CONFIGS[key];
  const visible = reportState.visibleCols[key];
  const cols = config.columns.filter(c => visible.has(c.key));

  document.getElementById('reportHeaderRow').innerHTML = cols.map(c => {
    const isPk = c.key === config.primaryKey;
    return `<th class="report-th${isPk ? ' report-pk-col' : ''}">${isPk ? '&#128273; ' : ''}${escapeHtml(c.label)}</th>`;
  }).join('');

  const filterRow = document.getElementById('reportFilterRow');
  filterRow.innerHTML = cols.map(c => `<th>${reportFilterCellHtml_(key, c)}</th>`).join('');

  cols.forEach(c => {
    if (c.type === 'text') {
      const input = filterRow.querySelector('[data-filter-key="' + c.key + '"]');
      input.addEventListener('input', () => {
        reportState.filters[key][c.key] = { value: input.value };
        renderReportRows();
      });
    } else if (c.type === 'number') {
      const opSel = filterRow.querySelector('[data-filter-op="' + c.key + '"]');
      const valInput = filterRow.querySelector('[data-filter-val="' + c.key + '"]');
      const update = () => { reportState.filters[key][c.key] = { op: opSel.value, value: valInput.value }; renderReportRows(); };
      opSel.addEventListener('change', update);
      valInput.addEventListener('input', update);
    } else if (c.type === 'date') {
      const fromInput = filterRow.querySelector('[data-filter-from="' + c.key + '"]');
      const toInput = filterRow.querySelector('[data-filter-to="' + c.key + '"]');
      const update = () => { reportState.filters[key][c.key] = { from: fromInput.value, to: toInput.value }; renderReportRows(); };
      fromInput.addEventListener('change', update);
      toInput.addEventListener('change', update);
    }
  });

  const sourceHint = document.getElementById('reportSourceCapHint');
  if (reportState.sourceTruncated[key]) {
    sourceHint.style.display = 'block';
    sourceHint.textContent = 'Showing the ' + (reportState.data[key] || []).length.toLocaleString() +
      ' most recent records. Older history still lives in the sheet - see the "Reports & row limits" note in Admin Settings for archiving guidance.';
  } else {
    sourceHint.style.display = 'none';
  }

  renderReportColumnsList_();
  renderReportRows();
}

function reportFilterCellHtml_(reportKey, col) {
  const f = reportState.filters[reportKey][col.key] || {};
  if (col.type === 'text') {
    return `<input type="text" class="report-filter-input" data-filter-key="${col.key}" placeholder="Filter..." value="${escapeHtml(f.value || '')}">`;
  }
  if (col.type === 'number') {
    const op = f.op || '=';
    return `
      <div class="report-filter-cell-num">
        <select data-filter-op="${col.key}">
          <option value="=" ${op === '=' ? 'selected' : ''}>=</option>
          <option value=">=" ${op === '>=' ? 'selected' : ''}>&ge;</option>
          <option value="<=" ${op === '<=' ? 'selected' : ''}>&le;</option>
        </select>
        <input type="number" data-filter-val="${col.key}" placeholder="value" value="${f.value !== undefined && f.value !== null ? f.value : ''}">
      </div>`;
  }
  if (col.type === 'date') {
    return `
      <div class="report-filter-cell-date">
        <input type="date" data-filter-from="${col.key}" title="From" value="${f.from || ''}">
        <input type="date" data-filter-to="${col.key}" title="To" value="${f.to || ''}">
      </div>`;
  }
  return '';
}

// Rebuilds ONLY the tbody - this is what runs on every keystroke, so it has
// to stay cheap and must never touch the filter inputs themselves.
function renderReportRows() {
  const key = reportState.active;
  const config = REPORT_CONFIGS[key];
  const visible = reportState.visibleCols[key];
  const cols = config.columns.filter(c => visible.has(c.key));
  const rawRows = reportState.data[key] || [];
  const filtered = filterReportRows_(rawRows, reportState.filters[key], config);

  document.getElementById('reportRowCount').textContent =
    filtered.length.toLocaleString() + ' of ' + rawRows.length.toLocaleString() + ' rows';
  document.getElementById('reportEmptyHint').style.display = (rawRows.length && !filtered.length) ? 'block' : 'none';

  const MAX_RENDER = 800; // keeps the browser snappy; narrow filters to see more precisely
  const toRender = filtered.slice(0, MAX_RENDER);

  document.getElementById('reportTableBody').innerHTML = toRender.map(row => (
    '<tr>' + cols.map(c => {
      const isPk = c.key === config.primaryKey;
      return `<td class="${isPk ? 'report-pk-col' : ''}">${formatReportCell_(c, row[c.key])}</td>`;
    }).join('') + '</tr>'
  )).join('');

  renderReportTotalsRow_(cols, filtered);

  const renderCapHint = document.getElementById('reportRenderCapHint');
  if (filtered.length > MAX_RENDER) {
    renderCapHint.style.display = 'block';
    renderCapHint.textContent = 'Showing the first ' + MAX_RENDER.toLocaleString() + ' matching rows of ' +
      filtered.length.toLocaleString() + ' - add another filter to narrow it down further.';
  } else {
    renderCapHint.style.display = 'none';
  }
}

// A totals footer that's always safe to trust - it computes over the FULL
// filtered set (not just what's rendered, so it stays right even past the
// 800-row render cap), and it knows which columns are genuinely additive
// vs. which repeat per bill line. A column marked dedupeBy counts each
// unique value of that key (e.g. each BillID) exactly once before adding -
// this is what makes "Bill Total Amount" sum correctly no matter how many
// product lines each bill has, instead of over-counting like a plain
// spreadsheet SUM() would. Columns marked noSum (unit prices, running
// stock balances) are skipped entirely rather than showing a misleading
// number.
function computeReportColumnTotal_(col, rows) {
  if (col.type !== 'number' || col.noSum) return null;
  if (col.dedupeBy) {
    const seen = new Set();
    let sum = 0;
    rows.forEach(r => {
      const k = r[col.dedupeBy];
      if (k === undefined || k === null || !seen.has(k)) {
        if (k !== undefined && k !== null) seen.add(k);
        sum += Number(r[col.key]) || 0;
      }
    });
    return sum;
  }
  return rows.reduce((s, r) => s + (Number(r[col.key]) || 0), 0);
}

function renderReportTotalsRow_(cols, filteredRows) {
  const tfoot = document.getElementById('reportTotalsRow');
  if (!tfoot) return;
  if (!filteredRows.length) { tfoot.innerHTML = ''; tfoot.style.display = 'none'; return; }

  let labelWritten = false;
  tfoot.innerHTML = cols.map(col => {
    const total = computeReportColumnTotal_(col, filteredRows);
    if (total === null) {
      if (!labelWritten) { labelWritten = true; return '<td class="report-totals-label">&Sigma; Totals (matching filters)</td>'; }
      return '<td></td>';
    }
    const display = col.format === 'money' ? formatMoney(total) : total.toLocaleString();
    const note = col.dedupeBy ? ' <span class="report-totals-note">(once per bill)</span>' : '';
    if (!labelWritten) { labelWritten = true; return `<td class="report-totals-label">&Sigma; ${display}${note}</td>`; }
    return `<td class="report-totals-value">${display}${note}</td>`;
  }).join('');
  tfoot.style.display = '';
}

function filterReportRows_(rows, filters, config) {
  const activeCols = config.columns.filter(c => filters[c.key]);
  if (!activeCols.length) return rows;
  return rows.filter(row => {
    for (const col of activeCols) {
      const f = filters[col.key];
      const val = row[col.key];
      if (col.type === 'text') {
        if (f.value) {
          const q = f.value.trim().toLowerCase();
          if (q && !String(val === null || val === undefined ? '' : val).toLowerCase().includes(q)) return false;
        }
      } else if (col.type === 'number') {
        if (f.value !== '' && f.value !== undefined && f.value !== null) {
          if (val === null || val === undefined) return false;
          const target = Number(f.value);
          if (!isNaN(target)) {
            const num = Number(val) || 0;
            const op = f.op || '=';
            if (op === '=' && num !== target) return false;
            if (op === '>=' && num < target) return false;
            if (op === '<=' && num > target) return false;
          }
        }
      } else if (col.type === 'date') {
        if (f.from && String(val) < f.from) return false;
        if (f.to && String(val) > f.to) return false;
      }
    }
    return true;
  });
}

function formatReportCell_(col, value) {
  if (value === null || value === undefined || value === '') {
    return (col.type === 'number' && value === null) ? '<span class="report-na">&mdash;</span>' : '';
  }
  if (col.format === 'money') return formatMoney(value);
  if (col.format === 'percent') return (Number(value) || 0) + '%';
  if (col.format === 'status') {
    const cls = String(value).toLowerCase() === 'active' ? 'ok' : 'out';
    return `<span class="inv-status-badge ${cls}">${escapeHtml(String(value))}</span>`;
  }
  if (col.format === 'chip') return `<span class="report-chip">${escapeHtml(String(value))}</span>`;
  if (col.format === 'signed') {
    const n = Number(value) || 0;
    const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : '');
    return `<span class="report-chip ${cls}">${n > 0 ? '+' : ''}${n}</span>`;
  }
  return escapeHtml(String(value));
}

// ---- Column show/hide popover ----
document.getElementById('reportColumnsBtn').addEventListener('click', () => {
  const pop = document.getElementById('reportColumnsPopover');
  pop.style.display = (pop.style.display === 'none' || !pop.style.display) ? 'block' : 'none';
});
document.getElementById('reportColumnsCancelBtn').addEventListener('click', closeReportColumnsPopover);
document.addEventListener('click', (e) => {
  const pop = document.getElementById('reportColumnsPopover');
  const btn = document.getElementById('reportColumnsBtn');
  if (pop.style.display === 'block' && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    closeReportColumnsPopover();
  }
});
function closeReportColumnsPopover() {
  const pop = document.getElementById('reportColumnsPopover');
  if (pop) pop.style.display = 'none';
}

document.getElementById('reportColumnsApplyBtn').addEventListener('click', () => {
  const key = reportState.active;
  const config = REPORT_CONFIGS[key];
  const checked = Array.from(document.querySelectorAll('#reportColumnsList input[type="checkbox"]:checked')).map(cb => cb.value);
  // The primary-key column can never be hidden - a report without its
  // unique identifier column stops being a report and starts being a
  // confusing list of numbers.
  if (config.primaryKey && checked.indexOf(config.primaryKey) === -1) checked.push(config.primaryKey);
  reportState.visibleCols[key] = new Set(checked);
  // Hiding a column also drops its filter - an invisible filter silently
  // narrowing rows the person can no longer see would be confusing, not
  // convenient.
  Object.keys(reportState.filters[key]).forEach(colKey => {
    if (!reportState.visibleCols[key].has(colKey)) delete reportState.filters[key][colKey];
  });
  closeReportColumnsPopover();
  renderReportShell();
  toast('Columns updated', 'success');
});

function renderReportColumnsList_() {
  const key = reportState.active;
  const config = REPORT_CONFIGS[key];
  const visible = reportState.visibleCols[key];
  document.getElementById('reportColumnsList').innerHTML = config.columns.map(c => {
    const isPk = c.key === config.primaryKey;
    return `<label>
      <input type="checkbox" value="${c.key}" ${visible.has(c.key) ? 'checked' : ''} ${isPk ? 'disabled' : ''}>
      ${escapeHtml(c.label)}${isPk ? ' <span style="color:var(--muted);font-size:11px;">(always shown)</span>' : ''}
    </label>`;
  }).join('');
}

// ---- Download Excel ----------------------------------------------------
// Gated by canDownloadReports_() (Super Admin always; a biller needs the
// CanAccessReportDownload toggle in Admin Settings). The button itself is
// shown/hidden in applyRoleToUI(); this click handler is just a second,
// server-agnostic line of defense so a stale/tampered tab can't trigger it -
// nothing here ever calls the server, so there's nothing to enforce there.
document.getElementById('reportDownloadBtn').addEventListener('click', () => {
  if (!canDownloadReports_()) { toast('You do not have access to download reports.', 'error'); return; }
  const key = reportState.active;
  if (!reportState.loaded[key] || !(reportState.data[key] || []).length) {
    toast('Nothing to download yet - load the report first.', 'error');
    return;
  }
  document.getElementById('reportDownloadModal').classList.add('show');
});
document.getElementById('reportDownloadCancelBtn').addEventListener('click', () => {
  document.getElementById('reportDownloadModal').classList.remove('show');
});
document.getElementById('reportDownloadFilteredBtn').addEventListener('click', () => {
  document.getElementById('reportDownloadModal').classList.remove('show');
  exportReportToExcel_('filtered');
});
document.getElementById('reportDownloadEntireBtn').addEventListener('click', () => {
  document.getElementById('reportDownloadModal').classList.remove('show');
  exportReportToExcel_('entire');
});

// mode: 'filtered' -> exactly what's currently on screen (the columns the
//       person has chosen to show via the Columns popover, narrowed by
//       whatever filters are currently typed into the filter row).
//       'entire'    -> the whole report exactly as the server returned it:
//       every column, every loaded row, ignoring filters/column-visibility
//       entirely - a full export regardless of what's currently on screen.
// Either way the header row always matches the data columns 1:1, in the
// same left-to-right order, because both come from the same `cols` array.
function exportReportToExcel_(mode) {
  const key = reportState.active;
  const config = REPORT_CONFIGS[key];
  const rawRows = reportState.data[key] || [];

  const cols = (mode === 'filtered')
    ? config.columns.filter(c => reportState.visibleCols[key].has(c.key))
    : config.columns.slice();
  const rows = (mode === 'filtered')
    ? filterReportRows_(rawRows, reportState.filters[key], config)
    : rawRows;

  if (!rows.length) { toast('No rows to download for this choice.', 'error'); return; }

  const headers = cols.map(c => c.label);
  const dataRows = rows.map(row => cols.map(c => {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return '';
    if (c.type === 'number') { const n = Number(v); return isNaN(n) ? '' : n; }
    return String(v);
  }));

  const xml = buildExcelXml_(config.label, headers, dataRows);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = config.label.replace(/\s+/g, '_') + '_' + (mode === 'filtered' ? 'Filtered' : 'Entire') + '_' + stamp + '.xls';
  downloadFileFromString_(filename, xml, 'application/vnd.ms-excel;charset=utf-8');

  let msg = 'Downloaded ' + rows.length.toLocaleString() + ' row' + (rows.length === 1 ? '' : 's') +
    ' (' + cols.length + ' column' + (cols.length === 1 ? '' : 's') + ')';
  if (mode === 'entire' && reportState.sourceTruncated[key]) {
    msg += ' - server already caps this report at its most recent records; see "Reports & row limits" in Admin Settings.';
  }
  toast(msg, 'success');
}

// Builds a real Excel workbook using the Excel 2003 "SpreadsheetML" XML
// format - Excel/LibreOffice/Google Sheets all open it natively as a
// genuine worksheet (typed cells, proper column headers), with no
// third-party zip/xlsx library needed in the browser. Numbers are written
// with ss:Type="Number" so Excel treats them as real numbers (sums,
// formatting) rather than text.
function buildExcelXml_(sheetLabel, headers, rows) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeSheetName = esc(sheetLabel).slice(0, 31) || 'Report';

  const headerCells = headers.map(h => `<Cell ss:StyleID="Header"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('');
  const bodyRows = rows.map(r => '<Row>' + r.map(cell => {
    const isNum = typeof cell === 'number' && isFinite(cell);
    return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${esc(cell)}</Data></Cell>`;
  }).join('') + '</Row>').join('');

  return '<?xml version="1.0"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#E1341E" ss:Pattern="Solid"/></Style></Styles>' +
    '<Worksheet ss:Name="' + safeSheetName + '"><Table>' +
    '<Row>' + headerCells + '</Row>' +
    bodyRows +
    '</Table></Worksheet></Workbook>';
}

function downloadFileFromString_(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// -------------------------------------------------------------------------
// 17. UTILITIES
// -------------------------------------------------------------------------
function formatMoney(n) { return '₹' + (Number(n) || 0).toFixed(2); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** Compute tax from an already-discounted net amount. Rates < 1% are treated
 *  as off. Tax is OFF by default - it only applies when taxOverride is
 *  strictly true (the toggle for THIS bill was explicitly switched on). */
function computeTax(subTotal, taxOverride) {
  const s = state.settings || {};
  const cgstPct = Number(s.CGSTPercent) || 0;
  const sgstPct = Number(s.SGSTPercent) || 0;
  const showTax = taxOverride === true;
  const cgst = cgstPct >= 1 ? Math.round(subTotal * cgstPct) / 100 : 0;
  const sgst = sgstPct >= 1 ? Math.round(subTotal * sgstPct) / 100 : 0;
  const taxTotal = cgst + sgst;
  const showTaxSection = showTax && (cgstPct >= 1 || sgstPct >= 1);
  return {
    cgstPct: cgstPct >= 1 ? cgstPct : 0,
    sgstPct: sgstPct >= 1 ? sgstPct : 0,
    cgstAmount: cgst,
    sgstAmount: sgst,
    taxTotal,
    // Tax only ever lands in the grand total when explicitly switched on
    // for this bill - never silently added just because a CGST/SGST % is
    // configured in Admin Settings.
    grandTotal: subTotal + (showTaxSection ? taxTotal : 0),
    showTaxSection
  };
}

/** Single source of truth for turning line items + an optional bill-level
 *  discount % into every number the bill needs. Mirrors computeBillTotals_
 *  in Code.gs exactly, so the live preview always matches what gets saved.
 *  Discount order: each item's own % first, then the bill-level "additional
 *  discount" % on what's left, then tax (if on) on what's left after that. */
function computeBillTotals(items, totalDiscountPct, taxOverride) {
  let grossSubtotal = 0, itemDiscountTotal = 0;
  const lineDetails = (items || []).map(it => {
    const price = Number(it.price) || 0;
    const qty = Number(it.qty) || 0;
    const discPct = Math.min(100, Math.max(0, Number(it.discountPercent) || 0));
    const gross = price * qty;
    const lineDiscountAmount = gross * discPct / 100;
    const lineTotal = gross - lineDiscountAmount;
    grossSubtotal += gross;
    itemDiscountTotal += lineDiscountAmount;
    return { name: it.name, price, qty, discountPercent: discPct, gross, lineTotal };
  });
  const afterItemDiscount = grossSubtotal - itemDiscountTotal;
  const totalDiscPct = Math.min(100, Math.max(0, Number(totalDiscountPct) || 0));
  const totalDiscountAmount = afterItemDiscount * totalDiscPct / 100;
  const netAmount = afterItemDiscount - totalDiscountAmount;
  const tax = computeTax(netAmount, taxOverride);
  return {
    items: lineDetails,
    grossSubtotal,
    itemDiscountTotal,
    afterItemDiscount,
    totalDiscPct,
    totalDiscountAmount,
    netAmount,
    tax,
    grandTotal: tax.grandTotal
  };
}

/** Product rows table - shared by the live preview and the Find/Edit /
 *  emailed-PDF views. Only shows a Discount column at all when at least one
 *  item actually has a discount, to keep an ordinary bill uncluttered. */
function buildBillItemsTableHtml(totals) {
  const hasDisc = totals.itemDiscountTotal > 0.004;
  const head = `<tr><th>Service / Treatment</th><th class="num">Price</th><th class="num">Qty</th>${hasDisc ? '<th class="num">Discount</th>' : ''}<th class="num">Total</th></tr>`;
  const body = totals.items.length
    ? totals.items.map(i => `
        <tr>
          <td>${escapeHtml(i.name)}</td>
          <td class="num">₹${i.price.toFixed(2)}</td>
          <td class="num">${i.qty}</td>
          ${hasDisc ? `<td class="num disc">${i.discountPercent > 0 ? '-' + i.discountPercent + '%' : '-'}</td>` : ''}
          <td class="num">₹${i.lineTotal.toFixed(2)}</td>
        </tr>`).join('')
    : `<tr><td colspan="${hasDisc ? 5 : 4}" style="text-align:center;color:var(--muted);padding:14px;">No products added yet</td></tr>`;
  return `<table class="bill-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/** Build totals + footer HTML shared by live preview and lookup print. */
function buildBillTotalsAndFooterHtml(totals, totalQty, s, billerName, versionNote, bankOverride) {
  const tax = totals.tax;
  const hasItemDisc = totals.itemDiscountTotal > 0.004;
  const hasAnyDisc = hasItemDisc || totals.totalDiscPct > 0;
  let totalsHtml = `
    <div class="bill-totals">
      <div class="row"><span>Total Qty</span><span>${totalQty}</span></div>
      <div class="row"><span>Item Subtotal</span><span>${formatMoney(totals.grossSubtotal)}</span></div>`;
  if (hasItemDisc) {
    totalsHtml += `<div class="row disc"><span>Item Discounts</span><span>-${formatMoney(totals.itemDiscountTotal)}</span></div>`;
  }
  if (totals.totalDiscPct > 0) {
    totalsHtml += `<div class="row disc"><span>Additional Discount (${totals.totalDiscPct}%)</span><span>-${formatMoney(totals.totalDiscountAmount)}</span></div>`;
  }
  if (hasAnyDisc) {
    totalsHtml += `<div class="row"><span>Net Amount</span><span>${formatMoney(totals.netAmount)}</span></div>`;
  }
  if (tax.showTaxSection) {
    if (tax.cgstPct >= 1) {
      totalsHtml += `<div class="row"><span>CGST @ ${tax.cgstPct}%</span><span>${formatMoney(tax.cgstAmount)}</span></div>`;
    }
    if (tax.sgstPct >= 1) {
      totalsHtml += `<div class="row"><span>SGST @ ${tax.sgstPct}%</span><span>${formatMoney(tax.sgstAmount)}</span></div>`;
    }
    totalsHtml += `<div class="row"><span>Tax Total</span><span>${formatMoney(tax.taxTotal)}</span></div>`;
  }
  totalsHtml += `
      <div class="row grand"><span>Grand Total</span><span>${formatMoney(tax.grandTotal)}</span></div>
    </div>`;

  let bankHtml = '';
  const showBank = (bankOverride === undefined || bankOverride === null) ? (s.ShowBankDetails !== false) : !!bankOverride;
  if (showBank) {
    const parts = [];
    if (s.BankName) parts.push(`Bank: <b>${escapeHtml(s.BankName)}</b>`);
    if (s.BankAccountNo) parts.push(`A/c: <b>${escapeHtml(s.BankAccountNo)}</b>`);
    if (s.BankIFSC) parts.push(`IFSC: <b>${escapeHtml(s.BankIFSC)}</b>`);
    if (s.BankAccountHolder) parts.push(`Holder: <b>${escapeHtml(s.BankAccountHolder)}</b>`);
    if (parts.length) bankHtml = `<div class="bill-bank">${parts.join(' &nbsp;·&nbsp; ')}</div>`;
  }

  let signHtml = '';
  if (s.ShowAuthorizedSignatory !== false) {
    const label = s.AuthorizedSignatoryLabel || 'Authorized Signatory';
    signHtml = `
      <div class="bill-sign">
        <div class="sign-box"></div>
        <div class="sign-label">${escapeHtml(label)}</div>
      </div>`;
  }

  const footHtml = `
    <div class="bill-foot">
      <div class="bill-foot-main">
        Billed by: <b>${escapeHtml(billerName || '-')}</b><br>
        ${versionNote ? `<span class="version-note">${escapeHtml(versionNote)}</span><br>` : ''}
        Thank you for choosing ${escapeHtml(s.CompanyName || 'us')}!
        ${bankHtml}
      </div>
      ${signHtml}
    </div>`;

  return { totalsHtml, footHtml, tax };
}

// -------------------------------------------------------------------------
// 16b. SHARE BILL - Email (sends PDF via server) / WhatsApp (opens chat
//      with the bill details pre-filled, ready to send).
// -------------------------------------------------------------------------
let shareMethod = null;

function openShareModal(billId, titleText, shareData) {
  document.getElementById('share_billId').value = billId;
  document.getElementById('shareBillTitle').textContent = titleText || ('Share Bill ' + billId);
  document.getElementById('shareEmailField').style.display = 'none';
  document.getElementById('shareWhatsappField').style.display = 'none';
  document.getElementById('share_send').style.display = 'none';
  // Pre-filled with the patient's own email / WhatsApp number (still fully
  // editable) - saves retyping what's already on the bill.
  const sd = shareData || {};
  const sdMobile = normalizeMobile_(sd.phone);
  document.getElementById('share_email').value = vEmail_(sd.email, 'Email', false).error ? '' : vLine_(sd.email);
  document.getElementById('share_phone').value = /^[6-9]\d{9}$/.test(sdMobile) ? '91' + sdMobile : '';
  clearErrorsIn_(document.getElementById('shareBillModal'));
  document.getElementById('shareStatus').textContent = '';
  document.getElementById('shareStatus').className = 'biller-status';
  shareMethod = null;
  state.shareData = shareData; // { customerName, date, items, totalDiscountPct, taxOverride, paymentMethod }
  document.getElementById('shareBillModal').classList.add('show');
}

document.getElementById('share_cancel').addEventListener('click', () => {
  document.getElementById('shareBillModal').classList.remove('show');
});

document.getElementById('shareViaEmailBtn').addEventListener('click', () => {
  shareMethod = 'email';
  document.getElementById('shareEmailField').style.display = 'block';
  document.getElementById('shareWhatsappField').style.display = 'none';
  document.getElementById('share_send').style.display = 'inline-block';
  document.getElementById('share_send').textContent = 'Send Email';
});

// Renders the exact same branded HTML the customer's email will contain
// (see apiGetEmailPreview / buildBrandedEmailShell_ in Code.gs) inside a
// sandboxed iframe, so there's no surprise between what the biller previews
// and what actually lands in the customer's inbox.
document.getElementById('shareEmailPreviewBtn').addEventListener('click', async () => {
  const billId = document.getElementById('share_billId').value;
  const btn = document.getElementById('shareEmailPreviewBtn');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Loading preview...';
  try {
    const r = await apiGet('getEmailPreview', { billId });
    if (!r.ok) { toast(r.error || 'Could not load email preview', 'error'); return; }
    document.getElementById('emailPreviewFrame').srcdoc = r.html;
    document.getElementById('emailPreviewModal').classList.add('show');
  } catch (err) {
    toast('Network error while loading email preview.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});
document.getElementById('emailPreview_close').addEventListener('click', () => {
  document.getElementById('emailPreviewModal').classList.remove('show');
});
// "Send Email" from inside the preview is a shortcut for the same Send
// button in the Share modal underneath - one send code path, not two.
document.getElementById('emailPreview_send').addEventListener('click', () => {
  document.getElementById('emailPreviewModal').classList.remove('show');
  document.getElementById('share_send').click();
});

document.getElementById('shareViaWhatsappBtn').addEventListener('click', () => {
  shareMethod = 'whatsapp';
  document.getElementById('shareWhatsappField').style.display = 'block';
  document.getElementById('shareEmailField').style.display = 'none';
  document.getElementById('share_send').style.display = 'inline-block';
  document.getElementById('share_send').textContent = 'Open WhatsApp';
});

// Print and "Save as PDF" both just open the browser's print dialog - the
// same dialog lets the person choose a physical printer OR "Save as PDF"
// as the destination, so one handler covers both buttons. Print CSS
// (see style.css) hides everything on the page except the bill itself,
// including this modal, so it's always the finished, saved bill that
// prints - never a half-filled form.
document.getElementById('sharePrintBtn').addEventListener('click', () => window.print());
document.getElementById('shareDownloadPdfBtn').addEventListener('click', () => window.print());

function buildShareMessageText(billId, d) {
  const totals = computeBillTotals(d.items, d.totalDiscountPct || 0, d.taxOverride === true);
  const itemLines = totals.items.map(it => {
    const discSuffix = it.discountPercent > 0 ? ` (-${it.discountPercent}%)` : '';
    return `- ${it.name} x${it.qty}${discSuffix} = ₹${it.lineTotal.toFixed(2)}`;
  }).join('\n');
  const discountLines = [];
  if (totals.itemDiscountTotal > 0.004) discountLines.push(`Item Discounts: -₹${totals.itemDiscountTotal.toFixed(2)}`);
  if (totals.totalDiscPct > 0) discountLines.push(`Additional Discount (${totals.totalDiscPct}%): -₹${totals.totalDiscountAmount.toFixed(2)}`);
  const discountBlock = discountLines.length ? `\n${discountLines.join('\n')}\nNet Amount: ₹${totals.netAmount.toFixed(2)}\n` : '';
  const taxLine = totals.tax.showTaxSection ? `Tax Total: ₹${totals.tax.taxTotal.toFixed(2)}\n` : '';
  const company = (state.settings && state.settings.CompanyName) || 'us';
  return `Hello ${d.customerName || 'Patient'},\n\nHere is your invoice from ${company}:\n\n` +
    `Bill ID: ${billId}\nDate: ${d.date}\n\nItems:\n${itemLines}\n${discountBlock}${taxLine}\n` +
    `Grand Total: ₹${totals.grandTotal.toFixed(2)}\nPayment Method: ${paymentMethodLabel(d.paymentMethod)}\n\n` +
    `Thank you for your business!`;
}

document.getElementById('share_send').addEventListener('click', async () => {
  const billId = document.getElementById('share_billId').value;
  const statusEl = document.getElementById('shareStatus');
  const btn = document.getElementById('share_send');

  if (shareMethod === 'email') {
    const emailRes = vEmail_(document.getElementById('share_email').value, 'Patient email', true);
    if (emailRes.error) {
      setFieldError_(document.getElementById('share_email'), emailRes.error);
      statusEl.textContent = emailRes.error;
      statusEl.className = 'biller-status err';
      return;
    }
    const email = emailRes.value;
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      const r = await apiPost('emailBillPdf', { billId, email });
      if (r.ok) {
        statusEl.textContent = 'Emailed to ' + email + '.';
        statusEl.className = 'biller-status ok';
        toast('Bill emailed successfully', 'success');
      } else if (r.error && /unknown get action/i.test(r.error)) {
        // The request likely took long enough that Google's own servers redirected the
        // confirmation and lost the response - but the email itself was almost certainly
        // already sent by the time this happens. Reassure rather than alarm.
        statusEl.textContent = 'This took a little longer than usual to confirm, but the email to ' +
          email + ' has most likely already been sent. Please check with the patient before resending.';
        statusEl.className = 'biller-status ok';
      } else {
        statusEl.textContent = r.error || 'Could not send email.';
        statusEl.className = 'biller-status err';
      }
    } catch (err) {
      statusEl.textContent = 'Network error while sending email.';
      statusEl.className = 'biller-status err';
    } finally {
      btn.disabled = false; btn.textContent = 'Send Email';
    }

  } else if (shareMethod === 'whatsapp') {
    // Digits only. A plain 10-digit Indian mobile gets 91 added; anything
    // else must already be a full international number (11-15 digits).
    const phone = waNumber_(document.getElementById('share_phone').value);
    const validWa = /^91[6-9]\d{9}$/.test(phone) || (!/^91/.test(phone) && /^[1-9]\d{10,14}$/.test(phone));
    if (!validWa) {
      const msg = 'Enter the WhatsApp number as 10 digits, or with country code (e.g. 919876543210) - digits only.';
      setFieldError_(document.getElementById('share_phone'), msg);
      statusEl.textContent = msg;
      statusEl.className = 'biller-status err';
      return;
    }
    document.getElementById('share_phone').value = phone;
    const msg = buildShareMessageText(billId, state.shareData);
    window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(msg), '_blank');
    statusEl.textContent = 'WhatsApp opened in a new tab - tap Send there to deliver it.';
    statusEl.className = 'biller-status ok';
  }
});

// -------------------------------------------------------------------------
// 18. INIT - auto restore session on reload (per browser tab)
// -------------------------------------------------------------------------
(async function init() {
  decorateInputs_(document);
  updatePaymentNote();
  // Theme the login screen itself from Admin Settings, even before anyone
  // is logged in - the CSS fallback colors only ever act as a backup if
  // this fails, never the real source.
  try {
    const themeRes = await apiGet('getSettings');
    if (themeRes.ok) applyTheme_(themeRes.settings);
  } catch (err) { /* CSS fallback colors cover this */ }

  const user = sessionStorage.getItem('SJP_user');
  if (user) {
    document.getElementById('whoAmI').textContent = sessionStorage.getItem('SJP_displayName') || user;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    bootstrapApp();
  }
})();

// =========================================================================
// 19. LETTERPAD  (type -> print / Save as PDF ; NOTHING is ever saved)
//
// This whole section is deliberately self-contained and read-only towards
// the rest of the app:
//   - it never calls apiGet / apiPost, so it can never touch the database;
//   - it never writes to sessionStorage / localStorage, so nothing survives
//     a reload (that is the explicitly requested behaviour);
//   - it prints through its OWN hidden iframe with its own stylesheet, so
//     the existing bill/lookup print pipeline (body[data-print-target] in
//     style.css, and the global @page margins there) is left completely
//     untouched.
//
// The A4 sheet is sized in real millimetres and is intentionally NOT
// responsive - what is on screen is exactly what comes out of the printer.
// =========================================================================

// --- Real-world page geometry. Everything below is derived from these, and
//     the SAME numbers are used on screen and in the print document, so the
//     two can never drift apart. ---
const LP_PAGE = {
  widthMm: 210,      // A4 width
  heightMm: 297,     // A4 height
  headMm: 32,        // predefined letterhead band
  footMm: 44,        // predefined address / contact band
  padTopMm: 8,
  padSideMm: 16,
  padBottomMm: 6
};
LP_PAGE.contentMm = LP_PAGE.heightMm - LP_PAGE.headMm - LP_PAGE.footMm; // 221mm

// --- The paper stylesheet. Injected into the app's <head> for the on-screen
//     sheet AND written verbatim into the print iframe, so "what you see" and
//     "what you print" are the same CSS, not two hand-kept copies. ---
const LP_PAPER_CSS = `
.lp-sheet, .lp-band, .lp-body, .lp-body * {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.lp-sheet {
  width: ${LP_PAGE.widthMm}mm;
  min-height: ${LP_PAGE.heightMm}mm;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  color: #222222;
  font-family: Georgia, 'Times New Roman', Times, serif;
  /* Mobile Safari/Chrome silently boost the font size of text sitting
     inside a wide box that's viewed through a narrower, horizontally-
     scrolling viewport ("text autosizing") - the sheet here is exactly
     that shape. That inflation is invisible (no layout property changes),
     it just makes each character wider, so lines wrap earlier and the
     text never reaches the sheet's true right-hand edge. Turning it off
     keeps the on-screen font size exactly what lp-body specifies, on
     every device, so wrapping matches the real printed width. */
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
.lp-band { flex: 0 0 auto; box-sizing: border-box; overflow: hidden; }
.lp-band-head {
  height: ${LP_PAGE.headMm}mm;
  background-color: #2778b7;
  background-image: linear-gradient(135deg, #2778b7 0%, #a8d339 100%);
  display: flex; align-items: center; justify-content: center;
  padding: 4mm 10mm;
}
.lp-band-head .lp-logo { height: 22mm; width: auto; max-width: 150mm; display: block; }
.lp-band-foot {
  height: ${LP_PAGE.footMm}mm;
  background-color: #2778b7;
  background-image: linear-gradient(135deg, #2778b7 0%, #a8d339 100%);
  color: #ffffff;
  padding: 4mm 10mm 3mm 10mm;
  text-align: center;
}
.lp-foot-addr { font-size: 8.5pt; line-height: 1.35; margin-bottom: 2mm; }
.lp-foot-title { font-size: 8pt; font-weight: 700; letter-spacing: .4px; margin-bottom: 1.6mm; }
.lp-foot-grid {
  display: flex; flex-wrap: wrap; justify-content: center;
  gap: 1.2mm 5mm; margin-bottom: 2mm;
}
.lp-foot-item { display: flex; align-items: center; gap: 1.4mm; font-size: 7.5pt; line-height: 1.2; }
.lp-foot-item img { width: 3.6mm; height: 3.6mm; display: block; flex: 0 0 auto; }
.lp-foot-copy {
  font-size: 7pt; padding-top: 1.6mm;
  border-top: 0.3mm solid rgba(255,255,255,0.45);
}
.lp-body {
  width: ${LP_PAGE.widthMm}mm;
  min-height: ${LP_PAGE.contentMm}mm;
  box-sizing: border-box;
  padding: ${LP_PAGE.padTopMm}mm ${LP_PAGE.padSideMm}mm ${LP_PAGE.padBottomMm}mm ${LP_PAGE.padSideMm}mm;
  font-family: Georgia, 'Times New Roman', Times, serif;
  font-size: 12pt;
  line-height: 1.5;
  color: #222222;
  outline: none;
  word-wrap: break-word;
  overflow-wrap: break-word;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
.lp-body p { margin: 0 0 8px 0; }
.lp-body h1 { font-size: 20pt; margin: 0 0 10px; }
.lp-body h2 { font-size: 17pt; margin: 0 0 9px; }
.lp-body h3 { font-size: 14pt; margin: 0 0 8px; }
.lp-body h4 { font-size: 12.5pt; margin: 0 0 8px; }
.lp-body ul, .lp-body ol { margin: 0 0 8px 0; padding-left: 26px; }
.lp-body li { margin-bottom: 3px; }
.lp-body blockquote {
  margin: 0 0 8px 0; padding: 2px 0 2px 12px;
  border-left: 3px solid #a8d339; color: #444444;
}
.lp-body pre {
  font-family: Consolas, 'Courier New', monospace; font-size: 10.5pt;
  margin: 0 0 8px 0; white-space: pre-wrap;
}
.lp-body hr { border: 0; border-top: 1px solid #999999; margin: 10px 0; }
.lp-body table { border-collapse: collapse; margin: 0 0 8px 0; }
.lp-body table td, .lp-body table th { border: 1px solid #888888; padding: 4px 7px; }
.lp-body img { max-width: 100%; }
.lp-sign-block { margin-top: 14mm; }
`;

// --- Print-only additions. Used ONLY inside the letterpad's private print
//     iframe - never added to the main document, so the app's own print
//     rules and @page margins are not affected in any way.
//
//     Each physical page is built by hand as one .lp-page block (see
//     lpPaginateBody_ / lpPrint_ below) rather than left to the browser's
//     own <thead>/<tfoot> table pagination. That table technique looks
//     correct on paper but several browsers (Chrome included) do not
//     reliably repeat a <tfoot> on every printed page - the footer can end
//     up on only one page, or not sitting at that page's true bottom edge.
//     Building each page explicitly removes that guesswork entirely: the
//     footer's position is decided by this layout, not by the print
//     engine's own pagination heuristics.
//
//     .lp-page is also centred (margin: 0 auto) rather than left-aligned,
//     so if the destination paper turns out to be wider than A4 (e.g. the
//     print dialog's Paper size is set to Letter instead of A4 - a browser/
//     OS setting no website can change), the extra width is split evenly on
//     both sides instead of showing up as a single blank strip down one
//     edge. ---
const LP_PRINT_CSS = `
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #ffffff; }
.lp-page {
  width: ${LP_PAGE.widthMm}mm;
  height: ${LP_PAGE.heightMm}mm;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  page-break-after: always;
  break-after: page;
}
.lp-page:last-child { page-break-after: auto; break-after: auto; }
.lp-page .lp-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
`;

const LP_EMPTY_HTML = '<p><br></p>';

const lpState = {
  ready: false,
  savedRange: null,
  pxPerMm: 96 / 25.4   // refreshed from a real probe element at init
};

// -------------------------------------------------------------------------
// 19a. SET-UP  (runs once, the first time the Letterpad menu is opened)
// -------------------------------------------------------------------------
function initLetterpad_() {
  const body = document.getElementById('lpBody');
  if (!body) return;

  if (!lpState.ready) {
    lpInjectPaperCss_();
    lpBindToolbar_();
    body.innerHTML = LP_EMPTY_HTML;
    lpState.ready = true;
  }

  lpMeasurePxPerMm_();
  lpRefreshStatus_();
}

// Adds LP_PAPER_CSS to the page exactly once. Every selector in it is
// .lp-* scoped, so it cannot reach any existing element.
function lpInjectPaperCss_() {
  if (document.getElementById('lpPaperStyle')) return;
  const st = document.createElement('style');
  st.id = 'lpPaperStyle';
  st.textContent = LP_PAPER_CSS;
  document.head.appendChild(st);
}

// Millimetres are only meaningful on screen once we know how many CSS pixels
// the browser is currently giving us per mm. The probe is placed INSIDE the
// zoomed wrapper so it is affected by the zoom setting in exactly the same
// way the sheet is - that keeps the page-break guides correct at every zoom.
function lpMeasurePxPerMm_() {
  const wrap = document.getElementById('lpBodyWrap');
  if (!wrap) return;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:0;left:0;height:100mm;width:0;visibility:hidden;pointer-events:none;';
  wrap.appendChild(probe);
  const h = probe.offsetHeight;
  probe.remove();
  if (h > 0) lpState.pxPerMm = h / 100;
}

// -------------------------------------------------------------------------
// 19b. SELECTION HELPERS
//
// Toolbar <select> menus steal focus from the editor, which collapses the
// user's selection. So the last selection made inside the letterpad body is
// remembered and put back before any dropdown-driven command runs - this is
// what makes "select a sentence, then pick a font size" behave like Word.
// -------------------------------------------------------------------------
function lpIsInBody_(node) {
  const body = document.getElementById('lpBody');
  if (!body || !node) return false;
  return node === body || body.contains(node.nodeType === 1 ? node : node.parentNode);
}

function lpSaveSelection_() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0);
  if (lpIsInBody_(r.commonAncestorContainer)) lpState.savedRange = r.cloneRange();
}

function lpRestoreSelection_() {
  const body = document.getElementById('lpBody');
  if (!body) return;
  body.focus();
  const sel = window.getSelection();
  if (lpState.savedRange && lpIsInBody_(lpState.savedRange.commonAncestorContainer)) {
    sel.removeAllRanges();
    sel.addRange(lpState.savedRange);
  }
}

function lpCurrentRange_() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  return lpIsInBody_(r.commonAncestorContainer) ? r : null;
}

// Runs a document.execCommand against the letterpad, always in CSS mode so
// the result is inline styles (which survive copy/paste and print cleanly)
// rather than deprecated <font> tags.
function lpExec_(cmd, value) {
  lpRestoreSelection_();
  try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* not supported - harmless */ }
  try { document.execCommand(cmd, false, value === undefined ? null : value); } catch (e) { /* ignore */ }
  lpSaveSelection_();
  lpRefreshStatus_();
  lpSyncToolbarFromSelection_();
}

// -------------------------------------------------------------------------
// 19c. FORMATTING COMMANDS
// -------------------------------------------------------------------------

// execCommand('fontSize') only understands the legacy 1-7 scale, which has no
// point sizes at all. The standard workaround: apply size 7, then swap the
// <font size="7"> tags it produced for spans carrying the real pt value.
function lpSetFontSize_(pt) {
  const body = document.getElementById('lpBody');
  if (!body || !pt) return;
  lpRestoreSelection_();
  try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* ignore */ }
  document.execCommand('fontSize', false, '7');
  body.querySelectorAll('font[size="7"]').forEach(f => {
    const span = document.createElement('span');
    span.style.fontSize = pt + 'pt';
    while (f.firstChild) span.appendChild(f.firstChild);
    f.parentNode.replaceChild(span, f);
  });
  try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }
  lpSaveSelection_();
  lpRefreshStatus_();
}

// The block elements the current selection touches. Used by the paragraph
// level settings (line spacing, space-after) which apply per paragraph, not
// per character.
function lpBlocksInSelection_() {
  const body = document.getElementById('lpBody');
  const range = lpCurrentRange_();
  if (!body || !range) return [];
  const blockTags = 'P,DIV,H1,H2,H3,H4,H5,H6,LI,BLOCKQUOTE,PRE,TD,TH';
  const all = Array.from(body.querySelectorAll(blockTags));
  const hit = all.filter(el => range.intersectsNode(el));
  if (hit.length) return hit;
  // Selection sits in a bare text node with no block wrapper yet.
  let n = range.commonAncestorContainer;
  if (n.nodeType === 3) n = n.parentNode;
  while (n && n !== body && !blockTags.split(',').includes(n.nodeName)) n = n.parentNode;
  return (n && n !== body) ? [n] : [body];
}

function lpApplyToBlocks_(styleProp, value) {
  lpRestoreSelection_();
  lpBlocksInSelection_().forEach(el => { el.style[styleProp] = value; });
  lpSaveSelection_();
  lpRefreshStatus_();
}

// --- Change case -------------------------------------------------------
// Applied to the SELECTED text only, and applied in a way that keeps every
// bit of formatting inside the selection (bold words stay bold, coloured
// words stay coloured). The selection is cloned, only its text nodes are
// rewritten, and the result is put back with insertHTML - which also means
// Ctrl+Z undoes it like any normal edit.
function lpChangeCase_(mode) {
  const range = lpCurrentRange_();
  if (!range || range.collapsed) {
    toast('Select some text first, then choose a case.', 'error');
    return;
  }
  const holder = document.createElement('div');
  holder.appendChild(range.cloneContents());

  const textNodes = [];
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);
  if (!textNodes.length) return;

  const combined = textNodes.map(t => t.nodeValue).join('');
  const converted = lpConvertCase_(combined, mode);

  if (converted.length === combined.length) {
    // Normal path - re-slice the converted string back across the same text
    // nodes, so "Sentence case" can see the whole sentence even when it is
    // split across <b> / <span> boundaries.
    let at = 0;
    textNodes.forEach(t => {
      const len = t.nodeValue.length;
      t.nodeValue = converted.substr(at, len);
      at += len;
    });
  } else {
    // Rare locale case where changing case changes the string length
    // (e.g. the German sharp s). Fall back to converting node by node.
    textNodes.forEach(t => { t.nodeValue = lpConvertCase_(t.nodeValue, mode); });
  }

  lpRestoreSelection_();
  document.execCommand('insertHTML', false, holder.innerHTML);
  lpSaveSelection_();
  lpRefreshStatus_();
}

function lpConvertCase_(str, mode) {
  if (mode === 'upper') return str.toUpperCase();
  if (mode === 'lower') return str.toLowerCase();
  if (mode === 'toggle') {
    return str.replace(/[a-zA-Z\u00C0-\u024F]/g, ch =>
      ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase());
  }
  if (mode === 'title') {
    return str.toLowerCase().replace(/(^|[\s"'(\[\-\/])(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase());
  }
  if (mode === 'sentence') {
    const lower = str.toLowerCase();
    return lower.replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase());
  }
  return str;
}

// hiliteColor is the standard highlight command; backColor is the older
// fallback some engines still want. Either can throw, so both are guarded.
function lpHilite_(color) {
  try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }
  let done = false;
  try { done = document.execCommand('hiliteColor', false, color); } catch (e) { done = false; }
  if (!done) {
    try { document.execCommand('backColor', false, color); } catch (e) { /* ignore */ }
  }
}

// --- Inserts -----------------------------------------------------------
function lpInsertHtml_(html) {
  lpRestoreSelection_();
  document.execCommand('insertHTML', false, html);
  lpSaveSelection_();
  lpRefreshStatus_();
}

function lpInsertTable_() {
  const rows = parseInt(prompt('How many rows?', '3'), 10);
  if (!rows || rows < 1) return;
  const cols = parseInt(prompt('How many columns?', '3'), 10);
  if (!cols || cols < 1) return;
  if (rows > 60 || cols > 12) {
    toast('Please keep it under 60 rows and 12 columns.', 'error');
    return;
  }
  let html = '<table style="width:100%;"><tbody>';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += '<td><br></td>';
    html += '</tr>';
  }
  html += '</tbody></table><p><br></p>';
  lpInsertHtml_(html);
}

function lpInsertDate_() {
  const d = new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  lpInsertHtml_(escapeHtml(d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear()));
}

function lpInsertSignature_() {
  lpInsertHtml_(
    '<div class="lp-sign-block"><p>Warm regards,</p><p><br></p><p><br></p>' +
    '<p><b>Team SJ Physiotherapy</b></p></div><p><br></p>'
  );
}

// -------------------------------------------------------------------------
// 19d. STATUS  (word count, page count, page-break guide lines)
// -------------------------------------------------------------------------
function lpRefreshStatus_() {
  const body = document.getElementById('lpBody');
  const wrap = document.getElementById('lpBodyWrap');
  if (!body || !wrap) return;

  // Placeholder
  const hasContent = body.textContent.trim().length > 0 ||
    body.querySelector('img, hr, table') !== null;
  body.classList.toggle('lp-is-empty', !hasContent);

  // Word count
  const words = body.textContent.trim() ? body.textContent.trim().split(/\s+/).length : 0;
  const wc = document.getElementById('lpWordCount');
  if (wc) wc.textContent = words + (words === 1 ? ' word' : ' words');

  // Page count + guide lines at each printed page boundary
  const pageH = LP_PAGE.contentMm * lpState.pxPerMm;
  const totalH = wrap.offsetHeight;
  const pages = Math.max(1, Math.ceil((totalH - 1) / pageH));

  const pc = document.getElementById('lpPageCount');
  if (pc) pc.textContent = pages + (pages === 1 ? ' page' : ' pages');

  const guides = document.getElementById('lpGuides');
  if (guides) {
    let html = '';
    for (let i = 1; i < pages; i++) {
      html += '<div class="lp-guide" style="top:' + (i * pageH) + 'px;">' +
        '<span>Page ' + i + ' ends here &middot; header and footer repeat on page ' + (i + 1) + '</span></div>';
    }
    guides.innerHTML = html;
  }
}

// Lights up the B / I / U style buttons to match wherever the caret is.
function lpSyncToolbarFromSelection_() {
  const map = { bold: 'bold', italic: 'italic', underline: 'underline', strikeThrough: 'strikeThrough' };
  Object.keys(map).forEach(cmd => {
    let on = false;
    try { on = document.queryCommandState(cmd); } catch (e) { on = false; }
    const btn = document.querySelector('.lp-tb-btn[data-lpcmd="' + cmd + '"]');
    if (btn) btn.classList.toggle('is-active', !!on);
  });
}

// -------------------------------------------------------------------------
// 19e. WIRING  (bound exactly once, from initLetterpad_)
// -------------------------------------------------------------------------
function lpBindToolbar_() {
  const body = document.getElementById('lpBody');
  const toolbar = document.getElementById('lpToolbar');
  if (!body || !toolbar) return;

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* ignore */ }

  // Plain command buttons. mousedown->preventDefault keeps the caret and the
  // selection exactly where they were instead of the button stealing focus.
  toolbar.querySelectorAll('.lp-tb-btn[data-lpcmd]').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => lpExec_(btn.dataset.lpcmd));
  });

  // Dropdowns
  const onSelect = (id, fn, reset) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('mousedown', () => lpSaveSelection_());
    el.addEventListener('change', () => {
      if (el.value !== '') fn(el.value);
      if (reset) el.value = '';
    });
  };
  onSelect('lpBlockStyle', v => lpExec_('formatBlock', '<' + v + '>'));
  onSelect('lpFontFamily', v => lpExec_('fontName', v));
  onSelect('lpFontSize', v => lpSetFontSize_(v));
  onSelect('lpLineHeight', v => lpApplyToBlocks_('lineHeight', v), true);
  onSelect('lpSpaceAfter', v => lpApplyToBlocks_('marginBottom', v + 'px'), true);
  onSelect('lpChangeCase', v => lpChangeCase_(v), true);

  // Colours
  const foreInput = document.getElementById('lpForeColor');
  const backInput = document.getElementById('lpBackColor');
  if (foreInput) {
    foreInput.addEventListener('mousedown', () => lpSaveSelection_());
    foreInput.addEventListener('input', () => {
      document.getElementById('lpForeSwatch').style.background = foreInput.value;
      lpExec_('foreColor', foreInput.value);
    });
  }
  if (backInput) {
    backInput.addEventListener('mousedown', () => lpSaveSelection_());
    backInput.addEventListener('input', () => {
      document.getElementById('lpBackSwatch').style.background = backInput.value;
      lpRestoreSelection_();
      lpHilite_(backInput.value);
      lpSaveSelection_();
      lpRefreshStatus_();
    });
  }
  const clearHi = document.getElementById('lpClearHighlight');
  if (clearHi) {
    clearHi.addEventListener('mousedown', e => e.preventDefault());
    clearHi.addEventListener('click', () => {
      lpRestoreSelection_();
      lpHilite_('transparent');
      lpSaveSelection_();
    });
  }

  // Insert buttons
  [['lpInsertHr', () => lpInsertHtml_('<hr><p><br></p>')],
   ['lpInsertTable', lpInsertTable_],
   ['lpInsertDate', lpInsertDate_],
   ['lpInsertSign', lpInsertSignature_]].forEach(([id, fn]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', fn);
  });

  // Zoom - screen only. The print iframe never sees this, so zooming can
  // never change what actually comes out of the printer.
  const zoom = document.getElementById('lpZoom');
  if (zoom) {
    zoom.addEventListener('change', () => {
      const wrap = document.getElementById('lpZoomWrap');
      if (wrap) wrap.style.zoom = zoom.value;
      // Re-measure: CSS zoom changes how many pixels a millimetre is worth.
      setTimeout(() => { lpMeasurePxPerMm_(); lpRefreshStatus_(); }, 0);
    });
  }

  // Editor events
  body.addEventListener('input', () => { lpSaveSelection_(); lpRefreshStatus_(); });
  body.addEventListener('keyup', () => { lpSaveSelection_(); lpSyncToolbarFromSelection_(); });
  body.addEventListener('mouseup', () => { lpSaveSelection_(); lpSyncToolbarFromSelection_(); });
  body.addEventListener('focus', () => lpSaveSelection_());

  // Paste: honour the "paste as plain text" checkbox, and always strip the
  // junk (scripts, positioned elements) Word/browsers like to bring along.
  body.addEventListener('paste', e => {
    const plainOnly = document.getElementById('lpPastePlain');
    if (plainOnly && plainOnly.checked) {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
      lpRefreshStatus_();
    } else {
      setTimeout(() => {
        body.querySelectorAll('script, style, link, meta, iframe, object, embed').forEach(el => el.remove());
        lpRefreshStatus_();
      }, 0);
    }
  });

  // Ctrl+P inside the Letterpad should print the LETTERPAD, not fall through
  // to the app's bill print pipeline (which would produce a blank page here,
  // because no data-print-target is set for this screen).
  document.addEventListener('keydown', e => {
    const view = document.getElementById('view-letterpad');
    if (!view || !view.classList.contains('active')) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      lpPrint_();
    }
  });

  // Reset (with the confirm popup)
  const resetBtn = document.getElementById('lpResetBtn');
  const modal = document.getElementById('lpResetModal');
  const waitBtn = document.getElementById('lpResetWaitBtn');
  const okBtn = document.getElementById('lpResetOkBtn');
  if (resetBtn && modal) {
    resetBtn.addEventListener('click', () => modal.classList.add('show'));
  }
  if (waitBtn) waitBtn.addEventListener('click', () => modal.classList.remove('show'));
  if (modal) {
    // Clicking the dark backdrop counts as "wait" - it closes the popup and
    // changes nothing, same as the Wait button.
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });
  }
  if (okBtn) {
    okBtn.addEventListener('click', () => {
      body.innerHTML = LP_EMPTY_HTML;
      lpState.savedRange = null;
      modal.classList.remove('show');
      lpRefreshStatus_();
      body.focus();
      toast('Letterpad cleared.', 'success');
    });
  }

  const printBtn = document.getElementById('lpPrintBtn');
  if (printBtn) printBtn.addEventListener('click', () => lpPrint_());

  window.addEventListener('resize', () => {
    const view = document.getElementById('view-letterpad');
    if (view && view.classList.contains('active')) { lpMeasurePxPerMm_(); lpRefreshStatus_(); }
  });
}

// -------------------------------------------------------------------------
// 19f. PAGINATION  (print-time only)
//
// The body's own top-level blocks (paragraphs, headings, lists, tables...)
// are measured once in a hidden, off-screen clone and bucketed into
// page-sized chunks. Each chunk becomes the body of its own full
// header+body+footer .lp-page (built in lpPrint_ below). Blocks are never
// split mid-element - only distributed at their own boundaries - so a
// paragraph or list item is never cut in half by a page break.
// -------------------------------------------------------------------------

// Kept a few mm short of the true 221mm content budget (LP_PAGE.contentMm)
// so that print-engine rounding (CSS mm resolved at the print engine's own
// DPI, which is not always identical to how the same mm value measures
// here) can never tip a line over onto an unwanted extra, near-empty page.
const LP_PRINT_SAFETY_MM = 5;

// Returns an array of HTML strings, one per printed page's body content.
// Falls back to a single page (the body's own HTML, unchanged) whenever
// there is nothing sensible to measure - so a short, single-page letter,
// still the overwhelmingly common case, prints exactly as before.
function lpPaginateBody_(bodyEl) {
  if (!bodyEl.childNodes.length) return [bodyEl.innerHTML || LP_EMPTY_HTML];

  // Work on a detached clone - this must never touch what the user is
  // actively editing.
  const source = document.createElement('div');
  source.innerHTML = bodyEl.innerHTML;

  // A contenteditable region can occasionally leave a bare run of text
  // sitting directly in the body (not inside a <p>), typically after a
  // paste. Wrap any such run so every top-level node is a normal,
  // measurable block element.
  Array.from(source.childNodes).forEach(n => {
    if (n.nodeType === 3 && n.nodeValue.trim()) {
      const wrap = document.createElement('p');
      source.insertBefore(wrap, n);
      wrap.appendChild(n);
    }
  });
  const blocks = Array.from(source.childNodes).filter(n => n.nodeType === 1);
  if (!blocks.length) return [bodyEl.innerHTML || LP_EMPTY_HTML];

  // Measured off-screen, at the CSS reference resolution (96px = 1in =
  // 25.4mm - fixed by the CSS spec, independent of the actual screen's own
  // DPI or of the on-screen zoom applied to the live editor). The host
  // carries the real .lp-body class so it inherits the exact same padding,
  // font and line-height the printed page will use, at the printed page's
  // real full width, so the measured heights match the real print output.
  const host = document.createElement('div');
  host.className = 'lp-body';
  host.style.cssText =
    'position:absolute; left:-99999px; top:0; visibility:hidden; ' +
    'width:' + LP_PAGE.widthMm + 'mm; height:auto; min-height:0; overflow:visible;';
  blocks.forEach(b => host.appendChild(b));
  document.body.appendChild(host);

  const pxPerMm = 96 / 25.4;
  const budgetPx = (LP_PAGE.contentMm - LP_PRINT_SAFETY_MM) * pxPerMm;

  const hostChildren = Array.from(host.children);
  const pages = [];
  let pageStart = 0;
  let pageTop = hostChildren.length ? hostChildren[0].offsetTop : 0;

  hostChildren.forEach((el, i) => {
    const bottom = (el.offsetTop + el.offsetHeight) - pageTop;
    if (bottom > budgetPx && i > pageStart) {
      pages.push(hostChildren.slice(pageStart, i).map(e => e.outerHTML).join(''));
      pageStart = i;
      pageTop = el.offsetTop;
    }
  });
  pages.push(hostChildren.slice(pageStart).map(e => e.outerHTML).join(''));

  host.remove();
  return pages.length ? pages : [bodyEl.innerHTML || LP_EMPTY_HTML];
}

// -------------------------------------------------------------------------
// 19g. PRINT / SAVE AS PDF
//
// Printed from a private, throwaway iframe carrying its own stylesheet.
// That is deliberate: the app's existing @media print block hides everything
// except body[data-print-target] and sets a 5mm @page margin for invoices.
// A letterhead needs a 0mm margin (the bands run edge to edge), and @page
// cannot be scoped per element - so rather than touch those shared rules and
// risk the bill layout, the letterpad simply prints somewhere else entirely.
//
// Every page is built from lpPaginateBody_'s chunks, each wrapped in its own
// full header+body+footer .lp-page - see the comment on LP_PRINT_CSS for why
// this replaced the earlier <thead>/<tfoot> table approach.
// -------------------------------------------------------------------------
function lpPrint_() {
  const body = document.getElementById('lpBody');
  const header = document.getElementById('lpHeader');
  const footer = document.getElementById('lpFooter');
  if (!body || !header || !footer) return;

  if (!body.textContent.trim() && !body.querySelector('img, hr, table')) {
    toast('The letterpad is empty - type something first.', 'error');
    return;
  }

  const headerHtml = header.outerHTML;
  const footerHtml = footer.outerHTML;
  const pagesHtml = lpPaginateBody_(body).map(chunk =>
    '<div class="lp-page">' + headerHtml +
    '<div class="lp-body">' + chunk + '</div>' +
    footerHtml + '</div>'
  ).join('');

  const docHtml =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<title>SJ Physiotherapy - Letter</title>' +
    '<style>' + LP_PAPER_CSS + LP_PRINT_CSS + '</style>' +
    '</head><body>' + pagesHtml + '</body></html>';

  const old = document.getElementById('lpPrintFrame');
  if (old) old.remove();

  const frame = document.createElement('iframe');
  frame.id = 'lpPrintFrame';
  frame.setAttribute('aria-hidden', 'true');
  // Was a 0x0, visibility:hidden iframe. Desktop browsers happily print a
  // hidden/zero-size iframe's document at its own real size regardless -
  // but mobile Chrome/Safari's print pipeline only outputs what the iframe
  // element itself is actually laid out and painted as on screen, so a 0x0
  // or visibility:hidden frame prints as a blank page there (this is the
  // "downloads only a white sheet" bug on phones). Giving it real A4
  // dimensions and hiding it purely by pushing it off-canvas - never
  // visibility:hidden, never display:none - keeps it invisible to the user
  // while giving every browser, mobile included, real content to render.
  frame.style.cssText =
    'position:fixed;top:0;left:-99999px;width:' + LP_PAGE.widthMm + 'mm;' +
    'height:' + LP_PAGE.heightMm + 'mm;border:0;';
  document.body.appendChild(frame);

  const fdoc = frame.contentWindow.document;
  fdoc.open();
  fdoc.write(docHtml);
  fdoc.close();

  // The letterhead logo and the contact icons are remote images. Printing
  // before they have arrived would silently produce a letter with gaps in
  // the header and footer, so wait for them (with a ceiling, so a slow or
  // unreachable image can never leave the user stuck).
  const imgs = Array.from(fdoc.images || []);
  let pending = imgs.filter(i => !i.complete).length;
  let fired = false;

  const go = () => {
    if (fired) return;
    fired = true;
    // A fixed setTimeout here used to guess how long the browser needs to
    // lay out and paint the freshly-written iframe before printing it. On
    // a phone right after typing, the main thread is often still busy
    // (keyboard closing, autocorrect settling), so a guessed delay can run
    // out before the paint actually happens - producing a blank print on
    // the first try, then working a moment later once the device is idle
    // again. Two chained requestAnimationFrame calls instead explicitly
    // wait for the browser to confirm a real paint has happened, so this
    // can no longer race ahead of the content actually being drawn.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch (e) {
            toast('Could not open the print dialog. Please try again.', 'error');
          }
        }, 60);
      });
    });
  };

  if (pending === 0) {
    go();
  } else {
    imgs.forEach(img => {
      if (img.complete) return;
      const done = () => { pending--; if (pending <= 0) go(); };
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
    setTimeout(go, 6000); // hard ceiling
  }

  // Clean the iframe up afterwards. Removing it too early can cancel the
  // print dialog in some browsers, so this waits for afterprint and keeps a
  // long fallback timer for browsers that never fire it.
  try {
    frame.contentWindow.addEventListener('afterprint', () => {
      setTimeout(() => { const f = document.getElementById('lpPrintFrame'); if (f) f.remove(); }, 500);
    });
  } catch (e) { /* ignore */ }
  setTimeout(() => { const f = document.getElementById('lpPrintFrame'); if (f) f.remove(); }, 120000);
}
