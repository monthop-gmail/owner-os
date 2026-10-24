import { describe, expect, it } from "vitest";
import { CreateCropCycleInput, CROP_TEMPLATES, DAY_MS, stageTasks, TEMPLATE_STAGES, TemplateKey } from "../src/index";

describe("CROP_TEMPLATES", () => {
  it("has a template for every TemplateKey", () => {
    expect(Object.keys(CROP_TEMPLATES).sort()).toEqual([...TemplateKey.options].sort());
  });

  it.each(TemplateKey.options)("%s has at least one task per stage and unique titles within a stage", (key) => {
    const template = CROP_TEMPLATES[key];
    expect(template.label.length).toBeGreaterThan(0);
    expect(template.crop.length).toBeGreaterThan(0);
    for (const stage of TEMPLATE_STAGES) {
      const tasks = template.stages[stage];
      expect(tasks.length, `${key}.${stage}`).toBeGreaterThan(0);
      const titles = tasks.map((t) => t.title);
      expect(new Set(titles).size, `${key}.${stage} titles`).toBe(titles.length);
      for (const t of tasks) {
        expect(t.title.length).toBeGreaterThan(0);
        expect(Number.isInteger(t.due_offset_days) && t.due_offset_days >= 0).toBe(true);
      }
    }
  });

  it("matches the agreed durian defaults", () => {
    expect(CROP_TEMPLATES.durian.label).toBe("ทุเรียน (ไม้ผล)");
    expect(CROP_TEMPLATES.durian.stages.growing).toEqual([
      { title: "ใส่ปุ๋ยบำรุงต้นหลังตัดแต่ง", due_offset_days: 7 },
      { title: "พ่นปุ๋ยทางใบและฮอร์โมนขยายพู", due_offset_days: 30 },
      { title: "โยงเชือกพยุงกิ่ง", due_offset_days: 60 },
    ]);
    expect(CROP_TEMPLATES.durian.stages.harvesting.map((t) => [t.title, t.due_offset_days])).toEqual([
      ["ตรวจความสุกและตัดผล", 0],
      ["ชั่งน้ำหนักและบันทึกใบชั่ง", 1],
    ]);
  });
});

describe("stageTasks", () => {
  it("offsets due dates from the time the stage is entered", () => {
    const at = Date.parse("2026-10-24T00:00:00.000Z");
    expect(stageTasks("maize", "growing", at)).toEqual([
      { title: "เตรียมดินและหยอดเมล็ด", due_at_ms: at },
      { title: "พ่นสารคุมวัชพืช", due_at_ms: at + 14 * DAY_MS },
      { title: "โดรนพ่นสารกำจัดหนอนกระทู้", due_at_ms: at + 30 * DAY_MS },
    ]);
  });

  it("creates nothing for planned or closed", () => {
    expect(stageTasks("melon", "closed", 0)).toEqual([]);
    expect(stageTasks("melon", "planned", 0)).toEqual([]);
  });
});

describe("CreateCropCycleInput.template_key", () => {
  it("accepts known keys and rejects others", () => {
    expect(CreateCropCycleInput.safeParse({ crop: "ทุเรียน", template_key: "durian" }).success).toBe(true);
    expect(CreateCropCycleInput.safeParse({ crop: "ทุเรียน", template_key: "mango" }).success).toBe(false);
  });
});
