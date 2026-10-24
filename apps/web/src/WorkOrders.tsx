import type { AssetUnit, WorkOrder, WorkOrderStatus } from "@owner-os/shared";
import { useEffect, useState } from "react";
import { ApiError, apiGet } from "./api";
import { STATUS_BADGES } from "./App";

const FILTERS: { value: WorkOrderStatus | "all"; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "open", label: "เปิดอยู่" },
  { value: "submitted", label: "ส่งแล้ว" },
  { value: "verified", label: "ยืนยันแล้ว" },
  { value: "rejected", label: "ไม่ผ่าน" },
];

/** Work orders of one asset with a status filter (`?status=`). All API text is rendered as text nodes. */
export function WorkOrders(props: {
  assetId: string;
  units: AssetUnit[];
  refreshKey: number;
  selectedId: string | null;
  onSelect: (wo: WorkOrder) => void;
}) {
  const [filter, setFilter] = useState<WorkOrderStatus | "all">("all");
  const [workOrders, setWorkOrders] = useState<WorkOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { assetId, refreshKey } = props;

  useEffect(() => {
    let cancelled = false;
    const query = filter === "all" ? "" : `?status=${filter}`;
    setWorkOrders(null);
    setError(null);
    apiGet<{ work_orders: WorkOrder[] }>(`/api/assets/${encodeURIComponent(assetId)}/work-orders${query}`)
      .then((res) => {
        if (!cancelled) setWorkOrders(res.work_orders);
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof ApiError && err.status === 401)) return;
        setError(err instanceof ApiError ? `โหลดรายการงานไม่สำเร็จ (HTTP ${err.status})` : "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, filter, refreshKey]);

  const unitName = (id: string | null) => (id === null ? "ทั้งสินทรัพย์" : (props.units.find((u) => u.id === id)?.name ?? "—"));

  return (
    <section className="space-y-2" aria-label="งาน">
      <h3 className="font-semibold">งาน</h3>
      <div className="flex flex-wrap gap-2" role="group" aria-label="กรองสถานะ">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3 py-2 text-sm ${
              filter === f.value ? "bg-slate-800 text-white" : "border border-slate-300 bg-white"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm font-semibold text-rose-700">
          {error}
        </p>
      )}
      {workOrders === null && !error && <p className="text-slate-500">กำลังโหลดงาน…</p>}
      {workOrders?.length === 0 && <p className="text-slate-500">ไม่มีงานในสถานะนี้</p>}

      <ul className="space-y-2">
        {workOrders?.map((wo) => {
          const badge = STATUS_BADGES.find((b) => b.status === wo.status);
          return (
            <li key={wo.id}>
              <button
                type="button"
                onClick={() => props.onSelect(wo)}
                data-testid="work-order"
                className={`w-full rounded-xl bg-white p-3 text-left shadow-sm ${
                  props.selectedId === wo.id ? "ring-2 ring-blue-500" : ""
                }`}
              >
                <span className="block font-semibold">{wo.title}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                  <span>{unitName(wo.unit_id)}</span>
                  {badge && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge.className}`}>
                      {badge.label}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
