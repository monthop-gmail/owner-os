import { z } from "zod";

// Default stage task templates per crop. Values are a starting point and can be edited later.

export const TemplateKey = z.enum(["durian", "maize", "melon"]);
export type TemplateKey = z.infer<typeof TemplateKey>;

/** Stages that get work orders when a crop cycle enters them. */
export const TEMPLATE_STAGES = ["growing", "harvesting"] as const;
export type TemplateStage = (typeof TEMPLATE_STAGES)[number];

/** due_at = time the cycle enters the stage + due_offset_days. */
export type StageTask = { title: string; due_offset_days: number };

export type CropTemplate = {
  label: string;
  crop: string;
  stages: Record<TemplateStage, StageTask[]>;
};

const WEIGH_AND_RECORD: StageTask = { title: "ชั่งน้ำหนักและบันทึกใบชั่ง", due_offset_days: 1 };

export const CROP_TEMPLATES: Readonly<Record<TemplateKey, CropTemplate>> = {
  durian: {
    label: "ทุเรียน (ไม้ผล)",
    crop: "ทุเรียน",
    stages: {
      growing: [
        { title: "ใส่ปุ๋ยบำรุงต้นหลังตัดแต่ง", due_offset_days: 7 },
        { title: "พ่นปุ๋ยทางใบและฮอร์โมนขยายพู", due_offset_days: 30 },
        { title: "โยงเชือกพยุงกิ่ง", due_offset_days: 60 },
      ],
      harvesting: [{ title: "ตรวจความสุกและตัดผล", due_offset_days: 0 }, WEIGH_AND_RECORD],
    },
  },
  maize: {
    label: "ข้าวโพดเลี้ยงสัตว์ (พืชไร่)",
    crop: "ข้าวโพดเลี้ยงสัตว์",
    stages: {
      growing: [
        { title: "เตรียมดินและหยอดเมล็ด", due_offset_days: 0 },
        { title: "พ่นสารคุมวัชพืช", due_offset_days: 14 },
        { title: "โดรนพ่นสารกำจัดหนอนกระทู้", due_offset_days: 30 },
      ],
      harvesting: [{ title: "รถเกี่ยวเก็บเกี่ยว", due_offset_days: 0 }, WEIGH_AND_RECORD],
    },
  },
  melon: {
    label: "เมล่อน (โรงเรือน)",
    crop: "เมล่อน",
    stages: {
      growing: [
        { title: "ย้ายกล้าลงโรงเรือน", due_offset_days: 0 },
        { title: "ผสมเกสรและไว้ลูก", due_offset_days: 25 },
        { title: "ตรวจระบบน้ำหยดและพัดลม", due_offset_days: 7 },
      ],
      harvesting: [{ title: "วัดความหวาน (Brix) และตัดผล", due_offset_days: 0 }, WEIGH_AND_RECORD],
    },
  },
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Tasks to create when a cycle with `templateKey` enters `stage` at `enteredAtMs` (empty for other stages). */
export function stageTasks(
  templateKey: TemplateKey,
  stage: string,
  enteredAtMs: number,
): { title: string; due_at_ms: number }[] {
  if (!(TEMPLATE_STAGES as readonly string[]).includes(stage)) return [];
  return CROP_TEMPLATES[templateKey].stages[stage as TemplateStage].map((t) => ({
    title: t.title,
    due_at_ms: enteredAtMs + t.due_offset_days * DAY_MS,
  }));
}
