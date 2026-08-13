"""
ETL: ดึงข้อมูลรายเพจ ของแต่ละยูนิต ย้อนหลังตั้งแต่ ม.ค.69 ถึงปัจจุบัน แล้ว normalize เป็น
long-format เขียนลง Staging Sheet ให้ dashboard อ่านต่อได้

คอลัมน์ที่ดึง (ดู STAGING_HEADER): งบที่ใช้ไป, รวมคนทักใหม่(ฝั่งแอด), คนทักใหม่(ฝั่งแอดมิน),
ต้นทุนทัก, ยอดขายรวม/ใหม่/เก่า, ออเดอร์รวม/ใหม่/เก่า, %ปิดใหม่, %ค่า ADS, ROAS ใหม่/รวม,
%ERROR รายเพจ — ครบตามที่ขอ 8/8/2569 (ก่อนหน้านี้ดึงแค่ ยอดขายรวม/ออเดอร์รวม/ค่าแอด/ROAS รวม)

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

สำคัญ: ตำแหน่งคอลัมน์ยอดขาย/ออเดอร์/ค่าแอด/ROAS **ไม่ hardcode** เป็นเลขคอลัมน์คงที่
เพราะพิสูจน์แล้วว่าใช้ไม่ได้จริง — ถ้าเพจไหนมีแอดมินเพิ่ม/ลดระหว่างปี ส่วนหัวตารางของบล็อกเดือน
นั้นจะกว้าง/แคบกว่าบล็อกอื่น ทำให้ตำแหน่งคอลัมน์ของ ค่าแอด/ROAS ขยับไปคนละที่ในแต่ละเดือน
สคริปต์นี้จึงค้นหาตำแหน่งคอลัมน์จากข้อความหัวตาราง ("ยอดขาย", "Order", "ค่าแอด", "ROAS\nรวม")
**ใหม่ทุกบล็อกเดือน** แทน จึงทนต่อการเปลี่ยนแปลงผังระหว่างปีได้

รองรับยูนิตที่เพิ่ม entry ใน UNITS แล้วเท่านั้น ยูนิตใหม่ต้องรัน --discover ก่อนเสมอ
เพื่อยืนยันชื่อ tab จริง (ไม่ต้องยืนยันตำแหน่งคอลัมน์อีกต่อไป เพราะหาอัตโนมัติแล้ว)

การติดตั้ง:
  pip install -r requirements.txt
  ใส่ path ไฟล์ credentials ของ service account (glory-sheets-reader-456@...)
  ในตัวแปรแวดล้อม GOOGLE_SERVICE_ACCOUNT_JSON แล้วแชร์สิทธิ์ "Viewer" ให้อีเมลนี้
  กับทั้ง Master catalog และไฟล์ต้นทางของยูนิต (และแชร์สิทธิ์ "Editor" ให้กับ Staging Sheet)

การใช้งาน:
  python sync_pages.py --discover U5                    # แสดงรายชื่อ tab ทั้งหมดของ U5
  python sync_pages.py --discover U5 "ชื่อ tab"          # แสดงบล็อกรายเดือน + หัวตาราง ของ tab นั้น
  python sync_pages.py --catalog U5                      # แสดงรายชื่อเพจของ U5 ใน master catalog (ช่วยจับคู่กับ tab)
  python sync_pages.py --unit U4                         # sync จริงเฉพาะ U4 (ต้อง map คอลัมน์ก่อน)
  python sync_pages.py --all                             # sync ทุกยูนิตที่มีอยู่ใน UNITS
"""

import os
import re
import sys
import time
from datetime import datetime

import gspread
from google.oauth2.service_account import Credentials


def call_with_retry(fn, *args, max_retries=6, **kwargs):
    """เรียก gspread API พร้อม retry แบบ exponential backoff เมื่อเจอ rate limit (429)
    จำเป็นเพราะ --all ยิง read requests รัวๆ หลายสิบครั้งในไม่กี่วินาที เกิน Google Sheets API
    quota เริ่มต้น (60 read requests/นาที/user) ได้ง่าย โดยเฉพาะตอนรันบน GitHub Actions
    ที่ไม่มีดีเลย์ระหว่างคำสั่งเหมือนตอนรันมือทีละยูนิต"""
    delay = 5
    for attempt in range(max_retries):
        try:
            return fn(*args, **kwargs)
        except gspread.exceptions.APIError as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 429 and attempt < max_retries - 1:
                print(f"  [rate limit] เจอ 429 รอ {delay}s แล้วลองใหม่ ({attempt + 1}/{max_retries})")
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            raise

# ========== CONFIG: แก้ตรงนี้ก่อนรัน ==========
SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "service_account.json")

MASTER_CATALOG_SHEET_ID = "1vjZ2ERd1Q-OAX5yYOgDztemVuF4samjSE5BXZ5snprA"
MASTER_CATALOG_TAB = "ชื่อเพจ"  # ชื่อ tab ในไฟล์ test-รายงานเพจ FB

STAGING_SHEET_ID = "1Jd5jsYoslIpbOtZwQ-skrXir7DIIY1xmRq9jH7htskk"
STAGING_TAB = "staging_รายเพจ"
STAGING_HEADER = [
    "date", "unit", "page", "admin", "active",
    "ad_spend",          # งบที่ใช้ไป
    "chats_ads",         # รวมคนทักใหม่ (ฝั่งแอด)
    "chats_admin",       # คนทักใหม่ (ฝั่งแอดมิน)
    "cost_per_chat",     # ต้นทุนทัก
    "sales_total",       # ยอดขายรวม
    "sales_new",         # ยอดขายใหม่
    "sales_old",         # ยอดขายเก่า
    "orders_total",      # ออเดอร์รวม
    "orders_new",        # ออเดอร์ใหม่
    "orders_old",        # ออเดอร์เก่า
    "close_rate_new",    # % ปิดใหม่
    "ads_pct",           # % ค่า ADS
    "roas_new",          # ROAS ใหม่
    "roas_total",        # ROAS รวม
    "error_pct",         # % ERROR รายเพจ
]

# ตั้งค่าต่อยูนิต — เพิ่ม entry ใหม่หลังยืนยันชื่อ tab ด้วย --discover
# tab_to_catalog: {ชื่อ tab: ชื่อเพจตรงตัวใน master catalog} เฉพาะเพจที่ยัง active เท่านั้นก็พอ
UNITS = {
    "U4": {
        "source_sheet_id": "1ErfvM4yYMXz7fp1iUaYh7KF9hvu6vwEj6Svo_SmTQ_c",
        "page_tabs": [
            "Ha Yeon-ฮายอง ครีมโสมเกาหลี",
            "Ha-Yeon ครีมโสมสูตรนำเข้าจากเกาหลี",
            "P3 Ha Yeon - ครีมโสมลดฝ้า",                 # active (P3, เบลล์) — เปลี่ยนชื่อ tab เมื่อ 8/8/2569
            "เพจHa Yeon ครีมฮายอง จากเกาหลี",             # active (P1, เบลล์)
            "เพจ ผิวสวยด้วยครีมฮายอง",
            "เพจHa Yeon ครีมโสมเกาหลี สูตรสลายฝ้า ",
        ],
        "tab_to_catalog": {
            "เพจHa Yeon ครีมฮายอง จากเกาหลี": "[P1] Ha Yeon ครีมฮายอง จากเกาหลี",
            "P3 Ha Yeon - ครีมโสมลดฝ้า": "[P3] Ha Yeon - ครีมโสมลดฝ้า",
        },
    },
    "U5": {
        "source_sheet_id": "1ReGkQWnacQG5n3prG12ID0QVbxBYqOVGe5mlqcE_dto",
        # tab เพจที่มีจริง 11 อัน แต่ตรงกับ master catalog (ยัง active) แค่ 4 อัน (P2,P3,P5,P6)
        # ที่เหลือ 7 อัน (สมุนไพรล้างน้ำตาลในเลือด, ดีวาวา-จินเซงบาลานซ์พลัส ฯลฯ) เป็นเพจเก่า
        # ที่เลิกใช้แล้ว ไม่มีใน catalog ปัจจุบัน — เติมเข้า page_tabs ทีหลังถ้าต้องการข้อมูลย้อนหลัง
        # ของเพจเหล่านั้นด้วย
        "page_tabs": [
            "DWAWA Ginseng วิตามินบำรุงสุขภาพสูตรใหม่",   # active (P2)
            "DWAWA-Ginseng บาลานซ์พลัส",                # active (P3)
            "Dwawa Ginseng - ดูแลสุขภาพสูตร 3in1",       # active (P5)
            "DWAWA - Ginseng สูตรใหม่ลดน้ำตาลในเลือด",   # active (P6)
        ],
        "tab_to_catalog": {
            "DWAWA Ginseng วิตามินบำรุงสุขภาพสูตรใหม่": "[P2] DWAWA Ginseng วิตามินบำรุงสุขภาพสูตรใหม่",
            "DWAWA-Ginseng บาลานซ์พลัส": "[P3] DWAWA-Ginseng บาลานซ์พลัส",
            "Dwawa Ginseng - ดูแลสุขภาพสูตร 3in1": "[P5] Dwawa Ginseng - ดูแลสุขภาพสูตร 3in1",
            "DWAWA - Ginseng สูตรใหม่ลดน้ำตาลในเลือด": "[P6] DWAWA - Ginseng สูตรใหม่ลดน้ำตาลในเลือด",
        },
    },
    "U6": {
        "source_sheet_id": "1yyRK43rWM-BfoMII3z5KxrAIGQAY0pZwN9jXjluJRfA",
        # master catalog ไม่มีแถวของ U6 เลยสักแถว (เช็ค 8/8/2569) — ดึงข้อมูลไปก่อนตามที่ตกลง
        # แปลว่าทุกเพจจะขึ้น active="inactive", admin="" ใน Staging ไปพลางๆ จนกว่าจะมีคน
        # เพิ่มแถว U6 ใน catalog แล้วค่อยมา sync ใหม่ให้ join ถูก
        # tab จริงมี 30 อัน กรองแล้วเหลือ tab ที่เป็น "เพจ" จริง 7 อัน (นอกนั้นเป็น
        # tab สรุป/tab ต่อแอดมิน)
        "page_tabs": [
            "เพจVerna Plus - ดับเบิ้ลแคปซูลเจ้าแรก",
            "เพจVERNA PLUS ดีท็อกผัก ลดหุ่นเจ้าแรก",
            "เพจVerna Plus-วีนาพลัส ดีท็อกผัก",
            "เพจVerna Plus - แคปซูลสองชั้น กระชับสัดส่วน ",
            "เพจVerna Plus - วิตามินผักดับเบิ้ลแคปซูล ",
            "Verna Plus - ดับเบิ้ลแคปซูล 2in1 ",
            "เพจVerna Plus - วิตามินผักดับเบิ้ลแคปซูลสูตรใหม่นำ",
        ],
        "tab_to_catalog": {},  # ว่างไว้ก่อน เพราะ catalog ยังไม่มีแถว U6 ให้จับคู่
    },
    "U7": {
        "source_sheet_id": "1sar_VxuTfoFXTlmX9ntnKrJPxgO_ecWnFK2cqoZXclY",
        # ไฟล์มี tab เพจจริง 13 อัน ตรงกับ master catalog (ยัง active) แค่ 3 อัน (P1,P2,P3)
        # ที่เหลือเป็นเพจเก่าที่เลิกใช้แล้ว ไม่มีใน catalog — สะกดชื่อ tab ไม่ตรงกับ catalog เป๊ะ
        # (อะพอสทรอฟีคนละตัวกัน ' vs ’, ตัวสะกดเพี้ยนเล็กน้อย) ต้อง map มือ
        "page_tabs": [
            "D'Lellise Probiovita-น้ำชงโพรไบโอติก เพื่อผู้หญิง",              # active (P1)
            "D’lellise ProbioVita น้ำชงโพรไบโอติกส์ เพื่อสุขภาพผู้หญิง",       # active (P2)
            "D'Lellise Probiovita-โพรไบโอติกส์ ดูแลภายในสตรี",               # active (P3)
        ],
        "tab_to_catalog": {
            "D'Lellise Probiovita-น้ำชงโพรไบโอติก เพื่อผู้หญิง": "[P1] D'Lellise Probiovita-น้ำชงโพรไบโอติก เพื่อผู้หญิง",
            "D’lellise ProbioVita น้ำชงโพรไบโอติกส์ เพื่อสุขภาพผู้หญิง": "[P2] D'lellise ProbioVita น้ำชงโพรไบโอติกส์ เพื่อสุขภาพผู้หญิง",
            "D'Lellise Probiovita-โพรไบโอติกส์ ดูแลภายในสตรี": "[P3] D'lellise ProbioVita-โพรไบโอติกส์ ดูเเลภายในสตรี",
        },
    },
    "U8": {
        "source_sheet_id": "1WkITiROQINlT0-sZzRa2R1IjVe5i29aiZgPPT6yEbxE",
        # ไฟล์มี tab เพจจริง 12 อัน ตรงกับ master catalog (ยัง active) แค่ 2 อัน (P2,P4)
        # ที่เหลือเป็นเพจเก่าที่เลิกใช้แล้ว ไม่มีใน catalog
        "page_tabs": [
            "D'Lellise-We Me Vistra จบปัญหาฉี่บ่อย ฉี่แสบขัด ",   # active (P2)
            "We-me Vistra วิตามินดูแลฉี่แสบขัด",                  # active (P4)
        ],
        "tab_to_catalog": {
            "D'Lellise-We Me Vistra จบปัญหาฉี่บ่อย ฉี่แสบขัด ": "[P2] D'Lellise-We Me Vistra จบปัญหาฉี่บ่อย ฉี่แสบขัด",
            "We-me Vistra วิตามินดูแลฉี่แสบขัด": "[P4] We-me Vistra วิตามินดูแลฉี่แสบขัด",
        },
    },
    "U9": {
        "source_sheet_id": "1-faRZ6_on39EAAff-mzWPjSvDsDApLP2IKT-9IeQ2fw",
        # master catalog มี U9 5 เพจ: [P8] Levonglow-ชาแม่แย้มดูแลโดยแพทย์แผนไทย (บีม),
        # [P2] Levonglow-ชาแม่แย้มลดเบาหวาน โดยแพทย์เเผนไทย (เกม),
        # [P3] ชาสมุนไพรแม่แย้ม - ดูแลสุขภาพโดยแพทย์แผนไทย เพจหลัก (แนน, ก้อย),
        # [P5] ชาแม่แย้มตราลีวองโกลว์-จบทุกปัญหาเบาหวาน ความดัน (เมย์),
        # [P7] Levonglow-ชาแม่แย้ม ลดเบาหวาน (ปอนด์, ก้อย)
        # ไฟล์มี tab เพจจริง 8 อัน ตรงกับ catalog 5 อัน (P2,P3,P5,P7,P8) ที่เหลือเป็นเพจเก่า
        "page_tabs": [
            "[P8]Levonglow-ชาแม่แย้มดูแลโดยแพทย์แผนไทย",
            "Levonglow-ชาแม่แย้มลดเบาหวาน โดยแพทย์เเผนไทย",
            "เพจชาสมุนไพรแม่แย้ม - ดูแลสุขภาพโดยแพทย์แผนไทยเพจ",
            "เพจชาแม่แย้มตราลีวองโกลว์-จบทุกปัญหาเบาหวาน ความดัน",
            "Levonglow-ชาแม่แย้ม ลดเบาหวาน",
        ],
        "tab_to_catalog": {
            "[P8]Levonglow-ชาแม่แย้มดูแลโดยแพทย์แผนไทย": "[P8] Levonglow-ชาแม่แย้มดูแลโดยแพทย์แผนไทย",
            "Levonglow-ชาแม่แย้มลดเบาหวาน โดยแพทย์เเผนไทย": "[P2] Levonglow-ชาแม่แย้มลดเบาหวาน โดยแพทย์เเผนไทย",
            "เพจชาสมุนไพรแม่แย้ม - ดูแลสุขภาพโดยแพทย์แผนไทยเพจ": "[P3] ชาสมุนไพรแม่แย้ม - ดูแลสุขภาพโดยแพทย์แผนไทย เพจหลัก",
            "เพจชาแม่แย้มตราลีวองโกลว์-จบทุกปัญหาเบาหวาน ความดัน": "[P5] ชาแม่แย้มตราลีวองโกลว์-จบทุกปัญหาเบาหวาน ความดัน",
            "Levonglow-ชาแม่แย้ม ลดเบาหวาน": "[P7] Levonglow-ชาแม่แย้ม ลดเบาหวาน",
        },
    },
    "U10": {
        "source_sheet_id": "1f7Wwk3lzXIaqVJorj_UgWLs5ruCv0pDL_1GIhMUZ14U",
        # master catalog ไม่มีแถวของ U10 เลยสักแถว (เช็ค 8/8/2569) เหมือน U6 — ดึงข้อมูลไปก่อน
        # ตามที่ตกลง ทุกเพจจะขึ้น active="inactive", admin="" ใน Staging ไปพลางๆ
        # tab จริงมี 26 อัน กรองแล้วเหลือ tab ที่เป็น "เพจ" จริง 12 อัน (นอกนั้นเป็น
        # tab สรุป/tab ต่อแอดมิน)
        "page_tabs": [
            "เพจวิตามินผักเวจจี้4",
            "เพจวิตามินผักเวจจี้3",
            "Veggy-วิตามินผักปั้นหุ่นสวยสูตรนำเข้าUSA ",
            "Veggy - วิตามินผักพรีเมี่ยมสูตรแพทย์อเมริกา ",
            "Veggy-เวจจี้ วิตามินผักเพจบริษัท",
            "Veggy - คุมหิว สูตรใหม่นำเข้า ",
            "Veggy - วิตามินผักอัดเม็ดเจ้าแรก",
            "เพจVeggy เวจจี้ วิตามินผักนำเข้าจากอเมริกา",
            "เพจวิตามินผักเวจจี้ กระชับหุ่น",
            "เพจveggy",
            "เพจ วิตามินผักเวจจี้2",
            "เพจVeggy By USA",
        ],
        "tab_to_catalog": {},  # ว่างไว้ก่อน เพราะ catalog ยังไม่มีแถว U10 ให้จับคู่
    },
    "U11": {
        "source_sheet_id": "1UAPPC3BZdpz7i6zKibvOJfC7oLJOp8C0u5oQ7KPCYJg",
        # master catalog มี U11 4 เพจ (แต่ละเพจมีแอดมิน 6-7 คน):
        # [P1] วิตามินดูแลผู้หญิง D'Lellise - เพจหลักบริษัท
        #   (นายด์, แป้ง, ประกาย, กิ๊ก, บีม (อรนิชา), ใบพลู)
        # [P2] วิตามินดูแลสุขภาพภายในผู้หญิง by D'Lellise
        #   (นายด์, แป้ง, ประกาย, กิ๊ก, บีม (อรนิชา), มีน, ใบพลู)
        # [P4] D'Lellise - วิตามินดูแลผู้หญิงเอกสิทธิ์ 1 เดียวในไทย
        #   (นายด์, แป้ง, ประกาย, กิ๊ก, บีม (อรนิชา), มีน, ใบพลู)
        # [P6] D'Lellise วิตามินบำรุงภายในผู้หญิง เพจหลัก-เจ้าของแบรนด์ (บีม (อรนิชา), ใบพลู)
        # ไฟล์มี tab เพจจริงหลายอัน ตรงกับ catalog (ยัง active) แค่ 4 อัน (P1,P2,P4,P6)
        # ที่เหลือเป็นเพจเก่าที่เลิกใช้แล้ว
        "page_tabs": [
            "เพจวิตมินดูแลผู้หญิง D'Lellise - เพจหลักบริษัท",              # active (P1)
            "วิตามินดูแลสุขภาพภายในผู้หญิง by D'Lellise",                  # active (P2)
            "D'Lellise-วิตามินดูแลผู้หญิงเอกสิทธิ์1เดียวในไทย",            # active (P4)
            "D'Lellise วิตามินบำรุงภายในผู้หญิง เพจหลัก-เจ้าของ",          # active (P6)
        ],
        "tab_to_catalog": {
            "เพจวิตมินดูแลผู้หญิง D'Lellise - เพจหลักบริษัท": "[P1] วิตามินดูแลผู้หญิง D'Lellise - เพจหลักบริษัท",
            "วิตามินดูแลสุขภาพภายในผู้หญิง by D'Lellise": "[P2] วิตามินดูแลสุขภาพภายในผู้หญิง by D'Lellise",
            "D'Lellise-วิตามินดูแลผู้หญิงเอกสิทธิ์1เดียวในไทย": "[P4] D’Lellise - วิตามินดูแลผู้หญิงเอกสิทธิ์ 1 เดียวในไทย",
            "D'Lellise วิตามินบำรุงภายในผู้หญิง เพจหลัก-เจ้าของ": "[P6] D'Lellise วิตามินบำรุงภายในผู้หญิง เพจหลัก-เจ้าของแบรนด์",
        },
    },
    "U12": {
        "source_sheet_id": "1Sh3v26TwSkRgT4Bz_BDBjddoTUpcUCVHMqoRJXluz1M",
        # master catalog มี U12 7 เพจ:
        # [P1] เจสัน เอ็ม - วิตามินบำรุงต่อมลูกหมาก เพจบริษัท (เกส, พลอย, จ๊อบ)
        # [P2] DWAWA - Jason M มัลติวิตามินดูแลท่านชาย (เกส)
        # [P5] ดีวาวา-เจสัน เอ็ม วิตามินต่อมลูกหมากสูตรนำเข้า (เวย์, กานต์, จ๊อบ)
        # [P6] DWAWA Jason M ดูแลต่อมลูกหมาก สูตรแพทย์เฉพาะทาง (เวย์)
        # [P7] DWAWA - Jason M Valtora-x มัลติวิตามิน (กานต์)
        # [P8] DWAWA Jason M Valtora-x ดูแลท่านชายโดยเฉพาะ (พลอย, เว)
        # [P9] Jason M Valtora-x ดูแลท่านชายวัย40+ (เว)
        # ไฟล์มี tab เพจจริงหลายอัน ตรงกับ catalog (ยัง active) ครบทั้ง 7 อัน
        "page_tabs": [
            "เจสัน เอ็ม - วิตามินบำรุงต่อมลูกหมาก เพจบริษัท",       # active (P1)
            "DWAWA - Jason M มัลติวิตามินดูแลท่านชาย",             # active (P2)
            "ดีวาวา-เจสัน เอ็ม วิตามินต่อมลูกหมากสูตรนำเข้า",       # active (P5)
            "DWAWA Jason M ดูแลต่อมลูกหมาก สูตรแพทย์เฉพาะทาง",     # active (P6)
            "DWAWA - Jason M Valtora-x มัลติวิตามิน",              # active (P7)
            "DWAWA  Jason M Valtora-x ดูแลท่านชายโดยเฉพาะ",        # active (P8) — เว้นวรรคซ้อน
            "Jason M Valtora-x ดูแลท่านชายวัย40+",                 # active (P9)
        ],
        "tab_to_catalog": {
            "เจสัน เอ็ม - วิตามินบำรุงต่อมลูกหมาก เพจบริษัท": "[P1] เจสัน เอ็ม - วิตามินบำรุงต่อมลูกหมาก เพจบริษัท",
            "DWAWA - Jason M มัลติวิตามินดูแลท่านชาย": "[P2] DWAWA - Jason M มัลติวิตามินดูแลท่านชาย",
            "ดีวาวา-เจสัน เอ็ม วิตามินต่อมลูกหมากสูตรนำเข้า": "[P5] ดีวาวา-เจสัน เอ็ม วิตามินต่อมลูกหมากสูตรนำเข้า",
            "DWAWA Jason M ดูแลต่อมลูกหมาก สูตรแพทย์เฉพาะทาง": "[P6] DWAWA Jason M ดูแลต่อมลูกหมาก สูตรแพทย์เฉพาะทาง",
            "DWAWA - Jason M Valtora-x มัลติวิตามิน": "[P7] DWAWA - Jason M Valtora-x มัลติวิตามิน",
            "DWAWA  Jason M Valtora-x ดูแลท่านชายโดยเฉพาะ": "[P8] DWAWA Jason M Valtora-x ดูแลท่านชายโดยเฉพาะ",
            "Jason M Valtora-x ดูแลท่านชายวัย40+": "[P9] Jason M Valtora-x ดูแลท่านชายวัย40+",
        },
    },
    "U13": {
        "source_sheet_id": "1ALVsnqiN4iEiDzYeG5wNO3YHsKG9wbO3mDBLf7qPHpw",
        # master catalog มี U13 3 เพจ (แอดมินชุดเดียวกันทั้ง 3 เพจ: กิ๊ฟท์, เมย์, ไอซ์, แอ้ม):
        # [P1] Lunary - วิตามินผลไม้รวม กระชับหุ่น
        # [P2] Lunary- วิตามินผลไม้รวมลดหุ่น แบบเร่งด่วน
        # [P3] Lunary-วิตามินผลไม้ลดหุ่น สูตรลับเฉพาะแบรนด์ดีวาวา
        # ไฟล์นี้มี tab ของ "U13 Fiber" (catalog แยกยูนิตต่างหาก) ปนอยู่ด้วย — ยังไม่เพิ่มตอนนี้
        "page_tabs": [
            "เพจLUNARY - วิตามินผลไม้รวม กระชับหุ่น",                       # active (P1)
            "เพจLUNARY - วิตามินผลไม้รวมลดหุ่น แบบเร่งด่วน",                # active (P2)
            "Lunary-วิตามินผลไม้ลดหุ่นสูตรลับเฉพาะแบรนด์ดีวาวา",           # active (P3)
        ],
        "tab_to_catalog": {
            "เพจLUNARY - วิตามินผลไม้รวม กระชับหุ่น": "[P1] Lunary - วิตามินผลไม้รวม กระชับหุ่น",
            "เพจLUNARY - วิตามินผลไม้รวมลดหุ่น แบบเร่งด่วน": "[P2] Lunary- วิตามินผลไม้รวมลดหุ่น แบบเร่งด่วน",
            "Lunary-วิตามินผลไม้ลดหุ่นสูตรลับเฉพาะแบรนด์ดีวาวา": "[P3] Lunary-วิตามินผลไม้ลดหุ่น สูตรลับเฉพาะแบรนด์ดีวาวา",
        },
    },
    "U13 Fiber": {
        # ไฟล์ต้นทางเดียวกับ U13 (ทีมรวม tab ไว้ในไฟล์เดียวกัน) แต่ catalog แยกเป็นคนละ unit
        "source_sheet_id": "1ALVsnqiN4iEiDzYeG5wNO3YHsKG9wbO3mDBLf7qPHpw",
        # master catalog มี U13 Fiber 1 เพจ: [P1] DWAWA-Lunaryไฟเบอร์สูตรปรับระบบขับถ่าย (ฟาง)
        "page_tabs": [
            "DWAWA-Lunaryไฟเบอร์สูตรปรับระบบขับถ่าย",  # active (P1)
        ],
        "tab_to_catalog": {
            "DWAWA-Lunaryไฟเบอร์สูตรปรับระบบขับถ่าย": "[P1] DWAWA-Lunaryไฟเบอร์สูตรปรับระบบขับถ่าย",
        },
    },
    "U14": {
        "source_sheet_id": "1xciBGrv9qCWCrkRakPOa77HZVmr0Yf-k4iQG0XY8pl8",
        # master catalog มี U14 2 เพจ:
        # [P1] พลูคาวพลัส พ่อทองชิต-ดูแลทุกปัญหาผื่นคัน (ภา)
        # [P2] พลูคาวพลัส ตราพ่อทองชิด - จบทุกปัญหาผิวหนัง (ส้ม)
        # P2 คลุมเครือเล็กน้อย: มี 2 tab สะกดคล้าย catalog — เลือกอันที่ข้อความตรงกัน
        # ("จบทุกปัญหาผิวหนัง") มากกว่า แม้สะกดแบรนด์ต่างนิดหน่อย (ชิต/ชิด)
        "page_tabs": [
            "เพจพลูคาวพลัส พ่อทองชิต-ดูแลทุกปัญหาผื่นคัน",   # active (P1)
            "เพจพลูคาวพลัส พ่อทองชิต-จบทุกปัญหาผิวหนัง",     # active (P2)
        ],
        "tab_to_catalog": {
            "เพจพลูคาวพลัส พ่อทองชิต-ดูแลทุกปัญหาผื่นคัน": "[P1] พลูคาวพลัส พ่อทองชิต-ดูแลทุกปัญหาผื่นคัน",
            "เพจพลูคาวพลัส พ่อทองชิต-จบทุกปัญหาผิวหนัง": "[P2] พลูคาวพลัส ตราพ่อทองชิด - จบทุกปัญหาผิวหนัง",
        },
    },
    "U15": {
        "source_sheet_id": "1GaLaa1z6MNAORYl0GrjftzGQ2n5KE112FRnbDLSLr9Q",
        # master catalog มี U15 6 เพจ:
        # [P1] DWAWA - Multi Green Veggie ลดไขมันในเลือด (มายด์, นุ๊ก)
        # [P2] DWAWA - Multi Green Veggie ดีท็อกซ์ไขมันในเลือด (ฟ้า, นุ๊ก)
        # [P3] Dwawa - Multi Green Veggie ดูแลสุขภาพ (ปลา, ต้นข้าว, มายด์)
        # [P4] Dwawa-Multi GreenVeggie ราชินีผักเขียว ดีท็อกซ์ไขมันในเลือด (โอปอ)
        # [P5] Multi Green Veggie ฟื้นฟูไขมันในเลือด (เอ็มเค, โอปอ)
        # [P6] DWAWA-Multi Green Veggie ผงผักนาโน ดูแลระดับไขมันในเลือด (ต้นข้าว, มาร์ค)
        "page_tabs": [
            "เพจDWAWA - Multi Green Veggie ลดไขมันในเลือด ",                       # active (P1)
            "เพจDWAWA - Multi Green Veggie ดีท็อกซ์ไขมันในเลือด",                  # active (P2)
            "เพจ Dwawa - Multi Green Veggie ดูแลสุขภาพ",                          # active (P3)
            "Dwawa-Multi GreenVeggie ราชินีผักเขียว ดีท็อกซ์ไขมันในเลือด",          # active (P4)
            "เพจ DWAWA - Multi Green Veggie ฟื้นฟูไขมันในเลือด",                   # active (P5)
            "DWAWA-Multi Green Veggie ผงผักนาโน ดูแลระดับไขมันในเลือด",           # active (P6)
        ],
        "tab_to_catalog": {
            "เพจDWAWA - Multi Green Veggie ลดไขมันในเลือด ": "[P1] DWAWA - Multi Green Veggie ลดไขมันในเลือด",
            "เพจDWAWA - Multi Green Veggie ดีท็อกซ์ไขมันในเลือด": "[P2] DWAWA - Multi Green Veggie ดีท็อกซ์ไขมันในเลือด",
            "เพจ Dwawa - Multi Green Veggie ดูแลสุขภาพ": "[P3] Dwawa - Multi Green Veggie ดูแลสุขภาพ",
            "Dwawa-Multi GreenVeggie ราชินีผักเขียว ดีท็อกซ์ไขมันในเลือด": "[P4] Dwawa-Multi GreenVeggie ราชินีผักเขียว ดีท็อกซ์ไขมันในเลือด",
            "เพจ DWAWA - Multi Green Veggie ฟื้นฟูไขมันในเลือด": "[P5] Multi Green Veggie ฟื้นฟูไขมันในเลือด",
            "DWAWA-Multi Green Veggie ผงผักนาโน ดูแลระดับไขมันในเลือด": "[P6] DWAWA-Multi Green Veggie ผงผักนาโน ดูแลระดับไขมันในเลือด",
        },
    },
    "U16": {
        "source_sheet_id": "1GlnRNC98qcvw68NRTCEaXTWkJAkYRg2-nxoM7MmE-oI",
        # master catalog มี U16 2 เพจ (แอดมินคนเดียวกันทั้งคู่: นา):
        # [P1] Levonglow - ชาสมุนไพรต่อมลูกหมากสูตร2
        # [P2] Levonglow - ชาหญ้าหนวดแมว เคล็ดลับสุขภาพวัย 40+
        "page_tabs": [
            "เพจLevonglow - ชาสมุนไพรต่อมลูกหมากสูตร2",       # active (P1)
            "Levonglow - ชาหญ้าหนวดแมว เคล็ดลับสุขภาพวัย 40+",  # active (P2)
        ],
        "tab_to_catalog": {
            "เพจLevonglow - ชาสมุนไพรต่อมลูกหมากสูตร2": "[P1] Levonglow - ชาสมุนไพรต่อมลูกหมากสูตร2",
            "Levonglow - ชาหญ้าหนวดแมว เคล็ดลับสุขภาพวัย 40+": "[P2] Levonglow - ชาหญ้าหนวดแมว เคล็ดลับสุขภาพวัย 40+",
        },
    },
    "U17": {
        "source_sheet_id": "1H7TiYcsBiiYIVy2LFzfMdPnRRHCnWpU-N7q8q8TOwKE",
        # master catalog มี U17 แค่ 1 เพจ (tab อื่นๆ สไตล์ "Dwawa JasonM-กาแฟ..." ไม่มีใน catalog เลย):
        # [P2] DWAWA-Jason M กาแฟลดต่อมลูกหมากโต — จับคู่ตามชื่อใกล้เคียงที่สุด ควร spot-check
        "page_tabs": [
            "ดีวาวา-เจสันเอ็ม กาแฟลดต่อมลูกหมาก สูตรใหม่",
        ],
        "tab_to_catalog": {
            "ดีวาวา-เจสันเอ็ม กาแฟลดต่อมลูกหมาก สูตรใหม่": "[P2] DWAWA-Jason M กาแฟลดต่อมลูกหมากโต",
        },
    },
    "U18": {
        "source_sheet_id": "1A-WN-TO94PDUxfR0F8M9X5-PItU33iG39IJkSGesR-o",
        # master catalog มี U18 2 เพจ (แอดมินคนเดียวกันทั้งคู่: มาร์ค (เปรมปรีดิ์)):
        # [P2] DWAWA Melon s ลดเซลลูไลท์ระดับเซลล์ - เพจบริษัท
        # [P3] Dwawa-Lunaryสูตรใหม่ ขจัดเซลล์ลูไลท์เพจบริษัท
        "page_tabs": [
            "DWAWA Melon s ลดเซลลูไลท์ระดับเซลล์ - เพจบริษัท ",
            "Dwawa-Lunaryสูตรใหม่ ขจัดเซลล์ลูไลท์เพจบริษัท",
        ],
        "tab_to_catalog": {
            "DWAWA Melon s ลดเซลลูไลท์ระดับเซลล์ - เพจบริษัท ": "[P2] DWAWA Melon s ลดเซลลูไลท์ระดับเซลล์ - เพจบริษัท",
            "Dwawa-Lunaryสูตรใหม่ ขจัดเซลล์ลูไลท์เพจบริษัท": "[P3] Dwawa-Lunaryสูตรใหม่ ขจัดเซลล์ลูไลท์เพจบริษัท",
        },
    },
    "U22": {
        "source_sheet_id": "1l4lCkjDqaD26Lv-6cQWpNMjVz4_BRiFuPIwCYFAmrqQ",
        # master catalog มี U22 แค่ 1 เพจ (tab อื่นๆ สไตล์ "Orenji Plus/Orenji+" ที่เหลือไม่มีใน catalog):
        # [P1] Orenji+ วิตามินส้ม สูตรนำเข้า
        "page_tabs": [
            "เพจOrenji+ วิตามินส้ม สูตรนำเข้า",
        ],
        "tab_to_catalog": {
            "เพจOrenji+ วิตามินส้ม สูตรนำเข้า": "[P1] Orenji+ วิตามินส้ม สูตรนำเข้า",
        },
    },
    "U23": {
        "source_sheet_id": "1CkVwXeeIlHX5B1Q3nxbKWjT_I4zKpxoq3fHT9-LZr28",
        # master catalog มี U23 2 เพจ (แอดมินคนเดียวกันทั้งคู่: แก้ม (สุธีกานต์)):
        # [P1] Venorra Gluta Plus-จบทุกปัญหาผิว
        # [P6] Venorra Gluta Plus - เคล็ดลับดูแลผิวกระจ่างใส — จับคู่ตามชื่อใกล้เคียงที่สุด ควร spot-check
        "page_tabs": [
            "Venorra Gluta Plus -จบทุกปัญหาผิว",
            "Venorra - น้ำชงกลูต้า เคล็ดลับดูแลผิว",
        ],
        "tab_to_catalog": {
            "Venorra Gluta Plus -จบทุกปัญหาผิว": "[P1] Venorra Gluta Plus-จบทุกปัญหาผิว",
            "Venorra - น้ำชงกลูต้า เคล็ดลับดูแลผิว": "[P6] Venorra Gluta Plus - เคล็ดลับดูแลผิวกระจ่างใส",
        },
    },
    "U5 ลาว": {
        "source_sheet_id": "1_93UJWNskacHlrfKMaMOCRI4lfo9xkDnOrenZfQ_YcY",
        # master catalog มี U5 ลาว แค่ 1 เพจ (tab อื่นๆ ที่เหลือไม่มีใน catalog):
        # [P4] Dwawa ginseng ວິຕາມິນໂສມຫຼຸດນໍ້າຕານໃນເລືອດ
        "page_tabs": [
            "[P4] Dwawa ginseng ວິຕາມິນໂສມຫຼຸດນໍ້າຕານໃນເລືອດ",
        ],
        "tab_to_catalog": {
            "[P4] Dwawa ginseng ວິຕາມິນໂສມຫຼຸດນໍ້າຕານໃນເລືອດ": "[P4] Dwawa ginseng ວິຕາມິນໂສມຫຼຸດນໍ້າຕານໃນເລືອດ",
        },
    },
    "U7 ลาว": {
        "source_sheet_id": "1jKwxC0YRFrwJp4s5BkO1d8Yyo-Jt0Ks9pUOq0ARec0Y",
        # master catalog ไม่มีเพจของ U7 ลาว เลย (เหมือน U6/U10) — ดึงไปก่อนโดยไม่มี active/admin
        # ตามที่ user ยืนยัน รอ catalog เพิ่มแถวทีหลังแล้วค่อย sync ซ้ำ
        "page_tabs": [
            "D'Lellise Probiovita ຟື້ນຟູພາຍໃນ ຫຼຸດຕົກຂາວເຮື້ອຮັງ",
            "D'Lellise Probiovita-ນ້ຳຊົງດູແລພາຍໃນ ແມ່ຍິງ",
            "D'Lellise Probiovita ດູແລພາຍໃນຜູ້ຍິງຄົບວົງຈອນ",
            "D’Lellise Probiovitaຂາຍດີທີ່ສຸດໃນໄທ",
        ],
        "tab_to_catalog": {},
    },
    "U9 ลาว": {
        "source_sheet_id": "1uHrMmbU6jWpzJPP0zZvXwOGU7oGJSbLcKqdDxGosfP8",
        # master catalog มี U9 ลาว 3 เพจ:
        "page_tabs": [
            "เพจ ชาสมุนไพรแม่แย้ม ตรา LeVonglow Thailand ",
            "เพจ Levonglow Th-ชาแม่แย้มเพื่อสุขภาพ ",
            "เพจLevonglow - ຊາແມ່ແຢ້ມຊ່ວຍຫຼຸດຄວາມດັນ ຫຼຸດເບາຫວານ ຫຼຸດອາການມືເທົ້າຊາ",
        ],
        "tab_to_catalog": {
            "เพจ ชาสมุนไพรแม่แย้ม ตรา LeVonglow Thailand ": "[P1] ชาสมุนไพรแม่แย้ม ตรา LeVonglow Thailand",
            "เพจ Levonglow Th-ชาแม่แย้มเพื่อสุขภาพ ": "[P2] Levonglow Th-ชาแม่แย้มเพื่อสุขภาพ",
            "เพจLevonglow - ຊາແມ່ແຢ້ມຊ່ວຍຫຼຸດຄວາມດັນ ຫຼຸດເບາຫວານ ຫຼຸດອາການມືເທົ້າຊາ": "[P3] Levonglow - ຊາແມ່ແຢ້ມຊ່ວຍຫຼຸດຄວາມດັນ ຫຼຸດເບາຫວານ ຫຼຸດອາການມືເທົ້າຊາ",
        },
    },
    "U23 ลาว": {
        "source_sheet_id": "1P4Fx50Jc_cG38n5F2hi9ShpMHPd93b1--2mgo8NcWm8",
        # master catalog ไม่มีเพจของ U23 ลาว เลย (เหมือน U6/U10/U7 ลาว) — ดึงไปก่อนโดยไม่มี active/admin
        "page_tabs": [
            "[P1] Venorra Gluta - ໜ້າອ່ອນໄວ ຈຸດດ່າງດຳເບິ່ງຈາງລົງ",
        ],
        "tab_to_catalog": {},
    },
    "Test Menova": {
        "source_sheet_id": "1bShclvDtgYvtZzZ7O_Jfdnbr499e4fKnjd0G5UE8OJ4",
        # ดึงทุกเพจในไฟล์ ทั้งที่ปิดไปแล้วและที่เปิดอยู่ (ตามที่ user ยืนยัน):
        # [P1] Menova - วิตามินเสริมอาหารผู้ชาย — ปิดไปแล้ว ไม่มีใน catalog แล้ว (จะได้ active=inactive)
        # [P2] Menvova-วิตามินที่ชายไทยไว้ใจ — ทีมตั้งชื่อ tab แล้ว (8/8/2569 ยังว่างอยู่ "[P2] ")
        #      สะกด "Menvova" ผิดจาก catalog "Menova" — ยังจับคู่ตาม P2 number ต่อไป
        "page_tabs": [
            "[P1] Menova - วิตามินเสริมอาหารผู้ชาย",
            "[P2] Menvova-วิตามินที่ชายไทยไว้ใจ",
        ],
        "tab_to_catalog": {
            "[P2] Menvova-วิตามินที่ชายไทยไว้ใจ": "[P2] Menova-วิตามินที่ชายไทยไว้ใจ",
        },
    },
    "Test Glacier Bloom": {
        "source_sheet_id": "1GXUssmABWh6FXfyIZrhbAyf2HmQpGfXBUsyoHHKenVU",
        # ดึงทุกเพจในไฟล์ ทั้งที่ปิดไปแล้วและที่เปิดอยู่ (เหมือน Test Menova):
        # มีแค่ [P2] เท่านั้นที่อยู่ใน catalog ตอนนี้ ที่เหลือ (P3, เพจหลัก) จะได้ active=inactive
        "page_tabs": [
            "[P2] GlacierBloomครีมบัวหิมะ-ชมพู่ ก่อนบ่าย",
            "[P3] GlacierBloom - ครีมบัวหิมะคืนความเยาว์",
            "เพจ Glacier Bloom - เคล็ดลับผิวฉ่ำกระจ่างใส",
        ],
        "tab_to_catalog": {
            "[P2] GlacierBloomครีมบัวหิมะ-ชมพู่ ก่อนบ่าย": "[P2] GlacierBloomครีมบัวหิมะ-ชมพู่ ก่อนบ่าย",
        },
    },
    "Test Zenova": {
        "source_sheet_id": "1wGcx1zH9bpXp-WTvqJwyG0B_OKCoxFHQ7y9fynbGj_0",
        # master catalog ไม่มีเพจของ Test Zenova เลย — ดึงไปก่อนโดยไม่มี active/admin (เหมือน Test Menova P1)
        "page_tabs": [
            "[P1] Zenova - OIL ลดไขมัน ดูแลสุขภาพ",
            "[P2] Zenova-OIL ลดไขมัน สูตรใหม่นำเข้าจากusa",
        ],
        "tab_to_catalog": {},
    },
    "U13 ลาว Capsule": {
        "source_sheet_id": "1M_ZHkswDHCko9JPcs43WIQpvJjvWMW7JdDhN-P-VmA0",
        # master catalog ไม่มีเพจของ U13 ลาว Capsule เลย — ดึงไปก่อนโดยไม่มี active/admin
        "page_tabs": [
            "DWAWA LUNARY - ແຄບຊູນຊ່ວຍຫຼຸດນ້ຳໜັກແບບເຮັດໄວ",
            "DWAWA-Lunary ລູນາຣີ່ ປັ້ນຫຸ່ນງາມ ກະຊັບສັດສ່ວນ ເປັນເພຈຫຼັກ ",
        ],
        "tab_to_catalog": {},
    },
    "U21": {
        "source_sheet_id": "1AVewaVALYRW5TTBe2vkecd1zOFBE2e7wNE77jmHksjI",
        # master catalog มี U21 4 เพจ (แอดมินร่วมกันทั้งกลุ่ม: เรย์/ทราย/ไบร์ท/นิว):
        "page_tabs": [
            "ลีวองโกลว์-ชาเถาวัลย์เปรียง แก้ชามือ-เท้า สูตร3",
            "Levonglow ชาสมุนไพรเถาวัลย์เปรียง แก้เหน็บชาสูตร3 ",
            "ลีวองโกลว์ ชาเถาวัลย์เปรียง สูตร3",
            "Levonglow-ชาสมุนไพรเถาวัลย์เปรียง ลดอาการชาสูตร3",
        ],
        "tab_to_catalog": {
            "ลีวองโกลว์-ชาเถาวัลย์เปรียง แก้ชามือ-เท้า สูตร3": "[P1] ลีวองโกลว์-ชาเถาวัลย์เปรียง แก้ชามือ-เท้า สูตร3",
            "Levonglow ชาสมุนไพรเถาวัลย์เปรียง แก้เหน็บชาสูตร3 ": "[P2] Levonglow ชาสมุนไพรเถาวัลย์เปรียง แก้เหน็บชาสูตร3",
            "ลีวองโกลว์ ชาเถาวัลย์เปรียง สูตร3": "[P3] ลีวองโกลว์ ชาเถาวัลย์เปรียง สูตร3",
            "Levonglow-ชาสมุนไพรเถาวัลย์เปรียง ลดอาการชาสูตร3": "[P4] Levonglow-ชาสมุนไพรเถาวัลย์เปรียง ลดอาการชาสูตร3",
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
    for row_num, _cols in blocks:
        detected = find_metric_columns(values, row_num)
        print(f"row {row_num}: {values[row_num - 1][:15]}  ->  คอลัมน์ที่หาเจอ: {detected}")

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
    sh = call_with_retry(client.open_by_key, MASTER_CATALOG_SHEET_ID)
    ws = call_with_retry(sh.worksheet, MASTER_CATALOG_TAB)
    rows = call_with_retry(ws.get_all_records)  # ใช้แถว 1 เป็น header: UNIT, เพจ, แอดมิน, ชื่อไฟล์, link

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


def find_metric_columns(values, header_row):
    """หาตำแหน่งคอลัมน์ของทุกเมตริกที่ต้องการ จากข้อความหัวตารางของบล็อกเดือนนี้เอง
    (ไม่ใช่เลขคอลัมน์คงที่) เพราะจำนวนคอลัมน์ต่างกันได้ถ้ามีแอดมินเพิ่ม/ลดระหว่างปี

    โครงสร้างที่พบจริง (ยืนยันจากหลายเพจ/หลายยูนิต): แถวหัวตาราง 5 ชั้นเริ่มที่ header_row
      แถว header_row   (banner_row) = แถวรวม มี "ROAS\\nใหม่"/"ROAS\\nรวม"/"%ปิดใหม่"/"% Error"
      แถว header_row+1 (group_row)  = ชื่อกลุ่ม เช่น "ลูกค้าใหม่(เพจ)"/"ลูกค้าเก่า.../"รวมคนเข้าจริง"
      แถว header_row+2 (label_row)  = ชื่อเมตริกย่อย "ยอดขาย"/"ออเดอร์"/"ค่าแอด"/"สนทนารายใหม่"

    ยืนยันจากไฟล์จริง U5 (8/8/2569): ตั้งแต่เดือน 7/2569 เป็นต้นไป บางเพจเปลี่ยนป้ายกำกับ
    ยอดขาย/ออเดอร์รวมจาก "ยอดขาย"/"Order" เป็น "ยอดรวม"/"Order รวม" (คอลัมน์ขยับไปไกลลิบ
    เพราะมีตารางสรุปใหม่แทรกเพิ่ม) แต่ค่าแอด/ROAS/% ต่างๆ ยังอยู่ตำแหน่งเดิม — ลองหาป้ายแบบใหม่
    ก่อน แล้วค่อย fallback ไปป้ายแบบเก่า (บล็อกเก่าไม่มีคำว่า "ยอดรวม" เลย จึงไม่ชนกัน)

    ยอดขาย/ออเดอร์ "ใหม่"/"เก่า" (แยกลูกค้าใหม่-เก่า) แบบเก่าอยู่ในกลุ่ม "ลูกค้าใหม่(เพจ)"/
    "ลูกค้าเก่า..." — 2 คอลัมน์แรกของกลุ่มคือยอดรวมของกลุ่มนั้น (ยืนยันจากข้อมูลจริง: วันที่
    ลูกค้าใหม่ล้วน ยอดในกลุ่ม "ลูกค้าใหม่(เพจ)" เท่ากับยอดขายรวมทั้งวันพอดี) แบบใหม่ (ก.ค.69+)
    มี "ยอดรวมใหม่"/"Order ใหม่" ให้ตรงๆ แต่ไม่มี "เก่า" แยกไว้ที่ระดับเพจ (มีแต่ระดับแอดมิน)
    ต้องคำนวณ เก่า = รวม - ใหม่ เอาเองถ้าหาคอลัมน์ตรงๆ ไม่เจอ (ทำใน parse_page_tab)
    """
    banner_row = values[header_row - 1] if header_row - 1 < len(values) else []
    group_row = values[header_row] if header_row < len(values) else []
    label_row = values[header_row + 1] if header_row + 1 < len(values) else []

    def find_col(row, text):
        for i, cell_val in enumerate(row):
            if cell_val.strip() == text:
                return i + 1  # 1-based column
        return None

    def find_col_containing(row, substr):
        for i, cell_val in enumerate(row):
            if substr in cell_val:
                return i + 1
        return None

    def group_total_cols(group_substr):
        """คืน (คอลัมน์ยอดขาย, คอลัมน์ออเดอร์) ของผลรวมกลุ่ม = 2 คอลัมน์แรกถัดจากจุดเริ่มกลุ่ม"""
        start = find_col_containing(group_row, group_substr)
        if not start:
            return None, None
        sales_ok = start - 1 < len(label_row) and label_row[start - 1].strip() == "ยอดขาย"
        orders_ok = start < len(label_row) and label_row[start].strip() == "ออเดอร์"
        return (start if sales_ok else None, start + 1 if orders_ok else None)

    # ใช้ substring สั้นๆ ("ใหม่"/"เก่า") แทนคำเต็ม เพราะเจอไฟล์จริงสะกดผิด เช่น
    # "ลูกค่าเก่า(เพจ)" (ค่า ไม่ใช่ ค้า) — สั้นแต่ไม่ชนกับข้อความอื่นใน group_row เพราะ
    # แถวนี้มีแค่ชื่อกลุ่ม (ลูกค้าใหม่.../ลูกค้าเก่า.../Line OA/รวมคนเข้าจริง) ไม่มี "ใหม่"/"เก่า"
    # ปนอยู่ในชื่อกลุ่มอื่น
    sales_new_group, orders_new_group = group_total_cols("ใหม่")
    sales_old_group, orders_old_group = group_total_cols("เก่า")

    return {
        "sales_total": find_col(label_row, "ยอดรวม") or find_col(label_row, "ยอดขาย"),
        "sales_new": find_col(label_row, "ยอดรวมใหม่") or sales_new_group,
        "sales_old": sales_old_group,  # ไม่เจอป้ายแบบใหม่ที่ระดับเพจ ให้คำนวณ รวม-ใหม่ แทนถ้า None
        "orders_total": find_col(label_row, "Order รวม") or find_col(label_row, "Order") or find_col(label_row, "ออเดอร์"),
        "orders_new": find_col(label_row, "Order ใหม่") or orders_new_group,
        "orders_old": orders_old_group,
        "ad_spend": find_col(label_row, "ค่าแอด"),
        "cost_per_chat": find_col(label_row, "ต้นทุน\nต่อทัก"),
        "chats_ads": find_col(label_row, "สนทนารายใหม่"),
        "chats_admin": find_col(group_row, "รวมคนเข้าจริง"),
        "close_rate_new": find_col(banner_row, "%ปิดใหม่"),
        "ads_pct": find_col(label_row, "%ค่าแอดรวม"),
        "roas_new": find_col(banner_row, "ROAS\nใหม่"),
        # บางเพจไม่แยก "ใหม่"/"รวม" มีแค่ ROAS รวมตัวเดียวเรียกว่า "ROAS เฉพาะเพจ" แทน
        "roas_total": find_col(banner_row, "ROAS\nรวม") or find_col(banner_row, "ROAS\nเฉพาะเพจ"),
        "error_pct": find_col(banner_row, "% Error"),
    }


def parse_page_tab(ws, unit_name, page_name):
    """Unpivot 1 tab (1 เพจ) ทุกบล็อกเดือนที่เจอ -> list of dict (long format)
    หาตำแหน่งคอลัมน์ใหม่ทุกบล็อกเดือน (ดู find_metric_columns) แทนตำแหน่งคงที่"""
    values = call_with_retry(ws.get_all_values)
    blocks = find_date_blocks(values)
    out = []

    def cell(row, col):
        if col is None:
            return ""
        idx = col - 1
        return row[idx].replace(",", "").strip() if idx < len(row) else ""

    def num(v):
        try:
            return float(v) if v not in ("", None) else None
        except ValueError:
            return None

    # เมตริกที่ต้องเจอเสมอ ถ้าไม่เจอแปลว่าโครงสร้างต่างไปมากจนไม่น่าเชื่อถือ ข้ามบล็อกนั้นไปเลย
    required = ["sales_total", "orders_total", "ad_spend", "roas_total"]

    for bi, (header_row, _cols) in enumerate(blocks):
        cols = find_metric_columns(values, header_row)
        if not all(cols[k] for k in required):
            print(f"  [เตือน] '{page_name}' บล็อกที่ขึ้นต้นแถว {header_row}: หาคอลัมน์หลักไม่ครบ {cols} — ข้ามบล็อกนี้")
            continue
        data_start = header_row  # แถวข้อมูลเริ่มถัดจากแถวหัวตารางของบล็อกนี้ (แถวหัวถูกข้ามเพราะ parse วันที่ไม่ผ่าน)
        data_end = blocks[bi + 1][0] - 1 if bi + 1 < len(blocks) else len(values)
        for row in values[data_start:data_end]:
            d = parse_thai_short_date(row[0] if row else "")
            if not d:
                continue

            sales_total = num(cell(row, cols["sales_total"]))
            sales_new = num(cell(row, cols["sales_new"]))
            sales_old = num(cell(row, cols["sales_old"]))
            if sales_old is None and sales_total is not None and sales_new is not None:
                sales_old = sales_total - sales_new  # ไม่มีคอลัมน์ "เก่า" ตรงๆ ในบล็อกแบบใหม่ (ก.ค.69+)

            orders_total = num(cell(row, cols["orders_total"]))
            orders_new = num(cell(row, cols["orders_new"]))
            orders_old = num(cell(row, cols["orders_old"]))
            if orders_old is None and orders_total is not None and orders_new is not None:
                orders_old = orders_total - orders_new

            out.append({
                "date": d.isoformat(),
                "unit": unit_name,
                "page": page_name,
                "ad_spend": num(cell(row, cols["ad_spend"])),
                "chats_ads": num(cell(row, cols["chats_ads"])),
                "chats_admin": num(cell(row, cols["chats_admin"])),
                "cost_per_chat": num(cell(row, cols["cost_per_chat"])),
                "sales_total": sales_total,
                "sales_new": sales_new,
                "sales_old": sales_old,
                "orders_total": orders_total,
                "orders_new": orders_new,
                "orders_old": orders_old,
                "close_rate_new": cell(row, cols["close_rate_new"]),
                "ads_pct": cell(row, cols["ads_pct"]),
                "roas_new": num(cell(row, cols["roas_new"])),
                "roas_total": num(cell(row, cols["roas_total"])),
                "error_pct": cell(row, cols["error_pct"]),
            })
    return out


def read_staging(write_client):
    sh = call_with_retry(write_client.open_by_key, STAGING_SHEET_ID)
    try:
        ws = call_with_retry(sh.worksheet, STAGING_TAB)
    except gspread.WorksheetNotFound:
        return []
    return call_with_retry(ws.get_all_records)


def write_staging(write_client, rows):
    sh = call_with_retry(write_client.open_by_key, STAGING_SHEET_ID)
    try:
        ws = call_with_retry(sh.worksheet, STAGING_TAB)
    except gspread.WorksheetNotFound:
        ws = call_with_retry(sh.add_worksheet, title=STAGING_TAB, rows=1, cols=len(STAGING_HEADER))

    call_with_retry(ws.clear)
    call_with_retry(
        ws.update,
        [STAGING_HEADER] + [[r.get(h, "") for h in STAGING_HEADER] for r in rows],
        value_input_option="RAW",
    )
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

    if not cfg["page_tabs"]:
        print(f"[ยังไม่ทำ] {unit_name} ยังไม่ได้ระบุ page_tabs — ข้าม")
        return existing_rows

    sh = call_with_retry(read_client.open_by_key, cfg["source_sheet_id"])
    unit_rows = []
    for tab_name in cfg["page_tabs"]:
        ws = call_with_retry(sh.worksheet, tab_name)
        unit_rows += parse_page_tab(ws, unit_name, tab_name)
        time.sleep(1.5)  # กันยิง read requests รัวเกินไปจนชน Google Sheets API quota (60/นาที/user)

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

    if "--catalog" in args:
        idx = args.index("--catalog")
        unit_label = args[idx + 1] if idx + 1 < len(args) else None
        if not unit_label:
            print("ใช้งาน: python sync_pages.py --catalog <UNIT>")
            return
        pages = load_master_catalog(get_client())
        matches = [(name, info) for name, info in pages.items() if info["unit"] == unit_label]
        print(f"=== เพจของ {unit_label} ใน master catalog: {len(matches)} เพจ ===")
        for name, info in matches:
            admins = ", ".join(info["admins"]) if info["admins"] else "(ไม่มีแอดมิน)"
            print(f"- {name}  (แอดมิน: {admins})")
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
