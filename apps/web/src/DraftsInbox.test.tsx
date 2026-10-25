import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetListItem } from "./App";
import { App } from "./App";
import { DraftsInbox, type AiDraft } from "./DraftsInbox";

const TOKEN = "stored-test-token";
const XSS = '<img src=x onerror="alert(1)">';

const assets: AssetListItem[] = [
  {
    id: "a-1",
    name: "สวนทุเรียนทดสอบ (demo)",
    kind: "farm",
    boundary: null,
    created_at: "2026-10-24T00:00:00.000Z",
    unit_count: 2,
    work_order_counts: { open: 0, in_progress: 0, submitted: 0, verified: 0, rejected: 0 },
  },
];

const base = { status: "pending" as const, created_by_client_id: "c-1", decided_at: null, decision_note: null, result_ref: null };
const drafts: AiDraft[] = [
  {
    ...base,
    id: "d-event",
    kind: "disaster_event",
    asset_id: "a-1",
    created_at: "2026-10-25T03:00:00.000Z",
    payload: {
      event_type: "storm",
      occurred_at: "2026-10-24T22:00:00.000Z",
      description: `ลมแรง ${XSS}`,
      units: [
        { unit_id: "u-1", damage_pct: 40, note: XSS },
        { unit_id: "u-2", damage_pct: 12.5 },
      ],
    },
  },
  {
    ...base,
    id: "d-prep",
    kind: "disaster_prep",
    asset_id: "a-unknown",
    created_at: "2026-10-25T02:00:00.000Z",
    payload: { event_type: "flood", unit_ids: ["u-1", "u-2", "u-3"] },
  },
  {
    ...base,
    id: "d-recovery",
    kind: "recovery_tasks",
    asset_id: "a-1",
    created_at: "2026-10-25T01:00:00.000Z",
    payload: { disaster_event_id: "ev-9" },
  },
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<(path: string, init: RequestInit) => Promise<Response>>>;
let pendingList: AiDraft[];
let onPost: Handler;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("owner-os.token", TOKEN);
  window.location.hash = "";
  pendingList = drafts;
  onPost = () => json(200, {});
  fetchMock = vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === "POST") return onPost(path, init);
    if (path === "/api/ai-drafts?status=pending") return json(200, { drafts: pendingList });
    if (path === "/api/assets") return json(200, { assets });
    if (path === "/api/ai-drafts") {
      return json(200, {
        drafts: [
          { ...drafts[0], status: "confirmed", decided_at: "2026-10-25T05:00:00.000Z", result_ref: "ev-1" },
          { ...drafts[1], status: "rejected", decided_at: "2026-10-25T06:00:00.000Z", decision_note: `ไม่จำเป็น ${XSS}` },
          ...drafts.slice(2),
        ],
      });
    }
    return json(404, { error: "not_found" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const posts = () => fetchMock.mock.calls.filter(([, init]) => init.method === "POST");
const renderInbox = () => render(<DraftsInbox assets={assets} onBack={() => {}} />);
const card = (kindLabel: string) => screen.getByText(kindLabel).closest("li") as HTMLElement;

describe("DraftsInbox", () => {
  it("shows the three draft kinds with Thai summaries and the AI label", async () => {
    renderInbox();
    expect(await screen.findAllByTestId("draft-card")).toHaveLength(3);
    expect(screen.getAllByText("เสนอโดย AI — ยังไม่มีผลจนกว่าจะยืนยัน")).toHaveLength(3);

    const event = card("บันทึกเหตุภัย");
    expect(within(event).getByText("สินทรัพย์: สวนทุเรียนทดสอบ (demo)")).toBeTruthy();
    expect(within(event).getByText("พายุ")).toBeTruthy();
    expect(within(event).getByText(/แปลง u-1: เสียหาย 40%/)).toBeTruthy();
    expect(within(event).getByText(/แปลง u-2: เสียหาย 12.5%/)).toBeTruthy();
    expect(within(event).getByText(/เสนอเมื่อ/).textContent).toMatch(/2569/); // Thai Buddhist-era date

    const prep = card("สร้างงานเตรียมรับมือ");
    expect(within(prep).getByText("สินทรัพย์: a-unknown")).toBeTruthy(); // unknown asset → id
    expect(within(prep).getByText("น้ำท่วม")).toBeTruthy();
    expect(prep.textContent).toContain("3 แปลง");

    expect(within(card("สร้างงานฟื้นฟู")).getByText("ฟื้นฟูหลังเหตุภัย: ev-9")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "รอยืนยัน (3)" })).toBeTruthy();
  });

  it("renders AI-supplied HTML as plain text (no img element)", async () => {
    const { container } = renderInbox();
    await screen.findAllByTestId("draft-card");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(XSS);
    fireEvent.click(screen.getByRole("tab", { name: "ประวัติ" }));
    await screen.findAllByTestId("history-item");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(`เหตุผล: ไม่จำเป็น ${XSS}`);
  });

  it("confirm posts with the Bearer token, disables the buttons while sending, then removes the draft", async () => {
    let release!: (r: Response) => void;
    onPost = () => new Promise<Response>((resolve) => (release = resolve));
    renderInbox();
    await screen.findAllByTestId("draft-card");
    const event = card("บันทึกเหตุภัย");
    const confirm = within(event).getByRole("button", { name: "ยืนยัน" });
    fireEvent.click(confirm);

    await waitFor(() => expect(posts()).toHaveLength(1));
    const [path, init] = posts()[0]!;
    expect(path).toBe("/api/ai-drafts/d-event/confirm");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect((within(event).getByRole("button", { name: "ปฏิเสธ" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm); // ignored while disabled
    expect(posts()).toHaveLength(1);

    release(json(200, { draft: { ...drafts[0], status: "confirmed" }, result: { id: "ev-1" } }));
    expect(await screen.findByText("ยืนยันร่างแล้ว ระบบบันทึกข้อมูลให้แล้ว")).toBeTruthy();
    expect(screen.getAllByTestId("draft-card")).toHaveLength(2);
    expect(screen.queryByText("บันทึกเหตุภัย")).toBeNull();
  });

  it("reject sends the optional note as { note }", async () => {
    renderInbox();
    await screen.findAllByTestId("draft-card");
    const prep = card("สร้างงานเตรียมรับมือ");
    fireEvent.click(within(prep).getByRole("button", { name: "ปฏิเสธ" }));
    fireEvent.change(within(prep).getByLabelText("เหตุผลที่ปฏิเสธ (ไม่บังคับ)"), { target: { value: "  ยังไม่มีพายุเข้า  " } });
    fireEvent.click(within(prep).getByRole("button", { name: "ยืนยันการปฏิเสธ" }));

    await screen.findByText("ปฏิเสธร่างแล้ว");
    const [path, init] = posts()[0]!;
    expect(path).toBe("/api/ai-drafts/d-prep/reject");
    expect(JSON.parse(init.body as string)).toEqual({ note: "ยังไม่มีพายุเข้า" });
    expect(screen.getAllByTestId("draft-card")).toHaveLength(2);
  });

  it("reject without a note sends an empty body object", async () => {
    renderInbox();
    await screen.findAllByTestId("draft-card");
    const rec = card("สร้างงานฟื้นฟู");
    fireEvent.click(within(rec).getByRole("button", { name: "ปฏิเสธ" }));
    fireEvent.click(within(rec).getByRole("button", { name: "ยืนยันการปฏิเสธ" }));
    await screen.findByText("ปฏิเสธร่างแล้ว");
    expect(JSON.parse(posts()[0]![1].body as string)).toEqual({});
  });

  it("409 draft_not_pending → Thai notice and reload", async () => {
    onPost = () => {
      pendingList = drafts.slice(1); // someone else already handled d-event
      return json(409, { error: "draft_not_pending", status: "confirmed" });
    };
    renderInbox();
    await screen.findAllByTestId("draft-card");
    const pendingLoads = () => fetchMock.mock.calls.filter(([p]) => p === "/api/ai-drafts?status=pending").length;
    expect(pendingLoads()).toBe(1);
    fireEvent.click(within(card("บันทึกเหตุภัย")).getByRole("button", { name: "ยืนยัน" }));

    expect(await screen.findByText("ร่างนี้ถูกจัดการไปแล้ว")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(2));
    expect(pendingLoads()).toBe(2);
  });

  it("other errors show the code with a Thai explanation and keep the draft", async () => {
    onPost = () => json(409, { error: "recovery_tasks_already_created" });
    renderInbox();
    await screen.findAllByTestId("draft-card");
    const rec = card("สร้างงานฟื้นฟู");
    fireEvent.click(within(rec).getByRole("button", { name: "ยืนยัน" }));
    const alert = await within(rec).findByRole("alert");
    expect(alert.textContent).toContain("recovery_tasks_already_created");
    expect(alert.textContent).toContain("เหตุภัยนี้สร้างงานฟื้นฟูไปแล้ว");
    expect(screen.getAllByTestId("draft-card")).toHaveLength(3);
    expect((within(rec).getByRole("button", { name: "ยืนยัน" }) as HTMLButtonElement).disabled).toBe(false);

    onPost = () => json(400, { error: "unit_not_in_asset" });
    fireEvent.click(within(card("บันทึกเหตุภัย")).getByRole("button", { name: "ยืนยัน" }));
    expect((await within(card("บันทึกเหตุภัย")).findByRole("alert")).textContent).toContain("มีแปลงที่ไม่อยู่ในสินทรัพย์นี้แล้ว");
  });

  it("history tab lists decided drafts read-only", async () => {
    renderInbox();
    await screen.findAllByTestId("draft-card");
    fireEvent.click(screen.getByRole("tab", { name: "ประวัติ" }));
    const items = await screen.findAllByTestId("history-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("ปฏิเสธแล้ว"); // newest decision first
    expect(items[1]!.textContent).toContain("ยืนยันแล้ว");
    expect(within(items[0]!).queryByRole("button")).toBeNull();
  });
});

describe("App integration", () => {
  it("shows the pending count in the asset list header and opens #/drafts", async () => {
    render(<App />);
    const link = await screen.findByTestId("drafts-link");
    await waitFor(() => expect(within(link).getByLabelText("รอยืนยัน 3 รายการ").textContent).toBe("3"));
    expect(link.getAttribute("href")).toBe("#/drafts");

    window.location.hash = "#/drafts";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "ร่างจาก AI" })).toBeTruthy();
    expect(await screen.findAllByTestId("draft-card")).toHaveLength(3);
  });
});
