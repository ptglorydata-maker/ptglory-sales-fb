"""
ETL นำร่อง (pilot): ดึงข้อมูลยอดขายรายเพจ ของยูนิต U4 ย้อนหลังตั้งแต่ ม.ค.69 ถึงปัจจุบัน
แล้ว normalize เป็น long-format เขียนลง Staging Sheet ให้ dashboard อ่านต่อได้

ทำไมต้องมีสคริปต์นี้:
- Master catalog (test-รายงานเพจ FB) บอกว่า "เพจไหน อยู่ยูนิตไหน ใครดูแล" แต่ไม่มีตัวเลขยอดขาย
- ไฟล์ต้นทางระดับยูนิต (เช่น U4 HaYeon 69) เก็บยอดขายรายวันแยกเป็น 1 tab ต่อ 1 เพจ
  (ยืนยันจริงจาก --discover: U4 มี 6 tab ต่อเพจ 6 เพจ ตรงกับที่ทีมแจ้งว่ามี 6 เพจทั้งหมด)
  แต่ละ tab เป็น wide-format: หลายเดือนวางซ้อนกันในแนวตั้ง แต่ละเดือนมีบล็อกหัวตาราง
  (merged cell) ของตัวเอง แล้วตามด้วยแถวข้อมูลรายวัน (dd/mm/yy) จนกว่าจะเจอหัวตารางเดือนถัดไป
  format นี้อ่านเข้าตารางวิเคราะห์/กราฟตรงๆ ไม่ได้ ต้อง unpivot ก่อน
- สคริปต์นี้ join สองไฟล์เข้าด้วยกัน แล้วเขียนผลลัพธ์แบบ 1 แถว = 1 วัน/1 เพจ ลง Staging Sheet

สถานะ: PILOT สำหรับ U4 เท่านั้น
รัน --discover ก่อนเสมอในการติดตั้งครั้งแรก (หรือทุกครั้งที่ยูนิตต้นทางแก้ผังตาราง)
เพื่อพิมพ์ชื่อ tab จริง + ตำแหน่งบล็อกรายเดือน (auto-detect จากแถวที่มีคำว่า "วันที่")
ก่อนจะ map คอลัมน์ให้ตรง เพราะไฟล์ต้นทางเป็น Google Sheet ที่มนุษย์จัดหน้าด้วยมือ
(merged cells, บล็อกไม่เท่ากันทุกเดือน) การเดา column index ล่วงหน้าโดยไม่เห็นของจริง
เสี่ยงข้อมูลผิดทั้งชุด

การติดตั้ง:
  pip install -r requirements.txt
  ใส่ path ไฟล์ credentials ของ service account (glory-sheets-reader-456@...)
  ในตัวแปรแวดล้อม GOOGLE_SERVICE_ACCOUNT_JSON แล้วแชร์สิทธิ์ "Viewer" ให้อีเมลนี้
  กับทั้ง Master catalog และไฟล์ต้นทางของยูนิต (และแชร์สิทธิ์ "Editor" ให้กับ Staging Sheet)

การใช้งาน:
  python sync_pages_u4.py --discover              # แสดงรายชื่อ tab ทั้งหมด
  python sync_pages_u4.py --discover "ชื่อ tab"    # แสดงบล็อกรายเดือน + หัวตาราง ของ tab นั้น
  python sync_pages_u4.py                          # sync จริง (ต้อง map คอลัมน์ให้ครบก่อน)
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

UNIT_NAME = "U4"
UNIT_SOURCE_SHEET_ID = "1ErfvM4yYMXz7fp1iUaYh7KF9hvu6vwEj6Svo_SmTQ_c"

# ชื่อ tab ต่อเพจของยูนิตนี้ (ยืนยันจริงจาก --discover เมื่อ 8/8/2569 — มี 6 เพจ)
UNIT_PAGE_TABS = [
    "Ha Yeon-ฮายอง ครีมโสมเกาหลี",              # active (P1, เบลล์)
    "Ha-Yeon ครีมโสมสูตรนำเข้าจากเกาหลี",
    "Ha Yeon - ครีมโสมลดฝ้า",                    # active (P3, เบลล์)
    "เพจHa Yeon ครีมฮายอง จากเกาหลี",
    "เพจ ผิวสวยด้วยครีมฮายอง",
    "เพจHa Yeon ครีมโสมเกาหลี สูตรสลายฝ้า ",
]

# Staging Sheet ปลายทาง (สร้างไฟล์ Google Sheet เปล่าไว้ก่อน แล้วแปะ ID ที่นี่)
STAGING_SHEET_ID = ""
STAGING_TAB = "staging_รายเพจ"

# ตำแหน่งคอลัมน์ (นับจาก 1, A=1) ต่อบล็อกเดือนในแต่ละ tab เพจ
# key = ชื่อ tab, value = (col_sales, col_orders, col_ad_spend, col_roas)
# ยืนยันครบทั้ง 6 tab จาก --discover เมื่อ 8/8/2569: col2=ยอดขายรวมเพจ, col5=Order รวม,
# col54=ค่าแอด, col60=ROAS รวม (แถวหัวตาราง 5 ชั้น row7-11, ข้อมูลเริ่ม row12) —
# ผังคอลัมน์เหมือนกันทุกเพจของ U4 (คงเป็นเพราะ copy จากแม่แบบเดียวกัน)
PAGE_COLUMN_MAP = {
    "Ha Yeon-ฮายอง ครีมโสมเกาหลี": (2, 5, 54, 60),
    "Ha-Yeon ครีมโสมสูตรนำเข้าจากเกาหลี": (2, 5, 54, 60),
    "Ha Yeon - ครีมโสมลดฝ้า": (2, 5, 54, 60),
    "เพจHa Yeon ครีมฮายอง จากเกาหลี": (2, 5, 54, 60),
    "เพจ ผิวสวยด้วยครีมฮายอง": (2, 5, 54, 60),
    "เพจHa Yeon ครีมโสมเกาหลี สูตรสลายฝ้า ": (2, 5, 54, 60),
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


def discover(client, tab_name=None):
    """ไม่ระบุ tab_name: พิมพ์รายชื่อ tab ทั้งหมด
    ระบุ tab_name: พิมพ์ตำแหน่งบล็อกรายเดือน (auto-detect) + หัวตาราง/ตัวอย่างข้อมูลของบล็อกแรก
    ไม่เขียนอะไรลง Staging"""
    sh = client.open_by_key(UNIT_SOURCE_SHEET_ID)

    if not tab_name:
        print(f"=== Tabs ทั้งหมดใน {UNIT_NAME} source sheet ===")
        for ws in sh.worksheets():
            print(f"- '{ws.title}'  (rows={ws.row_count}, cols={ws.col_count})")
        print("\nรันซ้ำแบบ: python sync_pages_u4.py --discover \"ชื่อ tab\" เพื่อดูรายละเอียดของ tab นั้น")
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


def parse_page_tab(ws, page_name, col_sales, col_orders, col_ad, col_roas):
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
                "unit": UNIT_NAME,
                "page": page_name,
                "sales": num(cell(row, col_sales)),
                "orders": num(cell(row, col_orders)),
                "ad_spend": num(cell(row, col_ad)),
                "roas": num(cell(row, col_roas)),
            })
    return out


def write_staging(write_client, rows):
    if not STAGING_SHEET_ID:
        print("ยังไม่ได้ตั้งค่า STAGING_SHEET_ID — ข้ามขั้นตอนเขียนข้อมูล")
        return
    sh = write_client.open_by_key(STAGING_SHEET_ID)
    try:
        ws = sh.worksheet(STAGING_TAB)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=STAGING_TAB, rows=1, cols=8)

    header = ["date", "unit", "page", "admin", "active", "sales", "orders", "ad_spend", "roas"]
    ws.clear()
    ws.update([header] + [[r.get(h, "") for h in header] for r in rows], value_input_option="RAW")
    print(f"เขียน {len(rows)} แถว ลง '{STAGING_TAB}' เรียบร้อย")


def main():
    args = sys.argv[1:]

    if "--discover" in args:
        idx = args.index("--discover")
        tab_name = args[idx + 1] if idx + 1 < len(args) else None
        discover(get_client(), tab_name)
        return

    read_client = get_client()
    pages = load_master_catalog(read_client)
    u4_pages = {p: info for p, info in pages.items() if info["unit"] == UNIT_NAME}
    print(f"พบเพจของ {UNIT_NAME} ใน master catalog: {len(u4_pages)} เพจ")
    for p, info in u4_pages.items():
        print(f"  - {p}  (แอดมิน: {', '.join(info['admins']) or '-'})")

    if not PAGE_COLUMN_MAP:
        print(
            "\n[ยังไม่ทำ] ยังไม่ได้ map คอลัมน์ยอดขายของแต่ละ tab เพจ "
            "(ต้องยืนยันตำแหน่งคอลัมน์จริงจากผล --discover \"ชื่อ tab\" ก่อน แล้วเติมค่าใน "
            "PAGE_COLUMN_MAP ด้านบนของไฟล์นี้)"
        )
        return

    sh = read_client.open_by_key(UNIT_SOURCE_SHEET_ID)
    all_rows = []
    for tab_name in UNIT_PAGE_TABS:
        mapping = PAGE_COLUMN_MAP.get(tab_name)
        if not mapping:
            print(f"ข้าม '{tab_name}' — ยังไม่มี column mapping")
            continue
        ws = sh.worksheet(tab_name)
        all_rows += parse_page_tab(ws, tab_name, *mapping)

    for r in all_rows:
        info = u4_pages.get(r["page"], {})
        r["admin"] = ", ".join(info.get("admins", []))
        r["active"] = "active" if info else "inactive"

    write_client = get_write_client()
    write_staging(write_client, all_rows)


if __name__ == "__main__":
    main()
