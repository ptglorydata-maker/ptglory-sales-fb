// ============================================================
// PT Glory — glory-pages-api Worker
// พอร์ตมาจาก pagestats-appsscript.gs (Google Apps Script) ให้ทำงานเหมือนเดิมทุกอย่างแต่รันบน
// Cloudflare Worker แทน — เหตุผล: Apps Script ต้องสแกนทั้งชีต Staging ใหม่ทุกคำขอ (ไม่มี query
// เฉพาะช่วงได้) ทำให้ "สถิติรายเพจ/รายคน" โหลดช้ากว่าหน้าอื่นที่อ่านจาก Worker (glory-api) มาก
// ย้ายมาที่นี่แล้วได้ 2 อย่างที่ Apps Script ทำไม่ได้: (1) แคชแถวดิบทั้งชีตใน KV ได้เต็มๆ (KV จำกัดที่
// 25MB/key ต่างจาก CacheService ของ Apps Script ที่จำกัดแค่ 100KB/key) (2) เอนจิน V8 ของ Worker
// เร็วกว่า Apps Script รันตรรกะรวมยอดมาก
//
// พารามิเตอร์/query string และ shape ของ JSON ที่คืน "เหมือนเดิมทุกประการ" กับ pagestats-appsscript.gs
// เพื่อให้ index.html แค่เปลี่ยน PAGE_API_URL เป็น URL ของ Worker นี้ ไม่ต้องแก้โค้ดฝั่งหน้าเว็บเลย
// ============================================================

// ====== CONFIG ======
const GOOGLE_CLIENT_EMAIL = 'glory-sheets-reader-456@ptglory-dashboard-sales-fb.iam.gserviceaccount.com';

const PAGES_SHEET_ID = '1Jd5jsYoslIpbOtZwQ-skrXir7DIIY1xmRq9jH7htskk'; // "Staging - รายเพจ"
const PAGES_TAB = 'staging_รายเพจ';
const ADMIN_TAB = 'staging_รายคน'; // ยอดขาย/ออเดอร์/%ปิด/เปอร์บิล รายบุคคลจริง — ใช้แค่ตอนดูรายละเอียดคนเดียว
const PAGES_TAB_GID = 851624242; // ใช้ normalize สำหรับ getPageUnits (ไม่ต้องพึ่ง gid จริงๆ เพราะดึงทั้งแท็บด้วยชื่ออยู่แล้ว — เก็บไว้เผื่ออ้างอิง)

const ROSTER_SHEET_ID = '1vjZ2ERd1Q-OAX5yYOgDztemVuF4samjSE5BXZ5snprA'; // "test-รายงานเพจ FB" (master catalog)
const KPI_SHEET_ID = '1a7Z1U3FouP7GeFMQ0D8yKUQOd9ZMgkJGxh0PFBLt5g0'; // "KPI ฝ่ายขาย FB 2569 (PT GLORY)"
const KPI_TAB_GID = 1293185359; // แท็บ "KPI แอดมิน"
const DA_TEAM_SHEET_ID = '1fvcBHub0z_xI6O_7Ml3MYNnzq-dJJl-g6NqFX0bTVb0'; // "Data กลางทีม DA"
const DA_TEAM_TAB = 'Data_All Unit in 69';
const DA_TEAM_YEAR = 2026; // ไฟล์นี้ไม่มีคอลัมน์ปี มีแต่ "เดือน" (1-12) — ข้อมูลทั้งไฟล์เป็นปี 2569 เท่านั้น

const TOKEN = 'glory_pg_0922541941'; // ต้องตรงกับ PAGE_API_TOKEN ใน index.html (ค่าเดียวกับที่ Apps Script เคยใช้)

// TTL ของแคชแต่ละชั้น (วินาที) — สั้นพอที่จะไม่ค้างข้อมูลเก่านานหลังรัน ETL ใหม่ แต่ยาวพอให้คนที่ดู
// ช่วง/ยูนิต/แอดมินเดียวกันซ้ำ (กรณีที่พบบ่อยที่สุด: ทุกคนเปิดมาเจอค่าเริ่มต้น "เดือนนี้" เหมือนกัน) เร็วขึ้นมาก
const TTL_RAW_ROWS = 90;      // แถวดิบทั้งชีต Staging (ใหญ่ อ่านจาก Sheets API แพงสุด)
const TTL_RESULT = 120;       // ผลลัพธ์ที่คำนวณเสร็จแล้วต่อชุดพารามิเตอร์
const TTL_UNITS = 600;        // dropdown หน่วย แทบไม่เปลี่ยน
const TTL_MONTH_DATA = 300;   // ข้อมูลรายเดือนจากไฟล์ DA/KPI (เหมือน Apps Script CacheService เดิม)
const TTL_META = 3600;        // metadata ของสเปรดชีต (ชื่อแท็บจาก gid) แทบไม่เปลี่ยนเลย

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
  // ต้องตัด header/footer ให้ถูกแม้ตอน paste secret ผ่าน Cloudflare dashboard UI จะไม่มีขึ้นบรรทัดใหม่เหลือ
  // เลยสักตัว (ยืนยันจริง: raw_line_count=1) เจอบั๊ก: ตัวแรกใช้ [^-]+ (อะไรก็ได้ที่ไม่ใช่ "-") เป็น greedy
  // พอไม่มี \n มาคั่น มันเลยกวาดกินตั้งแต่ "BEGIN " ยาวไปจนถึง "-----" ตัวถัดไปที่เจอ (คือ "-----END...")
  // กลืนคีย์จริงทั้งก้อนหายหมด เหลือ cleaned_length=0 — แก้เป็นจำกัด charset ตรงกลางแค่ A-Z/เว้นวรรค (ตัวอักษร
  // header จริงๆ) แทน เพราะ base64 ของคีย์จริงมีตัวพิมพ์เล็ก/ตัวเลข/+//  ปนอยู่เสมอเร็วมาก (ไม่กี่ตัวอักษรแรก
  // ก็เจอตัวพิมพ์เล็กแล้ว) รับประกันว่า regex จะหยุดที่ "-----" ปิดของ header เองตามธรรมชาติ ไม่ล้นไปกินคีย์จริง
  // (base64 มาตรฐานไม่มี "-" ปนอยู่เลย ขีดกลางที่เจอในสตริงทั้งหมดจึงมีแค่ในตัวคั่น header/footer เท่านั้น)
  var body = String(pem || '')
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  if (!body) throw new Error('GOOGLE_PRIVATE_KEY ว่างเปล่าหลังตัด header/footer — เช็คว่า paste ค่าครบหรือไม่');
  var der = b64ToBuf(body);
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
async function getAccessToken(env) {
  var kvKey = 'gtok:v1';
  var cachedRaw = await env.GLORY_KV.get(kvKey);
  if (cachedRaw) {
    try {
      var cached = JSON.parse(cachedRaw);
      if (cached.exp > Math.floor(Date.now() / 1000) + 60) return cached.token;
    } catch (e) { /* cache เพี้ยน ขอใหม่ */ }
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

// ============================================================
// ---------- ตัวช่วยอ่าน Google Sheets API + แคชใน KV ----------
// ============================================================
async function kvGetJson_(env, key) {
  var raw = await env.GLORY_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function kvPutJson_(env, key, obj, ttlSeconds) {
  try { await env.GLORY_KV.put(key, JSON.stringify(obj), { expirationTtl: ttlSeconds }); } catch (e) { /* ค่าใหญ่เกิน 25MB ก็แค่ไม่แคช ไม่ล่มทั้งหน้า */ }
}

// ดึงทั้งแท็บ (ไม่ระบุช่วงเซลล์) — Sheets API คืนเฉพาะช่วงที่มีข้อมูลจริงให้อัตโนมัติ ไม่ต้องรู้ lastRow/lastCol เอง
async function fetchTabValues_(env, spreadsheetId, sheetTitle, renderOption, dateTimeRenderOption) {
  var token = await getAccessToken(env);
  var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' +
    encodeURIComponent(sheetTitle) + '?valueRenderOption=' + (renderOption || 'FORMATTED_VALUE') +
    (dateTimeRenderOption ? '&dateTimeRenderOption=' + dateTimeRenderOption : '');
  var resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var data = await resp.json();
  if (!resp.ok) throw new Error('Sheets API error (' + sheetTitle + '): ' + JSON.stringify(data));
  return data.values || [];
}

// metadata ของสเปรดชีต (ชื่อ+gid ของทุกแท็บ เรียงตามลำดับแท็บจริง) — ใช้หา "แท็บแรก" (roster) และ
// หาชื่อแท็บปัจจุบันจาก gid (KPI) เพราะทีมอาจเปลี่ยนชื่อแท็บได้ตลอดแต่ gid ไม่เปลี่ยน (เหมือนที่
// pagestats-appsscript.gs ใช้ getSheetId() แทนชื่อแท็บตรงๆ)
async function getSpreadsheetMeta_(env, spreadsheetId) {
  var cacheKey = 'meta:v1:' + spreadsheetId;
  var cached = await kvGetJson_(env, cacheKey);
  if (cached) return cached;
  var token = await getAccessToken(env);
  var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '?fields=sheets.properties(sheetId,title,index)';
  var resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var data = await resp.json();
  if (!resp.ok) throw new Error('Sheets metadata error: ' + JSON.stringify(data));
  var sheets = (data.sheets || []).map(function (s) { return s.properties; }).sort(function (a, b) { return a.index - b.index; });
  await kvPutJson_(env, cacheKey, sheets, TTL_META);
  return sheets;
}
async function getSheetTitleByGid_(env, spreadsheetId, gid) {
  var meta = await getSpreadsheetMeta_(env, spreadsheetId);
  var found = meta.filter(function (s) { return s.sheetId === gid; })[0];
  if (!found) throw new Error('ไม่พบแท็บที่มี gid=' + gid + ' ในสเปรดชีต ' + spreadsheetId);
  return found.title;
}
async function getFirstSheetTitle_(env, spreadsheetId) {
  var meta = await getSpreadsheetMeta_(env, spreadsheetId);
  if (!meta.length) throw new Error('สเปรดชีต ' + spreadsheetId + ' ไม่มีแท็บเลย');
  return meta[0].title;
}

// ============================================================
// ---------- helpers ตัวเลข/วันที่/ชื่อ (พอร์ตตรงจาก .gs) ----------
// ============================================================
function num_(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v == null) return 0;
  var n = parseFloat(String(v).replace(/[,\s฿%]/g, ''));
  return isNaN(n) ? 0 : n;
}
function pct_(v) {
  if (v === '' || v == null) return NaN;
  if (typeof v === 'string') v = v.replace('%', '').trim();
  var n = parseFloat(v);
  return isNaN(n) ? NaN : n;
}
function round2_(n) { return Math.round(n * 100) / 100; }

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
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); // รูปแบบที่ etl/sync_pages.py เขียนลง Staging (date.isoformat())
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  var dd = new Date(s);
  return isNaN(dd.getTime()) ? null : dd;
}
function pad2_(n) { return n < 10 ? '0' + n : '' + n; }
function fmtYMD_(d) { return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()); }
function fmtHM_(d) { return pad2_(d.getHours()) + ':' + pad2_(d.getMinutes()); }
function todayBangkok_() {
  var now = new Date();
  var bkk = new Date(now.getTime() + 7 * 3600 * 1000);
  return new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate(), bkk.getUTCHours(), bkk.getUTCMinutes()));
}

// ตัดคอลัมน์ unit ดิบให้เหลือแค่รหัสยูนิตล้วน เช่น "U9 ชาสมุนไพรแม่แย้ม" → "U9", "U5 ลาว Capsule" → "U5 ลาว"
function normalizeUnitCode_(raw) {
  raw = String(raw || '').trim();
  var m = raw.match(/^([A-Za-z]+\d+)(\s*ลาว)?/);
  return m ? (m[1] + (m[2] ? ' ลาว' : '')) : raw;
}
// ดึง "ชื่อเล่น" ล้วนๆ จากป้าย "ชื่อเล่น (ชื่อจริง)" เช่น "อ้อม (บุษยา)" → "อ้อม"
function adminNick_(fullLabel) {
  var s = String(fullLabel || '').trim();
  var i = s.indexOf(' (');
  return i >= 0 ? s.slice(0, i).trim() : s;
}
// ตัดช่องว่างทั้งหมดออกก่อนเทียบ — คอลัมน์ "ชื่อจากไฟล์ต้น" ในไฟล์ DA พิมพ์ไม่สม่ำเสมอ (มี/ไม่มีวรรค)
function normalizeAdminKey_(s) { return String(s || '').replace(/\s+/g, ''); }

var THAI_MONTHS_ = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function parseThaiMonthLabel_(label) {
  label = String(label || '').trim();
  for (var i = 0; i < THAI_MONTHS_.length; i++) {
    if (label.indexOf(THAI_MONTHS_[i]) === 0) {
      var yy = label.match(/(\d{2,4})/);
      if (!yy) return null;
      var buddhistYear = yy[1].length <= 2 ? 2500 + parseInt(yy[1], 10) : parseInt(yy[1], 10);
      return (buddhistYear - 543) + '-' + String(i + 1).padStart(2, '0');
    }
  }
  return null;
}
function monthsBetween_(start, end) {
  var out = [], y = parseInt(start.slice(0, 4), 10), m = parseInt(start.slice(5, 7), 10);
  var endY = parseInt(end.slice(0, 4), 10), endM = parseInt(end.slice(5, 7), 10);
  while (y < endY || (y === endY && m <= endM)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// DA_NAME_ALIASES_: แก้ชื่อพิมพ์ผิดในไฟล์ DA ชั่วคราวระหว่างรอแก้ที่ต้นทาง — ดู pagestats-appsscript.gs
// สำหรับรายละเอียดเคส "เว (เวสารัช)" ไม่มีแถวตัวเอง มีแต่แถวที่เอาชื่อเล่น "เวย์" มาแปะคู่กับชื่อจริงผิด
var DA_NAME_ALIASES_ = {};
DA_NAME_ALIASES_[normalizeAdminKey_('เวย์ (เวสารัช)')] = normalizeAdminKey_('เว (เวสารัช)');

// ============================================================
// ---------- โหลดชีต Staging (รายเพจ/รายคน) — แคชแถวดิบทั้งชีตใน KV ----------
// ============================================================
var PAGES_NEED_COLS = ['date', 'unit', 'page', 'admin', 'active', 'ad_spend', 'chats_ads', 'chats_admin',
  'sales_total', 'sales_new', 'sales_old', 'orders_total', 'orders_new', 'orders_old',
  'close_rate_new', 'error_pct'];

async function loadPagesRows_(env) {
  var cacheKey = 'rows:v1:pages';
  var cached = await kvGetJson_(env, cacheKey);
  if (cached) return cached;
  var values = await fetchTabValues_(env, PAGES_SHEET_ID, PAGES_TAB, 'UNFORMATTED_VALUE', 'SERIAL_NUMBER');
  var rows = [];
  if (values.length >= 2) {
    var header = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
    var col = {};
    header.forEach(function (h, i) { if (col[h] === undefined) col[h] = i; });
    PAGES_NEED_COLS.forEach(function (k) { if (!(k in col)) throw new Error('ไม่พบคอลัมน์ในชีต staging_รายเพจ: ' + k); });
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var d = parseDate_(row[col.date]);
      if (!d) continue;
      rows.push({
        dateMs: d.getTime(),
        unit: String(row[col.unit] || '').trim(),
        page: String(row[col.page] || '').trim(),
        admin: String(row[col.admin] || '').trim(),
        active: String(row[col.active] || '').trim(),
        ad_spend: num_(row[col.ad_spend]), chats_ads: num_(row[col.chats_ads]), chats_admin: num_(row[col.chats_admin]),
        sales_total: num_(row[col.sales_total]), sales_new: num_(row[col.sales_new]), sales_old: num_(row[col.sales_old]),
        orders_total: num_(row[col.orders_total]), orders_new: num_(row[col.orders_new]), orders_old: num_(row[col.orders_old]),
        close_rate_new: pct_(row[col.close_rate_new]), error_pct: pct_(row[col.error_pct])
      });
    }
  }
  await kvPutJson_(env, cacheKey, rows, TTL_RAW_ROWS);
  return rows;
}

var ADMIN_NEED_COLS = ['date', 'unit', 'admin', 'sales_total', 'sales_new', 'sales_old',
  'orders_total', 'orders_new', 'orders_old', 'close_rate_new', 'ad_spend', 'cost_per_chat', 'roas_new'];

// staging_รายคน ใหญ่กว่า staging_รายเพจ (~50,000 แถว) และใช้แค่ตอนดูรายละเอียดคนเดียว (วาดกราฟแนวโน้ม
// รายวันจริง) — เรียกเฉพาะตอนมี adminFilter เท่านั้น (ดู getAdminStats_) กันโหลดหนักเปล่าๆ ตอนดู leaderboard
async function loadAdminRows_(env) {
  var cacheKey = 'rows:v1:admin';
  var cached = await kvGetJson_(env, cacheKey);
  if (cached) return cached;
  var rows = [];
  try {
    var values = await fetchTabValues_(env, PAGES_SHEET_ID, ADMIN_TAB, 'UNFORMATTED_VALUE', 'SERIAL_NUMBER');
    if (values.length >= 2) {
      var header = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
      var col = {};
      header.forEach(function (h, i) { if (col[h] === undefined) col[h] = i; });
      var hasAll = ADMIN_NEED_COLS.every(function (k) { return k in col; });
      if (hasAll) {
        for (var r = 1; r < values.length; r++) {
          var row = values[r];
          var d = parseDate_(row[col.date]);
          if (!d) continue;
          rows.push({
            dateMs: d.getTime(), unit: String(row[col.unit] || '').trim(), admin: String(row[col.admin] || '').trim(),
            sales_total: num_(row[col.sales_total]), sales_new: num_(row[col.sales_new]), sales_old: num_(row[col.sales_old]),
            orders_total: num_(row[col.orders_total]), orders_new: num_(row[col.orders_new]), orders_old: num_(row[col.orders_old]),
            close_rate_new: pct_(row[col.close_rate_new]), ad_spend: num_(row[col.ad_spend]), cost_per_chat: num_(row[col.cost_per_chat])
          });
        }
      }
    }
  } catch (e) { /* แท็บนี้อาจยังไม่มี/โครงสร้างผิดคาด — คืนว่างเปล่าให้ caller fallback เอง ไม่ล่มทั้งหน้า */ }
  await kvPutJson_(env, cacheKey, rows, TTL_RAW_ROWS);
  return rows;
}

// รวมยอดรายบุคคลจริงจาก staging_รายคน ในช่วง [start,end] (+ กรอง unit ถ้ามี) — key ผูกกับหน่วยเสมอ
// (ไม่ใช่แค่ชื่อเล่น) เพราะชื่อเล่นซ้ำกันข้ามยูนิตได้ (เช่น "ก้อย" มีทั้งใน U9 และ U12 เป็นคนละคน)
async function getAdminPersonalAgg_(env, start, end, unitFilter) {
  var rows = await loadAdminRows_(env);
  if (!rows.length) return { byAdmin: {}, byAdminDaily: {} };
  var startMs = new Date(start + 'T00:00:00').getTime(), endMs = new Date(end + 'T23:59:59').getTime();
  var byAdmin = {}, byAdminDaily = {};
  rows.forEach(function (row) {
    if (row.dateMs < startMs || row.dateMs > endMs) return;
    var unitNorm = normalizeUnitCode_(row.unit);
    if (!row.admin) return;
    if (unitFilter && unitFilter !== 'ทั้งหมด' && unitNorm !== unitFilter) return;
    var key = unitNorm + '|' + row.admin;
    if (!byAdmin[key]) byAdmin[key] = { sales_total: 0, sales_new: 0, sales_old: 0, orders_total: 0, orders_new: 0, orders_old: 0, closeSum: 0, closeCount: 0 };
    var g = byAdmin[key];
    g.sales_total += row.sales_total; g.sales_new += row.sales_new; g.sales_old += row.sales_old;
    g.orders_total += row.orders_total; g.orders_new += row.orders_new; g.orders_old += row.orders_old;
    if (!isNaN(row.close_rate_new)) { g.closeSum += row.close_rate_new; g.closeCount++; }
    var dateKey = fmtYMD_(new Date(row.dateMs));
    if (!byAdminDaily[key]) byAdminDaily[key] = {};
    byAdminDaily[key][dateKey] = (byAdminDaily[key][dateKey] || 0) + row.sales_total;
  });
  return { byAdmin: byAdmin, byAdminDaily: byAdminDaily };
}

// ============================================================
// ---------- สถิติรายเพจ ----------
// ============================================================
// ไม่แคชในนี้ซ้ำ — ตัว fetch handler ข้างล่างแคชผลลัพธ์ของทุก mode ที่คีย์เดียวกันอยู่แล้ว
async function getPageUnits_(env) {
  var rows = await loadPagesRows_(env);
  var seen = {}, units = [];
  rows.forEach(function (o) { if (o.unit && !seen[o.unit]) { seen[o.unit] = true; units.push(o.unit); } });
  units.sort();
  return { units: units };
}
async function getAdminUnits_(env) {
  var rows = await loadPagesRows_(env);
  var seen = {}, units = [];
  rows.forEach(function (o) { var u = normalizeUnitCode_(o.unit); if (u && !seen[u]) { seen[u] = true; units.push(u); } });
  units.sort();
  return { units: units };
}

async function getPageStats_(env, start, end, unitFilter) {
  var rows = await loadPagesRows_(env);
  if (!rows.length) return { rows: [], start: start, end: end };
  var startMs = new Date(start + 'T00:00:00').getTime(), endMs = new Date(end + 'T23:59:59').getTime();
  var byPage = {};
  rows.forEach(function (row) {
    if (row.dateMs < startMs || row.dateMs > endMs) return;
    if (!row.page) return;
    if (unitFilter && unitFilter !== 'ทั้งหมด' && row.unit !== unitFilter) return;
    var key = row.unit + '|' + row.page;
    if (!byPage[key]) {
      byPage[key] = {
        unit: row.unit, page: row.page, admin: '', active: '',
        ad_spend: 0, chats_ads: 0, chats_admin: 0,
        sales_total: 0, sales_new: 0, sales_old: 0,
        orders_total: 0, orders_new: 0, orders_old: 0,
        closeWeighted: 0, closeWeight: 0, errSum: 0, errCount: 0
      };
    }
    var g = byPage[key];
    if (row.admin) g.admin = row.admin; // แอดมินอาจเปลี่ยนระหว่างช่วง — ใช้ค่าจากแถววันที่ล่าสุดเป็นตัวแทน (แถวเรียงตามวันที่จากชีตอยู่แล้ว)
    if (row.active) g.active = row.active;
    g.ad_spend += row.ad_spend; g.chats_ads += row.chats_ads; g.chats_admin += row.chats_admin;
    g.sales_total += row.sales_total; g.sales_new += row.sales_new; g.sales_old += row.sales_old;
    g.orders_total += row.orders_total; g.orders_new += row.orders_new; g.orders_old += row.orders_old;
    if (!isNaN(row.close_rate_new) && row.chats_ads > 0) { g.closeWeighted += row.close_rate_new * row.chats_ads; g.closeWeight += row.chats_ads; }
    if (!isNaN(row.error_pct)) { g.errSum += row.error_pct; g.errCount++; }
  });
  var result = Object.keys(byPage).map(function (k) {
    var g = byPage[k];
    return {
      unit: g.unit, page: g.page, admin: g.admin, active: g.active === 'active',
      aov: g.orders_new ? round2_(g.sales_new / g.orders_new) : 0,
      ad_spend: round2_(g.ad_spend), chats_ads: g.chats_ads, chats_admin: g.chats_admin,
      cost_per_chat: g.chats_ads ? round2_(g.ad_spend / g.chats_ads) : 0,
      sales_total: round2_(g.sales_total), sales_new: round2_(g.sales_new), sales_old: round2_(g.sales_old),
      orders_total: round2_(g.orders_total), orders_new: round2_(g.orders_new), orders_old: round2_(g.orders_old),
      close_rate_new: g.closeWeight ? round2_(g.closeWeighted / g.closeWeight) : 0,
      ads_pct: g.sales_total ? round2_(g.ad_spend / g.sales_total * 100) : 0,
      roas_new: g.ad_spend ? round2_(g.sales_new / g.ad_spend) : 0,
      roas_total: g.ad_spend ? round2_(g.sales_total / g.ad_spend) : 0,
      error_pct: g.errCount ? round2_(g.errSum / g.errCount) : 0
    };
  });
  result.sort(function (a, b) { return b.sales_total - a.sales_total; });
  return { rows: result, start: start, end: end };
}

// ============================================================
// ---------- ไฟล์ Data กลางทีม DA ----------
// ============================================================
// คอลัมน์: A=UNIT(0), D=ชื่อจากไฟล์ต้น(3), E=ยอดขายทั้งหมด(4), G=ยอดตีกลับบาท(6), J=เดือน(9),
// K=Order รวม(10), L=ยอดขายลูกค้าใหม่(11), M=Order ลูกค้าใหม่(12), N=ยอดขายลูกค้าเก่า(13),
// O=Order ลูกค้าเก่า(14), U=%ปิดการขายลูกค้าใหม่(20), V=%ERROR(21), Y=จำนวนแชท Ads(24)
async function getDaTeamMonthRows_(env, month) {
  var cacheKey = 'da_rows:v1:' + month;
  var cached = await kvGetJson_(env, cacheKey);
  if (cached) return cached;
  var rows = [];
  var y = parseInt(month.slice(0, 4), 10), targetMonthNum = parseInt(month.slice(5, 7), 10);
  if (y === DA_TEAM_YEAR) {
    var values = await fetchTabValues_(env, DA_TEAM_SHEET_ID, DA_TEAM_TAB, 'FORMATTED_VALUE');
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var name = String(row[3] || '').trim();
      if (!name) continue; // แถวเปล่า (เดือนที่ยังไม่มีข้อมูลจริง ระบบเว้นที่ไว้ล่วงหน้า)
      if (parseInt(row[9], 10) !== targetMonthNum) continue;
      var key = normalizeAdminKey_(name);
      key = DA_NAME_ALIASES_[key] || key;
      rows.push({
        unit: String(row[0] || '').trim(), key: key,
        salesTotal: num_(row[4]), bounceAmt: num_(row[6]), ordersTotal: num_(row[10]),
        salesNew: num_(row[11]), ordersNew: num_(row[12]), salesOld: num_(row[13]), ordersOld: num_(row[14]),
        chatsAds: num_(row[24]), closeVal: pct_(row[20]), errVal: pct_(row[21])
      });
    }
  }
  await kvPutJson_(env, cacheKey, rows, TTL_MONTH_DATA);
  return rows;
}

// รวมแถวดิบตามคนคนเดียวกัน (อาจมีหลายแถวในเดือนเดียวกันถ้าย้ายไปช่วยหลายยูนิต) — ยอดขาย/ออเดอร์รวมตรงๆ
// ได้ ส่วน %ตีกลับ/%ปิดการขาย เป็นอัตราส่วน คำนวณจากตัวเลขดิบที่รวมแล้ว (ถ่วงน้ำหนักตามจำนวนจริง)
function aggregateDaRows_(rows, unitFilter) {
  var acc = {};
  rows.forEach(function (row) {
    if (unitFilter && unitFilter !== 'ทั้งหมด' && normalizeUnitCode_(row.unit) !== unitFilter) return;
    if (!acc[row.key]) acc[row.key] = {
      salesSum: 0, bounceAmtSum: 0, ordersSum: 0, salesNewSum: 0, ordersNewSum: 0, salesOldSum: 0, ordersOldSum: 0,
      chatsAdsSum: 0, closeWeighted: 0, errSum: 0, errCount: 0, units: {}
    };
    var a = acc[row.key];
    a.salesSum += row.salesTotal; a.bounceAmtSum += row.bounceAmt; a.ordersSum += row.ordersTotal;
    a.salesNewSum += row.salesNew; a.ordersNewSum += row.ordersNew;
    a.salesOldSum += row.salesOld; a.ordersOldSum += row.ordersOld;
    if (row.unit) a.units[normalizeUnitCode_(row.unit)] = true;
    // ถ่วงน้ำหนักด้วยจำนวนแชท Ads เมื่อมีค่าจริง (>0) แต่บางแถวในไฟล์ DA คอลัมน์นี้เป็น 0/ว่างทั้งที่มี
    // %ปิดการขายจริงอยู่ — ถ้าบังคับ chatsAds>0 ก่อนเสมอ ค่าที่มีจริงจะถูกทิ้งทั้งแถวเงียบๆ กลายเป็น 0/0=0% ผิดๆ
    if (!isNaN(row.closeVal)) {
      var w = row.chatsAds > 0 ? row.chatsAds : 1;
      a.closeWeighted += row.closeVal * w; a.chatsAdsSum += w;
    }
    if (!isNaN(row.errVal)) { a.errSum += row.errVal; a.errCount++; }
  });
  return acc;
}

async function getDaTeamMonthData_(env, month) {
  var acc = aggregateDaRows_(await getDaTeamMonthRows_(env, month), '');
  var result = {};
  Object.keys(acc).forEach(function (key) {
    var a = acc[key];
    result[key] = {
      month: month,
      sales_actual: round2_(a.salesSum),
      bounce_rate: a.salesSum ? round2_(a.bounceAmtSum / a.salesSum * 100) : 0,
      orders_total: a.ordersSum,
      aov_actual: a.ordersNewSum ? round2_(a.salesNewSum / a.ordersNewSum) : 0,
      close_rate_total: a.chatsAdsSum ? round2_(a.closeWeighted / a.chatsAdsSum) : 0,
      error_pct: a.errCount ? round2_(a.errSum / a.errCount) : null // null = ไม่มีข้อมูล % Error เดือนนี้ในไฟล์ DA เลย (ไม่ใช่ 0% จริง)
    };
  });
  return result;
}

// ดีบั๊ก: คืนทุกแถวดิบของคนคนหนึ่งในเดือนหนึ่ง พร้อมยอดรวม — ใช้เช็คว่า sales_total ที่ leaderboard
// โชว์ มาจากการรวมกี่แถว แถวไหนบ้าง
async function getDaDebugRows_(env, adminExact, month) {
  var key = normalizeAdminKey_(adminExact);
  key = DA_NAME_ALIASES_[key] || key;
  var allRows = await getDaTeamMonthRows_(env, month);
  var matched = allRows.filter(function (r) { return r.key === key; });
  var salesSum = matched.reduce(function (s, r) { return s + r.salesTotal; }, 0);
  return { admin_input: adminExact, normalized_key: key, month: month, row_count: matched.length, sales_total_sum: round2_(salesSum), rows: matched };
}

// ============================================================
// ---------- ไฟล์รายชื่อ (roster) + ไฟล์ KPI ฝ่ายขาย ----------
// ============================================================
async function getRosterMap_(env) {
  var cacheKey = 'roster:v1';
  var cached = await kvGetJson_(env, cacheKey);
  if (cached) return cached;
  var tabTitle = await getFirstSheetTitle_(env, ROSTER_SHEET_ID);
  var values = await fetchTabValues_(env, ROSTER_SHEET_ID, tabTitle, 'FORMATTED_VALUE');
  var map = {};
  if (values.length >= 2) {
    var header = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
    var col = {};
    header.forEach(function (h, i) { if (col[h] === undefined) col[h] = i; });
    if (!('แอดมิน' in col) || !('รหัสพนักงาน' in col)) throw new Error('ไม่พบคอลัมน์ แอดมิน หรือ รหัสพนักงาน ในไฟล์รายชื่อ');
    for (var r = 1; r < values.length; r++) {
      var nick = String(values[r][col['แอดมิน']] || '').trim();
      var empId = String(values[r][col['รหัสพนักงาน']] || '').trim();
      if (!nick || !empId) continue;
      if (!map[nick]) map[nick] = empId;
    }
  }
  await kvPutJson_(env, cacheKey, map, TTL_MONTH_DATA);
  return map;
}

// สแกนแท็บ "KPI แอดมิน" หาตำแหน่งคอลัมน์ "รหัสพนักงาน" และคอลัมน์ค่าจริง 4 ตัวของทุกบล็อกเดือน
// จากข้อความหัวตารางจริงเสมอ (ไม่ hardcode ตัวอักษรคอลัมน์ เพราะบล็อกอาจขยับ/กว้างไม่เท่ากัน)
async function getKpiSheetLayout_(env) {
  var cacheKey = 'kpi_layout:v1';
  var cached = await kvGetJson_(env, cacheKey);
  if (cached) return cached;
  var tabTitle = await getSheetTitleByGid_(env, KPI_SHEET_ID, KPI_TAB_GID);
  var values = await fetchTabValues_(env, KPI_SHEET_ID, tabTitle, 'FORMATTED_VALUE');
  var row1 = values[0] || [], row3 = values[2] || [];
  var lastCol = Math.max(row1.length, row3.length);

  var empIdCol = -1;
  for (var c = 0; c < row3.length; c++) { if (String(row3[c]).trim() === 'รหัสพนักงาน') { empIdCol = c; break; } }
  if (empIdCol < 0) throw new Error('ไม่พบคอลัมน์รหัสพนักงานในแท็บ KPI แอดมิน');

  var blocks = {}, curLabel = '';
  for (var c2 = 0; c2 < lastCol; c2++) {
    if (String(row1[c2] || '').trim()) curLabel = String(row1[c2]).trim();
    var h3 = String(row3[c2] || '').trim();
    if (h3 !== 'ยอดขาย' && h3 !== '%ปิดการขาย' && h3 !== 'ยอดขายเปอร์บิล' && h3 !== '% ตีกลับ') continue;
    var mm = parseThaiMonthLabel_(curLabel);
    if (!mm) continue;
    if (!blocks[mm]) blocks[mm] = { month: mm, label: curLabel, colSales: -1, colClose: -1, colAov: -1, colBounce: -1 };
    if (h3 === 'ยอดขาย') blocks[mm].colSales = c2;
    else if (h3 === '%ปิดการขาย') blocks[mm].colClose = c2;
    else if (h3 === 'ยอดขายเปอร์บิล') blocks[mm].colAov = c2;
    else blocks[mm].colBounce = c2;
  }
  Object.keys(blocks).forEach(function (mm) {
    var b = blocks[mm];
    var ok = b.colSales >= 0 && b.colClose === b.colSales + 1 && b.colAov === b.colSales + 2 && b.colBounce === b.colSales + 3;
    b.hasTargets = ok;
    if (ok) {
      b.colSalesTarget = b.colSales + 4; b.colSalesPts = b.colSales + 5;
      b.colCloseTarget = b.colSales + 6; b.colClosePts = b.colSales + 7;
      b.colAovTarget = b.colSales + 8; b.colAovPts = b.colSales + 9;
      b.colBounceTarget = b.colSales + 10; b.colBouncePts = b.colSales + 11;
      b.colScore = b.colSales + 12; b.colStatus = b.colSales + 13;
    }
  });
  var out = { tabTitle: tabTitle, empIdCol: empIdCol, blocks: blocks };
  await kvPutJson_(env, cacheKey, out, TTL_MONTH_DATA);
  return out;
}

async function getKpiMonthData_(env, month) {
  var cacheKey = 'kpi_month:v1:' + month;
  var cached = await kvGetJson_(env, cacheKey);
  if (cached) return cached;

  var rosterMap = await getRosterMap_(env);
  var empIdToNick = {};
  Object.keys(rosterMap).forEach(function (nick) { empIdToNick[rosterMap[nick]] = nick; });

  var layout = await getKpiSheetLayout_(env);
  var block = layout.blocks[month];
  var result = {};

  if (block) {
    var values = await fetchTabValues_(env, KPI_SHEET_ID, layout.tabTitle, 'FORMATTED_VALUE');
    for (var r = 3; r < values.length; r++) {
      var row = values[r];
      var nick = empIdToNick[String(row[layout.empIdCol] || '').trim()];
      if (!nick) continue;
      var out = {
        month: month, label: block.label,
        sales_actual: block.colSales >= 0 ? num_(row[block.colSales]) : null,
        close_rate_total: block.colClose >= 0 ? pct_(row[block.colClose]) : null,
        aov_actual: block.colAov >= 0 ? num_(row[block.colAov]) : null,
        bounce_rate: block.colBounce >= 0 ? pct_(row[block.colBounce]) : null,
        has_targets: !!block.hasTargets
      };
      if (block.hasTargets) {
        out.sales_target = num_(row[block.colSalesTarget]);
        out.close_target = pct_(row[block.colCloseTarget]);
        out.aov_target = num_(row[block.colAovTarget]);
        out.bounce_target = pct_(row[block.colBounceTarget]);
        out.score = num_(row[block.colScore]);
        out.status = String(row[block.colStatus] || '').trim();
      }
      result[nick] = out;
    }
  }
  await kvPutJson_(env, cacheKey, result, TTL_MONTH_DATA);
  return result;
}

// % ปิดการขาย (รวม), เปอร์บิล, % ตีกลับ, ยอดขายรวมเดือน ของแอดมินคนเดียว ทุกเดือนที่คาบเกี่ยวกับ [start,end]
async function getAdminKpi_(env, adminNickname, start, end) {
  var months = monthsBetween_(start, end);
  var key = normalizeAdminKey_(adminNickname);
  var monthsOut = [];
  for (var i = 0; i < months.length; i++) {
    var mm = months[i];
    var da = (await getDaTeamMonthData_(env, mm))[key];
    var kpi = null;
    try { kpi = (await getKpiMonthData_(env, mm))[adminNickname]; } catch (e) { /* ไฟล์ KPI เดิมพังก็ไม่เป็นไร ยังมีค่าจาก DA */ }
    if (!da && !kpi) continue;
    monthsOut.push({
      month: mm, label: kpi ? kpi.label : mm,
      sales_actual: da ? da.sales_actual : (kpi ? kpi.sales_actual : null),
      close_rate_total: da ? da.close_rate_total : (kpi ? kpi.close_rate_total : null),
      aov_actual: da ? da.aov_actual : (kpi ? kpi.aov_actual : null),
      bounce_rate: da ? da.bounce_rate : (kpi ? kpi.bounce_rate : null),
      has_targets: !!(kpi && kpi.has_targets),
      sales_target: kpi ? kpi.sales_target : null, close_target: kpi ? kpi.close_target : null,
      aov_target: kpi ? kpi.aov_target : null, bounce_target: kpi ? kpi.bounce_target : null,
      score: kpi ? kpi.score : null, status: kpi ? kpi.status : ''
    });
  }
  if (!monthsOut.length) return { found: false, reason: 'ไม่พบข้อมูลของ "' + adminNickname + '" ในช่วงเดือนที่เลือก (เช็คว่ามีในไฟล์ Data กลางทีม DA ไหม)' };
  return { found: true, months: monthsOut };
}

// สถานะ KPI + คะแนนรวม + %ตีกลับ ของ "หลายคนพร้อมกัน" สำหรับหน้าจัดอันดับ — ใช้เดือนล่าสุดที่คาบเกี่ยวเดือนเดียว
async function getKpiStatusBatch_(env, adminNicknames, start, end) {
  var out = {};
  if (!adminNicknames.length) return out;
  var months = monthsBetween_(start, end);
  var lastMonth = months[months.length - 1];
  var daMonthData = await getDaTeamMonthData_(env, lastMonth);
  var kpiMonthData = {};
  try { kpiMonthData = await getKpiMonthData_(env, lastMonth); } catch (e) { /* ไฟล์ KPI เดิมพังก็ไม่เป็นไร ยังมีค่าจาก DA */ }
  adminNicknames.forEach(function (nick) {
    var da = daMonthData[normalizeAdminKey_(nick)];
    var kpi = kpiMonthData[nick];
    if (!da && !kpi) return;
    out[nick] = { month: lastMonth, score: kpi ? kpi.score : null, status: kpi ? kpi.status : '', bounce_rate: da ? da.bounce_rate : (kpi ? kpi.bounce_rate : null) };
  });
  return out;
}

// ============================================================
// ---------- สถิติรายแอดมิน (leaderboard + รายละเอียดคนเดียว) ----------
// ============================================================
async function getAdminStats_(env, start, end, unitFilter, adminFilter) {
  var rows = await loadPagesRows_(env);
  if (!rows.length) return { rows: [], daily: null, start: start, end: end };

  var startMs = new Date(start + 'T00:00:00').getTime(), endMs = new Date(end + 'T23:59:59').getTime();
  var byAdmin = {};
  var byDate = adminFilter ? {} : null;

  rows.forEach(function (row) {
    if (row.dateMs < startMs || row.dateMs > endMs) return;
    // etl/sync_pages.py เขียน admin เป็น ", ".join(ทุกแอดมินของเพจนั้น) — แยกทีละคนก่อน group เสมอ
    var admins = String(row.admin || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!row.page || !admins.length) return;
    if (unitFilter && unitFilter !== 'ทั้งหมด' && normalizeUnitCode_(row.unit) !== unitFilter) return;

    admins.forEach(function (admin) {
      if (byDate && admin === adminFilter) {
        var dateKey = fmtYMD_(new Date(row.dateMs));
        byDate[dateKey] = (byDate[dateKey] || 0) + row.sales_total;
      }
      if (!byAdmin[admin]) {
        byAdmin[admin] = {
          admin: admin, units: {}, pages: {},
          ad_spend: 0, chats_ads: 0, chats_admin: 0,
          sales_total: 0, sales_new: 0, sales_old: 0,
          orders_total: 0, orders_new: 0, orders_old: 0,
          closeWeighted: 0, closeWeight: 0, errSum: 0, errCount: 0
        };
      }
      var g = byAdmin[admin];
      if (row.unit) g.units[normalizeUnitCode_(row.unit)] = true;
      g.pages[row.unit + '|' + row.page] = row.page;
      g.ad_spend += row.ad_spend; g.chats_ads += row.chats_ads; g.chats_admin += row.chats_admin;
      g.sales_total += row.sales_total; g.sales_new += row.sales_new; g.sales_old += row.sales_old;
      g.orders_total += row.orders_total; g.orders_new += row.orders_new; g.orders_old += row.orders_old;
      if (!isNaN(row.close_rate_new) && row.chats_ads > 0) { g.closeWeighted += row.close_rate_new * row.chats_ads; g.closeWeight += row.chats_ads; }
      if (!isNaN(row.error_pct)) { g.errSum += row.error_pct; g.errCount++; }
    });
  });

  // ยอดขาย/ออเดอร์/%ปิดใหม่/เปอร์บิล/%ERROR "ของจริงรายคน" มาจากไฟล์ Data กลางทีม DA เสมอเมื่อมีข้อมูล
  var daRowsAll = [];
  var months = monthsBetween_(start, end);
  for (var i = 0; i < months.length; i++) daRowsAll = daRowsAll.concat(await getDaTeamMonthRows_(env, months[i]));
  var daAgg = aggregateDaRows_(daRowsAll, unitFilter);
  // personalAgg สแกน staging_รายคน (~50,000 แถว) ใช้แค่ตอนดูรายละเอียดคนเดียว (มี adminFilter) เพื่อวาด
  // กราฟแนวโน้มรายวันจริง — ตอนดู leaderboard "ทั้งหมด" ไม่ได้ใช้ค่านี้เลย ข้ามไปกันโหลดหนักเปล่าๆ
  var personalAgg = adminFilter ? await getAdminPersonalAgg_(env, start, end, unitFilter) : { byAdmin: {}, byAdminDaily: {} };

  var result = Object.keys(byAdmin).map(function (k) {
    var g = byAdmin[k];
    var pageNames = Object.keys(g.pages).map(function (pk) { return g.pages[pk]; }).sort();
    var a = daAgg[normalizeAdminKey_(g.admin)];
    var hasReal = !!a && (a.salesSum !== 0 || a.ordersSum !== 0);

    var salesTotal = hasReal ? a.salesSum : g.sales_total;
    var salesNew = hasReal ? a.salesNewSum : g.sales_new;
    var salesOld = hasReal ? a.salesOldSum : g.sales_old;
    var ordersTotal = hasReal ? a.ordersSum : g.orders_total;
    var ordersNew = hasReal ? a.ordersNewSum : g.orders_new;
    var ordersOld = hasReal ? a.ordersOldSum : g.orders_old;
    var closeRateNew = hasReal ? (a.chatsAdsSum ? round2_(a.closeWeighted / a.chatsAdsSum) : 0) : (g.closeWeight ? round2_(g.closeWeighted / g.closeWeight) : 0);
    // null (ไม่ใช่ 0) เมื่อไม่มีค่า % Error ที่ใช้ได้เลยสักแถว — คอลัมน์ V ในไฟล์ DA มักว่างเปล่าจริงๆ
    var errorPct = hasReal ? (a.errCount ? round2_(a.errSum / a.errCount) : null) : (g.errCount ? round2_(g.errSum / g.errCount) : null);
    var adSpend = g.ad_spend;
    var costPerChat = g.chats_ads ? round2_(g.ad_spend / g.chats_ads) : 0;
    var roasNew = adSpend ? round2_(salesNew / adSpend) : 0;
    var roasTotal = adSpend ? round2_(salesTotal / adSpend) : 0;

    return {
      admin: g.admin, units: Object.keys(g.units).sort(), pageCount: pageNames.length, pages: pageNames,
      per_admin_real_data: hasReal, // true = ยอดจริงรายคนจากไฟล์ Data กลางทีม DA, false = ค่าประมาณ full-credit จากแท็บเพจ
      aov: ordersNew ? round2_(salesNew / ordersNew) : 0,
      aov_total: ordersTotal ? round2_(salesTotal / ordersTotal) : 0,
      ad_spend: round2_(adSpend), chats_ads: g.chats_ads, chats_admin: g.chats_admin, cost_per_chat: costPerChat,
      sales_total: round2_(salesTotal), sales_new: round2_(salesNew), sales_old: round2_(salesOld),
      orders_total: round2_(ordersTotal), orders_new: round2_(ordersNew), orders_old: round2_(ordersOld),
      close_rate_new: closeRateNew, ads_pct: salesTotal ? round2_(adSpend / salesTotal * 100) : 0,
      roas_new: roasNew, roas_total: roasTotal, error_pct: errorPct
    };
  });
  result.sort(function (a, b) { return b.sales_total - a.sales_total; });

  try {
    var statusBatch = await getKpiStatusBatch_(env, result.map(function (r) { return r.admin; }), start, end);
    result.forEach(function (r) { r.kpi_status = statusBatch[r.admin] || null; });
  } catch (batchErr) {
    result.forEach(function (r) { r.kpi_status = null; });
  }

  var dailySeries = null;
  if (byDate) {
    var filterUnits = byAdmin[adminFilter] ? Object.keys(byAdmin[adminFilter].units) : [];
    var realDaily = null;
    filterUnits.forEach(function (u) {
      var d2 = personalAgg.byAdminDaily[u + '|' + adminNick_(adminFilter)];
      if (!d2) return;
      if (!realDaily) realDaily = {};
      Object.keys(d2).forEach(function (dk) { realDaily[dk] = (realDaily[dk] || 0) + d2[dk]; });
    });
    var sourceDaily = (realDaily && Object.keys(realDaily).length) ? realDaily : byDate;
    dailySeries = Object.keys(sourceDaily).sort().map(function (dk) { return { date: dk, sales_total: round2_(sourceDaily[dk]) }; });
  }

  var kpi = null;
  if (adminFilter) {
    try { kpi = await getAdminKpi_(env, adminFilter, start, end); }
    catch (kpiErr) { kpi = { found: false, reason: 'โหลดข้อมูล KPI ไม่สำเร็จ: ' + kpiErr.message }; }
  }

  return { rows: result, daily: dailySeries, kpi: kpi, start: start, end: end };
}

// ============================================================
// ---------- HTTP handler ----------
// ============================================================
export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers });

    var p = Object.fromEntries(url.searchParams.entries());
    if (p.token !== TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
    }

    // ครอบทั้งก้อนด้วย try เดียว (รวมการอ่าน KV cache ด้วย) กัน exception ที่ไม่คาดคิดหลุดออกไปเป็นหน้า
    // "Error 1101" เปล่าๆ ของ Cloudflare (ไม่มี CORS header, ไม่ใช่ JSON) — อยากให้ error ทุกกรณีย้อนกลับมา
    // เป็น JSON {error:...} เหมือน pagestats-appsscript.gs เดิมเสมอ ไม่ว่าจะพังตรงไหนก็ตาม
    var cacheKey = null, cacheTtl = 0, out;
    try {
      if (p.mode === 'units') { cacheKey = 'resp:v1:units'; cacheTtl = TTL_UNITS; }
      else if (p.mode === 'admin_units') { cacheKey = 'resp:v1:admin_units'; cacheTtl = TTL_UNITS; }
      else if (p.mode === 'admin_stats') { cacheKey = 'resp:v1:admin_stats:' + (p.start || '') + '|' + (p.end || '') + '|' + (p.unit || '') + '|' + (p.admin || ''); cacheTtl = TTL_RESULT; }
      else if (p.mode !== 'da_debug' && p.mode !== 'env_debug') { cacheKey = 'resp:v1:page_stats:' + (p.start || '') + '|' + (p.end || '') + '|' + (p.unit || ''); cacheTtl = TTL_RESULT; }

      if (cacheKey) {
        var cached = await env.GLORY_KV.get(cacheKey);
        if (cached) {
          var resp = new Response(cached, { headers });
          resp.headers.set('X-Cache', 'HIT');
          return resp;
        }
      }

      if (p.mode === 'units') {
        out = await getPageUnits_(env);
      } else if (p.mode === 'admin_units') {
        out = await getAdminUnits_(env);
      } else if (p.mode === 'admin_stats') {
        if (!p.start || !p.end) throw new Error('missing start/end');
        out = await getAdminStats_(env, p.start, p.end, p.unit || '', p.admin || '');
      } else if (p.mode === 'da_debug') {
        if (!p.admin || !p.month) throw new Error('missing admin/month (เช่น admin=ใบพลู (ปิยกรณ์)&month=2026-08)');
        out = await getDaDebugRows_(env, p.admin, p.month);
      } else if (p.mode === 'env_debug') {
        // ดีบั๊กชั่วคราว: เช็คว่า secret GOOGLE_PRIVATE_KEY ที่เก็บไว้จริงยาว/ตัดหัวท้ายแล้วถูกต้องไหม
        // ไม่โชว์เนื้อหาจริงเลยแม้แต่ตัวเดียว (เอาแค่ 6 ตัวแรก/ท้ายของ "ค่าดิบ" พอเดาไม่ได้ว่า key จริงคืออะไร)
        var raw = env.GOOGLE_PRIVATE_KEY || '';
        var cleaned = raw.replace(/-----[A-Z ]+-----/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
        out = {
          has_secret: !!raw,
          raw_length: raw.length,
          raw_line_count: raw.split('\n').length,
          raw_has_literal_backslash_n: raw.indexOf('\\n') >= 0,
          cleaned_length: cleaned.length,
          cleaned_length_mod4: cleaned.length % 4,
          raw_head6: raw.slice(0, 6),
          raw_tail6: raw.slice(-6)
        };
      } else {
        if (!p.start || !p.end) throw new Error('missing start/end');
        out = await getPageStats_(env, p.start, p.end, p.unit || '');
      }
    } catch (err) {
      out = { error: (err && err.message) || String(err) };
    }

    var json = JSON.stringify(out);
    var respOut = new Response(json, { headers });
    respOut.headers.set('X-Cache', 'MISS');
    if (cacheKey && !(out && out.error)) {
      ctx.waitUntil(kvPutJson_(env, cacheKey, out, cacheTtl));
    }
    return respOut;
  }
};
