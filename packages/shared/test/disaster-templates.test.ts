import { describe, expect, it } from "vitest";
import {
  CROP_DISASTER_EXTRAS,
  DAY_MS,
  DISASTER_TASK_TEMPLATES,
  disasterStageTasks,
  disasterTaskPrefix,
  disasterWorkOrders,
  DisasterType,
  TemplateKey,
  type DisasterStage,
} from "../src/index";

const STAGES: DisasterStage[] = ["prepare", "recover"];

describe("DISASTER_TASK_TEMPLATES", () => {
  it("covers every disaster type", () => {
    expect(Object.keys(DISASTER_TASK_TEMPLATES).sort()).toEqual([...DisasterType.options].sort());
  });

  it.each(DisasterType.options)("%s has ≥ 1 recover task including the per-plot damage photo", (type) => {
    const recover = DISASTER_TASK_TEMPLATES[type].recover;
    expect(recover.length).toBeGreaterThanOrEqual(1);
    expect(recover.map((t) => t.title)).toContain("ถ่ายรูปความเสียหายรายแปลง");
    expect(DISASTER_TASK_TEMPLATES[type].prepare.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps titles unique per (type, stage) after adding every crop's extras", () => {
    for (const type of DisasterType.options) {
      for (const stage of STAGES) {
        for (const key of [null, ...TemplateKey.options]) {
          const titles = disasterStageTasks(type, stage, key).map((t) => t.title);
          expect(new Set(titles).size, `${type}/${stage}/${key}`).toBe(titles.length);
          for (const t of disasterStageTasks(type, stage, key)) {
            expect(Number.isInteger(t.due_offset_days) && t.due_offset_days >= 0).toBe(true);
          }
        }
      }
    }
  });

  it("adds the agreed crop extras", () => {
    expect(disasterStageTasks("storm", "prepare", "durian").map((t) => t.title)).toEqual([
      "โยงกิ่ง/ค้ำยันต้น",
      "เก็บวัสดุที่ปลิวได้",
      "ตัดแต่งทรงพุ่มลดแรงลม",
    ]);
    expect(disasterStageTasks("flood", "recover", "durian").at(-1)).toEqual({ title: "ตรวจโรครากเน่าโคนเน่า (ไฟทอฟธอรา)", due_offset_days: 3 });
    expect(disasterStageTasks("drought", "recover", "maize").at(-1)!.title).toBe("ประเมินว่าควรไถกลบปลูกใหม่หรือไม่");
    expect(disasterStageTasks("storm", "recover", "melon").at(-1)!.title).toBe("ตรวจมุ้ง/พลาสติกโรงเรือนฉีกขาด");
    expect(disasterStageTasks("storm", "prepare", null)).toHaveLength(2);
    expect(disasterStageTasks("flood", "recover", "maize")).toHaveLength(3); // no maize flood extras
    expect(Object.keys(CROP_DISASTER_EXTRAS).every((k) => (TemplateKey.options as string[]).includes(k))).toBe(true);
  });
});

describe("disasterWorkOrders", () => {
  it("prefixes titles and offsets due dates", () => {
    const at = Date.parse("2026-10-25T00:00:00.000Z");
    expect(disasterTaskPrefix("prepare", "storm")).toBe("[เตรียมรับมือพายุ/ลมแรง] ");
    expect(disasterTaskPrefix("recover", "flood")).toBe("[ฟื้นฟูหลังน้ำท่วม] ");
    expect(disasterWorkOrders("flood", "recover", "durian", at)).toEqual([
      { title: "[ฟื้นฟูหลังน้ำท่วม] ระบายน้ำออกจากแปลง", due_at_ms: at },
      { title: "[ฟื้นฟูหลังน้ำท่วม] ถ่ายรูปความเสียหายรายแปลง", due_at_ms: at },
      { title: "[ฟื้นฟูหลังน้ำท่วม] ตรวจรากเน่าและโรคหลังน้ำลด", due_at_ms: at + 3 * DAY_MS },
      { title: "[ฟื้นฟูหลังน้ำท่วม] ตรวจโรครากเน่าโคนเน่า (ไฟทอฟธอรา)", due_at_ms: at + 3 * DAY_MS },
    ]);
    for (const w of disasterWorkOrders("pest_disease", "recover", null, at)) expect(w.title.length).toBeLessThanOrEqual(200);
  });
});
