"""
ETL นำร่อง (pilot): ดึงข้อมูลยอดขายรายเพจ ของยูนิต U4 ย้อนหลังตั้งแต่ ม.ค.69 ถึงปัจจุบัน
แล้ว normalize เป็น long-format เขียนลง Staging Sheet ให้ dashboard อ่านต่อได้

ทำไมต้องมีสคริปต์นี้:
- Master catalog (test-รายงานเพจ FB) บอกว่า "เพจไหน อยู่ยูนิตไหน ใครดูแล" แต่ไม่มีตัวเลขยอดขาย
- ไฟล์ต้นทางระดับยูนิต (เช่น U4 HaYeon 69) เก็บยอดขายรายวันแบบ wide-format
  (1 แถว = 1 วันที่, คอลัมน์เป็นบล็อกซ้ำต่อแอดมิน/เพจ) กระจายอยู่หลาย tab ต่อเดือน
  format นี้อ่านเข้าตารางวิเคราะห์/กราฟตรงๆ ไม่ได้ ต้อง unpivot ก่อน
- สคริปต์นี้ join สองไฟล์เข้าด้วยกัน แล้วเขียนผลลัพธ์แบบ 1 แถว = 1 วัน/1 เพจ ลง Staging Sheet

สถานะ: PILOT สำหรับ U4 เท่านั้น
รัน --discover ก่อนเสมอในการติดตั้งครั้งแรก (หรือทุกครั้งที่ยูนิตต้นทางแก้ผังตาราง)
เพื่อพิมพ์ชื่อ tab จริง + แถวหัวตารางจริงออกมาให้ตรวจสอบ ก่อนจะ map คอลัมน์ให้ตรง
เพราะไฟล์ต้นทางเป็น Google Sheet ที่มนุษย์จัดหน้าด้วยมือ (merged cells, บล็อกไม่เท่ากันทุกเดือน)
การเดา column index ล่วงหน้าโดยไม่เห็นของจริงเสี่ยงข้อมูลผิดทั้งชุด

การติดตั้ง:
  pip install gspread google-auth pandas
  ใส่ path ไฟล์ credentials ของ service account (glory-sheets-reader-456@...)
  ในตัวแปรแวดล้อม GOOGLE_SERVICE_ACCOUNT_JSON แล้วแชร์สิทธิ์ "Viewer" ให้อีเมลนี้
  กับทั้ง Master catalog และไฟล์ต้นทางของยูนิต (และแชร์สิทธิ์ "Editor" ให้กับ Staging Sheet)
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

# ชื่อ tab รายเดือนของยูนิตนี้ (เติมทีละเดือนตามจริง หลังรัน --discover แล้วเห็นชื่อ tab ทั้งหมด)
UNIT_MONTH_TABS = [
    # "UNIT 4 เดือนมกราคม",
    # "UNIT 4 เดือนกุมภาพันธ์",
    # ...
]

# Staging Sheet ปลายทาง (สร้างไฟล์ Google Sheet เปล่าไว้ก่อน แล้วแปะ ID ที่นี่)
STAGING_SHEET_ID = ""
STAGING_TAB = "staging_รายเพจ"

# แถวหัวตาราง 3 ชั้นของแต่ละ tab รายเดือน (นับจาก 1) — ต้องยืนยันด้วย --discover ก่อน
# ตัวอย่างที่พบจริงใน "UNIT 4 เดือนมกราคม" (แถวข้อมูลเริ่มถัดจากนี้):
HEADER_ROWS = (5, 6, 7)  # แถว merged บนสุด / แถวชื่อแอดมิน-เพจ / แถวชื่อเมตริกย่อย
DATE_COL = 1  # คอลัมน์ A = วันที่ (dd/mm/yy พ.ศ. เช่น 01/01/26 = 1 ม.ค. 2569)
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


def discover(client):
    """พิมพ์รายชื่อ tab ทั้งหมดของไฟล์ต้นทาง + แถวหัวตาราง 10 แถวแรกของแต่ละ tab
    ใช้ตรวจสอบก่อน map คอลัมน์จริง ไม่เขียนอะไรลง Staging"""
    sh = client.open_by_key(UNIT_SOURCE_SHEET_ID)
    print(f"=== Tabs ทั้งหมดใน {UNIT_NAME} source sheet ===")
    for ws in sh.worksheets():
        print(f"- '{ws.title}'  (rows={ws.row_count}, cols={ws.col_count})")

    target = UNIT_MONTH_TABS[0] if UNIT_MONTH_TABS else None
    if not target:
        print("\n(ยังไม่ได้ระบุ UNIT_MONTH_TABS — เลือกชื่อ tab จากลิสต์ด้านบนมาใส่ในไฟล์นี้ก่อน)")
        return

    ws = sh.worksheet(target)
    rows = ws.get_all_values()[:12]
    print(f"\n=== 12 แถวแรกของ '{target}' (ใช้หาตำแหน่งแถวหัวตาราง/คอลัมน์วันที่) ===")
    for i, row in enumerate(rows, start=1):
        print(f"row {i}: {row}")


def parse_thai_short_date(s):
    """แปลง 'dd/mm/yy' (พ.ศ.) -> datetime.date (ค.ศ.) เช่น '01/01/26' -> 2026-01-01"""
    s = (s or "").strip()
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", s)
    if not m:
        return None
    d, mo, y = (int(x) for x in m.groups())
    y = y + 2000 if y < 100 else y  # ปี พ.ศ. 2 หลัก แต่ตัวเลขในชีตนี้ตรงกับ ค.ศ. อยู่แล้ว (เช่น 26 = 2026)
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


def parse_month_tab(ws, page_column_map):
    """Unpivot 1 tab รายเดือนของยูนิต -> list of dict (long format)

    page_column_map: list of (page_name, col_sales, col_orders, col_ad_spend, col_roas)
        คอลัมน์นับจาก 1 (A=1) ต้อง map ให้ตรงกับ tab จริง (ดูจาก --discover)
        ต้องกำหนดเองต่อยูนิต/ต่อ tab เพราะผังคอลัมน์ไม่คงที่ทุกเดือน
    """
    values = ws.get_all_values()
    data_start = HEADER_ROWS[-1]  # แถวข้อมูลเริ่มถัดจากแถวหัวตารางสุดท้าย
    out = []
    for row in values[data_start:]:
        if len(row) <= DATE_COL - 1:
            continue
        d = parse_thai_short_date(row[DATE_COL - 1])
        if not d:
            continue
        for page_name, c_sales, c_orders, c_ad, c_roas in page_column_map:
            def cell(col):
                idx = col - 1
                return row[idx].replace(",", "").strip() if idx < len(row) else ""

            def num(v):
                try:
                    return float(v) if v not in ("", None) else None
                except ValueError:
                    return None

            out.append({
                "date": d.isoformat(),
                "unit": UNIT_NAME,
                "page": page_name,
                "sales": num(cell(c_sales)),
                "orders": num(cell(c_orders)),
                "ad_spend": num(cell(c_ad)),
                "roas": num(cell(c_roas)),
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
    dry_run = "--discover" in sys.argv

    read_client = get_client()

    if dry_run:
        discover(read_client)
        return

    if not UNIT_MONTH_TABS:
        print("ยังไม่ได้ตั้งค่า UNIT_MONTH_TABS — รัน `python sync_pages_u4.py --discover` ก่อน")
        return

    pages = load_master_catalog(read_client)
    u4_pages = {p: info for p, info in pages.items() if info["unit"] == UNIT_NAME}
    print(f"พบเพจของ {UNIT_NAME} ใน master catalog: {len(u4_pages)} เพจ")
    for p, info in u4_pages.items():
        print(f"  - {p}  (แอดมิน: {', '.join(info['admins']) or '-'})")

    print(
        "\n[ยังไม่ทำ] ยังไม่ได้ map คอลัมน์ยอดขายในแต่ละ tab รายเดือนให้ตรงกับเพจแต่ละเพจ "
        "(ต้องยืนยันตำแหน่งคอลัมน์จริงจากผล --discover ก่อน แล้วเติมใน page_column_map "
        "ของฟังก์ชัน parse_month_tab สำหรับแต่ละเดือน เพราะผังตารางอาจขยับทุกเดือนที่มีการเพิ่ม/ลดแอดมิน)"
    )

    # ตัวอย่างเมื่อ map คอลัมน์เรียบร้อยแล้ว (ทำต่อทีละ tab ใน UNIT_MONTH_TABS):
    # sh = read_client.open_by_key(UNIT_SOURCE_SHEET_ID)
    # all_rows = []
    # for tab_name in UNIT_MONTH_TABS:
    #     ws = sh.worksheet(tab_name)
    #     page_column_map = [...]  # เฉพาะของ tab_name นี้
    #     all_rows += parse_month_tab(ws, page_column_map)
    # for r in all_rows:
    #     info = u4_pages.get(r["page"], {})
    #     r["admin"] = ", ".join(info.get("admins", []))
    #     r["active"] = "active" if info else "inactive"
    # write_client = get_write_client()
    # write_staging(write_client, all_rows)


if __name__ == "__main__":
    main()
