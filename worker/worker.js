// ============================================================
// PT Glory — glory-api Worker v2
// อ่าน Google Sheets โดยตรงผ่าน Service Account (ไม่ผ่าน Apps Script แล้ว)
// ถ้าการอ่านตรงล้มเหลว จะ fallback ไปเรียก Apps Script เดิมแทนอัตโนมัติ (กันเว็บล่ม)
// ============================================================

// ====== CONFIG ======
const SPREADSHEET_ID = '1W551Yhf3MWr2Z5-lG9s-m_m6pUrkxzISSijdwWerUQc';
const SHEET_THIS = 'data69';
const SHEET_LAST = 'data68';
const YEAR_THIS = '2569', YEAR_LAST = '2568';
const GOOGLE_CLIENT_EMAIL = 'glory-sheets-reader-456@ptglory-dashboard-sales-fb.iam.gserviceaccount.com';

// Staging Sheet รายเพจ (เขียนโดย etl/sync_pages.py) — ใช้สำหรับ action=pages
const PAGES_SHEET_ID = '1Jd5jsYoslIpbOtZwQ-skrXir7DIIY1xmRq9jH7htskk';
const PAGES_SHEET_TAB = 'staging_รายเพจ';

// fallback เดิม (ใช้เฉพาะตอนอ่าน Sheets API โดยตรงพัง)
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwn9JTGFYlOpIbFGKnB7N4SZ7kYRzwY9UbgkOE-MemS5g66F7VKq2aRfa9BbW-j80uSJg/exec';
const APPS_SCRIPT_TOKEN = 'ptglory_x9k2z7';

const TOKEN = 'ptglory_x9k2z7'; // token ฝั่ง client (index.html) — คนละตัวกับ Google
const FRESH_TTL = 300;
const STALE_MAX_AGE = 86400;

var COLS = {
  date:['วันที่'], sales:['ยอดรวม'], sales_new:['ยอดลคม.'], sales_old:['ยอดลคก.'],
  close_rate:['%ปิด'], roas_new:['ROAS ใหม่'], roas_old:['ROAS เก่า'], aov:['เปอร์บิล'],
  cost_inbox:['ต้นทุนทัก'], profit:['กำไร'], ad:['ค่า Ads','ค่าAds'],
  target_d:['เป้ายอด/d'], target_m:['เป้ายอด/M'], unit:['Unit'],
  inbox_new:['คนทักใหม่','ทักใหม่','คนทัก','จำนวนทัก'],
  comments:['คอมเมนต์','คอมเม้นท์','คอมเม้น','คอมเมนท์','comment','คอม'],
  orders_new:['ออเดอร์ใหม่','ออเดอรใหม่','จำนวนออเดอร์ใหม่','ออเดอร์ลูกค้าใหม่','ออเดอร์ลค.ใหม่'],
  orders_old:['ออเดอร์เก่า','ออเดอรเก่า','จำนวนออเดอร์เก่า','ออเดอร์ลูกค้าเก่า','ออเดอร์ลค.เก่า'],
  orders_total:['ออเดอร์รวม','ออเดอรรวม','จำนวนออเดอร์รวม','ออเดอร์ทั้งหมด','ออเดอร์'],
  cust_new:['จำนวนลูกค้าใหม่','ลูกค้าใหม่(คน)','ลูกค้าใหม่ (คน)','จำนวนลค.ใหม่','ลค.ใหม่(คน)','คนใหม่','จำนวนลูกค้าใหม่(คน)'],
  cust_old:['จำนวนลูกค้าเก่า','ลูกค้าเก่า(คน)','ลูกค้าเก่า (คน)','จำนวนลค.เก่า','ลค.เก่า(คน)','คนเก่า','จำนวนลูกค้าเก่า(คน)']
};
var ADD   = ['sales','sales_new','sales_old','profit','ad', 'target_d', 'inbox_new','comments','orders_new','orders_old','orders_total','cust_new','cust_old'];
var RATIO = ['close_rate','roas_new','roas_old','aov','cost_inbox','target_m'];
var TH_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

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

// อ่านค่าจากสเปรดชีตใดก็ได้ (ระบุ spreadsheetId เอง) — ใช้ทั้งกับ SPREADSHEET_ID หลัก และ PAGES_SHEET_ID
async function fetchValuesFrom_(env, spreadsheetId, sheetName) {
  var token = await getAccessToken(env);
  var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' +
    encodeURIComponent(sheetName) + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
  var resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var data = await resp.json();
  if (!resp.ok) throw new Error('Sheets API error (' + sheetName + '): ' + JSON.stringify(data));
  return data.values || [];
}
async function fetchSheetValues(env, sheetName) {
  return fetchValuesFrom_(env, SPREADSHEET_ID, sheetName);
}

// ============================================================
// ---------- helpers (พอร์ตมาจาก Code.gs ตรงๆ) ----------
// ============================================================
function normKey_(s) { return String(s).replace(/\s+/g, '').toLowerCase(); }
function isTestUnit_(u) { return /^test/i.test(String(u == null ? '' : u).trim()); }
function addN_(a, v) { return v == null ? a : ((a == null ? 0 : a) + v); }

function resolveCols_(header) {
  var nmap = {};
  header.forEach(function (h) { if (nmap[normKey_(h)] === undefined) nmap[normKey_(h)] = h; });
  var found = {};
  Object.keys(COLS).forEach(function (key) {
    COLS[key].some(function (a) {
      var n = normKey_(a);
      if (nmap[n] !== undefined) { found[key] = nmap[n]; return true; }
      return false;
    });
  });
  return found;
}

function num_(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v == null) return null;
  var n = parseFloat(String(v).replace(/[,\s฿%]/g, ''));
  return isNaN(n) ? null : n;
}

// แปลงเลข serial ของ Google Sheets (epoch 1899-12-30) เป็น JS Date
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

// "วันนี้" ตามเวลาไทย (UTC+7) — Workers รันเป็น UTC เสมอ ต้องชดเชยเองเพื่อไม่ให้วันที่คลาดช่วงเที่ยงคืน-ตี 7
function todayBangkok_() {
  var now = new Date();
  var bkk = new Date(now.getTime() + 7 * 3600 * 1000);
  return new Date(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate());
}

var _rowsCache_ = {}; // แคชผลอ่านชีตต่อ 1 request (ไม่ข้าม request อื่น)
async function readSheet_(env, name) {
  if (_rowsCache_[name]) return _rowsCache_[name];
  var values = await fetchSheetValues(env, name);
  if (values.length < 2) { _rowsCache_[name] = []; return []; }
  var header = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  var cmap = resolveCols_(header);
  var pos = {};
  header.forEach(function (h, i) { if (pos[h] === undefined) pos[h] = i; });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], o = {};
    Object.keys(cmap).forEach(function (key) { o[key] = row[pos[cmap[key]]]; });
    var d = parseDate_(o.date);
    if (!d) continue;
    o._date = d;
    rows.push(o);
  }
  _rowsCache_[name] = rows;
  return rows;
}

// ---------- Staging Sheet รายเพจ (etl/sync_pages.py) — header ตรงกับชื่อ field อยู่แล้ว ไม่ต้อง resolveCols_ ----------
var PAGES_NUMERIC_FIELDS = [
  'ad_spend', 'chats_ads', 'chats_admin', 'cost_per_chat',
  'sales_total', 'sales_new', 'sales_old',
  'orders_total', 'orders_new', 'orders_old',
  'close_rate_new', 'ads_pct', 'roas_new', 'roas_total', 'error_pct'
];
var _pagesRowsCache_ = null;
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

function key_(d) { return fmtYMD_(d); }
function mdKey_(d) { return (d.getMonth() + 1) + '-' + d.getDate(); }

function aggregate_(rows) {
  var byDay = {};
  rows.forEach(function (o) {
    var k = key_(o._date);
    if (!byDay[k]) { byDay[k] = { date: o._date, add: {}, rsum: {}, rn: {} }; }
    var b = byDay[k];
    ADD.forEach(function (c) { var x = num_(o[c]); if (x != null) b.add[c] = (b.add[c] || 0) + x; });
    RATIO.forEach(function (c) {
      var x = num_(o[c]);
      if (x == null) return;
      if ((c === 'close_rate' || c === 'aov') && x === 0) return;
      b.rsum[c] = (b.rsum[c] || 0) + x; b.rn[c] = (b.rn[c] || 0) + 1;
    });
  });
  var arr = Object.keys(byDay).map(function (k) {
    var b = byDay[k], rec = { key: k, date: b.date };
    ADD.forEach(function (c) { rec[c] = (c in b.add) ? b.add[c] : null; });
    RATIO.forEach(function (c) { rec[c] = (c in b.rsum) ? b.rsum[c] / b.rn[c] : null; });
    return rec;
  });
  arr.sort(function (a, b) { return a.date - b.date; });
  return arr;
}

function thDate_(d) { return d.getDate() + ' ' + TH_MONTHS[d.getMonth()] + ' ' + (d.getFullYear() + 543); }
function pctYoY_(cur, pr) { return (pr && cur != null) ? (cur - pr) / pr * 100 : null; }

// ============================================================
// ---------- getDashboardData / getMonthlyData / getRangeData ----------
// (พอร์ตมาจาก Code.gs เกือบทั้งหมด แค่เปลี่ยนแหล่งอ่านข้อมูล + การจัดรูปแบบวันที่/เวลา)
// ============================================================
async function getDashboardData(env, dateStr, unit) {
  var rows69 = await readSheet_(env, SHEET_THIS), rows68 = await readSheet_(env, SHEET_LAST);
  if (!rows69.length) return { error: 'อ่านข้อมูล data69 ไม่ได้ — ตรวจ SPREADSHEET_ID/สิทธิ์การแชร์' };

  var units = [], testUnits = [];
  rows69.forEach(function (o) {
    var u = o.unit ? String(o.unit).trim() : '';
    if (!u) return;
    if (isTestUnit_(u)) { if (testUnits.indexOf(u) < 0) testUnits.push(u); }
    else if (units.indexOf(u) < 0) units.push(u);
  });

  var testRows69 = rows69.filter(function (o) { return isTestUnit_(o.unit); });

  if (unit && unit !== 'ทั้งหมด') {
    rows69 = rows69.filter(function (o) { return String(o.unit).trim() === unit; });
    rows68 = rows68.filter(function (o) { return String(o.unit).trim() === unit; });
    testRows69 = [];
  } else {
    rows69 = rows69.filter(function (o) { return !isTestUnit_(o.unit); });
    rows68 = rows68.filter(function (o) { return !isTestUnit_(o.unit); });
  }

  var a69 = aggregate_(rows69), a68 = aggregate_(rows68);
  if (!a69.length) return { error: 'ไม่พบข้อมูลรายวันของ unit นี้' };

  var aTest = aggregate_(testRows69);
  var testMap = {}; aTest.forEach(function (r) { testMap[r.key] = r; });

  var a68Map = {};
  a68.forEach(function (r) { a68Map[mdKey_(r.date)] = r; });

  var mx = 0;
  a69.forEach(function (r) { if (r.close_rate != null) mx = Math.max(mx, Math.abs(r.close_rate)); });
  if (mx > 0 && mx <= 1.5) {
    a69.forEach(function (r) { if (r.close_rate != null) r.close_rate *= 100; });
    a68.forEach(function (r) { if (r.close_rate != null) r.close_rate *= 100; });
  }

  var sel = a69[a69.length - 1];
  if (dateStr) { a69.forEach(function (r) { if (r.key === dateStr) sel = r; }); }

  var prev = a68Map[mdKey_(sel.date)] || null;

  var mtd = 0, targetM = 0;
  var selMonth = sel.date.getMonth();

  var testDay = (testMap[sel.key] && testMap[sel.key].sales != null) ? testMap[sel.key].sales : null;
  var testMtd = 0, hasTest = false;
  aTest.forEach(function (r) {
    if (r.date.getMonth() === selMonth && r.date <= sel.date && r.sales != null) { testMtd += r.sales; hasTest = true; }
  });

  a69.forEach(function (r) {
    if (r.date.getMonth() === selMonth) {
      if (r.date <= sel.date && r.sales != null) mtd += r.sales;
      if (r.target_d != null) targetM += r.target_d;
    }
  });

  var upto = a69.filter(function (r) { return r.date <= sel.date; });
  var win = upto.slice(-14);
  var labels = [], sSales = [], sTarget = [], sLast = [];
  win.forEach(function (r) {
    labels.push(r.date.getDate() + '/' + (r.date.getMonth() + 1));
    sSales.push(r.sales); sTarget.push(r.target_d);
    var p = a68Map[mdKey_(r.date)];
    sLast.push(p ? p.sales : null);
  });

  var w7 = upto.slice(-7), paLabels = [], paProfit = [], paAd = [];
  w7.forEach(function (r) { paLabels.push(r.date.getDate() + '/' + (r.date.getMonth() + 1)); paProfit.push(r.profit); paAd.push(r.ad); });

  var table = w7.slice().reverse().map(function (r) {
    var p = a68Map[mdKey_(r.date)];
    var prevSales = p ? p.sales : null;
    var yoy = (prevSales && r.sales != null) ? (r.sales - prevSales) / prevSales * 100 : null;
    var ach = (r.target_d && r.sales != null) ? r.sales / r.target_d * 100 : null;
    return {
      date: r.date.getDate() + '/' + (r.date.getMonth() + 1),
      sales: r.sales, target: r.target_d, ach: ach,
      profit: r.profit, roas: r.roas_new,
      roasAll: (r.ad && r.sales != null) ? r.sales / r.ad : null,
      yoy: yoy
    };
  });

  var udMap = {};
  rows69.forEach(function (o) {
    if (key_(o._date) !== sel.key) return;
    var u = (o.unit != null ? String(o.unit).trim() : '') || '(ไม่ระบุ)';
    if (!udMap[u]) udMap[u] = { sales: 0, target: 0, ad: 0, profit: 0, newC: 0, oldC: 0 };
    var s = num_(o.sales); if (s != null) udMap[u].sales += s;
    var t = num_(o.target_d); if (t != null) udMap[u].target += t;
    var ad = num_(o.ad); if (ad != null) udMap[u].ad += ad;
    var pf = num_(o.profit); if (pf != null) udMap[u].profit += pf;
    var nc = num_(o.sales_new); if (nc != null) udMap[u].newC += nc;
    var oc = num_(o.sales_old); if (oc != null) udMap[u].oldC += oc;
  });
  var unitBreakdown = Object.keys(udMap).map(function (u) {
    var x = udMap[u];
    return { unit: u, sales: x.sales, target: x.target, ad: x.ad, profit: x.profit, newC: x.newC, oldC: x.oldC };
  }).sort(function (a, b) { return b.sales - a.sales; });

  return {
    meta: {
      dateLabel: thDate_(sel.date),
      prevLabel: prev ? thDate_(prev.date) : null,
      selected: sel.key,
      minDate: a69[0].key,
      maxDate: a69[a69.length - 1].key,
      units: units, testUnits: testUnits,
      updated: fmtHM_(todayBangkok_()),
      yearThis: YEAR_THIS, yearLast: YEAR_LAST
    },
    kpi: {
      sales: sel.sales, salesPrev: prev ? prev.sales : null, salesYoY: pctYoY_(sel.sales, prev ? prev.sales : null),
      targetD: sel.target_d, achD: (sel.target_d && sel.sales != null) ? sel.sales / sel.target_d * 100 : null,
      profit: sel.profit, profitYoY: pctYoY_(sel.profit, prev ? prev.profit : null),
      margin: (sel.profit != null && sel.sales) ? sel.profit / sel.sales * 100 : null,
      mtd: mtd, targetM: targetM,
      mtdRatio: targetM ? mtd / targetM * 100 : null,
      testSales: testDay, testMtd: hasTest ? testMtd : null,
      ad: sel.ad, adYoY: pctYoY_(sel.ad, prev ? prev.ad : null),
      roasNew: sel.roas_new, roasOld: sel.roas_old,
      roasAll: (sel.ad && sel.sales != null) ? sel.sales / sel.ad : null,
      closeRate: sel.close_rate, closePrev: prev ? prev.close_rate : null,
      aov: sel.aov, aovYoY: pctYoY_(sel.aov, prev ? prev.aov : null),
      costInbox: sel.cost_inbox, costYoY: pctYoY_(sel.cost_inbox, prev ? prev.cost_inbox : null)
    },
    series: { labels: labels, sales: sSales, target: sTarget, last: sLast },
    pa: { labels: paLabels, profit: paProfit, ad: paAd },
    newOld: { newVal: sel.sales_new, oldVal: sel.sales_old },
    unitBreakdown: unitBreakdown,
    table: table
  };
}

function monthlyAgg_(arr, capDate) {
  var n = 12, sumS = [], sumA = [], sumP = [], sumN = [], sumO = [], tM = [],
      crSum = [], crN = [], aoSum = [], aoN = [], otSum = [], onSum = [], ooSum = [], ibSum = [], ciSum = [], ciN = [],
      cnSum = [], coSum = [];
  for (var i = 0; i < n; i++) {
    sumS[i] = sumA[i] = sumP[i] = sumN[i] = sumO[i] = tM[i] = otSum[i] = onSum[i] = ooSum[i] = ibSum[i] = cnSum[i] = coSum[i] = null;
    crSum[i] = crN[i] = aoSum[i] = aoN[i] = ciSum[i] = ciN[i] = 0;
  }
  function add(a, v) { return v == null ? a : (a == null ? v : a + v); }
  arr.forEach(function (r) {
    var m = r.date.getMonth();
    sumS[m] = add(sumS[m], r.sales); sumA[m] = add(sumA[m], r.ad); sumP[m] = add(sumP[m], r.profit);
    sumN[m] = add(sumN[m], r.sales_new); sumO[m] = add(sumO[m], r.sales_old);
    otSum[m] = add(otSum[m], r.orders_total); onSum[m] = add(onSum[m], r.orders_new); ooSum[m] = add(ooSum[m], r.orders_old); ibSum[m] = add(ibSum[m], r.inbox_new);
    cnSum[m] = add(cnSum[m], r.cust_new); coSum[m] = add(coSum[m], r.cust_old);
    tM[m] = add(tM[m], r.target_d);
    var afterToday = capDate && r.date > capDate;
    if (!afterToday && r.close_rate != null && r.close_rate > 0) { crSum[m] += r.close_rate; crN[m]++; }
    if (!afterToday && r.aov != null && r.aov > 0) { aoSum[m] += r.aov; aoN[m]++; }
    if (!afterToday && r.cost_inbox != null && r.cost_inbox > 0) { ciSum[m] += r.cost_inbox; ciN[m]++; }
  });
  var roas = [], closeR = [], aov = [], orders = [], ordersN = [], ordersO = [], inbox = [],
      repeatPct = [], adPct = [], margin = [], costNew = [], costInbox = [], closeNew = [],
      custNew = [], custOld = [];
  for (var i = 0; i < n; i++) {
    roas[i] = (sumA[i] && sumS[i] != null) ? sumS[i] / sumA[i] : null;
    closeR[i] = crN[i] ? crSum[i] / crN[i] : null;
    var oSplit = (onSum[i] != null || ooSum[i] != null) ? ((onSum[i] || 0) + (ooSum[i] || 0)) : null;
    orders[i] = otSum[i] != null ? otSum[i] : (oSplit != null ? oSplit : null);
    ordersN[i] = onSum[i]; ordersO[i] = ooSum[i]; inbox[i] = ibSum[i]; custNew[i] = cnSum[i]; custOld[i] = coSum[i];
    if (onSum[i] != null && ooSum[i] != null && ((onSum[i]||0)+(ooSum[i]||0)) > 0) {
      repeatPct[i] = (ooSum[i] || 0) / ((onSum[i]||0)+(ooSum[i]||0)) * 100;
    } else if (cnSum[i] != null && coSum[i] != null && ((cnSum[i]||0)+(coSum[i]||0)) > 0) {
      repeatPct[i] = (coSum[i] || 0) / ((cnSum[i]||0)+(coSum[i]||0)) * 100;
    } else {
      var totCust = (sumN[i] || 0) + (sumO[i] || 0);
      repeatPct[i] = totCust ? sumO[i] / totCust * 100 : null;
    }
    adPct[i] = sumS[i] ? sumA[i] / sumS[i] * 100 : null;
    margin[i] = sumS[i] ? sumP[i] / sumS[i] * 100 : null;
    costNew[i] = cnSum[i] ? sumA[i] / cnSum[i] : (onSum[i] ? sumA[i] / onSum[i] : null);
    aov[i] = onSum[i] ? sumN[i] / onSum[i] : (aoN[i] ? aoSum[i] / aoN[i] : null);
    costInbox[i] = ibSum[i] ? sumA[i] / ibSum[i] : (ciN[i] ? ciSum[i] / ciN[i] : null);
    var cn = ibSum[i] ? onSum[i] / ibSum[i] * 100 : (crN[i] ? crSum[i] / crN[i] : null);
    if (cn != null && Math.abs(cn) <= 1.5) cn *= 100;
    closeNew[i] = cn;
  }
  return { sales: sumS, profit: sumP, ad: sumA, newC: sumN, oldC: sumO,
           targetM: tM, roas: roas, closeRate: closeR, aov: aov,
           orders: orders, ordersN: ordersN, ordersO: ordersO, inbox: inbox, repeatPct: repeatPct,
           adPct: adPct, margin: margin, roasAll: roas, costNew: costNew,
           costInbox: costInbox, closeNew: closeNew, custNew: custNew, custOld: custOld };
}

async function getMonthlyData(env, unit) {
  var rows69 = await readSheet_(env, SHEET_THIS), rows68 = await readSheet_(env, SHEET_LAST);
  if (!rows69.length) return { error: 'อ่านข้อมูล data69 ไม่ได้ — ตรวจ SPREADSHEET_ID/สิทธิ์การแชร์' };

  var units = [], testUnits = [];
  rows69.forEach(function (o) {
    var u = o.unit ? String(o.unit).trim() : '';
    if (!u) return;
    if (isTestUnit_(u)) { if (testUnits.indexOf(u) < 0) testUnits.push(u); }
    else if (units.indexOf(u) < 0) units.push(u);
  });

  var testRows69 = rows69.filter(function (o) { return isTestUnit_(o.unit); });
  var yearRows = rows69.filter(function (o) { return !isTestUnit_(o.unit); });

  if (unit && unit !== 'ทั้งหมด') {
    rows69 = rows69.filter(function (o) { return String(o.unit).trim() === unit; });
    rows68 = rows68.filter(function (o) { return String(o.unit).trim() === unit; });
    testRows69 = [];
  } else {
    rows69 = rows69.filter(function (o) { return !isTestUnit_(o.unit); });
    rows68 = rows68.filter(function (o) { return !isTestUnit_(o.unit); });
  }

  var a69 = aggregate_(rows69), a68 = aggregate_(rows68);
  var mx = 0;
  a69.forEach(function (r) { if (r.close_rate != null) mx = Math.max(mx, Math.abs(r.close_rate)); });
  if (mx > 0 && mx <= 1.5) {
    a69.forEach(function (r) { if (r.close_rate != null) r.close_rate *= 100; });
    a68.forEach(function (r) { if (r.close_rate != null) r.close_rate *= 100; });
  }

  var today = todayBangkok_();
  var M = monthlyAgg_(a69, today), L = monthlyAgg_(a68);

  var aTest = aggregate_(testRows69);
  var testSalesM = []; for (var ti = 0; ti < 12; ti++) testSalesM[ti] = null;
  aTest.forEach(function (r) {
    if (r.sales != null) { var mm = r.date.getMonth(); testSalesM[mm] = (testSalesM[mm] == null ? 0 : testSalesM[mm]) + r.sales; }
  });
  M.testSales = testSalesM;

  var cumThis = [], cumTarget = [], cumLast = [], runT = 0, runTg = 0, runL = 0, latest = -1, runTgHas = false;
  for (var i = 0; i < 12; i++) {
    if (M.sales[i] != null) { runT += M.sales[i]; cumThis.push(runT); latest = i; } else cumThis.push(null);
    if (M.targetM[i] != null) { runTg += M.targetM[i]; runTgHas = true; }
    cumTarget.push(runTgHas ? runTg : null);
    if (L.sales[i] != null) { runL += L.sales[i]; cumLast.push(runL); } else cumLast.push(null);
  }

  var um = {};
  rows69.forEach(function (o) {
    var m = o._date.getMonth();
    var u = (o.unit != null ? String(o.unit).trim() : '') || '(ไม่ระบุ)';
    if (!um[u]) { um[u] = { sales: [], target: [], ad: [], profit: [], newC: [], oldC: [] }; for (var z = 0; z < 12; z++) { um[u].sales[z] = 0; um[u].target[z] = 0; um[u].ad[z] = 0; um[u].profit[z] = 0; um[u].newC[z] = 0; um[u].oldC[z] = 0; } }
    var s = num_(o.sales); if (s != null) um[u].sales[m] += s;
    var t = num_(o.target_d); if (t != null) um[u].target[m] += t;
    var ad = num_(o.ad); if (ad != null) um[u].ad[m] += ad;
    var pf = num_(o.profit); if (pf != null) um[u].profit[m] += pf;
    var nc = num_(o.sales_new); if (nc != null) um[u].newC[m] += nc;
    var oc = num_(o.sales_old); if (oc != null) um[u].oldC[m] += oc;
  });
  var unitMonthly = Object.keys(um).map(function (u) { var x = um[u]; return { unit: u, sales: x.sales, target: x.target, ad: x.ad, profit: x.profit, newC: x.newC, oldC: x.oldC }; });

  var yMap = {};
  yearRows.forEach(function (o) {
    var u = (o.unit != null ? String(o.unit).trim() : '') || '(ไม่ระบุ)';
    if (!yMap[u]) yMap[u] = { unit:u, sales:0, target:0, ad:0, profit:0, newC:0, oldC:0,
                              ordersT:null, ordersN:null, ordersO:null, inbox:null, custNew:null, custOld:null, ci_s:0, ci_n:0, ao_s:0, ao_n:0, cr_s:0, cr_n:0 };
    var Y = yMap[u];
    var s=num_(o.sales), td=num_(o.target_d), ad=num_(o.ad), pf=num_(o.profit),
        sn=num_(o.sales_new), so=num_(o.sales_old), ot=num_(o.orders_total), od=num_(o.orders_new), oo=num_(o.orders_old),
        ib=num_(o.inbox_new), ci=num_(o.cost_inbox), ao=num_(o.aov), cr=num_(o.close_rate),
        cnw=num_(o.cust_new), cow=num_(o.cust_old);
    if(s!=null)Y.sales+=s; if(td!=null)Y.target+=td; if(ad!=null)Y.ad+=ad; if(pf!=null)Y.profit+=pf;
    if(sn!=null)Y.newC+=sn; if(so!=null)Y.oldC+=so;
    Y.ordersT=addN_(Y.ordersT,ot); Y.ordersN=addN_(Y.ordersN,od); Y.ordersO=addN_(Y.ordersO,oo); Y.inbox=addN_(Y.inbox,ib);
    Y.custNew=addN_(Y.custNew,cnw); Y.custOld=addN_(Y.custOld,cow);
    if(ci!=null&&ci!==0){Y.ci_s+=ci;Y.ci_n++;} if(ao!=null&&ao!==0){Y.ao_s+=ao;Y.ao_n++;} if(cr!=null&&cr!==0){Y.cr_s+=cr;Y.cr_n++;}
  });
  var unitYear = Object.keys(yMap).map(function(u){ return yMap[u]; }).sort(function(a,b){return b.sales-a.sales;});
  unitYear.forEach(function(r){
    var oSum=(r.ordersN||0)+(r.ordersO||0), cSum=(r.custNew||0)+(r.custOld||0);
    r.orders    = r.ordersT!=null ? r.ordersT : ((r.ordersN!=null||r.ordersO!=null) ? oSum : null);
    r.repeatPct = (r.ordersN!=null&&r.ordersO!=null&&oSum>0) ? r.ordersO/oSum*100
                : (r.custNew!=null&&r.custOld!=null&&cSum>0) ? r.custOld/cSum*100
                : (((r.newC||0)+(r.oldC||0)) ? r.oldC/((r.newC||0)+(r.oldC||0))*100 : null);
    r.adPct     = r.sales ? r.ad/r.sales*100 : null;
    r.margin    = r.sales ? r.profit/r.sales*100 : null;
    r.roasAll   = r.ad ? r.sales/r.ad : null;
    r.roasNew   = r.ad ? r.newC/r.ad : null;
    r.costNew   = r.custNew ? r.ad/r.custNew : (r.ordersN ? r.ad/r.ordersN : null);
    r.aov       = r.ordersN ? r.newC/r.ordersN : (r.ao_n ? r.ao_s/r.ao_n : null);
    r.costInbox = r.inbox ? r.ad/r.inbox : (r.ci_n ? r.ci_s/r.ci_n : null);
    var cn = r.inbox ? r.ordersN/r.inbox*100 : (r.cr_n ? r.cr_s/r.cr_n : null);
    if (cn != null && Math.abs(cn) <= 1.5) cn *= 100;
    r.closeNew  = cn;
  });

  return {
    meta: { units: units, testUnits: testUnits, yearThis: YEAR_THIS, yearLast: YEAR_LAST, latest: latest, updated: fmtHM_(todayBangkok_()) },
    labels: TH_MONTHS,
    cur: M,
    last: { sales: L.sales, profit: L.profit, ad: L.ad },
    cum: { sales: cumThis, target: cumTarget, last: cumLast },
    unitMonthly: unitMonthly,
    unitYear: unitYear
  };
}

async function getRangeData(env, startStr, endStr, unit) {
  var rows69 = await readSheet_(env, SHEET_THIS);
  if (!rows69.length) return { error: 'อ่านข้อมูล data69 ไม่ได้ — ตรวจ SPREADSHEET_ID/สิทธิ์การแชร์' };

  var units = [], testUnits = [];
  rows69.forEach(function (o) {
    var u = o.unit ? String(o.unit).trim() : '';
    if (!u) return;
    if (isTestUnit_(u)) { if (testUnits.indexOf(u) < 0) testUnits.push(u); }
    else if (units.indexOf(u) < 0) units.push(u);
  });
  if (unit && unit !== 'ทั้งหมด') rows69 = rows69.filter(function (o) { return String(o.unit).trim() === unit; });
  else rows69 = rows69.filter(function (o) { return !isTestUnit_(o.unit); });

  function pd(s){ var p = String(s).split('-'); return new Date(+p[0], +p[1]-1, +p[2]); }
  var start = pd(startStr), end = pd(endStr);
  if (end < start) { var t = start; start = end; end = t; }
  var DAY = 86400000;
  var lenDays = Math.round((end - start) / DAY) + 1;
  var prevEnd = new Date(start.getTime() - DAY);
  var prevStart = new Date(prevEnd.getTime() - (lenDays - 1) * DAY);

  function blank(){ return { ad:null, inbox_new:null, comments:null, sales:null, sales_new:null, sales_old:null, profit:null, orders_new:null,
                             ci_s:0, ci_n:0, cr_s:0, cr_n:0, ao_s:0, ao_n:0, target_d:null }; }
  function addF(acc, key, v){ if (v != null) acc[key] = (acc[key]||0) + v; }
  var cur = blank(), prev = blank();
  var byDay = {};
  var uMap = {};
  var unitDayProfit = {};

  rows69.forEach(function (o) {
    var d = o._date, k = key_(d);
    var inCur = (d >= start && d <= end), inPrev = (d >= prevStart && d <= prevEnd);
    var s = num_(o.sales), sn = num_(o.sales_new), so = num_(o.sales_old), pf = num_(o.profit),
        ad = num_(o.ad), td = num_(o.target_d), ib = num_(o.inbox_new), cm = num_(o.comments), od = num_(o.orders_new),
        oo = num_(o.orders_old),
        ot = num_(o.orders_total), ci = num_(o.cost_inbox), cr = num_(o.close_rate), ao = num_(o.aov),
        cnw = num_(o.cust_new), cow = num_(o.cust_old);

    if (d <= end && pf != null) {
      var u0 = (o.unit != null ? String(o.unit).trim() : '') || '(ไม่ระบุ)';
      if (!unitDayProfit[u0]) unitDayProfit[u0] = {};
      unitDayProfit[u0][k] = (unitDayProfit[u0][k] || 0) + pf;
    }

    if (inCur) {
      addF(cur,'sales',s); addF(cur,'sales_new',sn); addF(cur,'sales_old',so); addF(cur,'profit',pf);
      addF(cur,'ad',ad); addF(cur,'target_d',td); addF(cur,'inbox_new',ib); addF(cur,'comments',cm); addF(cur,'orders_new',od);
      if (ci != null && ci !== 0) { cur.ci_s += ci; cur.ci_n++; }
      if (cr != null && cr !== 0) { cur.cr_s += cr; cur.cr_n++; }
      if (ao != null && ao !== 0) { cur.ao_s += ao; cur.ao_n++; }
      if (!byDay[k]) byDay[k] = { date: d, sales: null, target: null };
      if (s != null) byDay[k].sales = (byDay[k].sales||0) + s;
      if (td != null) byDay[k].target = (byDay[k].target||0) + td;
      var u = (o.unit != null ? String(o.unit).trim() : '') || '(ไม่ระบุ)';
      if (!uMap[u]) uMap[u] = { unit:u, sales:0, target:0, ad:0, profit:0, newC:0, oldC:0,
                                ordersT:null, ordersN:null, ordersO:null, inbox:null, custNew:null, custOld:null, ci_s:0, ci_n:0, cr_s:0, cr_n:0, ao_s:0, ao_n:0 };
      var U = uMap[u];
      if (s!=null) U.sales+=s; if (td!=null) U.target+=td; if (ad!=null) U.ad+=ad;
      if (pf!=null) U.profit+=pf; if (sn!=null) U.newC+=sn; if (so!=null) U.oldC+=so;
      U.ordersT=addN_(U.ordersT,ot); U.ordersN=addN_(U.ordersN,od); U.ordersO=addN_(U.ordersO,oo); U.inbox=addN_(U.inbox,ib);
      U.custNew=addN_(U.custNew,cnw); U.custOld=addN_(U.custOld,cow);
      if (ci!=null && ci!==0){ U.ci_s+=ci; U.ci_n++; }
      if (cr!=null && cr!==0){ U.cr_s+=cr; U.cr_n++; }
      if (ao!=null && ao!==0){ U.ao_s+=ao; U.ao_n++; }
    } else if (inPrev) {
      addF(prev,'sales',s); addF(prev,'sales_new',sn); addF(prev,'profit',pf); addF(prev,'ad',ad);
      addF(prev,'inbox_new',ib); addF(prev,'comments',cm); addF(prev,'orders_new',od);
    }
  });

  var crAvg = cur.cr_n ? cur.cr_s / cur.cr_n : null;
  if (crAvg != null && Math.abs(crAvg) <= 1.5) crAvg *= 100;

  var sumS = cur.sales, sumAd = cur.ad, sumSN = cur.sales_new, sumIB = cur.inbox_new, sumOD = cur.orders_new;
  var totals = {
    ad: cur.ad, inbox_new: cur.inbox_new, comments: cur.comments,
    cost_inbox: (sumIB && sumAd != null) ? sumAd / sumIB : (cur.ci_n ? cur.ci_s / cur.ci_n : null),
    sales: cur.sales, sales_new: cur.sales_new, orders_new: cur.orders_new,
    close_new: (sumOD && sumIB) ? sumOD / sumIB * 100 : crAvg,
    aov_new: (sumOD && sumSN != null) ? sumSN / sumOD : (cur.ao_n ? cur.ao_s / cur.ao_n : null),
    ad_pct: (sumS) ? sumAd / sumS * 100 : null,
    roas_all: (sumAd) ? sumS / sumAd : null,
    roas_new: (sumAd && sumSN != null) ? sumSN / sumAd : null,
    profit: cur.profit, target: cur.target_d, sales_old: cur.sales_old
  };
  var pct = function (c, p) { return (p && c != null) ? (c - p) / p * 100 : null; };
  var deltas = {
    sales: pct(cur.sales, prev.sales), ad: pct(cur.ad, prev.ad), profit: pct(cur.profit, prev.profit),
    sales_new: pct(cur.sales_new, prev.sales_new),
    roas_all: (prev.ad && prev.sales != null && totals.roas_all != null) ? pct(totals.roas_all, prev.sales / prev.ad) : null
  };

  var unitBreakdown = Object.keys(uMap).map(function (u) { return uMap[u]; })
    .sort(function (a, b) { return b.sales - a.sales; });

  unitBreakdown.forEach(function (r) {
    var oSum=(r.ordersN||0)+(r.ordersO||0), cSum=(r.custNew||0)+(r.custOld||0);
    r.orders     = r.ordersT!=null ? r.ordersT : ((r.ordersN!=null||r.ordersO!=null) ? oSum : null);
    r.repeatPct  = (r.ordersN!=null&&r.ordersO!=null&&oSum>0) ? r.ordersO/oSum*100
                 : (r.custNew!=null&&r.custOld!=null&&cSum>0) ? r.custOld/cSum*100
                 : (((r.newC||0)+(r.oldC||0)) ? r.oldC/((r.newC||0)+(r.oldC||0))*100 : null);
    r.adPct      = r.sales ? r.ad / r.sales * 100 : null;
    r.margin     = r.sales ? r.profit / r.sales * 100 : null;
    r.roasAll    = r.ad ? r.sales / r.ad : null;
    r.roasNew    = r.ad ? r.newC / r.ad : null;
    r.costNew    = r.custNew ? r.ad / r.custNew : (r.ordersN ? r.ad / r.ordersN : null);
    r.aov        = r.ordersN ? r.newC / r.ordersN : (r.ao_n ? r.ao_s / r.ao_n : null);
    r.costInbox  = r.inbox ? r.ad / r.inbox : (r.ci_n ? r.ci_s / r.ci_n : null);
    var cn = r.inbox ? r.ordersN / r.inbox * 100 : (r.cr_n ? r.cr_s / r.cr_n : null);
    if (cn != null && Math.abs(cn) <= 1.5) cn *= 100;
    r.closeNew   = cn;
  });

  var lossStreaks = [], profitable = [], budgetRec = [];
  Object.keys(unitDayProfit).forEach(function (u) {
    var days = Object.keys(unitDayProfit[u]).sort();
    var streak = 0, lossSum = 0;
    for (var i = days.length - 1; i >= 0; i--) {
      if (unitDayProfit[u][days[i]] < 0) { streak++; lossSum += unitDayProfit[u][days[i]]; } else break;
    }
    if (streak >= 2) lossStreaks.push({ unit: u, days: streak, loss: lossSum });
  });
  lossStreaks.sort(function (a, b) { return a.loss - b.loss; });

  unitBreakdown.forEach(function (r) {
    var roas = r.ad ? r.sales / r.ad : null;
    var gba = (r.profit != null && r.ad != null) ? r.profit + r.ad : null;
    var be = (gba != null && gba > 0 && r.sales) ? r.sales / gba : null;
    if (r.profit != null && r.profit > 0) profitable.push({ unit: r.unit, profit: r.profit, roas: roas });
    var rec, why;
    if (r.profit != null && r.profit < 0) { rec = 'ลด/หยุดงบ'; why = 'ขาดทุน'; }
    else if (be != null && roas != null && roas >= be * 1.15 && r.profit > 0) { rec = 'เพิ่มงบได้'; why = 'กำไรดี ROAS สูงกว่าคุ้มทุนพอควร'; }
    else if (be != null && roas != null && roas < be) { rec = 'ลดงบ'; why = 'ROAS ต่ำกว่าคุ้มทุน'; }
    else { rec = 'คงงบ'; why = 'อยู่ระดับพอคุ้ม'; }
    budgetRec.push({ unit: r.unit, sales: r.sales, ad: r.ad, profit: r.profit, roas: roas, breakeven: be, rec: rec, why: why });
  });
  profitable.sort(function (a, b) { return b.profit - a.profit; });

  var dayArr = Object.keys(byDay).map(function (k) { return byDay[k]; }).sort(function (a, b) { return a.date - b.date; });
  var labels = [], sSales = [], sTarget = [];
  dayArr.forEach(function (r) { labels.push(r.date.getDate() + '/' + (r.date.getMonth() + 1)); sSales.push(r.sales); sTarget.push(r.target); });

  var minD = null, maxD = null;
  rows69.forEach(function (o) { var d = o._date; if (!minD || d < minD) minD = d; if (!maxD || d > maxD) maxD = d; });

  return {
    meta: {
      startLabel: thDate_(start), endLabel: thDate_(end), days: lenDays,
      prevLabel: thDate_(prevStart) + ' – ' + thDate_(prevEnd),
      minDate: minD ? key_(minD) : null, maxDate: maxD ? key_(maxD) : null, units: units, testUnits: testUnits,
      updated: fmtHM_(todayBangkok_())
    },
    totals: totals, deltas: deltas,
    newOld: { newVal: cur.sales_new, oldVal: cur.sales_old },
    unitBreakdown: unitBreakdown,
    series: { labels: labels, sales: sSales, target: sTarget },
    lossStreaks: lossStreaks, profitable: profitable, budgetRec: budgetRec
  };
}

// ============================================================
// ---------- getPagesData: action=pages&unit=Uxx ----------
// อ่านจาก Staging Sheet รายเพจ (เขียนโดย etl/sync_pages.py) — คนละไฟล์กับ data69/data68
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

// ============================================================
// ---------- fallback ไป Apps Script เดิม (เผื่ออ่าน Sheets API ตรงพัง) ----------
// ============================================================
async function fetchViaAppsScript(action, extraParams) {
  var p = new URLSearchParams(extraParams);
  p.set('action', action);
  p.set('token', APPS_SCRIPT_TOKEN);
  var resp = await fetch(APPS_SCRIPT_URL + '?' + p.toString(), { redirect: 'follow' });
  var text = await resp.text();
  return JSON.parse(text);
}

async function computeData(env, action, params) {
  try {
    if (action === 'daily') return await getDashboardData(env, params.date || null, params.unit || null);
    if (action === 'monthly') return await getMonthlyData(env, params.unit || null);
    if (action === 'range') return await getRangeData(env, params.start, params.end, params.unit || null);
    if (action === 'pages') return await getPagesData(env, params.unit || null); // ไม่มี fallback ไป Apps Script เดิม (ไม่รู้จัก action นี้)
    return { error: 'unknown action: ' + action };
  } catch (e) {
    if (action === 'pages') return { error: e.message };
    // อ่าน Sheets API ตรงพัง (เช่น key หมดอายุ/สิทธิ์หลุด) → fallback ไป Apps Script เดิมกันเว็บล่ม
    try {
      return await fetchViaAppsScript(action, params);
    } catch (e2) {
      return { error: 'อ่านข้อมูลไม่สำเร็จทั้งทางตรงและ fallback: ' + e.message + ' / ' + e2.message };
    }
  }
}

function canonicalKey(params) {
  var keys = Array.from(params.keys()).sort();
  return 'v1:' + keys.map(function (k) { return k + '=' + params.get(k); }).join('&');
}

async function warmOne(env, action, params) {
  var data = await computeData(env, action, params);
  var kvParams = new URLSearchParams(params);
  var kvKey = canonicalKey(kvParams);
  await env.GLORY_KV.put(kvKey, JSON.stringify({ data: JSON.stringify(data), ts: Date.now() }), { expirationTtl: STALE_MAX_AGE });
  return data;
}

// หมายเหตุ: Workers KV free tier เขียนได้แค่ 1,000 ครั้ง/วัน (ทั้งบัญชี ไม่ใช่ต่อ Worker)
// เดิมอุ่นทุก Unit ทุก 5 นาที ชนโควต้าเกินตั้งแต่กลางวัน — ตอนนี้อุ่นเฉพาะมุมมอง "ทั้งหมด" เท่านั้น
// (เร็วพอสำหรับ default view ที่ทุกคนเปิดเจอ) ส่วนมุมมองรายยูนิตปล่อยให้แคชแบบ on-demand ตอนมีคนเปิดจริง
// (เร็วอยู่แล้วเพราะตอนนี้อ่าน Google Sheets API ตรง ไม่ผ่าน Apps Script ที่ช้าแล้ว)
async function warmRecent(env) {
  _rowsCache_ = {};
  var today = todayBangkok_(), yest = new Date(today); yest.setDate(yest.getDate() - 1);
  var todayStr = fmtYMD_(today), yestStr = fmtYMD_(yest);

  await warmOne(env, 'monthly', { unit: '' });
  await warmOne(env, 'daily', { date: todayStr, unit: '' });
  await warmOne(env, 'daily', { date: yestStr, unit: '' });
  var rangeStart = fmtYMD_(new Date(today.getTime() - 6 * 86400000));
  await warmOne(env, 'range', { start: rangeStart, end: todayStr, unit: '' });
  // รวม 4 ครั้ง/รอบ — ตั้ง cron ทุก 10 นาที = 4×144 = 576 ครั้ง/วัน (เหลือ budget ให้ warmHistory + การเข้าชมจริง)
}

var WARM_HISTORY_DAYS = 30;
async function warmHistory(env) {
  _rowsCache_ = {};
  var today = todayBangkok_();
  await warmOne(env, 'monthly', { unit: '' });
  for (var i = 2; i < WARM_HISTORY_DAYS; i++) {
    var d = new Date(today.getTime() - i * 86400000);
    await warmOne(env, 'daily', { date: fmtYMD_(d), unit: '' });
  }
  // รวม ~29 ครั้ง/วัน (รันวันละครั้ง) — ยังเหลือ budget เยอะสำหรับ query ของ Unit ต่างๆ ที่มีคนเปิดจริง
}

// ============================================================
// ---------- สถิติการใช้งานแดชบอร์ด (KPI: มีคนเข้าใช้กี่คน รายวัน/เดือน/ไตรมาส/ปี) ----------
// เก็บแยกจากระบบ cache ข้อมูลขายโดยสิ้นเชิง เขียน KV แค่ "ครั้งแรกที่คนๆนั้นเข้าในแต่ละวัน" เท่านั้น
// (คนเดิมเปิดซ้ำวันเดียวกันไม่เขียนซ้ำ) และตอนอ่านสรุปผลใช้แค่ get/list ไม่เขียน จึงแทบไม่กิน put quota เลย
// ============================================================
async function trackVisit(env, email) {
  // นับ "ทุกครั้งที่เข้าใช้งาน" (page view) ไม่ใช่นับคนไม่ซ้ำ — เขียน KV ทุกครั้งที่มีคนล็อกอินสำเร็จ
  var dateStr = fmtYMD_(todayBangkok_());
  var kvKey = 'usage:' + dateStr;
  var raw = await env.GLORY_KV.get(kvKey);
  var rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch (e) {}
  if (!rec) rec = { count: 0 };
  rec.count = (rec.count || 0) + 1;
  await env.GLORY_KV.put(kvKey, JSON.stringify(rec), { expirationTtl: 400 * 86400 }); // เก็บไว้ ~400 วัน พอสรุปรายปีย้อนหลังได้
}

async function computeUsage(env) {
  var list = await env.GLORY_KV.list({ prefix: 'usage:' });
  var keys = list.keys.map(function (k) { return k.name; });
  while (!list.list_complete && list.cursor) {
    list = await env.GLORY_KV.list({ prefix: 'usage:', cursor: list.cursor });
    keys = keys.concat(list.keys.map(function (k) { return k.name; }));
  }
  var records = await Promise.all(keys.map(async function (k) {
    var raw = await env.GLORY_KV.get(k);
    var rec = null;
    try { rec = raw ? JSON.parse(raw) : null; } catch (e) {}
    return { date: k.replace('usage:', ''), count: rec ? (rec.count || 0) : 0 };
  }));
  records.sort(function (a, b) { return a.date < b.date ? 1 : -1; }); // ใหม่สุดก่อน

  var today = todayBangkok_();
  var todayStr = fmtYMD_(today);
  var monthPrefix = todayStr.slice(0, 7); // YYYY-MM
  var yearStr = todayStr.slice(0, 4);
  var q = Math.floor(today.getMonth() / 3);
  var qMonths = [q * 3, q * 3 + 1, q * 3 + 2];

  var sumToday = 0, sumMonth = 0, sumQuarter = 0, sumYear = 0;
  records.forEach(function (r) {
    var d = new Date(r.date + 'T00:00:00');
    var isToday = r.date === todayStr;
    var isMonth = r.date.slice(0, 7) === monthPrefix;
    var isYear = r.date.slice(0, 4) === yearStr;
    var isQuarter = isYear && qMonths.indexOf(d.getMonth()) >= 0;
    if (isToday) sumToday += r.count;
    if (isMonth) sumMonth += r.count;
    if (isQuarter) sumQuarter += r.count;
    if (isYear) sumYear += r.count;
  });

  return {
    today: sumToday,
    month: sumMonth,
    quarter: sumQuarter,
    year: sumYear,
    daily: records.slice(0, 60).map(function (r) { return { date: r.date, count: r.count }; }),
    updated: fmtHM_(todayBangkok_())
  };
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers });

    var qp = new URLSearchParams(url.search);
    if (qp.get('token') !== TOKEN) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers });
    }
    // debug: ?warmNow=recent หรือ ?warmNow=history เพื่อสั่งอุ่นด้วยมือผ่าน HTTP (ใช้ตอนทดสอบ)
    if (qp.get('warmNow') === 'recent') {
      ctx.waitUntil((async function(){ try{ await warmRecent(env); }catch(e){} })());
      return new Response(JSON.stringify({ ok: true, started: 'warmRecent' }), { headers });
    }
    if (qp.get('warmNow') === 'history') {
      ctx.waitUntil((async function(){ try{ await warmHistory(env); }catch(e){} })());
      return new Response(JSON.stringify({ ok: true, started: 'warmHistory' }), { headers });
    }

    // ---------- สถิติการใช้งานแดชบอร์ด (แยกจาก cache ข้อมูลขาย เพื่อไม่กิน put quota เกินจำเป็น) ----------
    if (request.method === 'POST' && qp.get('mode') === 'track') {
      var trackBody = null;
      try { trackBody = await request.json(); } catch (e) {}
      var trackEmail = (trackBody && trackBody.email) ? String(trackBody.email).trim().toLowerCase() : '';
      if (trackEmail) ctx.waitUntil(trackVisit(env, trackEmail));
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    if (qp.get('mode') === 'usage') {
      try {
        var usage = await computeUsage(env);
        return new Response(JSON.stringify(usage), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    var params = new URLSearchParams(url.search);
    params.delete('token');
    var action = params.get('action') || 'daily';
    var kvKey = canonicalKey(params);

    async function computeFresh() {
      var obj = {};
      params.forEach(function (v, k) { obj[k] = v; });
      var data = await computeData(env, action, obj);
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
  },

  // Cloudflare Cron Trigger เรียกอัตโนมัติ (ตั้งค่าใน dashboard: Workers > glory-api > Triggers > Cron Triggers)
  async scheduled(event, env, ctx) {
    if (event.cron === '*/10 * * * *') {
      ctx.waitUntil(warmRecent(env));
    } else {
      ctx.waitUntil(warmHistory(env));
    }
  }
};
