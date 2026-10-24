# owner-os — Progress
ทำทีละ task · แต่ละ task จบที่ PR + รีวิวโดย Mentor ก่อนเริ่ม task ถัดไป

## Milestone 1: Workspace & D1 Core
- [x] Task 1.1: pnpm-workspace.yaml, root package.json, tsconfig.base.json
- [x] Task 1.2: packages/shared — types + Zod schemas (Asset, AssetUnit, WorkOrder, Evidence)
- [x] Task 1.3: apps/worker — Hono + Drizzle config + wrangler.toml (D1 + R2 bindings, local only)
- [x] Task 1.4: schema.ts (assets, asset_units, work_orders, work_order_evidence, farm_crop_cycles) + initial Drizzle migration SQL

## Milestone 2: Proof-of-Work Spike
- [x] Task 2.1: POST /api/assets, POST /api/assets/:id/units
- [x] Task 2.2: POST /api/tasks/:id/upload-ticket + PUT /api/tasks/:id/complete (upload ผ่าน Worker → R2, geofence ด้วย Turf + accuracy + buffer)
- [x] Task 2.4: auth ขั้นต่ำ (bearer token จาก Worker secret) — ต้องเสร็จก่อน deploy ครั้งแรก
- [x] Task 2.3: /test-camera หน้า HTML ทดสอบ GPS + กล้อง + อัปโหลด (ทดสอบบนมือถือได้หลัง deploy HTTPS) — หมายเหตุ: ทดสอบบนมือถือจริงรอ deploy HTTPS
- [x] Task 2.5: hardening ก่อน deploy (race · เพดาน evidence · captured_at)
- [x] Task 2.6: CI (GitHub Actions)
- [x] Task 2.7: demo seed ผ่าน API + /test-camera retry

## Milestone 3: Web Dashboard
- [x] Task 3.0: read API สำหรับ dashboard
- [x] Task 3.1: apps/web — Vite + React + Tailwind + proxy ไป Worker
- [x] Task 3.2: Leaflet วาดแปลง + คำนวณพื้นที่ด้วย Turf + บันทึก GeoJSON
- [x] Task 3.3: Owner Audit Dashboard — สถานะแปลง + รูป proof-of-work พร้อมหมุดบนแผนที่

## Milestone 4: Operational Engine & Settlements (รอกติกาจากเจ้าของ)
- [x] Task 4.1a: crop cycle state machine + API
- [x] Task 4.1b: แม่แบบงานตามช่วง (ทุเรียน/ข้าวโพด)
- [x] Task 4.2: Harvest log + ใบชั่งน้ำหนัก เก็บใน R2
- [x] Task 4.3a: สัญญาครบ 4 type (draft_unconfirmed)
- [ ] Task 4.3b: settlement engine
