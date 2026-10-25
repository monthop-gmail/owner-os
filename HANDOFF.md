# owner-os — เอกสารส่งมอบ (HANDOFF)

เอกสารนี้เขียนให้ทีมผู้มอบหมายงาน (ทีมต้นทาง) ใช้อ่าน repo ทำความเข้าใจ รันในเครื่อง และประเมินงาน
repo นี้เป็นของ `monthop-gmail` ทำตามโจทย์ที่ทีมต้นทางส่งมา · ทุกตัวเลข ชื่อตาราง ชื่อ binding และชื่อ tool ด้านล่างอ้างจากโค้ดใน repo
· ไม่มีค่าจริงของ Cloudflare, secret หรือข้อมูลส่วนบุคคลในเอกสารนี้ (ตัวอย่างค่าทั้งหมดเป็น placeholder)

## 1. owner-os คืออะไร

owner-os คือระบบหลังบ้านสำหรับ **เจ้าของสินทรัพย์** (สวนผลไม้ ไร่ โรงเรือน ที่พักให้เช่า) ที่ให้คนอื่นดูแลแทน
เจ้าของบันทึกสินทรัพย์และแปลง มอบหมายงาน แล้วตรวจ **หลักฐานการทำงาน (proof-of-work)** เป็นรูปพร้อมพิกัด GPS ที่ระบบตรวจว่าอยู่ในแปลงจริง
ระบบติดตามรอบปลูกและผลผลิต และเก็บสัญญากับผู้ดูแลได้ 4 แบบ ระบบคำนวณ **ร่าง** การแบ่งรายได้ได้ แต่ยังไม่บันทึกเป็นการจ่ายจริง
มีส่วนรับมือภัยพิบัติ และให้ AI บนคลาวด์ (ChatGPT/Claude) อ่านข้อมูลหรือเสนอร่างผ่าน MCP ได้ โดยร่างทุกชิ้นต้องให้เจ้าของยืนยันก่อน

สถานะตาม [`PROGRESS.md`](PROGRESS.md) (ทุก task ติ๊กแล้ว · แต่ละ task จบที่ PR + รีวิว):

| Milestone | ทำอะไรแล้ว |
|---|---|
| 1 Workspace & D1 Core | pnpm monorepo · `packages/shared` (types + Zod) · Worker Hono + Drizzle · schema แรก + migration |
| 2 Proof-of-Work Spike | API สร้างสินทรัพย์/แปลง/งาน · อัปโหลดรูปผ่าน Worker → R2 · geofence ด้วย Turf · bearer token · หน้า `/test-camera` · hardening · CI · demo seed ผ่าน API |
| 3 Web Dashboard | read API · `apps/web` (Vite + React + Tailwind) · วาดแปลงบน Leaflet + คำนวณพื้นที่ · หน้าตรวจงานพร้อมรูปและหมุดบนแผนที่ |
| 4 Operational Engine & Settlements | รอบปลูก (state machine) · แม่แบบงานตามช่วง · บันทึกผลผลิต + ใบชั่งใน R2 · สัญญา 4 type · settlement engine (**preview เท่านั้น**) |
| 5 รับมือภัยพิบัติ | บันทึกเหตุภัย + แปลงที่โดน + % ความเสียหาย + ผูกรูปหลักฐาน · ข้อตกลงกรณีภัยของทุก type · แม่แบบงานเตรียม/ฟื้นฟู |
| 6 MCP สำหรับ AI | OAuth + หน้า consent หลัง Cloudflare Access · `/mcp` (JSON-RPC) · tool อ่าน 10 ตัว · tool คำนวณ 2 ตัว · tool ร่าง 3 ตัว + กล่องร่างบนเว็บ · audit + rate limit |

> ใน PROGRESS.md งานภัยพิบัติอยู่ใต้หัว "Milestone 5" แต่ใช้เลข task 4.4a–c และงาน MCP อยู่ใต้ "Milestone 6" แต่ใช้เลข task 5.x · เลขไม่ตรงกันเพราะลำดับที่ทำจริง

## 2. สถาปัตยกรรม

```
apps/worker      Cloudflare Worker: Hono (API) + Drizzle (D1) + R2 + OAuth/MCP
apps/web         Vite + React 19 + Tailwind + Leaflet (แดชบอร์ดเจ้าของ)
packages/shared  types + Zod schemas + settlement engine + แม่แบบงาน (ใช้ร่วมทั้ง worker และ web)
```

- **Stack:** TypeScript · pnpm 9 (`packageManager` ใน `package.json`) · Node ตาม `.nvmrc` (22)
  · Hono · Drizzle ORM + drizzle-kit · Cloudflare D1 / R2 / KV · `@cloudflare/workers-oauth-provider` · Turf · Vitest
- **Binding** (ดู `apps/worker/wrangler.toml`):
  - `DB` เป็น D1 ชื่อ `owner-os` เก็บ migration ใน `migrations/`
  - `BUCKET` เป็น R2 ชื่อ `owner-os-evidence`
  - `OAUTH_KV` เป็น KV ใช้เก็บ grant, token และ client ของ OAuth
- **การยืนยันตัวตน:**
  - `/api/*` ใช้ `Authorization: Bearer <API_TOKEN>` (ไฟล์ `src/auth.ts`)
  - `/mcp` ใช้ OAuth token เท่านั้น
  - token สองแบบนี้ใช้แทนกันไม่ได้ (มีเทสต์ตรวจว่า OAuth token เรียก `/api/*` แล้วได้ 401)

### ตาราง D1 (13 ตาราง · 12 migration `0000`–`0011` · ไม่มีการแก้ migration เดิม)

| ตาราง | หน้าที่ |
|---|---|
| `assets` | สินทรัพย์ (`kind`: farm · property · equipment · other) + ขอบเขต GeoJSON |
| `asset_units` | แปลง/โซน/อาคารย่อยของสินทรัพย์ + polygon + พื้นที่ ใช้ทำ geofence |
| `work_orders` | งานที่มอบหมาย (open → in_progress → submitted → verified/rejected) · ผูกรอบปลูกหรือเหตุภัยได้ |
| `work_order_evidence` | หลักฐานรูปของงาน: พิกัด · ความแม่นยำ · ผล geofence · key ใน R2 |
| `farm_crop_cycles` | รอบปลูกต่อแปลง (planned → growing → harvesting → closed) + แม่แบบ |
| `farm_harvest_logs` | บันทึกผลผลิต (กรัม · สตางค์/กก. · รายได้คำนวณโดยเซิร์ฟเวอร์) + ใบชั่งใน R2 |
| `asset_contracts` | สัญญากับผู้ดูแล 4 type (terms เป็น JSON · `draft_unconfirmed`) |
| `disaster_events` | เหตุภัยต่อสินทรัพย์ (ประเภท · เวลา) + เวลาที่สร้างงานฟื้นฟูแล้ว |
| `disaster_event_units` | แปลงที่โดนภัย + % ความเสียหาย (เก็บเป็น basis points) |
| `disaster_event_evidence` | ผูกรูปหลักฐาน (GPS) กับเหตุภัย ใช้ประกอบการเคลม |
| `ai_clients` | เพดานสิทธิ์และ rate limit ของ AI (`0008` ใส่แถว `mcp-default` scope `read`) |
| `mcp_audit` | log ทุก tool call ของ MCP (ไม่เก็บ argument/ผลลัพธ์/อีเมล) |
| `ai_drafts` | ร่างที่ AI เสนอ รอเจ้าของยืนยันหรือปฏิเสธ |

**R2 (`BUCKET`) เก็บไฟล์สองแบบ:**
- รูปหลักฐานงาน เก็บที่ key `work-orders/<work_order_id>/<evidence_id>` (สูงสุด 20 รูปต่องาน · ไฟล์ละไม่เกิน 10 MB)
- รูปใบชั่งน้ำหนัก เก็บที่ key `harvest-logs/<crop_cycle_id>/<harvest_log_id>`

ไฟล์ทั้งหมดอัปโหลดผ่าน Worker (ไม่ใช้ presigned URL)

**ทำไมเงินเป็นสตางค์และน้ำหนักเป็นกรัม:** ในฐานข้อมูลและใน settlement engine เก็บทุกค่าเป็นจำนวนเต็ม
(`packages/shared/src/money.ts`) เพื่อไม่ให้ทศนิยมแบบ floating point คลาดเวลาบวก คูณ หรือแบ่งเปอร์เซ็นต์
· API รับและแสดงเป็นบาทและกิโลกรัม (เงินทศนิยมไม่เกิน 2 ตำแหน่ง · น้ำหนักไม่เกิน 3 ตำแหน่ง) แล้วแปลงที่ขอบระบบครั้งเดียว
· เปอร์เซ็นต์เก็บเป็น basis points (1% = 100) ด้วยเหตุผลเดียวกัน

## 3. รันในเครื่อง

ลำดับนี้ลองรันจริงใน clone ใหม่แล้วผ่าน (Linux · Node 22 · pnpm 9.15.9 ผ่าน corepack) ทุกอย่างทำงานในเครื่อง ไม่แตะ Cloudflare จริง

```sh
# 1) clone + ติดตั้ง
git clone https://github.com/monthop-gmail/owner-os.git
cd owner-os
corepack enable            # ได้ pnpm ตาม packageManager
pnpm install --frozen-lockfile

# 2) Worker: secret สำหรับเครื่องนี้ + migration ลง D1 local (ใน .wrangler/)
cd apps/worker
cp .dev.vars.example .dev.vars   # API_TOKEN / CONSENT_CSRF_SECRET ค่า local-only (อย่าใช้ค่านี้บน production)
pnpm db:migrate:local            # apply 0000–0011 ทั้ง 12 ไฟล์

# 3) เปิด Worker (อ่าน .dev.vars อัตโนมัติ) ที่ http://localhost:8787
pnpm exec wrangler dev --local
```

อีก terminal:

```sh
# 4) ใส่ข้อมูล demo ผ่าน API (สินทรัพย์ 4 · สัญญา 4 · แปลง 4 · งาน 5 · ส่งหลักฐานแล้ว 3)
cd apps/worker
pnpm seed:demo --dry-run   # ดูแผน ไม่ส่งอะไร
OWNER_OS_URL=http://localhost:8787 OWNER_OS_TOKEN=change-me-local-only pnpm seed:demo

# 5) เว็บ (ที่ราก repo) · Vite proxy /api และ /test-camera ไปที่ :8787
pnpm --filter @owner-os/web dev
```

เปิด URL ที่ Vite แสดง (ปกติ `http://localhost:5173`) แล้วกรอก token เดียวกับ `API_TOKEN` ใน `.dev.vars`
· เว็บเก็บ token ไว้ใน localStorage ของเบราว์เซอร์เท่านั้น ไม่มี token อยู่ใน bundle

- **`/test-camera`** (`http://localhost:8787/test-camera`) เป็นหน้าทดสอบถ่ายรูป + GPS + อัปโหลดหลักฐาน
  **กล้องและ GPS บนมือถือจริงใช้ได้เฉพาะหน้า HTTPS** (เบราว์เซอร์อนุญาต `getUserMedia` และ geolocation บน `localhost` หรือ HTTPS เท่านั้น)
  ถ้าจะทดสอบบนมือถือ ต้อง deploy ก่อนหรือใช้ tunnel แบบ HTTPS
- **ตรวจว่าระบบขึ้นแล้ว:**
  - `curl localhost:8787/health` ต้องได้ `{"ok":true,...}`
  - `/api/assets` ที่ไม่ส่ง token ต้องได้ 401
  - `POST /mcp` ที่ไม่ส่ง token ต้องได้ 401
  - `/.well-known/oauth-authorization-server` ต้องแสดง metadata ของ OAuth
- **เทสต์ทั้งหมด (ที่ราก repo):** `pnpm typecheck && pnpm test && pnpm build`
  - `pnpm build` ฝั่ง worker คือ `wrangler deploy --dry-run` ซึ่งแค่ bundle ไม่ deploy
  - เทสต์ของ worker ใช้ D1 และ R2 ของ Miniflare แบบ in-memory ผ่าน `getPlatformProxy` และไม่ mock ฐานข้อมูล
- **การรัน seed ซ้ำจะสร้างข้อมูลซ้ำ** (seed ไม่ idempotent) ถ้าจะเริ่มใหม่ ให้ลบ `apps/worker/.wrangler/` แล้ว migrate ใหม่

## 4. ข้อมูล demo

ตอนทำ Task 2.7 ทีมเราไม่โหลด `seed.sql` ที่ทีมต้นทางส่งมา ด้วยเหตุผลที่บันทึกไว้ตอนตรวจไฟล์ดังต่อไปนี้
(`seed.sql` ไม่ได้ commit ไว้ใน repo นี้ จึงตรวจซ้ำจาก repo ไม่ได้ ถ้าต้องการรายละเอียดรายบรรทัด ให้เทียบไฟล์ต้นฉบับของทีมต้นทางกับ `apps/worker/src/db/schema.ts`):

- **schema ไม่ตรง:** ชื่อคอลัมน์และโครงตารางไม่ตรงกับ schema จริง (`apps/worker/src/db/schema.ts`)
- **หน่วยเวลา:** เวลาเป็นวินาที แต่ระบบใช้ epoch **มิลลิวินาที**
- **ตารางยังไม่มี:** อ้างตารางที่ยังไม่มีในตอนนั้น
- **พิมพ์ผิด:** มีค่าที่พิมพ์ผิด
- **พื้นที่ไม่ตรง:** พื้นที่ของ polygon ไม่ตรงกับตัวเลขพื้นที่ที่เขียนไว้

ทีมเราจึงย้ายข้อมูลตัวอย่างมาไว้ที่ [`apps/worker/fixtures/demo-seed.json`](apps/worker/fixtures/demo-seed.json) (ข้อมูลสมมติ · ชื่อลงท้าย "(demo)")
แล้วโหลด **ผ่าน API จริง** ด้วย `pnpm seed:demo` (`src/seed/demo.ts` · `scripts/seed-demo.ts`)
ข้อมูลจึงผ่าน validation และ geofence เดียวกับการใช้งานจริง และขอบเขตแปลงใช้ polygon ที่วัดพื้นที่ได้ตรง
(เทสต์ `test/seed-demo.test.ts` ตรวจว่าแปลง `durian-a` มีพื้นที่คลาดจาก 47,435 ตร.ม. ไม่เกิน 1%)
ทุกคำขอใช้ `API_TOKEN` และ seed จะหยุดที่คำขอแรกที่ได้สถานะที่ไม่ใช่ 2xx

**`milestone4_not_loaded`** ในไฟล์เดียวกันเป็นข้อมูลอ้างอิงจาก seed ของทีมต้นทางที่ **ตั้งใจไม่โหลด**:
- รอบปลูก 3 รอบ (ทุเรียนหมอนทอง · ข้าวโพดเลี้ยงสัตว์ · เมล่อน)
- ตัวอย่างผลผลิตเมล่อน 1,200 กก. × 85 บาท = 102,000 บาท
- ตัวอย่าง settlement เมล่อน (รายได้ 102,000 · OPEX 32,000)

เก็บไว้เทียบกับ engine ใน Milestone 4 ส่วนสัญญาของแต่ละสินทรัพย์ย้ายไปโหลดพร้อมสินทรัพย์ตั้งแต่ Task 4.3a

## 5. ความครอบคลุมทุก type

### Asset type ใน demo

| สินทรัพย์ demo | ประเภท (`kind`) | แปลง | สัญญา |
|---|---|---|---|
| สวนทุเรียนนายหัวภูพาน — **ไม้ผล** | `farm` | แปลงหมอนทอง โซน A | `fixed_target_bonus` (นายหัว) |
| ไร่ข้าวโพดโมเดิร์นฟาร์ม — **พืชไร่** | `farm` | แปลงรวมพืชไร่ ทุ่งเหนือ | `pay_per_job` |
| มินิฟาร์มโรงเรือนเมล่อน — **โรงเรือน** | `farm` | โรงเรือนปิด A1 | `turnkey_profit_share` |
| พูลวิลล่าปล่อยเช่า — **อสังหาฯ/ที่พัก** | `property` | Villa House 1 (3 ห้องนอน) | `property_management` |

แม่แบบงานตามช่วงของรอบปลูก (`packages/shared/src/crop-templates.ts`) มี `durian`, `maize` และ `melon` · ช่วงที่มีงานคือ `growing` และ `harvesting`

### Contract type ทั้ง 4 (`packages/shared/src/contracts.ts`) · ทุกสัญญาเป็น `draft_unconfirmed`

| type | ค่าตั้งที่ปรับได้ (ค่าเริ่มต้น) |
|---|---|
| `turnkey_profit_share` | `owner_share_pct` + `operator_share_pct` (รวมต้อง = 100) · `management_retainer_monthly_thb` (0) · `retainer_timing` `before_split` \| `after_split` (`before_split`) · `loss_policy` `owner_absorbs` \| `split_by_share` (`owner_absorbs`) |
| `pay_per_job` | `rates[]` ต่องาน: `job_key` · `label` · `unit` (`rai` \| `job` \| `hour`) · `rate_thb` |
| `property_management` | `revenue_commission_pct` · `cleaning_fee_per_turnover_thb` |
| `fixed_target_bonus` (นายหัว) | `owner_target_revenue_thb` · `excess_operator_pct` (100) · `opex_borne_by` `operator_reimbursed` \| `operator` \| `owner` (`operator_reimbursed`) · `shortfall_policy` `owner_absorbs` \| `operator_covers` (`owner_absorbs`) |

**จุดที่ทีมเราตีความต่างหรือเพิ่มจากโจทย์** (ทุกข้อเป็นค่าตั้งที่ปรับได้ และรอเจ้าของยืนยัน):

1. **นายหัว: คืน OPEX ก่อนเทียบเป้า** (`opex_borne_by: operator_reimbursed`, Task 4.3c)
   - ระบบคืนค่าใช้จ่ายให้ผู้ดูแลจากยอดขายก่อน แล้วนำส่วนที่เหลือ (รายได้ − OPEX) ไปเทียบกับเป้าของเจ้าของ
   - ส่วนที่เกินเป้าเป็นโบนัสของผู้ดูแล ผู้ดูแลจึงไม่ติดลบ ยกเว้นเลือก `operator_covers`
   - ตัวอย่างกับสัญญา demo (เป้า 350,000):
     - รายได้ 420,000 · OPEX 40,000 → เจ้าของ 350,000 · ผู้ดูแล 30,000
     - รายได้ 300,000 · OPEX 40,000 → เจ้าของ 260,000 · ผู้ดูแล 0
2. **turnkey: หัก retainer ก่อนแบ่ง** (`retainer_timing: before_split`)
   - ค่าบริหารรายเดือน × จำนวนเดือนถูกหักออกจากกำไรก่อนแบ่งตามสัดส่วน
   - ตัวอย่างเมล่อน: รายได้ 102,000 · OPEX 32,000 · แบ่ง 70/30
     - ทีมต้นทางคิดไว้ 49,000 / 21,000 ซึ่งยังไม่หัก retainer (ตรงกับผลของ engine เมื่อ retainer = 0)
     - หัก retainer 5,000 × 3 เดือน = 15,000 ก่อนแบ่ง → กำไรที่แบ่ง 55,000 → เจ้าของ **38,500** · ผู้ดูแล **31,500** (ส่วนแบ่ง 16,500 + retainer 15,000)
   - ตัวเลขทั้งสองชุดตรวจด้วย `computeSettlement` ของ `packages/shared` แล้ว
3. **ข้อตกลงกรณีภัยพิบัติ** (`disaster_clause` ไม่บังคับ · ถ้าไม่ใส่จะใช้ค่าเริ่มต้นตอนคำนวณ)
   - ค่าเริ่มต้นตั้งให้ฝั่งผู้ดูแล/ผู้รับจ้างไม่ติดลบ
   - ข้อตกลงจะทำงานเมื่อความเสียหายถึง `min_damage_pct` (ค่าเริ่มต้น 20%)
   - ค่าตั้งของแต่ละ type:
     - turnkey: `loss_policy_on_disaster` (`owner_absorbs`) · `insurance_recipient` `pool` \| `owner` (`pool`)
     - pay_per_job: `cancellation_fee_pct_on_disaster` (0)
     - property: `repair_cost_owner_pct` (100)
     - นายหัว: `target_adjustment` `scale_by_damage` \| `none` (`scale_by_damage`) · `insurance_recipient` (`pool`)
   - settlement รับเงินประกันและเงินช่วยเหลือรัฐได้ (`insurance_thb` · `government_aid_thb`)

settlement ทั้งหมดเป็น **preview** (`POST /api/contracts/:id/settlement-preview`) ซึ่งคำนวณแล้วตอบกลับเท่านั้น ไม่เขียนฐานข้อมูล
ผลมี `rules_status: "draft_unconfirmed"` และ `assumptions` บอกการตีความที่ใช้ทุกครั้ง

## 6. ภัยพิบัติ

- **เหตุภัย** `POST /api/assets/:id/disaster-events`
  - ประเภทภัย: `flood` · `drought` · `storm` · `pest_disease` · `fire` · `other`
  - ระบุเวลาเกิด/สิ้นสุด และรายการแปลงที่โดนพร้อม **% ความเสียหาย** (ทศนิยมไม่เกิน 2 ตำแหน่ง · แปลงต้องอยู่ในสินทรัพย์นั้น)
- **ผลกระทบต่อรอบปลูก** `GET /api/crop-cycles/:id/disaster-impact`
  - รวมเหตุภัยในช่วงของรอบปลูกแบบทบกัน: 1 − Π(1 − dᵢ) และไม่เกิน 100%
  - settlement preview ที่อ้างรอบปลูกจะใช้ค่านี้ ถ้าไม่ได้ส่ง `damage_pct` มาเอง
- **หลักฐานเคลม** `POST /api/disaster-events/:id/evidence`
  - ผูกรูปหลักฐานที่อัปโหลดแล้ว (มีพิกัด GPS และผล geofence) กับเหตุภัย เพื่อใช้ประกอบการเคลมประกัน
- **งานเตรียมรับมือ / ฟื้นฟู** (แม่แบบใน `packages/shared/src/disaster-templates.ts` ต่อประเภทภัย บวกงานเฉพาะพืช durian/maize/melon)
  - `POST /api/assets/:id/disaster-prep` สร้างงานเตรียมก่อนภัยมา โดยไม่บันทึกเหตุภัย
  - `POST /api/disaster-events/:id/recovery-tasks` สร้างงานฟื้นฟูหลังเหตุภัยได้ครั้งเดียวต่อเหตุ (ครั้งถัดไปได้ 409)

## 7. ใช้จาก AI (MCP)

- **Endpoint:** `https://<worker-host>/mcp` เป็น MCP แบบ JSON-RPC 2.0 แบบ stateless ตอบ `application/json`
- **การเชื่อมต่อของ AI** (ChatGPT/Claude ตั้ง header เองไม่ได้ จึงใช้ OAuth 2.1):
  - ลงทะเบียนผ่าน `/oauth/register` (DCR) → `/oauth/authorize` → `/oauth/token` (PKCE S256)
  - redirect_uri ต้องเป็น https และ host ต้องอยู่ใน `MCP_ALLOWED_REDIRECT_HOSTS`
- **หน้า consent** (`/oauth/authorize`):
  - อยู่หลัง **Cloudflare Access**: ตรวจ JWT `Cf-Access-Jwt-Assertion` แบบ RS256 และอีเมลต้องอยู่ใน `OWNER_EMAILS`
  - CSRF ใช้ครั้งเดียว
  - ถ้าขาด config ใดจะตอบ 503
- **tool 15 ตัว** (`apps/worker/src/mcp/server.ts`):
  - **อ่าน** (scope `read`) 10 ตัว: `list_assets` · `get_asset` · `list_work_orders` · `get_work_order` · `list_evidence` · `list_crop_cycles` · `list_harvest_logs` · `list_contracts` · `list_disaster_events` · `get_disaster_impact`
    - เรียก route `GET /api/...` เดิมภายใน Worker
    - id ทุกตัวต้องตรงรูปแบบ `^[A-Za-z0-9_-]{1,64}$` (กัน path injection)
    - ไม่มี tool ดึงไฟล์รูปหรือใบชั่ง
  - **คำนวณ** (scope `read`) 2 ตัว: `settlement_preview` · `settlement_what_if`
    - `settlement_what_if` เทียบได้สูงสุด 10 สถานการณ์ต่อครั้ง
    - เป็น POST ภายในตัวเดียวที่อนุญาต และส่งได้เฉพาะ path `/api/contracts/<id>/settlement-preview`
    - ไม่เขียนฐานข้อมูล
  - **ร่าง** (scope `draft`) 3 ตัว: `propose_disaster_event` · `propose_disaster_prep` · `propose_recovery_tasks`
    - บันทึกแถวใน `ai_drafts` เท่านั้น และ **ไม่มีผลกับข้อมูลจริงจนกว่าเจ้าของจะยืนยัน**
    - เจ้าของยืนยันหรือปฏิเสธที่หน้าเว็บ `#/drafts` (กล่อง "ร่างจาก AI") หรือผ่าน `POST /api/ai-drafts/:id/confirm|reject` ซึ่งใช้ `API_TOKEN` ของคน
    - MCP token เรียก `/api/ai-drafts/*` ไม่ได้
    - เมื่อยืนยัน ระบบเรียก route เขียนเดิม
    - pending ได้ไม่เกิน 20 ร่างต่อสินทรัพย์
- **scope `draft` ปิดเป็นค่าเริ่มต้น:**
  - แถว `mcp-default` ใน `ai_clients` มีเพดาน `read`
  - ถ้าเจ้าของต้องการให้ AI เสนอร่าง ต้อง UPDATE แถวนั้นเป็น `read,draft` เอง
  - สิทธิ์ที่ใช้จริงคือ scope ของ token ∩ เพดานในแถว
- **ควบคุมและตรวจสอบ:**
  - ทุก tool call ลง `mcp_audit` (เก็บ user hash · client_id · tool · ok/error_code · ms)
  - rate limit ต่อ client มาจาก `rate_per_minute`/`rate_per_day` ของแถว (ค่าเริ่มต้น 60 / 5000)
  - ถ้าเช็ก rate limit ไม่ได้: tool อ่าน fail-open · tool ร่าง fail-closed
  - ตัดสิทธิ์ AI ทั้งหมด: ตั้ง `revoked_at` ของแถว `mcp-default`

## 8. deploy บน Cloudflare (เช็กลิสต์ · ใส่ค่าจริงเองตอน deploy)

ใน repo ไม่มีค่าจริงใด ๆ · id ใน `wrangler.toml` เป็น placeholder ทั้งหมด

1. **D1:**
   - `wrangler d1 create owner-os`
   - นำ `database_id` ที่ได้ไปใส่ใน `[[d1_databases]]` (binding `DB`)
2. **R2:** `wrangler r2 bucket create owner-os-evidence` (binding `BUCKET`)
3. **KV:**
   - `wrangler kv namespace create OAUTH_KV`
   - นำ id ไปใส่ใน `[[kv_namespaces]]`
4. **Secret** ใช้ `wrangler secret put` และต้องเป็นค่าสุ่มยาว ไม่ใช่ค่าใน `.dev.vars.example`:
   - `API_TOKEN` ใช้กับ `/api/*` และเป็น token ที่เจ้าของกรอกในเว็บ
   - `CONSENT_CSRF_SECRET`
5. **Vars** (ใน `[vars]` ของ `wrangler.toml` หรือใน dashboard):
   - `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`)
   - `ACCESS_AUD` (audience tag ของ Access application)
   - `OWNER_EMAILS` (คั่นด้วย `,`)
   - `MCP_ALLOWED_REDIRECT_HOSTS` (ค่าเริ่มต้น `chatgpt.com,claude.ai`)
6. **Cloudflare Access:**
   - สร้าง application ครอบ path `/oauth/authorize` และใส่ policy ให้เฉพาะอีเมลเจ้าของ
   - ห้ามครอบ `/oauth/token`, `/oauth/register`, `/.well-known/*` และ `/mcp` เพราะ AI ต้องเรียกได้โดยตรง
7. **Migration remote ทั้งหมด:** `cd apps/worker && pnpm exec wrangler d1 migrations apply owner-os --remote` (0000–0011 ซึ่งรวมแถว `mcp-default`)
8. **Deploy:** `pnpm exec wrangler deploy` (ใน `apps/worker`) · เว็บ build ด้วย `pnpm --filter @owner-os/web build` ได้ `apps/web/dist`
   · repo ยังไม่มี config deploy ของเว็บ โฮสต์ที่ใช้ต้องส่ง `/api` ไปยัง Worker origin เดียวกัน (ตอน dev ใช้ proxy ของ Vite)
9. **Smoke test:**
   - `GET /health` ต้องได้ 200
   - `/api/assets` ที่ไม่มี token ต้องได้ 401 และเมื่อมี token ต้องได้ 200
   - `/test-camera` ต้องได้ 200 (ทดสอบกล้องและ GPS บนมือถือจริงผ่าน HTTPS)
   - `POST /mcp` ที่ไม่มี token ต้องได้ 401 และมี header `WWW-Authenticate`
   - `GET /.well-known/oauth-authorization-server` ต้องได้ metadata
   - เปิด `/oauth/authorize` ต้องถูก Access ถามตัวตน
   - (ไม่บังคับ) `OWNER_OS_URL=https://<worker-host> OWNER_OS_TOKEN=<API_TOKEN> pnpm seed:demo` ใส่ demo

## 9. ต้องยืนยันก่อนใช้จริง

- **กติกาเงินทั้งหมดเป็น `draft_unconfirmed`** ทั้งสัญญา 4 type, ข้อตกลงกรณีภัย และค่าเริ่มต้นในข้อ 5
  - เป็นการตีความของทีมเรา ต้องให้เจ้าของยืนยันกติกาจริงก่อน
  - ระบบแสดงผลเป็น preview เท่านั้น
- **แม่แบบงาน** ปลูก (ทุเรียน/ข้าวโพด/เมล่อน) และรับมือภัย เป็นค่าเริ่มต้นจากหลักทั่วไป ควรให้ผู้เชี่ยวชาญพืชและพื้นที่ทบทวน
- **ความคุ้มครองประกันจริง:** ระบบรับยอดเงินประกันที่กรอกเท่านั้น ยังไม่รู้เงื่อนไขกรมธรรม์ (`insurance_recipient` ค่าเริ่มต้นเป็น `pool`)
- **ข้อมูลที่ AI อ่าน** (ผ่าน MCP) จะไปอยู่กับผู้ให้บริการ AI ตามนโยบายของผู้ให้บริการนั้น
  - พิกัดและรูปเป็นค่าที่ภาคสนามแจ้ง
  - เจ้าของควรตัดสินใจก่อนว่าจะเปิด MCP และจะเปิด scope `draft` หรือไม่
- **geofence** ใช้ความแม่นยำ GPS ไม่เกิน 100 ม. และ buffer 15 ม. ค่าทั้งสองตั้งในโค้ด (`src/routes/tasks.ts`) ควรยืนยันว่าเหมาะกับพื้นที่จริง

## 10. ยังไม่ทำ / backlog

- **หลายเจ้าของ:** ยังไม่มี `owner_id` ทั้งระบบเป็นของเจ้าของคนเดียว
- **ผู้รับงาน:** ยังไม่มีบัญชีผู้ดูแลหรือผู้รับงาน หน้าส่งงานคือ `/test-camera`
- **ค่าใช้จ่ายต่องาน:** ยังไม่มีบันทึกค่าใช้จ่ายต่องาน OPEX ใน settlement จึงต้องกรอกเป็นยอดรวม
- **settlement จริง:** บันทึกและอนุมัติ settlement จริง (ตอนนี้เป็น preview เท่านั้น)
- **กองทุนสำรอง:** ยังไม่มี
- **UI บนเว็บ:** ยังไม่มีหน้าสัญญา รอบปลูก settlement และเหตุภัย (ทำผ่าน API หรือ MCP ได้) · เว็บตอนนี้มีรายการสินทรัพย์ แผนที่และวาดแปลง ตรวจงานและรูปหลักฐาน และกล่องร่างจาก AI
- **ระบบเตือนภัย:** ยังไม่มีการดึงข้อมูลพยากรณ์หรือการแจ้งเตือนอัตโนมัติ
- **token เดียวสำหรับ `/api/*`:** ทุกคนที่มี `API_TOKEN` ทำได้ทุกอย่าง ยังไม่มีผู้ใช้หรือ role
- **seed ไม่ idempotent:** รันซ้ำแล้วข้อมูลซ้ำ ยังไม่มี API ลบ
- **P3 อื่นที่ทราบ:** PROGRESS.md ไม่มีรายการ P3 แยก ข้อเหล่านี้รวมจากหมายเหตุใน PR
  - rate limit ของ MCP นับจาก `mcp_audit` แบบอ่านแล้วตัดสิน (ไม่ atomic) จึงอาจเกินเล็กน้อยเมื่อเรียกพร้อมกัน
  - `settlement_what_if` บนสัญญา turnkey ที่ base ใช้ `crop_cycle_id` แต่ไม่ส่ง `period_months` มา: สถานการณ์ที่ปรับรายได้จะได้ error `period_months_required` (ต้องใส่ `period_months` ใน base)
  - กล่องร่างบนเว็บแสดงแปลงเป็น id (payload มีแค่ `unit_id`)
  - หัวข้อ "ใช้จาก AI (MCP)" ใน README ยังเขียนว่ามีแค่ `list_assets`/`get_asset` ให้ยึดรายการในข้อ 7 ของเอกสารนี้
  - ยังไม่ได้ทดสอบ `/test-camera` บนมือถือจริงผ่าน HTTPS (รอ deploy)

## 11. วิธีทำงานของทีมเรา

- **ทำทีละ task:** แต่ละใบงานมีขอบเขต ไฟล์ที่แตะได้ และเกณฑ์รับงานชัดเจน ทำเสร็จแล้วจบที่ Draft PR เข้า `main`
- **PR ซ้อน branch:** branch ของ task ถัดไปแตกจาก branch ก่อนหน้า (ยังไม่ merge) ดังนั้น diff ของ PR หลัง ๆ จะรวมงานก่อนหน้าไว้จนกว่าจะ merge ตามลำดับ
- **รีวิว:** Mentor รีวิวที่ **exact head SHA** ใช้ mutation probe (แก้โค้ดให้ผิดแล้วดูว่าเทสต์จับได้) และลอง e2e จริง พบอะไรก็ออกใบแก้ (P2/P3) ก่อนไป task ถัดไป
- **CI** (`.github/workflows/ci.yml`): ทุก push และทุก PR รัน `pnpm install --frozen-lockfile` · `pnpm typecheck` · `pnpm test` · `pnpm build` และต้องเขียวก่อนส่งงาน
- **migration:** additive เท่านั้น สร้างด้วย `drizzle-kit generate` และไม่แก้ไฟล์เดิม · `drizzle-kit generate` ที่รันซ้ำต้องได้ "No schema changes"
