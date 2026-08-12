// ============================================================
// PT Glory — glory-pages-api Worker
// Worker แยกต่างหากจาก glory-api เดิม มีแค่ endpoint เดียว: ข้อมูลยอดขายรายเพจ
// อ่านจาก Staging Sheet รายเพจ (เขียนโดย etl/sync_pages.py) ผ่าน Service Account เดียวกัน
// ใช้กับหน้า dashboard https://ptglorydata-maker.github.io/ptglory-sales-fb/ (section "รายเพจ")
// ============================================================

// ====== CONFIG ======
const GOOGLE_CLIENT_EMAIL = 'glory-sheets-reader-456@ptglory-dashboard-sales-fb.iam.gserviceaccount.com';

// Staging Sheet รายเพจ (เขียนโดย etl/sync_pages.py)
const PAGES_SHEET_ID = '1Jd5jsYoslIpbOtZwQ-skrXir7DIIY1xmRq9jH7htskk';
const PAGES_SHEET_TAB = 'staging_รายเพจ';

const TOKEN = 'ptglory_x9k2z7'; // token ฝั่ง client (index.html) — ใช้ตัวเดียวกับ glory-api เดิม
const FRESH_TTL = 300;
const STALE_MAX_AGE = 86400;

// ============================================================
// ---------- Google OAuth (Service Account JWT, RS256) ----------
// ============================================================
function b64ToBuf(b64) {
  var bin = atob(b64);
  var buf = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function bufToB64Url(buf) {
  var bytes = new Uint8Array(buf), str = '';
  for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function strToB64Url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function importPrivateKey(pem) {
  var body = pem.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s+/g, '');
  var der = b64ToBuf(body);
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
async function getAccessToken(env) {
  var kvKey = 'v1:_gtoken';
  var cachedRaw = await env.GLORY_KV.get(kvKey);
  if (cachedRaw) {
    try {
      var cached = JSON.parse(cachedRaw);
      if (cached.exp > Math.floor(Date.now() / 1000) + 60) return cached.token;
    } catch (e) {}
  }
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claim = {
    iss: GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  var unsigned = strToB64Url(JSON.stringify(header)) + '.' + strToB64Url(JSON.stringify(claim));
  var pem = (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!pem) throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_PRIVATE_KEY secret ใน Worker');
  var key = await importPrivateKey(pem);
  var sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  var jwt = unsigned + '.' + bufToB64Url(sigBuf);

  var resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });
  var data = await resp.json();
  if (!data.access_token) throw new Error('Google token error: ' + JSON.stringify(data));
  await env.GLORY_KV.put(kvKey, JSON.stringify({ token: data.access_token, exp: now + data.expires_in }), { expirationTtl: Math.max(60, data.expires_in - 60) });
  return data.access_token;
}

async function fetchValuesFrom_(env, spreadsheetId, sheetName) {
  var token = await getAccessToken(env);
  var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' +
    encodeURIComponent(sheetName) + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
  var resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var data = await resp.json();
  if (!resp.ok) throw new Error('Sheets API error (' + sheetName + '): ' + JSON.stringify(data));
  return data.values || [];
}

// ============================================================
// ---------- helpers ----------
// ============================================================
function num_(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v == null) return null;
  var n = parseFloat(String(v).replace(/[,\s฿%]/g, ''));
  return isNaN(n) ? null : n;
}

function serialToDate_(serial) {
  var utcDays = Math.floor(serial - 25569);
  var base = new Date(utcDays * 86400 * 1000);
  var fracDay = serial - Math.floor(serial);
  var totalSec = Math.round(86400 * fracDay);
  var hh = Math.floor(totalSec / 3600), mm = Math.floor((totalSec % 3600) / 60), ss = totalSec % 60;
  return new Date(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mm, ss);
}

function parseDate_(v) {
  if (typeof v === 'number') return serialToDate_(v);
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    var d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (y > 2400) y -= 543;
    return new Date(y, mo - 1, d);
  }
  // ISO เช่น 2026-01-01 (รูปแบบที่ etl/sync_pages.py เขียนลง Staging Sheet ด้วย date.isoformat())
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  var dd = new Date(s);
  return isNaN(dd.getTime()) ? null : dd;
}

function pad2_(n) { return n < 10 ? '0' + n : '' + n; }
function fmtYMD_(d) { return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()); }
function fmtHM_(d) { return pad2_(d.getHours()) + ':' + pad2_(d.getMinutes()); }
function key_(d) { return fmtYMD_(d); }

function todayBangkok_() {
  var now = new Date();
  var bkk = new Date(now.getTime() + 7 * 3600 * 1000);
  return new Date(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate());
}

// ---------- Staging Sheet รายเพจ — header ตรงกับชื่อ field อยู่แล้ว ----------
var PAGES_NUMERIC_FIELDS = [
  'ad_spend', 'chats_ads', 'chats_admin', 'cost_per_chat',
  'sales_total', 'sales_new', 'sales_old',
  'orders_total', 'orders_new', 'orders_old',
  'close_rate_new', 'ads_pct', 'roas_new', 'roas_total', 'error_pct'
];
var _pagesRowsCache_ = null; // แคชต่อ 1 request เท่านั้น
async function readPagesSheet_(env) {
  if (_pagesRowsCache_) return _pagesRowsCache_;
  var values = await fetchValuesFrom_(env, PAGES_SHEET_ID, PAGES_SHEET_TAB);
  if (values.length < 2) { _pagesRowsCache_ = []; return []; }
  var header = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  var pos = {};
  header.forEach(function (h, i) { if (pos[h] === undefined) pos[h] = i; });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], o = {};
    header.forEach(function (h) { o[h] = row[pos[h]]; });
    var d = parseDate_(o.date);
    if (!d) continue;
    o._date = d;
    o.unit = o.unit != null ? String(o.unit).trim() : '';
    o.page = o.page != null ? String(o.page).trim() : '';
    o.admin = o.admin != null ? String(o.admin).trim() : '';
    o.active = o.active != null ? String(o.active).trim() : '';
    PAGES_NUMERIC_FIELDS.forEach(function (f) { o[f] = num_(o[f]); });
    rows.push(o);
  }
  _pagesRowsCache_ = rows;
  return rows;
}

// ============================================================
// ---------- getPagesData: ?unit=Uxx ----------
// ไม่ระบุ unit -> คืนแค่ meta.units (รายชื่อยูนิตทั้งหมดที่มีในสเตจจิ้ง) ไม่คืนแถวข้อมูล กันโหลดหนัก
// ============================================================
async function getPagesData(env, unit) {
  var rows = await readPagesSheet_(env);
  if (!rows.length) return { error: 'อ่านข้อมูล Staging Sheet รายเพจไม่ได้ — ตรวจ PAGES_SHEET_ID/สิทธิ์การแชร์ หรือยังไม่เคย sync' };

  var units = [];
  rows.forEach(function (o) { if (o.unit && units.indexOf(o.unit) < 0) units.push(o.unit); });
  units.sort();

  var meta = { units: units, updated: fmtHM_(todayBangkok_()) };
  if (!unit) return { meta: meta, pages: [], rows: [] };

  var unitRows = rows.filter(function (o) { return o.unit === unit; });
  if (!unitRows.length) return { meta: meta, pages: [], rows: [], error: 'ไม่พบข้อมูลของ unit นี้ใน Staging Sheet' };

  // รายชื่อเพจของยูนิตนี้ + สถานะ active/admin ล่าสุด (แถวที่วันที่ใหม่สุดของแต่ละเพจ)
  var pageMap = {};
  unitRows.forEach(function (o) {
    var p = pageMap[o.page];
    if (!p || o._date > p._date) pageMap[o.page] = o;
  });
  var pages = Object.keys(pageMap).map(function (p) {
    var o = pageMap[p];
    return { page: p, admin: o.admin, active: o.active === 'active' };
  }).sort(function (a, b) { return (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.page.localeCompare(b.page); });

  var outRows = unitRows
    .sort(function (a, b) { return a._date - b._date; })
    .map(function (o) {
      return {
        date: key_(o._date), page: o.page, admin: o.admin, active: o.active === 'active',
        ad_spend: o.ad_spend, chats_ads: o.chats_ads, chats_admin: o.chats_admin, cost_per_chat: o.cost_per_chat,
        sales_total: o.sales_total, sales_new: o.sales_new, sales_old: o.sales_old,
        orders_total: o.orders_total, orders_new: o.orders_new, orders_old: o.orders_old,
        close_rate_new: o.close_rate_new, ads_pct: o.ads_pct,
        roas_new: o.roas_new, roas_total: o.roas_total, error_pct: o.error_pct
      };
    });

  return { meta: meta, pages: pages, rows: outRows };
}

function canonicalKey_(params) {
  var keys = Array.from(params.keys()).sort();
  return 'v1:' + keys.map(function (k) { return k + '=' + params.get(k); }).join('&');
}

// ============================================================
// ---------- HTTP handler ----------
// ============================================================
export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers });

    var params = new URLSearchParams(url.search);
    if (params.get('token') !== TOKEN) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers });
    }
    params.delete('token');
    var unit = params.get('unit') || null;
    var kvKey = canonicalKey_(params);

    async function computeFresh() {
      var data = await getPagesData(env, unit);
      var text = JSON.stringify(data);
      try {
        JSON.parse(text);
        await env.GLORY_KV.put(kvKey, JSON.stringify({ data: text, ts: Date.now() }), { expirationTtl: STALE_MAX_AGE });
      } catch (e) {}
      return text;
    }

    var raw = await env.GLORY_KV.get(kvKey);
    if (raw) {
      var cached = null;
      try { cached = JSON.parse(raw); } catch (e) {}
      if (cached) {
        var age = (Date.now() - cached.ts) / 1000;
        var resp = new Response(cached.data, { headers });
        resp.headers.set('X-Cache', age < FRESH_TTL ? 'HIT-FRESH' : 'HIT-STALE');
        resp.headers.set('X-Cache-Age', Math.round(age).toString());
        if (age >= FRESH_TTL) ctx.waitUntil(computeFresh().catch(function(){}));
        return resp;
      }
    }

    try {
      var data = await computeFresh();
      var resp2 = new Response(data, { headers });
      resp2.headers.set('X-Cache', 'MISS');
      return resp2;
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }
};
