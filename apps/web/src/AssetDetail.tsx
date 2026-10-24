import type { Asset, AssetUnit, AssetUnitType } from "@owner-os/shared";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, apiGet, apiPost } from "./api";
import { KIND_LABEL } from "./App";
import { areaM2, canClose, formatArea, polygonToLatLngs, toPolygon, type LatLngPoint } from "./geo";

// Default marker icons from the bundle instead of Leaflet's CSS-relative lookup.
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
const THAILAND_CENTER: L.LatLngTuple = [13.5, 100.9];
const THAILAND_ZOOM = 6;
const UNIT_STYLE: L.PathOptions = { color: "#2563eb", weight: 2, fillOpacity: 0.15 };
const DRAFT_STYLE: L.PathOptions = { color: "#ea580c", weight: 2, dashArray: "6 4", fillOpacity: 0.2 };

const UNIT_TYPES: { value: AssetUnitType; label: string }[] = [
  { value: "plot", label: "แปลง" },
  { value: "zone", label: "โซน" },
  { value: "building", label: "อาคาร/โรงเรือน" },
  { value: "other", label: "อื่น ๆ" },
];

type DetailResponse = { asset: Asset; units: AssetUnit[] };

function describeError(err: unknown, action: "load" | "save"): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "ไม่พบสินทรัพย์นี้";
    if (err.status === 400) return "ข้อมูลแปลงไม่ถูกต้อง — ตรวจชื่อแปลง (1–200 ตัวอักษร) และรูปแปลง";
    if (err.status === 401) return "API token ไม่ถูกต้อง";
    return `${action === "save" ? "บันทึก" : "โหลด"}ไม่สำเร็จ (HTTP ${err.status})`;
  }
  return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้";
}

export function AssetDetail({ assetId, onBack }: { assetId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [points, setPoints] = useState<LatLngPoint[]>([]);
  const [closed, setClosed] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setDetail(await apiGet<DetailResponse>(`/api/assets/${encodeURIComponent(assetId)}`));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setLoadError(describeError(err, "load"));
    }
  }, [assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const draftArea = areaM2(points);

  return (
    <section className="space-y-3">
      <button type="button" onClick={onBack} className="rounded-lg border border-slate-300 px-3 py-2">
        ← กลับไปรายการ
      </button>

      {loadError && (
        <p role="alert" className="font-semibold text-rose-700">
          {loadError}
        </p>
      )}
      {!detail && !loadError && <p className="text-slate-500">กำลังโหลด…</p>}

      {detail && (
        <>
          <div>
            <h2 className="text-lg font-semibold">{detail.asset.name}</h2>
            <p className="text-sm text-slate-500">{KIND_LABEL[detail.asset.kind]}</p>
          </div>

          <PlotMap
            units={detail.units}
            points={points}
            closed={closed}
            onAddPoint={(p) => {
              if (!closed) setPoints((prev) => [...prev, p]);
            }}
          />

          <div className="rounded-xl bg-white p-3 shadow-sm">
            <p className="text-sm text-slate-600">
              {closed ? "แปลงปิดแล้ว" : "แตะบนแผนที่เพื่อเพิ่มจุด"} · {points.length} จุด
              {canClose(points) && <> · พื้นที่ {formatArea(draftArea)}</>}
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={points.length === 0}
                onClick={() => {
                  setClosed(false);
                  setPoints((prev) => prev.slice(0, -1));
                }}
                className="rounded-lg border border-slate-300 p-3 disabled:opacity-40"
              >
                ย้อนจุด
              </button>
              <button
                type="button"
                disabled={points.length === 0}
                onClick={() => {
                  setClosed(false);
                  setPoints([]);
                }}
                className="rounded-lg border border-slate-300 p-3 disabled:opacity-40"
              >
                ล้าง
              </button>
              <button
                type="button"
                disabled={closed || !canClose(points)}
                onClick={() => setClosed(true)}
                className="rounded-lg bg-orange-600 p-3 font-semibold text-white disabled:bg-slate-300"
              >
                ปิดแปลง
              </button>
            </div>
            {closed && (
              <SaveUnitForm
                assetId={assetId}
                points={points}
                onSaved={() => {
                  setPoints([]);
                  setClosed(false);
                  void load();
                }}
              />
            )}
          </div>

          <UnitList units={detail.units} />
        </>
      )}
    </section>
  );
}

function SaveUnitForm(props: { assetId: string; points: LatLngPoint[]; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [unitType, setUnitType] = useState<AssetUnitType>("plot");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const boundary = toPolygon(props.points);
    if (!boundary) return setError("ต้องมีอย่างน้อย 3 จุด");
    if (!name.trim()) return setError("กรอกชื่อแปลงก่อน");
    setBusy(true);
    setError(null);
    try {
      await apiPost<AssetUnit>(`/api/assets/${encodeURIComponent(props.assetId)}/units`, {
        name: name.trim(),
        unit_type: unitType,
        boundary,
      });
      props.onSaved();
    } catch (err) {
      setError(describeError(err, "save"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-2">
      <label className="block text-sm" htmlFor="unit-name">
        ชื่อแปลง
      </label>
      <input
        id="unit-name"
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-lg border border-slate-300 p-3 text-base"
      />
      <label className="block text-sm" htmlFor="unit-type">
        ประเภท
      </label>
      <select
        id="unit-type"
        value={unitType}
        onChange={(e) => setUnitType(e.target.value as AssetUnitType)}
        className="w-full rounded-lg border border-slate-300 p-3 text-base"
      >
        {UNIT_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
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
        {busy ? "กำลังบันทึก…" : "บันทึกแปลง"}
      </button>
    </form>
  );
}

function UnitList({ units }: { units: AssetUnit[] }) {
  if (units.length === 0) return <p className="text-slate-500">ยังไม่มีแปลง</p>;
  return (
    <ul className="space-y-2">
      {units.map((u) => (
        <li key={u.id} className="rounded-xl bg-white p-3 shadow-sm">
          <p className="font-semibold">{u.name}</p>
          <p className="text-sm text-slate-600">{u.area_m2 === null ? "ไม่ทราบพื้นที่" : formatArea(u.area_m2)}</p>
        </li>
      ))}
    </ul>
  );
}

/** Leaflet map: existing units (fit to bounds) plus the in-progress draft drawn from `points`. */
function PlotMap(props: {
  units: AssetUnit[];
  points: LatLngPoint[];
  closed: boolean;
  onAddPoint: (p: LatLngPoint) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const unitsLayerRef = useRef<L.LayerGroup | null>(null);
  const draftLayerRef = useRef<L.LayerGroup | null>(null);
  const onAddPointRef = useRef(props.onAddPoint);

  useEffect(() => {
    onAddPointRef.current = props.onAddPoint;
  }, [props.onAddPoint]);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current).setView(THAILAND_CENTER, THAILAND_ZOOM);
    // Plain-text credit instead of Leaflet's default prefix link, so the page links nowhere but the OSM tiles.
    map.attributionControl.setPrefix("Leaflet");
    L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
    unitsLayerRef.current = L.layerGroup().addTo(map);
    draftLayerRef.current = L.layerGroup().addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => onAddPointRef.current({ lat: e.latlng.lat, lng: e.latlng.lng }));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Existing units + fit bounds.
  useEffect(() => {
    const map = mapRef.current;
    const layer = unitsLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds = L.latLngBounds([]);
    for (const unit of props.units) {
      const latLngs = polygonToLatLngs(unit.boundary);
      const label = `${unit.name}${unit.area_m2 === null ? "" : ` · ${formatArea(unit.area_m2)}`}`;
      L.polygon(latLngs, UNIT_STYLE).bindTooltip(label, { sticky: true }).addTo(layer);
      latLngs.forEach((ll) => bounds.extend(ll));
    }
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 18 });
  }, [props.units]);

  // Draft: vertices, open line while drawing, filled polygon once closed.
  useEffect(() => {
    const layer = draftLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const latLngs = props.points.map((p): L.LatLngTuple => [p.lat, p.lng]);
    if (latLngs.length >= 3) {
      L.polygon(latLngs, { ...DRAFT_STYLE, dashArray: props.closed ? undefined : "6 4" }).addTo(layer);
    } else if (latLngs.length === 2) {
      L.polyline(latLngs, DRAFT_STYLE).addTo(layer);
    }
    for (const ll of latLngs) {
      L.circleMarker(ll, { radius: 5, color: "#ea580c", fillColor: "#fff", fillOpacity: 1 }).addTo(layer);
    }
  }, [props.points, props.closed]);

  return <div ref={containerRef} className="h-80 w-full overflow-hidden rounded-xl md:h-[28rem]" />;
}
