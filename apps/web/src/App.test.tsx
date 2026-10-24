import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiPost, UNAUTHORIZED_EVENT } from "./api";
import { App, type AssetListItem } from "./App";

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
