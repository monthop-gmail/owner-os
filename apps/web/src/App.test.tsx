import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AssetUnit, WorkOrder } from "@owner-os/shared";
import { apiBlob, apiPost, UNAUTHORIZED_EVENT } from "./api";
import { App, type AssetListItem } from "./App";
import { EvidencePanel } from "./EvidencePanel";
import { WorkOrders } from "./WorkOrders";

const sample: AssetListItem[] = [
  {
    id: "a-1",
    name: "สวนทดสอบ (demo)",
    kind: "farm",
    boundary: null,
    created_at: "2026-10-24T00:00:00.000Z",
    unit_count: 2,
    work_order_counts: { open: 1, in_progress: 0, submitted: 3, verified: 0, rejected: 0 },
  },
  {
    id: "a-2",
    name: "บ้านทดสอบ (demo)",
    kind: "property",
    boundary: null,
    created_at: "2026-10-23T00:00:00.000Z",
    unit_count: 0,
    work_order_counts: { open: 0, in_progress: 0, submitted: 0, verified: 0, rejected: 0 },
  },
];

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function enterToken(token: string) {
  fireEvent.change(screen.getByLabelText("API token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
}

describe("App", () => {
  it("shows the token screen when no token is stored", () => {
    render(<App />);
    expect(screen.getByLabelText("API token")).toHaveProperty("type", "password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the token with GET /api/assets using a Bearer header, then lists assets with badges", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { assets: sample }));
    render(<App />);
    enterToken("typed-test-token");

    await screen.findByText("สวนทดสอบ (demo)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/assets");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer typed-test-token");

    expect(screen.getAllByTestId("asset-card")).toHaveLength(2);
    expect(screen.getByText("ฟาร์ม")).toBeTruthy();
    expect(screen.getByText("2 แปลง/หน่วย")).toBeTruthy();
    expect(screen.getByText("เปิดอยู่ 1")).toBeTruthy();
    expect(screen.getByText("ส่งแล้ว 3")).toBeTruthy();
    expect(screen.getByText("ยังไม่มีงาน")).toBeTruthy();
    expect(localStorage.getItem("owner-os.token")).toBe("typed-test-token");
  });

  it("shows a Thai error for a wrong token and stays on the token screen", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    render(<App />);
    enterToken("wrong");
    expect((await screen.findByRole("alert")).textContent).toBe("API token ไม่ถูกต้อง");
    // Exactly one message: the "token no longer valid" notice is only for sessions that were signed in.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("token ใช้ไม่ได้แล้ว กรุณากรอกใหม่")).toBeNull();
    expect(screen.getByLabelText("API token")).toBeTruthy();
    expect(localStorage.getItem("owner-os.token")).toBeNull();
  });

  it("returns to the token screen when a stored token gets 401", async () => {
    localStorage.setItem("owner-os.token", "expired-test-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    render(<App />);

    await screen.findByLabelText("API token");
    expect(screen.getByText("token ใช้ไม่ได้แล้ว กรุณากรอกใหม่")).toBeTruthy();
    expect(localStorage.getItem("owner-os.token")).toBeNull();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer expired-test-token");
  });

  it("logs out and clears the stored token", async () => {
    localStorage.setItem("owner-os.token", "stored-test-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { assets: sample }));
    render(<App />);
    await screen.findByText("สวนทดสอบ (demo)");

    fireEvent.click(screen.getByRole("button", { name: "ออกจากระบบ" }));
    expect(screen.getByLabelText("API token")).toBeTruthy();
    expect(localStorage.getItem("owner-os.token")).toBeNull();
  });
});

describe("apiPost", () => {
  it("sends the stored Bearer token and a JSON body", async () => {
    localStorage.setItem("owner-os.token", "stored-test-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "u-1" }));
    const body = { name: "แปลง 1", unit_type: "plot", boundary: { type: "Polygon", coordinates: [] } };

    await expect(apiPost("/api/assets/a-1/units", body)).resolves.toEqual({ id: "u-1" });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(path).toBe("/api/assets/a-1/units");
    expect(init.method).toBe("POST");
    expect(headers.authorization).toBe("Bearer stored-test-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("clears the token and dispatches the unauthorized event on 401", async () => {
    localStorage.setItem("owner-os.token", "expired-test-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    const onUnauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    try {
      await expect(apiPost("/api/assets", {})).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    } finally {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    }
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("owner-os.token")).toBeNull();
  });

  it("rejects with the API error code on 400", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "validation_error", issues: [] }));
    await expect(apiPost("/api/assets/a-1/units", {})).rejects.toMatchObject({ status: 400, code: "validation_error" });
  });
});

describe("hash routing", () => {
  it("links each asset to #/assets/<id>", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { assets: sample }));
    render(<App />);
    enterToken("typed-test-token");
    const link = await screen.findByRole("link", { name: "สวนทดสอบ (demo)" });
    expect(link.getAttribute("href")).toBe("#/assets/a-1");
  });
});

describe("apiBlob", () => {
  it("fetches binary data with the Bearer token", async () => {
    localStorage.setItem("owner-os.token", "stored-test-token");
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    const blob = await apiBlob("/api/evidence/e-1/image");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8]));
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/evidence/e-1/image");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer stored-test-token");
  });

  it("dispatches the same unauthorized event as apiGet on 401", async () => {
    localStorage.setItem("owner-os.token", "expired-test-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    const onUnauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    try {
      await expect(apiBlob("/api/evidence/e-1/image")).rejects.toMatchObject({ status: 401 });
    } finally {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    }
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("owner-os.token")).toBeNull();
  });
});

const unit: AssetUnit = {
  id: "u-1",
  asset_id: "a-1",
  name: "แปลง A",
  unit_type: "plot",
  boundary: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  area_m2: 100,
  created_at: "2026-10-24T00:00:00.000Z",
};
const workOrder = (over: Partial<WorkOrder>): WorkOrder => ({
  id: "wo-1",
  asset_id: "a-1",
  unit_id: "u-1",
  title: "ใส่ปุ๋ย",
  status: "open",
  due_at: null,
  created_at: "2026-10-24T00:00:00.000Z",
  ...over,
});

describe("WorkOrders", () => {
  it("lists work orders with unit name and Thai status badge, and filters with ?status=submitted", async () => {
    localStorage.setItem("owner-os.token", "stored-test-token");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { work_orders: [workOrder({}), workOrder({ id: "wo-2", title: "โดรนพ่นยา", status: "submitted" })] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { work_orders: [workOrder({ id: "wo-2", title: "โดรนพ่นยา", status: "submitted" })] }));

    render(<WorkOrders assetId="a-1" units={[unit]} refreshKey={0} selectedId={null} onSelect={() => {}} />);
    expect(await screen.findAllByTestId("work-order")).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/assets/a-1/work-orders");
    expect(screen.getAllByText("แปลง A")).toHaveLength(2);
    const [first, second] = screen.getAllByTestId("work-order");
    expect(within(first!).getByText("เปิดอยู่")).toBeTruthy();
    expect(within(second!).getByText("ส่งแล้ว")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "ส่งแล้ว" }));
    await waitFor(() => expect(screen.getAllByTestId("work-order")).toHaveLength(1));
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/assets/a-1/work-orders?status=submitted");
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer stored-test-token");
  });

  it("renders an HTML-looking title as text, without creating an <img>", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { work_orders: [workOrder({ title: evil })] }));
    const { container } = render(
      <WorkOrders assetId="a-1" units={[unit]} refreshKey={0} selectedId={null} onSelect={() => {}} />,
    );
    expect(await screen.findByText(evil)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("reports the selected work order", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { work_orders: [workOrder({})] }));
    const onSelect = vi.fn();
    render(<WorkOrders assetId="a-1" units={[unit]} refreshKey={0} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(await screen.findByTestId("work-order"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "wo-1" }));
  });
});

describe("EvidencePanel", () => {
  it('shows "ยังไม่มีหลักฐาน" for a work order without uploaded evidence', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { work_order: workOrder({}), evidence: [] }));
    render(<EvidencePanel selection={{ kind: "work_order", workOrderId: "wo-1", title: "ใส่ปุ๋ย" }} onClose={() => {}} />);
    expect(await screen.findByText("ยังไม่มีหลักฐาน")).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/tasks/wo-1");
  });

  it("shows the latest evidence of a submitted work order with its image from an object URL", async () => {
    localStorage.setItem("owner-os.token", "stored-test-token");
    // jsdom has no object URLs; install stubs and put the originals back afterwards.
    const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    const createObjectURL = vi.fn(() => "blob:test-image");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    onTestFinished(() => {
      Object.assign(URL, original);
    });
    const evidence = {
      id: "e-1",
      work_order_id: "wo-1",
      r2_key: "work-orders/wo-1/e-1",
      lat: 16.441,
      lng: 102.835,
      accuracy_m: 10,
      captured_at: "2026-10-24T02:00:00.000Z",
      inside_geofence: false,
      distance_outside_m: 9.6,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { work_order: workOrder({ status: "submitted" }), evidence: [evidence] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8]), { status: 200, headers: { "content-type": "image/jpeg" } }));

    const { unmount } = render(
      <EvidencePanel selection={{ kind: "work_order", workOrderId: "wo-1", title: "ใส่ปุ๋ย" }} onClose={() => {}} />,
    );
    const img = await screen.findByRole("img", { name: "รูปหลักฐาน" });
    expect(img.getAttribute("src")).toBe("blob:test-image");
    expect(screen.getByText("24 ต.ค. 2569 · 09:00 น.")).toBeTruthy();
    expect(screen.getByText("16.441000, 102.835000")).toBeTruthy();
    expect(screen.getByText("±10 ม.")).toBeTruthy();
    expect(screen.getByText("นอกแปลง 10 ม.")).toBeTruthy();
    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/evidence/e-1/image");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer stored-test-token");

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-image");
  });

  it("shows a Thai message when the image cannot be loaded", async () => {
    const evidence = {
      id: "e-2",
      work_order_id: "wo-1",
      r2_key: "k",
      lat: 1,
      lng: 1,
      accuracy_m: 5,
      captured_at: null,
      inside_geofence: true,
      distance_outside_m: 0,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "evidence_not_found" }));
    render(<EvidencePanel selection={{ kind: "evidence", evidence, title: "งาน" }} onClose={() => {}} />);
    expect(await screen.findByText("ไม่พบรูปของหลักฐานนี้")).toBeTruthy();
    expect(screen.getByText("อยู่ในแปลง")).toBeTruthy();
  });
});
