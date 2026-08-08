# Pipeline ข้อมูลรายเพจ (pilot: U4)

## เป้าหมาย
ดึงข้อมูลยอดขายรายวัน **ต่อเพจ** ของแต่ละยูนิต (เริ่มที่ U4) ย้อนหลังตั้งแต่ ม.ค.69 ถึงปัจจุบัน
โดย join กับไฟล์ master catalog ("test-รายงานเพจ FB") เพื่อรู้ว่าเพจไหน active/ใครดูแลอยู่
แล้วเขียนผลลัพธ์แบบ normalize (long-format) ลง Staging Sheet ให้ dashboard
(https://ptglorydata-maker.github.io/ptglory-sales-fb/) อ่านต่อได้

## สิ่งที่ตรวจสอบแล้วจากไฟล์จริง

**Master catalog** — flat table `UNIT | เพจ | แอดมิน | ชื่อไฟล์ | link`
1 แถว = 1 คู่ (เพจ × แอดมิน) เพจเดียวอาจมีแอดมินหลายคน

**ไฟล์ต้นทางระดับยูนิต** (เช่น U4 HaYeon 69) — ซับซ้อน มี 3 รูปแบบตารางในไฟล์เดียว:
1. สรุปยอดขายรายเดือนของทั้งยูนิต (ไม่แยกเพจ)
2. "KPI/รายวัน รายเพจ" — สแนปช็อตแค่วันล่าสุดวันเดียว ไม่ใช่ประวัติย้อนหลัง
3. ตาราง raw รายวันจริง แยกเป็น **tab ต่อเดือน** (เช่น "UNIT 4 เดือนมกราคม") เป็น
   wide-format: header ซ้อน 3 ชั้น (merged cells), 1 แถว = 1 วันที่ (เช่น `01/01/26`),
   คอลัมน์เป็นบล็อกซ้ำต่อแอดมิน/เพจ (ยอดขาย, ออเดอร์, %ปิด, ROAS, ค่าแอด ฯลฯ)

ข้อมูลย้อนหลังที่ต้องการอยู่ใน (3) แต่ **ผังคอลัมน์ไม่คงที่** — มีโอกาสขยับทุกครั้งที่เพิ่ม/ลดแอดมิน
หรือเพจในเดือนนั้นๆ จึงไม่สามารถ hardcode ตำแหน่งคอลัมน์ล่วงหน้าแบบเดายาวๆ ได้อย่างปลอดภัย

## ทำไมต้องมี --discover ก่อนเสมอ

`sync_pages_u4.py --discover` จะต่อ Google Sheets API จริงแล้วพิมพ์:
- ชื่อ tab ทั้งหมดในไฟล์ต้นทาง (ยืนยันชื่อ tab รายเดือนที่แท้จริง)
- 12 แถวแรกของ tab ที่เลือก (ยืนยันตำแหน่งแถวหัวตาราง/คอลัมน์วันที่/บล็อกคอลัมน์ต่อเพจ)

เพราะการอ่านไฟล์ผ่านตัวแปลง Markdown (ไม่มี service account) ไม่สามารถให้ตำแหน่งคอลัมน์ตรงตัวได้
(merged cell ถูกแปลงเป็นข้อความซ้ำ ไม่มีเลขคอลัมน์กำกับ) ต้องยืนยันด้วย gspread ของจริงก่อน map

## ขั้นตอนติดตั้ง
1. `pip install -r requirements.txt`
2. ขอไฟล์ credentials (JSON key) ของ `glory-sheets-reader-456@ptglory-dashboard-sales-fb.iam.gserviceaccount.com`
   ตั้ง env var: `export GOOGLE_SERVICE_ACCOUNT_JSON=/path/to/key.json`
3. สร้าง Google Sheet เปล่าไว้เป็น Staging แล้วแชร์สิทธิ์ "Editor" ให้ service account ด้านบน
   นำ Sheet ID มาใส่ใน `STAGING_SHEET_ID` ในไฟล์ `sync_pages_u4.py`
4. รัน `python sync_pages_u4.py --discover` แล้วส่งผลลัพธ์ที่พิมพ์ออกมากลับมาคุยต่อ
   เพื่อ map คอลัมน์ให้ตรงเพจ/เดือน (จะทำทีละเดือน เพราะผังอาจไม่เหมือนกันทุกเดือน)
5. เมื่อ map ครบทุกเดือนของ U4 แล้ว รัน `python sync_pages_u4.py` เพื่อ sync ข้อมูลจริงลง Staging Sheet

## ขั้นต่อไปหลัง pilot U4 สำเร็จ
- ขยาย config ให้รองรับหลายยูนิต (มากกว่า 40 ยูนิตใน master catalog)
- เพิ่ม mode ใหม่ในฝั่ง Cloudflare Worker (เช่น `mode=pages&unit=U4`) อ่านจาก Staging Sheet
- เพิ่ม section "รายเพจ" ในหน้า dashboard (`index.html`) แสดงเพจ active/inactive ต่อยูนิต
  พร้อมกราฟยอดขายรายวัน/เดือนต่อเพจ
- ถ้าข้อมูลโตจนช้า (หลายยูนิต × รายวัน × หลายปี) ค่อยย้าย Staging จาก Google Sheet ไป BigQuery
