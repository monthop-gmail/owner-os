import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, ApiError } from "./api";
import type { AssetListItem } from "./App";

// Owner inbox for drafts proposed by AI over MCP. Everything in a payload comes from an AI, so it is only
// ever rendered as React text (no innerHTML).

export type DraftKind = "disaster_event" | "disaster_prep" | "recovery_tasks";
export type AiDraft = {
  id: string;
  kind: DraftKind;
  asset_id: string;
  payload: unknown;
  status: "pending" | "confirmed" | "rejected";
  created_at: string;
  created_by_client_id: string;
  decided_at: string | null;
  decision_note: string | null;
  result_ref: string | null;
};
type DraftsResponse = { drafts: AiDraft[] };

export const PENDING_DRAFTS_PATH = "/api/ai-drafts?status=pending";
const HISTORY_LIMIT = 20;

export const DRAFT_KIND_LABEL: Record<DraftKind, string> = {
  disaster_event: "บันทึกเหตุภัย",
  disaster_prep: "สร้างงานเตรียมรับมือ",
  recovery_tasks: "สร้างงานฟื้นฟู",
};

const DISASTER_TYPE_LABEL: Record<string, string> = {
  flood: "น้ำท่วม",
  drought: "ภัยแล้ง",
  storm: "พายุ",
  pest_disease: "ศัตรูพืช/โรคระบาด",
  fire: "ไฟไหม้",
  other: "อื่น ๆ",
};

const STATUS_LABEL: Record<AiDraft["status"], string> = {
  pending: "รอยืนยัน",
  confirmed: "ยืนยันแล้ว",
  rejected: "ปฏิเสธแล้ว",
};

/** Thai explanations for error codes the confirm/reject routes can return. */
const ERROR_TEXT: Record<string, string> = {
  validation_error: "ข้อมูลในร่างไม่ผ่านการตรวจสอบ (อาจล้าสมัยแล้ว)",
  unit_not_in_asset: "มีแปลงที่ไม่อยู่ในสินทรัพย์นี้แล้ว",
  asset_not_found: "ไม่พบสินทรัพย์",
  disaster_event_not_found: "ไม่พบเหตุภัยที่อ้างถึง",
  recovery_tasks_already_created: "เหตุภัยนี้สร้างงานฟื้นฟูไปแล้ว",
  draft_not_found: "ไม่พบร่างนี้",
};

const dateTimeTh = (iso: string) =>
  new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/** Human-readable summary of a draft payload (text only). */
function PayloadSummary({ draft }: { draft: AiDraft }) {
  const p = isRecord(draft.payload) ? draft.payload : {};
  const disasterType = DISASTER_TYPE_LABEL[text(p.event_type)] ?? text(p.event_type);
  switch (draft.kind) {
    case "disaster_event": {
      const units = Array.isArray(p.units) ? p.units.filter(isRecord) : [];
      const occurred = typeof p.occurred_at === "string" && !Number.isNaN(Date.parse(p.occurred_at)) ? dateTimeTh(p.occurred_at) : "-";
      return (
        <div className="space-y-1 text-sm">
          <p>
            ภัย: <strong>{disasterType}</strong> · เกิดเมื่อ {occurred}
          </p>
          {typeof p.description === "string" && <p className="text-slate-600">รายละเอียด: {p.description}</p>}
          <ul className="list-disc pl-5" aria-label="แปลงที่เสียหาย">
            {units.map((u, i) => (
              <li key={i}>
                แปลง {text(u.unit_id)}: เสียหาย {text(u.damage_pct)}%
                {typeof u.note === "string" && <span className="text-slate-600"> ({u.note})</span>}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "disaster_prep": {
      const unitIds = Array.isArray(p.unit_ids) ? p.unit_ids : null;
      return (
        <p className="text-sm">
          เตรียมรับมือ: <strong>{disasterType}</strong> · {unitIds ? `${unitIds.length} แปลง` : "ทุกแปลงของสินทรัพย์"}
        </p>
      );
    }
    case "recovery_tasks":
      return <p className="text-sm">ฟื้นฟูหลังเหตุภัย: {text(p.disaster_event_id)}</p>;
  }
}

function DraftCard(props: {
  draft: AiDraft;
  assetName: string;
  onDone: (id: string, message: string) => void;
  onAlreadyHandled: () => void;
}) {
  const { draft } = props;
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = async (action: "confirm" | "reject") => {
    setBusy(true);
    setError(null);
    const path = `/api/ai-drafts/${encodeURIComponent(draft.id)}/${action}`;
    try {
      await apiPost(path, action === "reject" && note.trim() ? { note: note.trim() } : {});
      props.onDone(draft.id, action === "confirm" ? "ยืนยันร่างแล้ว ระบบบันทึกข้อมูลให้แล้ว" : "ปฏิเสธร่างแล้ว");
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409 && (err.code === "draft_not_pending" || err.code === undefined)) {
        props.onAlreadyHandled();
        return;
      }
      if (err instanceof ApiError) {
        const code = err.code ?? `HTTP ${err.status}`;
        setError(`${code}: ${ERROR_TEXT[err.code ?? ""] ?? "ทำรายการไม่สำเร็จ"} — ร่างยังรอยืนยันอยู่`);
      } else {
        setError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ร่างยังรอยืนยันอยู่");
      }
    }
  };

  return (
    <li className="space-y-2 rounded-xl bg-white p-4 shadow-sm" data-testid="draft-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{DRAFT_KIND_LABEL[draft.kind] ?? draft.kind}</h3>
        <span className="text-sm text-slate-500">เสนอเมื่อ {dateTimeTh(draft.created_at)}</span>
      </div>
      <p className="text-sm text-slate-600">สินทรัพย์: {props.assetName}</p>
      <p className="inline-block rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
        เสนอโดย AI — ยังไม่มีผลจนกว่าจะยืนยัน
      </p>
      <PayloadSummary draft={draft} />
      {error && (
        <p role="alert" className="text-sm font-semibold text-rose-700">
          {error}
        </p>
      )}
      {rejecting && (
        <div className="space-y-1">
          <label className="block text-sm" htmlFor={`note-${draft.id}`}>
            เหตุผลที่ปฏิเสธ (ไม่บังคับ)
          </label>
          <input
            id={`note-${draft.id}`}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-slate-300 p-2"
          />
        </div>
      )}
      <div className="flex gap-2">
        {!rejecting ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void send("confirm")}
              className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white disabled:bg-slate-400"
            >
              ยืนยัน
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRejecting(true)}
              className="rounded-lg border border-rose-300 px-4 py-2 text-rose-700 disabled:text-slate-400"
            >
              ปฏิเสธ
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void send("reject")}
              className="rounded-lg bg-rose-600 px-4 py-2 font-semibold text-white disabled:bg-slate-400"
            >
              ยืนยันการปฏิเสธ
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRejecting(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 disabled:text-slate-400"
            >
              ยกเลิก
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function HistoryList({ drafts, assetName }: { drafts: AiDraft[]; assetName: (id: string) => string }) {
  if (drafts.length === 0) return <p className="text-slate-500">ยังไม่มีประวัติ</p>;
  return (
    <ul className="space-y-2">
      {drafts.map((d) => (
        <li key={d.id} className="rounded-xl bg-white p-3 text-sm shadow-sm" data-testid="history-item">
          <p>
            <strong>{DRAFT_KIND_LABEL[d.kind] ?? d.kind}</strong> · {assetName(d.asset_id)} · {STATUS_LABEL[d.status]}
            {d.decided_at && ` เมื่อ ${dateTimeTh(d.decided_at)}`}
          </p>
          {d.decision_note && <p className="text-slate-600">เหตุผล: {d.decision_note}</p>}
        </li>
      ))}
    </ul>
  );
}

export function DraftsInbox(props: { assets: AssetListItem[] | null; onBack: () => void }) {
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [pending, setPending] = useState<AiDraft[] | null>(null);
  const [history, setHistory] = useState<AiDraft[] | null>(null);
  const [assets, setAssets] = useState<AssetListItem[] | null>(props.assets);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    setError(null);
    try {
      setPending((await apiGet<DraftsResponse>(PENDING_DRAFTS_PATH)).drafts);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setError("โหลดร่างไม่สำเร็จ");
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const { drafts } = await apiGet<DraftsResponse>("/api/ai-drafts");
      const decided = drafts
        .filter((d) => d.status !== "pending")
        .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))
        .slice(0, HISTORY_LIMIT);
      setHistory(decided);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setError("โหลดประวัติไม่สำเร็จ");
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  useEffect(() => {
    if (assets !== null) return;
    apiGet<{ assets: AssetListItem[] }>("/api/assets")
      .then((res) => setAssets(res.assets))
      .catch(() => setAssets([])); // names fall back to ids
  }, [assets]);

  useEffect(() => {
    if (tab === "history") void loadHistory();
  }, [tab, loadHistory]);

  const assetName = (id: string) => assets?.find((a) => a.id === id)?.name ?? id;

  const onDone = (id: string, message: string) => {
    setPending((list) => list?.filter((d) => d.id !== id) ?? null);
    setHistory(null);
    setNotice(message);
  };

  const onAlreadyHandled = () => {
    setNotice("ร่างนี้ถูกจัดการไปแล้ว");
    void loadPending();
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">ร่างจาก AI</h2>
        <button type="button" onClick={props.onBack} className="rounded-lg border border-slate-300 px-3 py-2">
          กลับไปหน้าสินทรัพย์
        </button>
      </div>
      <div className="flex gap-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "pending"}
          onClick={() => setTab("pending")}
          className={`rounded-lg px-3 py-2 ${tab === "pending" ? "bg-slate-800 text-white" : "border border-slate-300"}`}
        >
          รอยืนยัน{pending ? ` (${pending.length})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          onClick={() => setTab("history")}
          className={`rounded-lg px-3 py-2 ${tab === "history" ? "bg-slate-800 text-white" : "border border-slate-300"}`}
        >
          ประวัติ
        </button>
      </div>
      {notice && (
        <p role="status" className="text-sm font-semibold text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-semibold text-rose-700">
          {error}
        </p>
      )}
      {tab === "pending" ? (
        <>
          {pending === null && !error && <p className="text-slate-500">กำลังโหลด…</p>}
          {pending?.length === 0 && <p className="text-slate-500">ไม่มีร่างรอยืนยัน</p>}
          <ul className="space-y-3">
            {pending?.map((d) => (
              <DraftCard key={d.id} draft={d} assetName={assetName(d.asset_id)} onDone={onDone} onAlreadyHandled={onAlreadyHandled} />
            ))}
          </ul>
        </>
      ) : history === null ? (
        <p className="text-slate-500">กำลังโหลด…</p>
      ) : (
        <HistoryList drafts={history} assetName={assetName} />
      )}
    </section>
  );
}

/** Count of pending drafts for the asset list header; links to #/drafts. Errors just hide the count. */
export function PendingDraftsBadge() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<DraftsResponse>(PENDING_DRAFTS_PATH)
      .then((res) => alive && setCount(res.drafts.length))
      .catch(() => alive && setCount(null));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <a href="#/drafts" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900" data-testid="drafts-link">
      ร่างจาก AI
      {count !== null && (
        <span className="ml-1 rounded-full bg-amber-600 px-2 text-xs font-semibold text-white" aria-label={`รอยืนยัน ${count} รายการ`}>
          {count}
        </span>
      )}
    </a>
  );
}
