"""
ETL: ดึงข้อมูลยอดขายรายเพจ ของแต่ละยูนิต ย้อนหลังตั้งแต่ ม.ค.69 ถึงปัจจุบัน
แล้ว normalize เป็น long-format เขียนลง Staging Sheet ให้ dashboard อ่านต่อได้

ทำไมต้องมีสคริปต์นี้:
- Master catalog (test-รายงานเพจ FB) บอกว่า "เพจไหน อยู่ยูนิตไหน ใครดูแล" แต่ไม่มีตัวเลขยอดขาย
- ไฟล์ต้นทางระดับยูนิต (เช่น U4 HaYeon 69) เก็บยอดขายรายวันแยกเป็น 1 tab ต่อ 1 เพจ
  แต่ละ tab เป็น wide-format: หลายเดือนวางซ้อนกันในแนวตั้ง แต่ละเดือนมีบล็อกหัวตาราง
  (merged cell) ของตัวเอง แล้วตามด้วยแถวข้อมูลรายวัน (dd/mm/yy) จนกว่าจะเจอหัวตารางเดือนถัดไป
  format นี้อ่านเข้าตารางวิเคราะห์/กราฟตรงๆ ไม่ได้ ต้อง unpivot ก่อน
- ชื่อ tab กับชื่อเพจใน master catalog สะกดไม่ตรงกัน (catalog มี "[P1] " นำหน้า, บาง tab มี
  "เพจ" นำหน้า ฯลฯ) ต้องจับคู่ด้วยมือผ่าน tab_to_catalog แทนการเดา fuzzy match
- สคริปต์นี้ join ทุกอย่างเข้าด้วยกัน แล้วเขียนผลลัพธ์แบบ 1 แถว = 1 วัน/1 เพจ ลง Staging Sheet
  (รองรับหลายยูนิตในไฟล์ Staging เดียวกัน — sync ทีละยูนิตจะแทนที่เฉพาะแถวของยูนิตนั้น)

รองรับยูนิตที่ผ่านการยืนยันคอลัมน์แล้วเท่านั้น (ดู UNITS ด้านล่าง) ยูนิตใหม่ต้องเพิ่ม
entry ใน UNITS ก่อน โดยเริ่มจาก --discover เสมอเพื่อยืนยันชื่อ tab จริง + ตำแหน่งคอลัมน์
เพราะแต่ละไฟล์ต้นทางเป็น Google Sheet ที่มนุษย์จัดหน้าด้วยมือ ผังอาจไม่เหมือนกันทุกยูนิต

การติดตั้ง:
  pip install -r requirements.txt
  ใส่ path ไฟล์ credentials ของ service account (glory-sheets-reader-456@...)
  ในตัวแปรแวดล้อม GOOGLE_SERVICE_ACCOUNT_JSON แล้วแชร์สิทธิ์ "Viewer" ให้อีเมลนี้
  กับทั้ง Master catalog และไฟล์ต้นทางของยูนิต (และแชร์สิทธิ์ "Editor" ให้กับ Staging Sheet)

การใช้งาน:
  python sync_pages.py --discover U5                    # แสดงรายชื่อ tab ทั้งหมดของ U5
  python sync_pages.py --discover U5 "ชื่อ tab"          # แสดงบล็อกรายเดือน + หัวตาราง ของ tab นั้น
  python sync_pages.py --unit U4                         # sync จริงเฉพาะ U4 (ต้อง map คอลัมน์ก่อน)
  python sync_pages.py --all                             # sync ทุกยูนิตที่มีอยู่ใน UNITS
"""

import os
import re
import sys
from datetime import datetime

import gspread
from google.oauth2.service_account import Credentials

# ========== CONFIG: แก้ตรงนี้ก่อนรัน ==========
SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "service_account.json")

MASTER_CATALOG_SHEET_ID = "1vjZ2ERd1Q-OAX5yYOgDztemVuF4samjSE5BXZ5snprA"
MASTER_CATALOG_TAB = "ชื่อเพจ"  # ชื่อ tab ในไฟล์ test-รายงานเพจ FB

STAGING_SHEET_ID = "1Jd5jsYoslIpbOtZwQ-skrXir7DIIY1xmRq9jH7htskk"
STAGING_TAB = "staging_รายเพจ"
STAGING_HEADER = ["date", "unit", "page", "admin", "active", "sales", "orders", "ad_spend", "roas"]

# ตั้งค่าต่อยูนิต — เพิ่ม entry ใหม่หลังยืนยันด้วย --discover แล้วเท่านั้น
# page_column_map: {ชื่อ tab: (col_sales, col_orders, col_ad_spend, col_roas)} นับจาก 1 (A=1)
# tab_to_catalog: {ชื่อ tab: ชื่อเพจตรงตัวใน master catalog} เฉพาะเพจที่ยัง active เท่านั้นก็พอ
UNITS = {
    "U4": {
        "source_sheet_id": "1ErfvM4yYMXz7fp1iUaYh7KF9hvu6vwEj6Svo_SmTQ_c",
        "page_tabs": [
            "Ha Yeon-ฮายอง ครีมโสมเกาหลี",
            "Ha-Yeon ครีมโสมสูตรนำเข้าจากเกาหลี",
            "Ha Yeon - ครีมโสมลดฝ้า",                    # active (P3, เบลล์)
            "เพจHa Yeon ครีมฮายอง จากเกาหลี",             # active (P1, เบลล์)
            "เพจ ผิวสวยด้วยครีมฮายอง",
            "เพจHa Yeon ครีมโสมเกาหลี สูตรสลายฝ้า ",
        ],
        "tab_to_catalog": {
            "เพจHa Yeon ครีมฮายอง จากเกาหลี": "[P1] Ha Yeon ครีมฮายอง จากเกาหลี",
            "Ha Yeon - ครีมโสมลดฝ้า": "[P3] Ha Yeon - ครีมโสมลดฝ้า",
        },
        # ยืนยันครบทั้ง 6 tab จาก --discover เมื่อ 8/8/2569: col2=ยอดขายรวมเพจ, col5=Order รวม,
        # col54=ค่าแอด, col60=ROAS รวม (แถวหัวตาราง 5 ชั้น, ข้อมูลเริ่มถัดจากนั้น) —
        # ผังคอลัมน์เหมือนกันทุกเพจของ U4 (คงเป็นเพราะ copy จากแม่แบบเดียวกัน)
        "page_column_map": {
            "Ha Yeon-ฮายอง ครีมโสมเกาหลี": (2, 5, 54, 60),
            "Ha-Yeon ครีมโสมสูตรนำเข้าจากเกาหลี": (2, 5, 54, 60),
            "Ha Yeon - ครีมโสมลดฝ้า": (2, 5, 54, 60),
            "เพจHa Yeon ครีมฮายอง จากเกาหลี": (2, 5, 54, 60),
            "เพจ ผิวสวยด้วยครีมฮายอง": (2, 5, 54, 60),
            "เพจHa Yeon ครีมโสมเกาหลี สูตรสลายฝ้า ": (2, 5, 54, 60),
        },
    },
    "U5": {
        "source_sheet_id": "1ReGkQWnacQG5n3prG12ID0QVbxBYqOVGe5mlqcE_dto",
        # tab เพจที่มีจริง 11 อัน แต่ตรงกับ master catalog (ยัง active) แค่ 4 อัน (P2,P3,P5,P6)
        # ที่เหลือ 7 อัน (สมุนไพรล้างน้ำตาลในเลือด, ดีวาวา-จินเซงบาลานซ์พลัส ฯลฯ) เป็นเพจเก่า
        # ที่เลิกใช้แล้ว ไม่มีใน catalog ปัจจุบัน — เติมเข้า page_tabs ทีหลังถ้าต้องการข้อมูลย้อนหลัง
        # ของเพจเหล่านั้นด้วย ตอนนี้ยังไม่ได้ discover คอลัมน์ของ 7 อันนั้น
        "page_tabs": [
            "DWAWA Ginseng วิตามินบำรุงสุขภาพสูตรใหม่",   # active (P2)
            "DWAWA-Ginseng บาลานซ์พลัส",                # active (P3)
            # "Dwawa Ginseng - ดูแลสุขภาพสูตร 3in1",       # active (P5) — ยังไม่ discover
            # "DWAWA - Ginseng สูตรใหม่ลดน้ำตาลในเลือด",   # active (P6) — ยังไม่ discover
        ],
        "tab_to_catalog": {
            "DWAWA Ginseng วิตามินบำรุงสุขภาพสูตรใหม่": "[P2] DWAWA Ginseng วิตามินบำรุงสุขภาพสูตรใหม่",
            "DWAWA-Ginseng บาลานซ์พลัส": "[P3] DWAWA-Ginseng บาลานซ์พลัส",
        },
        # ยืนยันจาก --discover เมื่อ 8/8/2569: เหมือน U4 เป๊ะ (col2/5/54/60) แต่ tab นี้กว้างกว่า
        # (133-147 คอลัมน์ vs 93 ของ U4) เพราะมีคอลัมน์เผื่อว่างท้ายตาราง ไม่ได้ใช้งานจริง
        "page_column_map": {
            "DWAWA Ginseng วิตามินบำรุงสุขภาพสูตรใหม่": (2, 5, 54, 60),
            "DWAWA-Ginseng บาลานซ์พลัส": (2, 5, 54, 60),
        },
    },
}
# ====================================================


def get_client():
    creds = Credentials.from_service_account_file(
        SERVICE_ACCOUNT_JSON,
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly",
                "https://www.googleapis.com/auth/drive.readonly"],
    )
    return gspread.authorize(creds)


def get_write_client():
    creds = Credentials.from_service_account_file(
        SERVICE_ACCOUNT_JSON,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return gspread.authorize(creds)


def find_date_blocks(values):
    """สแกนทุกแถวหาแถวที่มีคำว่า 'วันที่' อยู่ในคอลัมน์ไหนก็ได้ (แถวหัวตารางของแต่ละบล็อกเดือน)
    คืน list of (row_number_1based, columns_ที่พบคำว่า 'วันที่')
    ใช้หาจุดเริ่มบล็อกเดือนแต่ละบล็อกแบบอัตโนมัติ แทนการไล่นับเอง"""
    blocks = []
    for i, row in enumerate(values, start=1):
        cols = [j + 1 for j, cell in enumerate(row) if cell.strip() == "วันที่"]
        if cols:
            blocks.append((i, cols))
    return blocks


def discover(client, unit_source_sheet_id, unit_label, tab_name=None):
    """ไม่ระบุ tab_name: พิมพ์รายชื่อ tab ทั้งหมดของยูนิตนั้น
    ระบุ tab_name: พิมพ์ตำแหน่งบล็อกรายเดือน (auto-detect) + หัวตาราง/ตัวอย่างข้อมูลของบล็อกแรก
    ไม่เขียนอะไรลง Staging"""
    sh = client.open_by_key(unit_source_sheet_id)

    if not tab_name:
        print(f"=== Tabs ทั้งหมดใน {unit_label} source sheet ===")
        for ws in sh.worksheets():
            print(f"- '{ws.title}'  (rows={ws.row_count}, cols={ws.col_count})")
        print(f"\nรันซ้ำแบบ: python sync_pages.py --discover {unit_label} \"ชื่อ tab\" เพื่อดูรายละเอียดของ tab นั้น")
        return

    ws = sh.worksheet(tab_name)
    values = ws.get_all_values()

    blocks = find_date_blocks(values)
    print(f"=== พบหัวตาราง 'วันที่' ทั้งหมด {len(blocks)} จุดใน '{tab_name}' (แต่ละจุด = 1 บล็อกเดือน) ===")
    for row_num, cols in blocks:
        print(f"row {row_num}: คอลัมน์ {cols}  ->  {values[row_num - 1][:15]}")

    if not blocks:
        print("ไม่พบคำว่า 'วันที่' เลย — โครงสร้างอาจต่างจากที่คาด ต้องเปิดไฟล์ดูเอง")
        return

    first_row = blocks[0][0]
    print(f"\n=== แถว {first_row} ถึง {first_row + 9} (หัวตารางบล็อกแรก + ตัวอย่างข้อมูล 2-3 แถว) ===")
    for i in range(first_row - 1, min(first_row + 9, len(values))):
        print(f"row {i + 1}: {values[i]}")


def parse_thai_short_date(s):
    """แปลง 'dd/mm/yy' (ค.ศ. เช่น 26=2026) -> datetime.date เช่น '01/01/26' -> 2026-01-01"""
    s = (s or "").strip()
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", s)
    if not m:
        return None
    d, mo, y = (int(x) for x in m.groups())
    y = y + 2000 if y < 100 else y
    try:
        return datetime(y, mo, d).date()
    except ValueError:
        return None


def load_master_catalog(client):
    """คืน dict: page_name -> {"unit": ..., "admins": [...]}"""
    sh = client.open_by_key(MASTER_CATALOG_SHEET_ID)
    ws = sh.worksheet(MASTER_CATALOG_TAB)
    rows = ws.get_all_records()  # ใช้แถว 1 เป็น header: UNIT, เพจ, แอดมิน, ชื่อไฟล์, link

    pages = {}
    for r in rows:
        page = str(r.get("เพจ", "")).strip()
        unit = str(r.get("UNIT", "")).strip()
        admin = str(r.get("แอดมิน", "")).strip()
        if not page or not unit:
            continue
        entry = pages.setdefault(page, {"unit": unit, "admins": []})
        if admin and admin not in entry["admins"]:
            entry["admins"].append(admin)
    return pages


def parse_page_tab(ws, unit_name, page_name, col_sales, col_orders, col_ad, col_roas):
    """Unpivot 1 tab (1 เพจ) ทุกบล็อกเดือนที่เจอ -> list of dict (long format)
    คอลัมน์นับจาก 1 (A=1) ใช้ตำแหน่งเดียวกันทุกบล็อกเดือน (สมมติฐานที่ต้องยืนยันด้วย --discover
    ว่าแต่ละเดือนวางคอลัมน์ตรงกันจริง — ถ้าไม่ตรง ต้องแยก map ต่อบล็อกแทน)"""
    values = ws.get_all_values()
    blocks = find_date_blocks(values)
    out = []

    def cell(row, col):
        idx = col - 1
        return row[idx].replace(",", "").strip() if idx < len(row) else ""

    def num(v):
        try:
            return float(v) if v not in ("", None) else None
        except ValueError:
            return None

    for bi, (header_row, _cols) in enumerate(blocks):
        data_start = header_row  # แถวข้อมูลเริ่มถัดจากแถวหัวตารางของบล็อกนี้
        data_end = blocks[bi + 1][0] - 1 if bi + 1 < len(blocks) else len(values)
        for row in values[data_start:data_end]:
            d = parse_thai_short_date(row[0] if row else "")
            if not d:
                continue
            out.append({
                "date": d.isoformat(),
                "unit": unit_name,
                "page": page_name,
                "sales": num(cell(row, col_sales)),
                "orders": num(cell(row, col_orders)),
                "ad_spend": num(cell(row, col_ad)),
                "roas": num(cell(row, col_roas)),
            })
    return out


def read_staging(write_client):
    sh = write_client.open_by_key(STAGING_SHEET_ID)
    try:
        ws = sh.worksheet(STAGING_TAB)
    except gspread.WorksheetNotFound:
        return []
    return ws.get_all_records()


def write_staging(write_client, rows):
    sh = write_client.open_by_key(STAGING_SHEET_ID)
    try:
        ws = sh.worksheet(STAGING_TAB)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=STAGING_TAB, rows=1, cols=len(STAGING_HEADER))

    ws.clear()
    ws.update([STAGING_HEADER] + [[r.get(h, "") for h in STAGING_HEADER] for r in rows], value_input_option="RAW")
    print(f"เขียนรวม {len(rows)} แถว ลง '{STAGING_TAB}' เรียบร้อย")


def sync_unit(read_client, write_client, unit_name, pages, existing_rows):
    cfg = UNITS.get(unit_name)
    if not cfg:
        print(f"ไม่พบการตั้งค่าของ {unit_name} ใน UNITS — รัน --discover {unit_name} ก่อนเพื่อเพิ่ม config")
        return existing_rows

    unit_pages = {p: info for p, info in pages.items() if info["unit"] == unit_name}
    print(f"พบเพจของ {unit_name} ใน master catalog: {len(unit_pages)} เพจ")
    for p, info in unit_pages.items():
        print(f"  - {p}  (แอดมิน: {', '.join(info['admins']) or '-'})")

    page_column_map = cfg["page_column_map"]
    if not page_column_map:
        print(f"[ยังไม่ทำ] {unit_name} ยังไม่ได้ map คอลัมน์ยอดขายของแต่ละ tab เพจ — ข้าม")
        return existing_rows

    sh = read_client.open_by_key(cfg["source_sheet_id"])
    unit_rows = []
    for tab_name in cfg["page_tabs"]:
        mapping = page_column_map.get(tab_name)
        if not mapping:
            print(f"ข้าม '{tab_name}' — ยังไม่มี column mapping")
            continue
        ws = sh.worksheet(tab_name)
        unit_rows += parse_page_tab(ws, unit_name, tab_name, *mapping)

    tab_to_catalog = cfg["tab_to_catalog"]
    for r in unit_rows:
        catalog_name = tab_to_catalog.get(r["page"])
        info = unit_pages.get(catalog_name, {}) if catalog_name else {}
        r["admin"] = ", ".join(info.get("admins", []))
        r["active"] = "active" if info else "inactive"

    # แทนที่เฉพาะแถวของยูนิตนี้ ไม่แตะยูนิตอื่นที่ sync ไว้ก่อนแล้วใน Staging Sheet เดียวกัน
    kept = [r for r in existing_rows if str(r.get("unit", "")).strip() != unit_name]
    return kept + unit_rows


def main():
    args = sys.argv[1:]

    if "--discover" in args:
        idx = args.index("--discover")
        unit_label = args[idx + 1] if idx + 1 < len(args) else None
        tab_name = args[idx + 2] if idx + 2 < len(args) else None
        if not unit_label:
            print("ใช้งาน: python sync_pages.py --discover <UNIT> [\"ชื่อ tab\"]")
            return
        cfg = UNITS.get(unit_label)
        source_sheet_id = cfg["source_sheet_id"] if cfg else None
        if not source_sheet_id:
            print(f"ยังไม่มี source_sheet_id ของ {unit_label} ใน UNITS — เพิ่มก่อน (ต้องรู้ลิงก์ไฟล์ต้นทางของยูนิตนี้)")
            return
        discover(get_client(), source_sheet_id, unit_label, tab_name)
        return

    if "--unit" in args:
        idx = args.index("--unit")
        units_to_sync = [args[idx + 1]] if idx + 1 < len(args) else []
    elif "--all" in args:
        units_to_sync = list(UNITS.keys())
    else:
        print("ใช้งาน: --discover <UNIT> [\"ชื่อ tab\"] | --unit <UNIT> | --all")
        return

    read_client = get_client()
    write_client = get_write_client()
    pages = load_master_catalog(read_client)
    all_rows = read_staging(write_client)

    for unit_name in units_to_sync:
        all_rows = sync_unit(read_client, write_client, unit_name, pages, all_rows)

    write_staging(write_client, all_rows)


if __name__ == "__main__":
    main()
