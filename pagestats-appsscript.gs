/**
 * Apps Script backend สำหรับ "สถิติรายเพจ" — ให้ index.html ดึงข้อมูลจากชีต "Staging - รายเพจ"
 *
 * วิธีติดตั้ง:
 * 1) เปิดชีต "Staging - รายเพจ" (https://docs.google.com/spreadsheets/d/1Jd5jsYoslIpbOtZwQ-skrXir7DIIY1xmRq9jH7htskk)
 * 2) เมนู Extensions > Apps Script
 * 3) ลบโค้ดเดิมในไฟล์ Code.gs ทั้งหมด แล้ววางไฟล์นี้แทน
 * 4) แก้ TOKEN ด้านล่างเป็นรหัสลับของตัวเอง แล้วเอาค่าเดียวกันไปใส่ตัวแปร PAGE_API_TOKEN ใน index.html
 * 5) กด Deploy > New deployment > เลือกประเภท "Web app"
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 6) คัดลอก URL ที่ได้ (ลงท้ายด้วย /exec) ไปใส่ตัวแปร PAGE_API_URL ใน index.html
 * 7) ทุกครั้งที่แก้โค้ดนี้ ต้อง Deploy > Manage deployments > แก้ไข (ไอคอนดินสอ) > Version: New version ใหม่ ไม่งั้น URL เดิมจะยังใช้โค้ดเก่าอยู่
 *
 * หมายเหตุเรื่องการรวมข้อมูลช่วงเวลา (period aggregation):
 * - ค่าเงิน/จำนวนนับ (ad_spend, chats_*, sales_*, orders_*) รวมด้วยการบวก (sum) ตรงไปตรงมา
 * - อัตราส่วนที่สูตรชัดเจน (cost_per_chat, ads_pct, roas_new, roas_total) คำนวณใหม่จากยอดรวมของช่วง
 *   ไม่ใช่ค่าเฉลี่ยของแต่ละวัน เพื่อไม่ให้ค่าเพี้ยนตามจำนวนวันที่ active/inactive
 * - close_rate_new (%ปิดใหม่) ใช้ค่าเฉลี่ยถ่วงน้ำหนักด้วย chats_ads ของแต่ละวัน (ประมาณการ เพราะไม่ทราบสูตรจริงที่ใช้คำนวณคอลัมน์นี้ในชีต)
 * - error_pct (%ERROR รายเพจ) ใช้ค่าเฉลี่ยธรรมดาของแต่ละวันที่มีข้อมูล (ไม่ทราบสูตร/ตัวหารที่แท้จริงเช่นกัน)
 * ถ้าสูตรจริงของ close_rate_new / error_pct ต่างจากนี้ ให้แก้ในฟังก์ชัน getPageStats() ด้านล่าง
 */

// ===== CONFIG: แก้ตรงนี้ก่อน deploy =====
var TOKEN = 'ptglory_pagestats_x7q2'; // ต้องตรงกับ PAGE_API_TOKEN ใน index.html
var SHEET_GID = 851624242; // แท็บ "staging_รายเพจ" (จาก URL ...?gid=851624242)
// ==========================================

function doGet(e) {
  var out;
  try {
    var p = (e && e.parameter) || {};
    if (p.token !== TOKEN) throw new Error('Unauthorized');
    var start = p.start, end = p.end;
    if (!start || !end) throw new Error('missing start/end');
    out = getPageStats(start, end, p.unit || '');
  } catch (err) {
    out = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === SHEET_GID) return sheets[i];
  }
  throw new Error('ไม่พบแท็บที่มี gid=' + SHEET_GID + ' — แก้ค่า SHEET_GID ในโค้ดนี้');
}

function getPageStats(start, end, unitFilter) {
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { rows: [], start: start, end: end };

  var header = values[0];
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });

  var need = ['date', 'unit', 'page', 'ad_spend', 'chats_ads', 'chats_admin',
    'sales_total', 'sales_new', 'sales_old', 'orders_total', 'orders_new', 'orders_old',
    'close_rate_new', 'error_pct'];
  need.forEach(function (k) { if (!(k in col)) throw new Error('ไม่พบคอลัมน์ในชีต: ' + k); });

  var startD = new Date(start + 'T00:00:00');
  var endD = new Date(end + 'T23:59:59');
  var byPage = {}; // key = unit + '|' + page

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var d = row[col.date];
    var dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt) || dt < startD || dt > endD) continue;

    var unit = String(row[col.unit] || '').trim();
    var page = String(row[col.page] || '').trim();
    if (!page) continue;
    if (unitFilter && unitFilter !== 'ทั้งหมด' && unit !== unitFilter) continue;

    var key = unit + '|' + page;
    if (!byPage[key]) {
      byPage[key] = {
        unit: unit, page: page,
        ad_spend: 0, chats_ads: 0, chats_admin: 0,
        sales_total: 0, sales_new: 0, sales_old: 0,
        orders_total: 0, orders_new: 0, orders_old: 0,
        closeWeighted: 0, closeWeight: 0,
        errSum: 0, errCount: 0
      };
    }
    var g = byPage[key];
    g.ad_spend += num_(row[col.ad_spend]);
    g.chats_ads += num_(row[col.chats_ads]);
    g.chats_admin += num_(row[col.chats_admin]);
    g.sales_total += num_(row[col.sales_total]);
    g.sales_new += num_(row[col.sales_new]);
    g.sales_old += num_(row[col.sales_old]);
    g.orders_total += num_(row[col.orders_total]);
    g.orders_new += num_(row[col.orders_new]);
    g.orders_old += num_(row[col.orders_old]);

    var dailyChatsAds = num_(row[col.chats_ads]);
    var closeVal = pct_(row[col.close_rate_new]);
    if (!isNaN(closeVal) && dailyChatsAds > 0) {
      g.closeWeighted += closeVal * dailyChatsAds;
      g.closeWeight += dailyChatsAds;
    }
    var errVal = pct_(row[col.error_pct]);
    if (!isNaN(errVal)) { g.errSum += errVal; g.errCount++; }
  }

  var result = Object.keys(byPage).map(function (k) {
    var g = byPage[k];
    var chatsTotal = g.chats_ads + g.chats_admin;
    return {
      unit: g.unit,
      page: g.page,
      ad_spend: round2_(g.ad_spend),
      chats_ads: g.chats_ads,
      chats_admin: g.chats_admin,
      cost_per_chat: chatsTotal ? round2_(g.ad_spend / chatsTotal) : 0,
      sales_total: round2_(g.sales_total),
      sales_new: round2_(g.sales_new),
      sales_old: round2_(g.sales_old),
      orders_total: round2_(g.orders_total),
      orders_new: round2_(g.orders_new),
      orders_old: round2_(g.orders_old),
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

function num_(v) {
  if (typeof v === 'string') v = v.replace(/,/g, '').trim();
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
function pct_(v) {
  if (typeof v === 'string') v = v.replace('%', '').trim();
  return parseFloat(v);
}
function round2_(n) { return Math.round(n * 100) / 100; }
