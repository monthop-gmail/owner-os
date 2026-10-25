// Pure helpers for evidence pins and their detail panel.
import type { WorkOrder } from "@owner-os/shared";

/** Evidence as returned by the API: location/geofence fields are null until the work order is completed. */
export type EvidenceItem = {
  id: string;
  work_order_id: string;
  r2_key: string;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  captured_at: string | null;
  inside_geofence: boolean | null;
  distance_outside_m: number | null;
};

/** Item from GET /api/evidence (map pins): always uploaded and located. */
export type PinEvidence = EvidenceItem & {
  lat: number;
  lng: number;
  asset_id: string;
  unit_id: string | null;
  work_order_title: string;
};

export type TaskDetail = { work_order: WorkOrder; evidence: EvidenceItem[] };

/** Must match the server's GEOFENCE_BUFFER_M. */
export const GEOFENCE_BUFFER_M = 15;

export type PinKind = "inside" | "buffer" | "outside";
export type PinStyle = { kind: PinKind; color: string; label: string };

const PIN_STYLES: Record<PinKind, PinStyle> = {
  inside: { kind: "inside", color: "#16a34a", label: "ในแปลง" },
  buffer: { kind: "buffer", color: "#ea580c", label: "นอกแปลงเล็กน้อย (อยู่ในระยะเผื่อ)" },
  // Not expected (the server rejects these), kept so an odd row is never shown as a pass.
  outside: { kind: "outside", color: "#dc2626", label: "นอกแปลง" },
};

/** Green inside the plot, orange when it passed only thanks to the buffer. */
export function pinStyle(e: Pick<EvidenceItem, "inside_geofence" | "distance_outside_m">): PinStyle {
  if (e.inside_geofence) return PIN_STYLES.inside;
  if (e.distance_outside_m !== null && e.distance_outside_m <= GEOFENCE_BUFFER_M) return PIN_STYLES.buffer;
  return PIN_STYLES.outside;
}

/** "อยู่ในแปลง" or "นอกแปลง 12 ม." (null when the evidence has no geofence result yet). */
export function describeGeofence(e: Pick<EvidenceItem, "inside_geofence" | "distance_outside_m">): string | null {
  if (e.inside_geofence === null) return null;
  if (e.inside_geofence) return "อยู่ในแปลง";
  return `นอกแปลง ${Math.round(e.distance_outside_m ?? 0)} ม.`;
}

const THAI_DATE = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const THAI_TIME = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "24 ต.ค. 2569 · 09:00 น." in Asia/Bangkok; "—" when missing or invalid. */
export function formatCapturedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${THAI_DATE.format(d)} · ${THAI_TIME.format(d)} น.`;
}
