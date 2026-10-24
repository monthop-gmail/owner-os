# owner-os

[![CI](https://github.com/monthop-gmail/owner-os/actions/workflows/ci.yml/badge.svg)](https://github.com/monthop-gmail/owner-os/actions/workflows/ci.yml)

owner-os คือระบบสำหรับเจ้าของสินทรัพย์ (แปลงเกษตร/ทรัพย์สิน) ใช้บันทึกสินทรัพย์ มอบหมายงาน และตรวจหลักฐานการทำงาน (proof-of-work) พร้อมพิกัด GPS — สร้างเป็น monorepo บน Cloudflare Workers + D1 + R2 และหน้าเว็บ React

```sh
pnpm install
pnpm typecheck
```

## Web dashboard (dev)

Two terminals; the Vite dev server proxies `/api` and `/test-camera` to the local Worker on :8787.

```sh
# 1) Worker (local D1/R2, local-only token)
cd apps/worker && pnpm db:migrate:local && pnpm exec wrangler dev --local --var API_TOKEN:change-me-local-only

# 2) Web
pnpm --filter @owner-os/web dev
```

Open the URL Vite prints and enter the same token. The token is only stored in that browser's localStorage.

## Demo data

Seeds 4 synthetic demo assets (units, work orders, 3 with proof-of-work) **through the API** from `apps/worker/fixtures/demo-seed.json`.
Running it again creates duplicates (there is no GET/DELETE API yet).

```sh
cd apps/worker
pnpm seed:demo --dry-run                      # print the plan, send nothing

# local: apply migrations, then start the Worker with a local-only token
pnpm db:migrate:local
pnpm exec wrangler dev --local --var API_TOKEN:change-me-local-only
OWNER_OS_URL=http://localhost:8787 OWNER_OS_TOKEN=change-me-local-only pnpm seed:demo

# deployed Worker
OWNER_OS_URL=https://<your-worker-url> OWNER_OS_TOKEN=<API_TOKEN> pnpm seed:demo
```
