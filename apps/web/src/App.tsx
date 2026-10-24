import type { Asset, AssetKind, WorkOrderStatus } from "@owner-os/shared";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { apiGet, ApiError, clearToken, getToken, setToken, UNAUTHORIZED_EVENT } from "./api";

export type AssetListItem = Asset & {
  unit_count: number;
  work_order_counts: Record<WorkOrderStatus, number>;
};
type AssetsResponse = { assets: AssetListItem[] };

// Leaflet is only loaded when an asset detail page is opened.
const AssetDetail = lazy(() => import("./AssetDetail").then((m) => ({ default: m.AssetDetail })));

export const KIND_LABEL: Record<AssetKind, string> = {
  farm: "ฟาร์ม",
  property: "อสังหาฯ",
  equipment: "อุปกรณ์",
  other: "อื่น ๆ",
};

export const STATUS_BADGES: { status: WorkOrderStatus; label: string; className: string }[] = [
  { status: "open", label: "เปิดอยู่", className: "bg-sky-100 text-sky-800" },
  { status: "in_progress", label: "กำลังทำ", className: "bg-amber-100 text-amber-800" },
  { status: "submitted", label: "ส่งแล้ว", className: "bg-violet-100 text-violet-800" },
  { status: "verified", label: "ยืนยันแล้ว", className: "bg-emerald-100 text-emerald-800" },
  { status: "rejected", label: "ไม่ผ่าน", className: "bg-rose-100 text-rose-800" },
];

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "API token ไม่ถูกต้อง";
    if (err.status === 503) return "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า API token";
    return `เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ (HTTP ${err.status})`;
  }
  return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้";
}

/** Minimal hash routing: "#/assets/<id>" opens the detail page, anything else is the list. */
function assetIdFromHash(hash: string): string | null {
  const match = /^#\/assets\/([^/]+)$/.exec(hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function useHashAssetId(): string | null {
  const [assetId, setAssetId] = useState(() => assetIdFromHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setAssetId(assetIdFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return assetId;
}

export function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [assets, setAssets] = useState<AssetListItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const assetId = useHashAssetId();
  // Only a session that was signed in gets the "token no longer valid" notice; a wrong token typed on the
  // token screen already shows its own error.
  const signedInRef = useRef(token !== null);
  useEffect(() => {
    signedInRef.current = token !== null;
  }, [token]);

  useEffect(() => {
    const onUnauthorized = () => {
      if (signedInRef.current) setNotice("token ใช้ไม่ได้แล้ว กรุณากรอกใหม่");
      setTokenState(null);
      setAssets(null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signedIn = (newToken: string, list: AssetListItem[]) => {
    setToken(newToken);
    setTokenState(newToken);
    setAssets(list);
    setNotice(null);
  };

  const logout = () => {
    clearToken();
    setTokenState(null);
    setAssets(null);
    setNotice(null);
  };

  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="mb-4 text-xl font-bold">owner-os · แดชบอร์ดเจ้าของ</h1>
      {token && assetId ? (
        <Suspense fallback={<p className="text-slate-500">กำลังโหลดแผนที่…</p>}>
          <AssetDetail key={assetId} assetId={assetId} onBack={() => (window.location.hash = "")} />
        </Suspense>
      ) : token ? (
        <AssetsScreen initial={assets} onLoaded={setAssets} onLogout={logout} />
      ) : (
        <TokenScreen notice={notice} onSignedIn={signedIn} />
      )}
    </main>
  );
}

function TokenScreen(props: { notice: string | null; onSignedIn: (token: string, assets: AssetListItem[]) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const candidate = value.trim();
    if (!candidate) {
      setError("กรอก API token ก่อน");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { assets } = await apiGet<AssetsResponse>("/api/assets", candidate);
      props.onSignedIn(candidate, assets);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">เข้าสู่ระบบ</h2>
      {props.notice && <p className="text-sm text-amber-700">{props.notice}</p>}
      <label className="block text-sm" htmlFor="api-token">
        API token
      </label>
      <input
        id="api-token"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded-lg border border-slate-300 p-3 text-base"
      />
      {error && (
        <p role="alert" className="text-sm font-semibold text-rose-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-blue-600 p-3 text-lg font-semibold text-white disabled:bg-slate-400"
      >
        {busy ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}
      </button>
    </form>
  );
}

function AssetsScreen(props: {
  initial: AssetListItem[] | null;
  onLoaded: (assets: AssetListItem[]) => void;
  onLogout: () => void;
}) {
  const [assets, setAssets] = useState<AssetListItem[] | null>(props.initial);
  const [error, setError] = useState<string | null>(null);
  const { onLoaded } = props;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiGet<AssetsResponse>("/api/assets");
      setAssets(res.assets);
      onLoaded(res.assets);
    } catch (err) {
      // 401 is handled globally (back to the token screen).
      if (!(err instanceof ApiError && err.status === 401)) setError(errorMessage(err));
    }
  }, [onLoaded]);

  useEffect(() => {
    if (props.initial === null) void load();
  }, [props.initial, load]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">สินทรัพย์</h2>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} className="rounded-lg border border-slate-300 px-3 py-2">
            รีเฟรช
          </button>
          <button type="button" onClick={props.onLogout} className="rounded-lg bg-slate-800 px-3 py-2 text-white">
            ออกจากระบบ
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm font-semibold text-rose-700">
          {error}
        </p>
      )}
      {assets === null && !error && <p className="text-slate-500">กำลังโหลด…</p>}
      {assets?.length === 0 && <p className="text-slate-500">ยังไม่มีสินทรัพย์</p>}

      <ul className="space-y-3">
        {assets?.map((asset) => (
          <AssetCard key={asset.id} asset={asset} />
        ))}
      </ul>
    </section>
  );
}

function AssetCard({ asset }: { asset: AssetListItem }) {
  const badges = STATUS_BADGES.filter((b) => asset.work_order_counts[b.status] > 0);
  return (
    <li className="rounded-xl bg-white p-4 shadow-sm" data-testid="asset-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">
          <a href={`#/assets/${encodeURIComponent(asset.id)}`} className="text-blue-700 underline">
            {asset.name}
          </a>
        </h3>
        <span className="text-sm text-slate-500">{KIND_LABEL[asset.kind]}</span>
      </div>
      <p className="mt-1 text-sm text-slate-600">{asset.unit_count} แปลง/หน่วย</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {badges.length === 0 ? (
          <span className="text-sm text-slate-400">ยังไม่มีงาน</span>
        ) : (
          badges.map((b) => (
            <span key={b.status} className={`rounded-full px-2 py-1 text-xs font-semibold ${b.className}`}>
              {b.label} {asset.work_order_counts[b.status]}
            </span>
          ))
        )}
      </div>
    </li>
  );
}
