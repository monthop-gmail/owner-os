import { useEffect, useState } from "react";
import { ApiError, apiBlob, apiGet } from "./api";
import { describeGeofence, formatCapturedAt, pinStyle, type EvidenceItem, type TaskDetail } from "./evidence";

export type Selection =
  | { kind: "evidence"; evidence: EvidenceItem; title: string }
  | { kind: "work_order"; workOrderId: string; title: string };

/** Details for a selected pin or work order, including the photo fetched with the bearer token. */
export function EvidencePanel({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  const [evidence, setEvidence] = useState<EvidenceItem | null | undefined>(
    selection.kind === "evidence" ? selection.evidence : undefined,
  );
  const [error, setError] = useState<string | null>(null);

  // A work order: newest uploaded evidence from GET /api/tasks/:id (undefined = loading, null = none).
  useEffect(() => {
    if (selection.kind !== "work_order") return;
    let cancelled = false;
    setEvidence(undefined);
    setError(null);
    apiGet<TaskDetail>(`/api/tasks/${encodeURIComponent(selection.workOrderId)}`)
      .then((res) => {
        if (!cancelled) setEvidence(res.evidence[0] ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof ApiError && err.status === 401)) return;
        setError("โหลดรายละเอียดงานไม่สำเร็จ");
      });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  return (
    <section aria-label="รายละเอียดหลักฐาน" className="space-y-2 rounded-xl bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold">{selection.title}</h3>
        <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1">
          ปิด
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm font-semibold text-rose-700">
          {error}
        </p>
      )}
      {evidence === undefined && !error && <p className="text-slate-500">กำลังโหลด…</p>}
      {evidence === null && <p className="text-slate-500">ยังไม่มีหลักฐาน</p>}
      {evidence && <EvidenceFacts evidence={evidence} />}
    </section>
  );
}

function EvidenceFacts({ evidence }: { evidence: EvidenceItem }) {
  const geofence = describeGeofence(evidence);
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">เวลาถ่าย</dt>
        <dd>{formatCapturedAt(evidence.captured_at)}</dd>
        <dt className="text-slate-500">พิกัด</dt>
        <dd>
          {evidence.lat !== null && evidence.lng !== null
            ? `${evidence.lat.toFixed(6)}, ${evidence.lng.toFixed(6)}`
            : "ยังไม่มีพิกัด (ยังไม่ผ่านการตรวจ)"}
        </dd>
        <dt className="text-slate-500">ความแม่นยำ</dt>
        <dd>{evidence.accuracy_m === null ? "—" : `±${Math.round(evidence.accuracy_m)} ม.`}</dd>
        <dt className="text-slate-500">ตำแหน่ง</dt>
        <dd>
          {geofence === null ? (
            "—"
          ) : (
            <span style={{ color: pinStyle(evidence).color }} className="font-semibold">
              {geofence}
            </span>
          )}
        </dd>
      </dl>
      <EvidenceImage evidenceId={evidence.id} />
    </>
  );
}

/** Fetches the image with the bearer token into an object URL; revoked when closed or changed. */
function EvidenceImage({ evidenceId }: { evidenceId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    apiBlob(`/api/evidence/${encodeURIComponent(evidenceId)}/image`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof ApiError && err.status === 401)) return;
        setError(err instanceof ApiError && err.status === 404 ? "ไม่พบรูปของหลักฐานนี้" : "โหลดรูปไม่สำเร็จ");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [evidenceId]);

  if (error) return <p className="text-sm font-semibold text-rose-700">{error}</p>;
  if (!url) return <p className="text-sm text-slate-500">กำลังโหลดรูป…</p>;
  return <img src={url} alt="รูปหลักฐาน" className="max-h-96 w-full rounded-lg object-contain" />;
}
