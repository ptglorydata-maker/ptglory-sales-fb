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
 * คอลัมน์ admin ใน Staging เป็น ", ".join(...) ของทุกแอดมินในเพจนั้น (มาจาก etl/sync_pages.py) — โค้ด
 * แยกทีละคนก่อน group เสมอ ไม่ group ตามสตริงรวมตรงๆ (ไม่งั้นเพจที่มีแอดมินร่วมกัน 2 คนจะกลายเป็น
 * "คนที่ 3" ปลอมๆ ใน dropdown) ผลคือถ้าเพจหนึ่งมีแอดมิน 2 คนดูแลร่วมกัน ทั้งคู่จะได้เครดิตยอดเต็มของ
 * เพจนั้น (ไม่หารครึ่ง) เพราะไม่รู้สัดส่วนงานจริงของแต่ละคน — sales_total รวมของทุกคนบวกกันจึงมากกว่า
 * ยอดขายจริงของบริษัทได้ถ้ามีเพจที่ดูแลร่วมกันเยอะ ถือว่าตั้งใจ ไม่ใช่บั๊ก
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
var KPI_TAB_GID = 1293185359; // แท็บ "KPI แอดมิน" — ยังใช้อยู่เฉพาะเป้า/คะแนน/สถานะ (ไม่มีในไฟล์ DA)
var DA_TEAM_SHEET_ID = '1fvcBHub0z_xI6O_7Ml3MYNnzq-dJJl-g6NqFX0bTVb0'; // "Data กลางทีม DA" (ข้อมูลกลางของทีม)
var DA_TEAM_TAB = 'Data_All Unit in 69'; // ยอดขายรวมเดือน/%ปิดการขาย/เปอร์บิล/%ตีกลับ รายคนจริง — แหล่งหลักตอนนี้
var DA_TEAM_YEAR = 2026; // ไฟล์นี้ไม่มีคอลัมน์ปี มีแต่ "เดือน" (1-12) — ข้อมูลทั้งไฟล์เป็นปี 2569 เท่านั้น
// ==========================================

function doGet(e) {
  var out;
  try {
    var p = (e && e.parameter) || {};
    if (p.token !== TOKEN) throw new Error('Unauthorized');
    if (p.mode === 'units') {
      out = getPageUnits();
    } else if (p.mode === 'admin_units') {
      out = getAdminUnits_();
    } else if (p.mode === 'admin_stats') {
      var startA = p.start, endA = p.end;
      if (!startA || !endA) throw new Error('missing start/end');
      out = getAdminStats(startA, endA, p.unit || '', p.admin || '');
    } else if (p.mode === 'da_debug') {
      // ดีบั๊ก: โชว์แถวดิบทุกแถวจากไฟล์ "Data กลางทีม DA" ที่ถูกรวมเข้าเป็น sales_total ของคนคนหนึ่งในเดือนหนึ่ง
      // ใช้เช็คว่ามีแถวซ้ำ/นับเกินจริงไหม เรียกด้วย ?mode=da_debug&admin=<ชื่อเต็มตรงคอลัมน์D>&month=YYYY-MM&token=...
      if (!p.admin || !p.month) throw new Error('missing admin/month (เช่น admin=ใบพลู (ปิยกรณ์)&month=2026-08)');
      out = getDaDebugRows_(p.admin, p.month);
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

// ตัดคอลัมน์ unit ดิบให้เหลือแค่รหัสยูนิตล้วน เช่น "U9 ชาสมุนไพรแม่แย้ม" → "U9", "U5 ลาว Capsule" → "U5 ลาว"
// เผื่อคอลัมน์ unit ใน Staging มีข้อความต่อท้ายปนมา (เจอจริงกับ U9 — บางแถวเป็น "U9" ล้วนๆ บางแถวมีชื่อ
// เพจต่อท้าย) ถ้าไม่ normalize ก่อน การกรองยูนิตแบบ exact-match จะพลาดข้อมูลอีกฝั่งไปเงียบๆ
// ดึง "ชื่อเล่น" ล้วนๆ จากป้ายในไฟล์รายชื่อ ซึ่งเป็นรูปแบบ "ชื่อเล่น (ชื่อจริง)" เช่น "อ้อม (บุษยา)" → "อ้อม"
// จำเป็นเพราะแท็บ "Adminชื่อ" ต้นทาง (ที่ etl/sync_pages.py อ่านมาใส่ staging_รายคน) ตั้งชื่อแท็บด้วย
// ชื่อเล่นล้วนๆ เท่านั้น (เช่น "Adminอ้อม" → "อ้อม") ไม่มีวงเล็บชื่อจริงต่อท้ายเหมือนไฟล์รายชื่อ ถ้าไม่ตัด
// วงเล็บออกก่อน key จะไม่ตรงกันเลยสักคน แล้วจะ fallback ไปใช้ค่าประมาณแบบเดิมเงียบๆ ทุกคนโดยไม่มีใครรู้
function adminNick_(fullLabel) {
  var s = String(fullLabel || '').trim();
  var i = s.indexOf(' (');
  return i >= 0 ? s.slice(0, i).trim() : s;
}

function normalizeUnitCode_(raw) {
  raw = String(raw || '').trim();
  var m = raw.match(/^([A-Za-z]+\d+)(\s*ลาว)?/);
  return m ? (m[1] + (m[2] ? ' ลาว' : '')) : raw;
}

// รายชื่อยูนิต (normalize แล้ว) สำหรับ dropdown "หน่วย (Unit)" ของแท็บ "สถิติรายคน" โดยเฉพาะ — แยกจาก
// getPageUnits() ของแท็บ "สถิติรายเพจ" ไม่ให้กระทบกัน เพราะแท็บนั้นใช้ unit ดิบตรงๆ อยู่แล้วและทำงานปกติดี
function getAdminUnits_() {
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { units: [] };
  var header = values[0], col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });
  if (!('unit' in col)) throw new Error('ไม่พบคอลัมน์ unit ในชีต');
  var seen = {}, units = [];
  for (var r = 1; r < values.length; r++) {
    var u = normalizeUnitCode_(values[r][col.unit]);
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

// แท็บ "staging_รายคน" — ยอดขาย/ออเดอร์/%ปิด/เปอร์บิล รายบุคคลจริง (จากแท็บ "Adminชื่อ" ของแต่ละยูนิต
// ผ่าน etl/sync_pages.py) ใช้แทนค่าประมาณแบบ full-credit จาก staging_รายเพจ เมื่อมีข้อมูลจริงของคนนั้น
// อาจยังไม่มีแท็บนี้ในชีต (ยังไม่เคย sync หรือ deploy โค้ดใหม่ก่อนรัน ETL รอบแรก) จึงคืน null แทนการ throw
// เพื่อให้ getAdminStats() fallback ไปใช้ค่าประมาณแบบเดิมได้เงียบๆ ไม่ล่มทั้งหน้า
function getAdminDataSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName('staging_รายคน') || null;
}

// รวมยอดรายบุคคลจริงจาก staging_รายคน ในช่วง [start,end] (+ กรอง unit ถ้ามี) คืน:
//   byAdmin: { "หน่วย|ชื่อเล่น": { sales_total, sales_new, sales_old, orders_total, orders_new, orders_old,
//                                    closeSum, closeCount } }
//   byAdminDaily: { "หน่วย|ชื่อเล่น": { 'YYYY-MM-DD': sales_total } } — ใช้วาดกราฟแนวโน้มรายวันจริงในหน้า detail
// key ต้องผูกกับหน่วยด้วยเสมอ (ไม่ใช่แค่ชื่อเล่นเฉยๆ) เพราะชื่อเล่นซ้ำกันข้ามยูนิตได้ (เช่น "ก้อย" มีทั้งใน
// U9 และ U12 เป็นคนละคน) ถ้า key แค่ชื่อเล่น ตอนดู "ทั้งหมด" (ไม่กรองยูนิต) ยอดของสองคนจะถูกรวมปนกัน
function getAdminPersonalAgg_(start, end, unitFilter) {
  var sh = getAdminDataSheet_();
  if (!sh) return { byAdmin: {}, byAdminDaily: {} };
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { byAdmin: {}, byAdminDaily: {} };

  var header = values[0], col = {};
  header.forEach(function (h, i) { col[String(h).trim()] = i; });
  var need = ['date', 'unit', 'admin', 'sales_total', 'sales_new', 'sales_old',
    'orders_total', 'orders_new', 'orders_old', 'close_rate_new',
    'ad_spend', 'cost_per_chat', 'roas_new'];
  var hasAll = need.every(function (k) { return k in col; });
  if (!hasAll) return { byAdmin: {}, byAdminDaily: {} }; // โครงสร้างแท็บผิดคาด — ข้ามไปใช้ fallback แทน

  var startD = new Date(start + 'T00:00:00');
  var endD = new Date(end + 'T23:59:59');
  var byAdmin = {}, byAdminDaily = {};

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var d = row[col.date];
    var dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt) || dt < startD || dt > endD) continue;

    var unitNorm = normalizeUnitCode_(row[col.unit]);
    var admin = String(row[col.admin] || '').trim();
    if (!admin) continue;
    if (unitFilter && unitFilter !== 'ทั้งหมด' && unitNorm !== unitFilter) continue;

    var key = unitNorm + '|' + admin;
    if (!byAdmin[key]) {
      byAdmin[key] = {
        sales_total: 0, sales_new: 0, sales_old: 0,
        orders_total: 0, orders_new: 0, orders_old: 0,
        closeSum: 0, closeCount: 0,
        ad_spend: 0, cost_per_chat_sum: 0, cost_per_chat_count: 0
      };
    }
    var g = byAdmin[key];
    var rowSales = num_(row[col.sales_total]);
    g.sales_total += rowSales;
    g.sales_new += num_(row[col.sales_new]);
    g.sales_old += num_(row[col.sales_old]);
    g.orders_total += num_(row[col.orders_total]);
    g.orders_new += num_(row[col.orders_new]);
    g.orders_old += num_(row[col.orders_old]);
    var closeVal = pct_(row[col.close_rate_new]);
    if (!isNaN(closeVal)) { g.closeSum += closeVal; g.closeCount++; }
    g.ad_spend += num_(row[col.ad_spend]);
    var costPerChatVal = num_(row[col.cost_per_chat]);
    if (costPerChatVal) { g.cost_per_chat_sum += costPerChatVal; g.cost_per_chat_count++; }

    var dateKey = Utilities.formatDate(dt, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd');
    if (!byAdminDaily[key]) byAdminDaily[key] = {};
    byAdminDaily[key][dateKey] = (byAdminDaily[key][dateKey] || 0) + rowSales;
  }

  return { byAdmin: byAdmin, byAdminDaily: byAdminDaily };
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
    // etl/sync_pages.py เขียน admin เป็น ", ".join(ทุกแอดมินของเพจนั้น) — เพจที่มีแอดมินร่วมกันหลายคน
    // จะได้สตริงรวม เช่น "ปุยฝ้าย (ปวรรรณ), ตะวัน (ปานตะวัน)" ถ้า group ตามสตริงนี้ตรงๆ จะกลายเป็น
    // "คนที่ 3" ปลอมๆ ที่ไม่ตรงกับใครในไฟล์รายชื่อเลย (ทำให้ dropdown มึนและ join กับไฟล์ KPI ไม่เจอ)
    // ต้องแยกทีละคนแล้วให้เครดิตยอดของเพจนั้นกับทุกคนที่ดูแลเพจนั้นจริง
    var admins = String(row[col.admin] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!page || !admins.length) continue;
    // เทียบยูนิตแบบ normalize แล้ว (ไม่ใช่ exact-match ตรงๆ เหมือน getPageStats) เพราะคอลัมน์ unit ใน
    // Staging มีค่าเพี้ยนปนอยู่บ้าง (เช่น "U9 ชาสมุนไพรแม่แย้ม" ปนกับ "U9" ล้วนๆ) — ดู normalizeUnitCode_()
    if (unitFilter && unitFilter !== 'ทั้งหมด' && normalizeUnitCode_(unit) !== unitFilter) continue;

    var dailyChatsAds = num_(row[col.chats_ads]);
    var closeVal = pct_(row[col.close_rate_new]);
    var errVal = pct_(row[col.error_pct]);

    admins.forEach(function (admin) {
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
      if (unit) g.units[normalizeUnitCode_(unit)] = true;
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

      if (!isNaN(closeVal) && dailyChatsAds > 0) {
        g.closeWeighted += closeVal * dailyChatsAds;
        g.closeWeight += dailyChatsAds;
      }
      if (!isNaN(errVal)) { g.errSum += errVal; g.errCount++; }
    });
  }

  // ยอดขาย/ออเดอร์/%ปิดใหม่/เปอร์บิล/%ERROR "ของจริงรายคน" มาจากไฟล์ Data กลางทีม DA เสมอเมื่อมีข้อมูล
  // ของคนนั้นในช่วง/ยูนิตที่เลือก (แหล่งหลักตามที่ยืนยัน — ไม่ใช้แท็บ ค่าคอมแอดมิน รายวันของแต่ละยูนิต
  // อีกต่อไป เพราะบางคนไม่มีคอลัมน์อยู่ในนั้นเลย เช่น "เว" ทำให้ตกไปใช้ค่าประมาณ full-credit ที่ผิดเพี้ยน)
  // ค่าแอด/ROAS/ต้นทุนทัก ยังคงมาจากแท็บเพจเสมอ เพราะไฟล์ DA ไม่มีคอลัมน์งบโฆษณาให้
  var daRowsAll = [];
  monthsBetween_(start, end).forEach(function (mm) { daRowsAll = daRowsAll.concat(getDaTeamMonthRowsCached_(mm)); });
  var daAgg = aggregateDaRows_(daRowsAll, unitFilter);
  var personalAgg = getAdminPersonalAgg_(start, end, unitFilter); // ยังใช้แค่วาดกราฟแนวโน้มรายวัน (ดูด้านล่าง)

  var result = Object.keys(byAdmin).map(function (k) {
    var g = byAdmin[k];
    var pageNames = Object.keys(g.pages).map(function (pk) { return g.pages[pk]; }).sort();
    // daAgg มาจากไฟล์ DA ที่คีย์ด้วยชื่อเต็ม "ชื่อเล่น (ชื่อจริง)" ทั้งสตริง (ตัดแค่ช่องว่าง) ไม่ใช่ชื่อเล่น
    // เฉยๆ (adminNick_) แบบที่ใช้กับแท็บ ค่าคอมแอดมิน เดิม — ต้องคีย์ให้ตรงฟอร์แมตของไฟล์ DA ไม่งั้นจับคู่
    // ไม่ติดเลยสักคน (พังแบบเงียบๆ กลับไปใช้ค่าประมาณ full-credit เดิมทุกคนโดยไม่รู้ตัว)
    var a = daAgg[normalizeAdminKey_(g.admin)];
    var hasReal = !!a && (a.salesSum !== 0 || a.ordersSum !== 0);

    var salesTotal = hasReal ? a.salesSum : g.sales_total;
    var salesNew = hasReal ? a.salesNewSum : g.sales_new;
    var salesOld = hasReal ? a.salesOldSum : g.sales_old;
    var ordersTotal = hasReal ? a.ordersSum : g.orders_total;
    var ordersNew = hasReal ? a.ordersNewSum : g.orders_new;
    var ordersOld = hasReal ? a.ordersOldSum : g.orders_old;
    var closeRateNew = hasReal
      ? (a.chatsAdsSum ? round2_(a.closeWeighted / a.chatsAdsSum) : 0)
      : (g.closeWeight ? round2_(g.closeWeighted / g.closeWeight) : 0);
    var errorPct = hasReal
      ? (a.errCount ? round2_(a.errSum / a.errCount) : 0)
      : (g.errCount ? round2_(g.errSum / g.errCount) : 0);
    // ค่าแอด/ROAS/ต้นทุนทัก: มาจากแท็บเพจ (staging_รายเพจ) เสมอ ไม่มีในไฟล์ DA
    var adSpend = g.ad_spend;
    var costPerChat = g.chats_ads ? round2_(g.ad_spend / g.chats_ads) : 0;
    var roasNew = adSpend ? round2_(salesNew / adSpend) : 0;
    var roasTotal = adSpend ? round2_(salesTotal / adSpend) : 0;

    return {
      admin: g.admin,
      units: Object.keys(g.units).sort(),
      pageCount: pageNames.length,
      pages: pageNames,
      per_admin_real_data: hasReal, // true = ยอดจริงรายคนจากไฟล์ Data กลางทีม DA, false = ค่าประมาณ full-credit จากแท็บเพจ
      // เปอร์บิลใหม่ = ยอดขายใหม่ ÷ ออเดอร์ใหม่ (สูตรเดียวกับสถิติรายเพจ)
      aov: ordersNew ? round2_(salesNew / ordersNew) : 0,
      // เปอร์บิลรวม = ยอดขายรวม ÷ ออเดอร์รวม (คำนวณเพิ่มจากข้อมูลเดิม ไม่ต้องเพิ่มคอลัมน์ในชีต)
      aov_total: ordersTotal ? round2_(salesTotal / ordersTotal) : 0,
      ad_spend: round2_(adSpend),
      chats_ads: g.chats_ads,
      chats_admin: g.chats_admin,
      cost_per_chat: costPerChat,
      sales_total: round2_(salesTotal),
      sales_new: round2_(salesNew),
      sales_old: round2_(salesOld),
      orders_total: round2_(ordersTotal),
      orders_new: round2_(ordersNew),
      orders_old: round2_(ordersOld),
      close_rate_new: closeRateNew,
      ads_pct: salesTotal ? round2_(adSpend / salesTotal * 100) : 0,
      roas_new: roasNew,
      roas_total: roasTotal,
      error_pct: errorPct
    };
  });
  result.sort(function (a, b) { return b.sales_total - a.sales_total; });

  // ป้าย "ผ่าน/ไม่ผ่าน KPI" + คะแนน สำหรับหน้าจัดอันดับ (leaderboard) — แนบให้ทุกแถวเสมอ (อ่านไฟล์แค่ครั้ง
  // เดียวไม่ว่าจะกี่คน) แยกจาก kpi ละเอียด (ทุกเดือน/เป้า) ที่แนบเฉพาะตอนกรองแอดมินคนเดียวด้านล่าง
  try {
    var statusBatch = getKpiStatusBatch_(result.map(function (r) { return r.admin; }), start, end);
    result.forEach(function (r) { r.kpi_status = statusBatch[r.admin] || null; });
  } catch (batchErr) {
    result.forEach(function (r) { r.kpi_status = null; });
  }

  var dailySeries = null;
  if (byDate) {
    // ถ้ามีข้อมูลจริงรายคนของคนนี้ในแท็บ staging_รายคน ใช้กราฟแนวโน้มจากข้อมูลจริงแทนค่าประมาณ full-credit
    // หาหน่วยของแอดมินคนนี้จาก byAdmin ที่รวบรวมไว้แล้วด้านบน (ต้องผูกหน่วยด้วย ไม่ใช่แค่ชื่อเล่น — ดูเหตุผลที่ getAdminPersonalAgg_)
    var filterUnits = byAdmin[adminFilter] ? Object.keys(byAdmin[adminFilter].units) : [];
    var realDaily = null;
    filterUnits.forEach(function (u) {
      var d2 = personalAgg.byAdminDaily[u + '|' + adminNick_(adminFilter)];
      if (!d2) return;
      if (!realDaily) realDaily = {};
      Object.keys(d2).forEach(function (dk) { realDaily[dk] = (realDaily[dk] || 0) + d2[dk]; });
    });
    var sourceDaily = (realDaily && Object.keys(realDaily).length) ? realDaily : byDate;
    dailySeries = Object.keys(sourceDaily).sort().map(function (dk) {
      return { date: dk, sales_total: round2_(sourceDaily[dk]) };
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

// สแกนแท็บ "KPI แอดมิน" หาตำแหน่งคอลัมน์ "รหัสพนักงาน" (คงที่ต้นตาราง) และคอลัมน์ค่าจริง 4 ตัวของทุกบล็อกเดือน
// (ยอดขาย/%ปิดการขาย/ยอดขายเปอร์บิล/% ตีกลับ) จากข้อความหัวตารางจริงในแถว 3 เสมอ (ไม่ hardcode ตัวอักษร
// คอลัมน์ เพราะบล็อกอาจขยับ/กว้างไม่เท่ากันเหมือนที่เจอปัญหานี้มาแล้วกับไฟล์รายเพจ)
//
// ต่อจากคอลัมน์ "ยอดขาย" (ค่าจริง) ของแต่ละบล็อก มีคอลัมน์เป้า/คะแนนอีก 8 คอลัมน์ + คะแนนรวม + สถานะ KPI
// เรียงตำแหน่งคงที่เสมอ (ยืนยันจากไฟล์จริงเดือนสิงหาคม 69: EN..FA = ยอดขาย,%ปิดการขาย,เปอร์บิล,%ตีกลับ,
// [เป้ายอดขาย,คะแนน],[เป้า%ปิด,คะแนน],[เป้าเปอร์บิล,คะแนน],[เป้า%ตีกลับ,คะแนน],คะแนนรวม,สถานะ KPI)
// เชื่อตำแหน่งนี้เฉพาะบล็อกที่ผ่านการเช็คความสอดคล้องแล้วเท่านั้น (ระยะห่างระหว่างคอลัมน์ที่หาเจอจริง
// ต้องตรงกับที่คาดไว้พอดี) — บล็อกไหนไม่ตรงจะได้แค่ค่าจริง 4 ตัว ไม่ได้เป้า/คะแนน/สถานะ กันโชว์เลขผิด
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
    if (h3 !== 'ยอดขาย' && h3 !== '%ปิดการขาย' && h3 !== 'ยอดขายเปอร์บิล' && h3 !== '% ตีกลับ') continue;
    var mm = parseThaiMonthLabel_(curLabel);
    if (!mm) continue;
    if (!blocks[mm]) blocks[mm] = { month: mm, label: curLabel, colSales: -1, colClose: -1, colAov: -1, colBounce: -1 };
    if (h3 === 'ยอดขาย') blocks[mm].colSales = c2;
    else if (h3 === '%ปิดการขาย') blocks[mm].colClose = c2;
    else if (h3 === 'ยอดขายเปอร์บิล') blocks[mm].colAov = c2;
    else blocks[mm].colBounce = c2;
  }

  // เติมตำแหน่งเป้า/คะแนน/สถานะ เฉพาะบล็อกที่ระยะห่างของ 4 คอลัมน์จริงตรงกับที่คาดไว้พอดี (colSales,+1,+2,+3)
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

// ข้อมูล KPI ของ "ทุกคน" ในเดือนเดียว — cache ไว้ใน CacheService (5 นาที) เพราะเป็นส่วนที่ทำให้โหลดช้า
// (เปิดไฟล์รายชื่อ + ไฟล์ KPI คนละไฟล์ทุกครั้งที่กดแท็บสถิติรายคน แม้แค่ดู leaderboard เฉยๆ) — อ่านจริง
// แค่ครั้งเดียวต่อเดือนต่อ 5 นาที ไม่ว่าจะมีกี่คนกดดูกี่ครั้ง คืนเป็น {ชื่อเล่นแอดมิน: {...ข้อมูลเดือนนั้น}}
function getKpiMonthDataCached_(month) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'kpi_month_v1_' + month;
  var cached = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (e) { /* cache เพี้ยน อ่านใหม่ */ } }

  var rosterMap = getRosterMap_(); // ชื่อเล่น → รหัสพนักงาน
  var empIdToNick = {};
  Object.keys(rosterMap).forEach(function (nick) { empIdToNick[rosterMap[nick]] = nick; });

  var layout = getKpiSheetLayout_();
  var block = layout.blocks[month];
  var result = {};

  if (block) {
    var dataRows = layout.lastRow - 3;
    if (dataRows > 0) {
      var data = layout.sheet.getRange(4, 1, dataRows, layout.lastCol).getDisplayValues();
      for (var r = 0; r < data.length; r++) {
        var row = data[r];
        var nick = empIdToNick[String(row[layout.empIdCol]).trim()];
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
  }

  // เก็บ cache แบบไม่ถือสาถ้าใหญ่เกิน 100KB/key ของ CacheService (แค่ทำให้ครั้งถัดไปช้าเท่าเดิม ไม่ error)
  try { cache.put(cacheKey, JSON.stringify(result), 300); } catch (e) { }
  return result;
}

// ตัดช่องว่างทั้งหมดออกก่อนเทียบ — คอลัมน์ "ชื่อจากไฟล์ต้น" ในไฟล์ Data กลางทีม DA พิมพ์ไม่สม่ำเสมอ
// (บางแถว "เบลล์ (ดาราวดี)" มีวรรค บางแถว "เบลล์(ดาราวดี)" ไม่มีวรรค) ทั้งที่เป็นคนเดียวกัน
function normalizeAdminKey_(s) { return String(s || '').replace(/\s+/g, ''); }

// แถวดิบของไฟล์ Data กลางทีม DA (Data_All Unit in 69) เฉพาะเดือนที่ขอ — cache 5 นาที/เดือน (เหมือน KPI เดิม)
// คอลัมน์: A=UNIT, D=ชื่อจากไฟล์ต้น (join key ตรงกับ Staging.admin เป๊ะ ยกเว้นช่องว่าง — normalizeAdminKey_),
// E=ยอดขายทั้งหมด, G=ยอดตีกลับ(บาท), J=เดือน(1-12, ปีเดียวคือ DA_TEAM_YEAR), K=Order รวม,
// L=ยอดขายลูกค้าใหม่ทั้งหมด, M=Order ลูกค้าใหม่ทั้งหมด, N=ยอดขายลูกค้าเก่าทั้งหมด, O=Order ลูกค้าเก่าทั้งหมด,
// U=% ปิดการขายลูกค้าใหม่, V=% ERROR, Y=จำนวนแชท Ads
//
// เป็นแถวดิบ (ไม่รวมยอดในนี้) เพราะผู้เรียกต้องรวมได้ 2 แบบ: getDaTeamMonthDataCached_() รวมทุกยูนิต
// (ใช้กับ KPI การ์ดรายละเอียด/badge ที่ไม่กรองยูนิต) ส่วน getAdminStats() (leaderboard) ต้องกรองยูนิตได้ด้วย
//
// DA_NAME_ALIASES_: แก้ชื่อพิมพ์ผิดในไฟล์ DA ชั่วคราวระหว่างรอแก้ที่ต้นทาง — ยืนยันแล้วว่า U12
// "เว (เวสารัช)" (ตัวจริงตามไฟล์รายชื่อ) ไม่มีแถวของตัวเองในไฟล์ DA เลย มีแต่แถวที่เอาชื่อเล่น "เวย์"
// (ของอีกคนคือ เวย์ (นภาพร)) มาแปะคู่กับชื่อจริง "เวสารัช" ผิด — ลบบรรทัดนี้ออกทันทีที่แก้ที่ไฟล์ DA แล้ว
var DA_NAME_ALIASES_ = {};
DA_NAME_ALIASES_[normalizeAdminKey_('เวย์ (เวสารัช)')] = normalizeAdminKey_('เว (เวสารัช)');

function getDaTeamMonthRowsCached_(month) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'da_team_rows_v1_' + month;
  var cached = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (e) { /* cache เพี้ยน อ่านใหม่ */ } }

  var rows = [];
  var y = parseInt(month.slice(0, 4), 10), targetMonthNum = parseInt(month.slice(5, 7), 10);
  if (y === DA_TEAM_YEAR) {
    var sh = SpreadsheetApp.openById(DA_TEAM_SHEET_ID).getSheetByName(DA_TEAM_TAB);
    if (!sh) throw new Error('ไม่พบแท็บ "' + DA_TEAM_TAB + '" ในไฟล์ Data กลางทีม DA');
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow > 1) {
      var values = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
      for (var r = 0; r < values.length; r++) {
        var row = values[r];
        var name = String(row[3] || '').trim();
        if (!name) continue; // แถวเปล่า (เดือนที่ยังไม่มีข้อมูลจริง ระบบเว้นที่ไว้ล่วงหน้า)
        if (parseInt(row[9], 10) !== targetMonthNum) continue;
        var key = normalizeAdminKey_(name);
        key = DA_NAME_ALIASES_[key] || key;
        rows.push({
          unit: String(row[0] || '').trim(),
          key: key,
          salesTotal: num_(row[4]), bounceAmt: num_(row[6]), ordersTotal: num_(row[10]),
          salesNew: num_(row[11]), ordersNew: num_(row[12]), salesOld: num_(row[13]), ordersOld: num_(row[14]),
          chatsAds: num_(row[24]), closeVal: pct_(row[20]), errVal: pct_(row[21])
        });
      }
    }
  }
  try { cache.put(cacheKey, JSON.stringify(rows), 300); } catch (e) { }
  return rows;
}

// รวมแถวดิบจาก getDaTeamMonthRowsCached_() (หลายเดือนได้ — ผู้เรียก concat มาก่อน) ตามคนคนเดียวกันมีได้
// หลายแถวในเดือนเดียวกัน (ย้ายไปช่วยหลายยูนิตในเดือนนั้น เช่น เวย์ ทำ U6 บางเดือน/U7 บางเดือน/U12 บางเดือน)
// ต้องรวมทุกแถวของคนนั้นเข้าด้วยกัน ไม่ใช่ใช้แถวสุดท้ายที่เจอเฉยๆ (แบบเดิมทำให้ยอดหายไปเยอะ) ยอดขาย/ออเดอร์
// รวมกันตรงๆ ได้ ส่วน %ตีกลับ/เปอร์บิล/%ปิดการขาย เป็นอัตราส่วน คำนวณจากตัวเลขดิบที่รวมแล้ว (ถ่วงน้ำหนัก
// ตามจำนวนจริง) ไม่ใช่เอา % ของแต่ละแถวมาเฉลี่ยตรงๆ ซึ่งจะผิดถ้าแต่ละแถวมีฐานไม่เท่ากัน
// unitFilter ว่าง/'ทั้งหมด' = ไม่กรอง (รวมทุกยูนิตของคนนั้น)
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
    if (!isNaN(row.closeVal) && row.chatsAds > 0) { a.closeWeighted += row.closeVal * row.chatsAds; a.chatsAdsSum += row.chatsAds; }
    if (!isNaN(row.errVal)) { a.errSum += row.errVal; a.errCount++; }
  });
  return acc;
}

// ดีบั๊ก: คืนทุกแถวดิบของคนคนหนึ่งในเดือนหนึ่งจากไฟล์ Data กลางทีม DA พร้อมยอดรวม — ใช้เช็คว่า sales_total
// ที่ leaderboard โชว์ มาจากการรวมกี่แถว แถวไหนบ้าง (ถ้ามีแถวซ้ำ unit เดียวกันปนอยู่ แปลว่าข้อมูลต้นทาง
// ในไฟล์ DA เองซ้ำ/พิมพ์ผิด ไม่ใช่บั๊กจากโค้ดฝั่งนี้) key เทียบแบบ normalizeAdminKey_ เหมือน getAdminStats()
function getDaDebugRows_(adminExact, month) {
  var key = normalizeAdminKey_(adminExact);
  key = DA_NAME_ALIASES_[key] || key;
  var allRows = getDaTeamMonthRowsCached_(month);
  var matched = allRows.filter(function (r) { return r.key === key; });
  var salesSum = matched.reduce(function (s, r) { return s + r.salesTotal; }, 0);
  return {
    admin_input: adminExact,
    normalized_key: key,
    month: month,
    row_count: matched.length,
    sales_total_sum: round2_(salesSum),
    rows: matched
  };
}

// ยอดขายรวมเดือน/%ปิดการขาย/เปอร์บิล/%ตีกลับ "ของจริงรายคน" รวมทุกยูนิต — ใช้กับ getAdminKpi_()/
// getKpiStatusBatch_() (การ์ดรายละเอียด/badge บน leaderboard ไม่ต้องกรองยูนิต)
function getDaTeamMonthDataCached_(month) {
  var acc = aggregateDaRows_(getDaTeamMonthRowsCached_(month), '');
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
      error_pct: a.errCount ? round2_(a.errSum / a.errCount) : 0
    };
  });
  return result;
}

// % ปิดการขาย (รวม), เปอร์บิล, % ตีกลับ, ยอดขายรวมเดือน ของแอดมินคนเดียว ทุกเดือนที่คาบเกี่ยวกับ [start,end]
// ค่าจริง 4 ตัวนี้มาจากไฟล์ Data กลางทีม DA (join ตรงด้วยชื่อ ไม่ต้องพึ่งรหัสพนักงาน) ส่วนเป้า/คะแนน/สถานะ
// KPI ยังต้องอ่านจากไฟล์ "KPI ฝ่ายขาย FB 2569" เหมือนเดิม เพราะไฟล์ DA ไม่มีคอลัมน์เป้าให้
function getAdminKpi_(adminNickname, start, end) {
  var months = monthsBetween_(start, end);
  var key = normalizeAdminKey_(adminNickname);
  var monthsOut = [];
  months.forEach(function (mm) {
    var da = getDaTeamMonthDataCached_(mm)[key];
    var kpi = null;
    try { kpi = getKpiMonthDataCached_(mm)[adminNickname]; } catch (e) { /* ไฟล์ KPI เดิมพังก็ไม่เป็นไร ยังมีค่าจาก DA */ }
    if (!da && !kpi) return;
    monthsOut.push({
      month: mm,
      label: kpi ? kpi.label : mm,
      sales_actual: da ? da.sales_actual : (kpi ? kpi.sales_actual : null),
      close_rate_total: da ? da.close_rate_total : (kpi ? kpi.close_rate_total : null),
      aov_actual: da ? da.aov_actual : (kpi ? kpi.aov_actual : null),
      bounce_rate: da ? da.bounce_rate : (kpi ? kpi.bounce_rate : null),
      has_targets: !!(kpi && kpi.has_targets),
      sales_target: kpi ? kpi.sales_target : null,
      close_target: kpi ? kpi.close_target : null,
      aov_target: kpi ? kpi.aov_target : null,
      bounce_target: kpi ? kpi.bounce_target : null,
      score: kpi ? kpi.score : null,
      status: kpi ? kpi.status : ''
    });
  });
  if (!monthsOut.length) return { found: false, reason: 'ไม่พบข้อมูลของ "' + adminNickname + '" ในช่วงเดือนที่เลือก (เช็คว่ามีในไฟล์ Data กลางทีม DA ไหม)' };
  return { found: true, months: monthsOut };
}

// สถานะ KPI (ผ่าน/ไม่ผ่าน) + คะแนนรวม (จากไฟล์ KPI เดิม) + % ตีกลับ (จากไฟล์ DA) ของ "หลายคนพร้อมกัน"
// สำหรับหน้าจัดอันดับ (leaderboard) — ใช้เดือนล่าสุดที่คาบเกี่ยวกับ [start,end] เดือนเดียว
function getKpiStatusBatch_(adminNicknames, start, end) {
  var out = {};
  if (!adminNicknames.length) return out;
  var months = monthsBetween_(start, end);
  var lastMonth = months[months.length - 1];
  var daMonthData = getDaTeamMonthDataCached_(lastMonth);
  var kpiMonthData = {};
  try { kpiMonthData = getKpiMonthDataCached_(lastMonth); } catch (e) { /* ไฟล์ KPI เดิมพังก็ไม่เป็นไร ยังมีค่าจาก DA */ }
  adminNicknames.forEach(function (nick) {
    var da = daMonthData[normalizeAdminKey_(nick)];
    var kpi = kpiMonthData[nick];
    if (!da && !kpi) return;
    out[nick] = {
      month: lastMonth,
      score: kpi ? kpi.score : null,
      status: kpi ? kpi.status : '',
      bounce_rate: da ? da.bounce_rate : (kpi ? kpi.bounce_rate : null)
    };
  });
  return out;
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
