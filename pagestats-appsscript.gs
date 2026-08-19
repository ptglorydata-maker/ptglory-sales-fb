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
 * - admin/active ใช้ค่าจากแถววันที่ล่าสุดในช่วงที่เลือก (ไม่ได้รวม/เฉลี่ย เพราะเป็นข้อความ/สถานะ)
 * - aov (เปอร์บิล) คำนวณจากยอดรวมช่วง (sales_new/orders_new) เหมือน cost_per_chat ไม่ใช่ค่าเฉลี่ยรายวัน
 *
 * "สถิติรายแอดมิน" (mode=admin_stats, ฟังก์ชัน getAdminStats()) ใช้ชีต/สูตรเดียวกันทุกอย่าง แต่ group
 * ตามชื่อแอดมินแทนเพจ — รวมยอดของแอดมินคนเดียวกันที่ดูแลหลายเพจ/หลายยูนิตเข้าด้วยกัน แถวที่ไม่มี
 * ชื่อแอดมินจะไม่ถูกนับ (ไม่รู้ว่าเป็นของใคร) — ถ้าส่ง query param "admin" มาด้วย จะได้ "daily"
 * เพิ่มในผลลัพธ์ (ยอดขายรวมรายวันเฉพาะของแอดมินคนนั้น สำหรับกราฟแนวโน้มในหน้า detail)
 *
 * "kpi" (% ปิดการขาย / % ตีกลับ รายคน) — มาจากไฟล์คนละไฟล์กับ Staging Sheet นี้ 2 ไฟล์:
 *   1) ไฟล์รายชื่อ "test-รายงานเพจ FB" (master catalog เดียวกับที่ etl/sync_pages.py อ่าน "แอดมิน" มาใส่ Staging)
 *      มีคอลัมน์ แอดมิน (ชื่อเล่น) / รหัสพนักงาน / ชื่อเต็มแอดมิน — ใช้แค่ แอดมิน→รหัสพนักงาน
 *   2) ไฟล์ "KPI ฝ่ายขาย FB 2569" แท็บ "KPI แอดมิน" — มีบล็อกข้อมูลแยกทีละเดือน (ม.ค.69 เริ่มคอลัมน์ AB
 *      ขยับไปทางขวาเรื่อยๆ ทุกเดือน) แต่ละบล็อกมีคอลัมน์ "รหัสพนักงาน", "%ปิดการขาย", "% ตีกลับ" —
 *      หาตำแหน่งคอลัมน์จากข้อความหัวตารางจริงเสมอ (ไม่ hardcode ตัวอักษรคอลัมน์) เพราะบล็อกอาจขยับ/
 *      เปลี่ยนความกว้างได้เหมือนที่เจอปัญหานี้มาแล้วกับไฟล์รายเพจ (ดู etl/README.md)
 *   จับคู่คนด้วย "รหัสพนักงาน" (แม่นกว่าจับคู่ด้วยชื่อเต็มที่เสี่ยงสะกด/วรรคไม่ตรงกัน)
 *   ทั้ง 2 ไฟล์นี้ Apps Script อ่านได้เพราะรันด้วยบัญชี Google ของคนที่ deploy เอง ("Execute as: Me")
 *   ตราบใดที่บัญชีนั้นมีสิทธิ์เข้าไฟล์ทั้งสอง — ไม่เกี่ยวกับ service account ที่ etl/sync_pages.py ใช้
 */

// ===== CONFIG: แก้ตรงนี้ก่อน deploy =====
var TOKEN = 'glory_pg_0922541941'; // ต้องตรงกับ PAGE_API_TOKEN ใน index.html
var SHEET_GID = 851624242; // แท็บ "staging_รายเพจ" (จาก URL ...?gid=851624242)
var ROSTER_SHEET_ID = '1vjZ2ERd1Q-OAX5yYOgDztemVuF4samjSE5BXZ5snprA'; // "test-รายงานเพจ FB" (master catalog)
var KPI_SHEET_ID = '1a7Z1U3FouP7GeFMQ0D8yKUQOd9ZMgkJGxh0PFBLt5g0'; // "KPI ฝ่ายขาย FB 2569 (PT GLORY)"
var KPI_TAB_GID = 1293185359; // แท็บ "KPI แอดมิน"
// ==========================================

function doGet(e) {
  var out;
  try {
    var p = (e && e.parameter) || {};
    if (p.token !== TOKEN) throw new Error('Unauthorized');
    if (p.mode === 'units') {
      out = getPageUnits();
    } else if (p.mode === 'admin_stats') {
      var startA = p.start, endA = p.end;
      if (!startA || !endA) throw new Error('missing start/end');
      out = getAdminStats(startA, endA, p.unit || '', p.admin || '');
    } else {
      var start = p.start, end = p.end;
      if (!start || !end) throw new Error('missing start/end');
      out = getPageStats(start, end, p.unit || '');
    }
  } catch (err) {
    out = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// รายชื่อยูนิตที่มีข้อมูลรายเพจจริงใน Staging Sheet (ไม่ใช่รายชื่อยูนิตทั้งหมดจากระบบยอดขายหลัก
// data69 ที่มียูนิตเยอะกว่า) — ใช้เติม dropdown "หน่วย (Unit)" เฉพาะตอนอยู่แท็บ "สถิติรายเพจ"
function getPageUnits() {
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { units: [] };
  var header = values[0];
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });
  if (!('unit' in col)) throw new Error('ไม่พบคอลัมน์ unit ในชีต');
  var seen = {}, units = [];
  for (var r = 1; r < values.length; r++) {
    var u = String(values[r][col.unit] || '').trim();
    if (u && !seen[u]) { seen[u] = true; units.push(u); }
  }
  units.sort();
  return { units: units };
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

  var need = ['date', 'unit', 'page', 'admin', 'active', 'ad_spend', 'chats_ads', 'chats_admin',
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
        unit: unit, page: page, admin: '', active: '',
        ad_spend: 0, chats_ads: 0, chats_admin: 0,
        sales_total: 0, sales_new: 0, sales_old: 0,
        orders_total: 0, orders_new: 0, orders_old: 0,
        closeWeighted: 0, closeWeight: 0,
        errSum: 0, errCount: 0
      };
    }
    var g = byPage[key];
    // แอดมินอาจเปลี่ยนได้ระหว่างช่วงที่เลือก — ใช้ค่าจากแถววันที่ล่าสุดในช่วงนั้นเป็นตัวแทน
    var rowAdmin = String(row[col.admin] || '').trim();
    if (rowAdmin) g.admin = rowAdmin;
    // active เหมือนกัน — ใช้ค่าจากแถววันที่ล่าสุดในช่วงนั้น (เพจอาจปิด/เปิดระหว่างช่วงที่เลือกได้)
    var rowActive = String(row[col.active] || '').trim();
    if (rowActive) g.active = rowActive;
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
    return {
      unit: g.unit,
      page: g.page,
      admin: g.admin,
      active: g.active === 'active',
      // เปอร์บิล = ยอดขายใหม่ ÷ ออเดอร์ใหม่ (ราคาเฉลี่ยต่อบิลของลูกค้าใหม่ — สูตรเดียวกับที่ dashboard ใช้ที่อื่น)
      aov: g.orders_new ? round2_(g.sales_new / g.orders_new) : 0,
      ad_spend: round2_(g.ad_spend),
      chats_ads: g.chats_ads,
      chats_admin: g.chats_admin,
      // ต้นทุนทัก = ค่าแอด ÷ คนทักใหม่ฝั่งแอด เท่านั้น (ตรงกับสูตร "ต้นทุนต่อทัก" ในชีตต้นทาง) — ไม่บวก chats_admin
      cost_per_chat: g.chats_ads ? round2_(g.ad_spend / g.chats_ads) : 0,
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

// สถิติรายแอดมิน — เหมือน getPageStats() ทุกประการ (ใช้ชีต/คอลัมน์ต้นทางเดียวกัน) แต่ group
// ตาม "admin" แทน "unit|page" เพื่อรวมยอดของแอดมินคนเดียวกันที่อาจดูแลหลายเพจ/หลายยูนิตเข้าด้วยกัน
// แถวที่ไม่มีชื่อแอดมิน (ว่าง) จะไม่ถูกนับ เพราะไม่รู้ว่าเป็นของใคร
// ถ้าส่ง adminFilter มาด้วย จะคืน "daily" เพิ่ม — ยอดขายรวมรายวันเฉพาะของแอดมินคนนั้น
// (ใช้วาดกราฟแนวโน้มรายวันในหน้า detail โดยไม่ต้องดึงทุกแถวมาที่ฝั่งเว็บ)
function getAdminStats(start, end, unitFilter, adminFilter) {
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { rows: [], daily: null, start: start, end: end };

  var header = values[0];
  var col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });

  var need = ['date', 'unit', 'page', 'admin', 'ad_spend', 'chats_ads', 'chats_admin',
    'sales_total', 'sales_new', 'sales_old', 'orders_total', 'orders_new', 'orders_old',
    'close_rate_new', 'error_pct'];
  need.forEach(function (k) { if (!(k in col)) throw new Error('ไม่พบคอลัมน์ในชีต: ' + k); });

  var startD = new Date(start + 'T00:00:00');
  var endD = new Date(end + 'T23:59:59');
  var byAdmin = {}; // key = ชื่อแอดมิน
  var byDate = adminFilter ? {} : null; // key = 'YYYY-MM-DD' เฉพาะตอนมี adminFilter

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var d = row[col.date];
    var dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt) || dt < startD || dt > endD) continue;

    var unit = String(row[col.unit] || '').trim();
    var page = String(row[col.page] || '').trim();
    var admin = String(row[col.admin] || '').trim();
    if (!page || !admin) continue;
    if (unitFilter && unitFilter !== 'ทั้งหมด' && unit !== unitFilter) continue;

    if (byDate && admin === adminFilter) {
      var dateKey = Utilities.formatDate(dt, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd');
      byDate[dateKey] = (byDate[dateKey] || 0) + num_(row[col.sales_total]);
    }

    if (!byAdmin[admin]) {
      byAdmin[admin] = {
        admin: admin, units: {}, pages: {},
        ad_spend: 0, chats_ads: 0, chats_admin: 0,
        sales_total: 0, sales_new: 0, sales_old: 0,
        orders_total: 0, orders_new: 0, orders_old: 0,
        closeWeighted: 0, closeWeight: 0,
        errSum: 0, errCount: 0
      };
    }
    var g = byAdmin[admin];
    if (unit) g.units[unit] = true;
    g.pages[unit + '|' + page] = page;
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

  var result = Object.keys(byAdmin).map(function (k) {
    var g = byAdmin[k];
    var pageNames = Object.keys(g.pages).map(function (pk) { return g.pages[pk]; }).sort();
    return {
      admin: g.admin,
      units: Object.keys(g.units).sort(),
      pageCount: pageNames.length,
      pages: pageNames,
      // เปอร์บิลใหม่ = ยอดขายใหม่ ÷ ออเดอร์ใหม่ (สูตรเดียวกับสถิติรายเพจ)
      aov: g.orders_new ? round2_(g.sales_new / g.orders_new) : 0,
      // เปอร์บิลรวม = ยอดขายรวม ÷ ออเดอร์รวม (คำนวณเพิ่มจากข้อมูลเดิม ไม่ต้องเพิ่มคอลัมน์ในชีต)
      aov_total: g.orders_total ? round2_(g.sales_total / g.orders_total) : 0,
      ad_spend: round2_(g.ad_spend),
      chats_ads: g.chats_ads,
      chats_admin: g.chats_admin,
      cost_per_chat: g.chats_ads ? round2_(g.ad_spend / g.chats_ads) : 0,
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

  var dailySeries = null;
  if (byDate) {
    dailySeries = Object.keys(byDate).sort().map(function (dk) {
      return { date: dk, sales_total: round2_(byDate[dk]) };
    });
  }

  var kpi = null;
  if (adminFilter) {
    try { kpi = getAdminKpi_(adminFilter, start, end); }
    catch (kpiErr) { kpi = { found: false, reason: 'โหลดข้อมูล KPI ไม่สำเร็จ: ' + kpiErr.message }; }
  }

  return { rows: result, daily: dailySeries, kpi: kpi, start: start, end: end };
}

// ===== % ปิดการขาย (รวม) / % ตีกลับ — อ่านจากไฟล์รายชื่อ + ไฟล์ KPI คนละไฟล์กับ Staging Sheet =====

var THAI_MONTHS_ = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

// ชื่อเล่นแอดมิน (คอลัมน์ "แอดมิน" ในไฟล์รายชื่อ ตรงกับ Staging.admin เป๊ะๆ เพราะ ETL ดึงมาจากไฟล์เดียวกันนี้) → รหัสพนักงาน
function getRosterMap_() {
  var ss = SpreadsheetApp.openById(ROSTER_SHEET_ID);
  var sh = ss.getSheets()[0];
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return {};
  var header = values[0], col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });
  if (!('แอดมิน' in col) || !('รหัสพนักงาน' in col)) {
    throw new Error('ไม่พบคอลัมน์ แอดมิน หรือ รหัสพนักงาน ในไฟล์รายชื่อ');
  }
  var map = {};
  for (var r = 1; r < values.length; r++) {
    var nick = String(values[r][col['แอดมิน']] || '').trim();
    var empId = String(values[r][col['รหัสพนักงาน']] || '').trim();
    if (!nick || !empId) continue;
    if (!map[nick]) map[nick] = empId; // เก็บครั้งแรกพอ (แถวอื่นของคนเดียวกันควรมีรหัสเดียวกันอยู่แล้ว)
  }
  return map;
}

// พ.ศ. 2 หลักแบบ "สิงหาคม 69" → "2026-08"
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

// สแกนแท็บ "KPI แอดมิน" หาตำแหน่งคอลัมน์ "รหัสพนักงาน" (คงที่ต้นตาราง) และคอลัมน์ %ปิดการขาย/% ตีกลับ
// ของทุกบล็อกเดือน จากข้อความหัวตารางจริง (ไม่ hardcode ตัวอักษรคอลัมน์ เพราะบล็อกอาจขยับ/กว้างไม่เท่ากัน)
function getKpiSheetLayout_() {
  var ss = SpreadsheetApp.openById(KPI_SHEET_ID);
  var sheets = ss.getSheets(), sh = null;
  for (var i = 0; i < sheets.length; i++) { if (sheets[i].getSheetId() === KPI_TAB_GID) { sh = sheets[i]; break; } }
  if (!sh) throw new Error('ไม่พบแท็บ KPI แอดมิน (gid=' + KPI_TAB_GID + ')');
  var lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
  var row1 = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var row3 = sh.getRange(3, 1, 1, lastCol).getDisplayValues()[0];

  var empIdCol = -1;
  for (var c = 0; c < row3.length; c++) { if (String(row3[c]).trim() === 'รหัสพนักงาน') { empIdCol = c; break; } }
  if (empIdCol < 0) throw new Error('ไม่พบคอลัมน์รหัสพนักงานในแท็บ KPI แอดมิน');

  var blocks = {}, curLabel = '';
  for (var c2 = 0; c2 < row1.length; c2++) {
    if (String(row1[c2]).trim()) curLabel = String(row1[c2]).trim();
    var h3 = String(row3[c2]).trim();
    if (h3 !== '%ปิดการขาย' && h3 !== '% ตีกลับ') continue;
    var mm = parseThaiMonthLabel_(curLabel);
    if (!mm) continue;
    if (!blocks[mm]) blocks[mm] = { month: mm, label: curLabel, colClose: -1, colBounce: -1 };
    if (h3 === '%ปิดการขาย') blocks[mm].colClose = c2; else blocks[mm].colBounce = c2;
  }

  return { sheet: sh, empIdCol: empIdCol, lastRow: lastRow, lastCol: lastCol, blocks: blocks };
}

// รายชื่อ 'YYYY-MM' ทุกเดือนที่ [start,end] คาบเกี่ยว (start/end เป็นสตริง 'YYYY-MM-DD')
function monthsBetween_(start, end) {
  var out = [], y = parseInt(start.slice(0, 4), 10), m = parseInt(start.slice(5, 7), 10);
  var endY = parseInt(end.slice(0, 4), 10), endM = parseInt(end.slice(5, 7), 10);
  while (y < endY || (y === endY && m <= endM)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// % ปิดการขาย (รวม) และ % ตีกลับ ของแอดมินคนเดียว (ชื่อเล่น) ทุกเดือนที่คาบเกี่ยวกับ [start,end]
function getAdminKpi_(adminNickname, start, end) {
  var empId = getRosterMap_()[adminNickname];
  if (!empId) return { found: false, reason: 'ไม่พบรหัสพนักงานของ "' + adminNickname + '" ในไฟล์รายชื่อ' };

  var layout = getKpiSheetLayout_();
  var months = monthsBetween_(start, end).filter(function (mm) { return mm in layout.blocks; });
  if (!months.length) return { found: false, reason: 'ไม่มีบล็อก KPI ของเดือนที่เลือกในแท็บ KPI แอดมิน' };

  var dataRows = layout.lastRow - 3;
  if (dataRows <= 0) return { found: false, reason: 'แท็บ KPI แอดมิน ไม่มีข้อมูล' };
  var data = layout.sheet.getRange(4, 1, dataRows, layout.lastCol).getDisplayValues();
  var row = null;
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][layout.empIdCol]).trim() === empId) { row = data[r]; break; }
  }
  if (!row) return { found: false, reason: 'ไม่พบรหัสพนักงาน ' + empId + ' ในแท็บ KPI แอดมิน' };

  var monthsOut = months.map(function (mm) {
    var b = layout.blocks[mm];
    return {
      month: mm, label: b.label,
      close_rate_total: b.colClose >= 0 ? pct_(row[b.colClose]) : null,
      bounce_rate: b.colBounce >= 0 ? pct_(row[b.colBounce]) : null
    };
  });
  return { found: true, employeeId: empId, months: monthsOut };
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
