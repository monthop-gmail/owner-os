// Field work that reduces disaster damage: "prepare" tasks when a warning comes in, "recover" tasks after an
// event is recorded. Each becomes an ordinary work order, so its photo evidence (GPS + geofence) can back a
// claim. Defaults are a starting point and can be edited later.
import { DAY_MS, type StageTask, type TemplateKey } from "./crop-templates";
import { DISASTER_TYPE_LABELS, type DisasterType } from "./disasters";

export type DisasterStage = "prepare" | "recover";
type StageTasks = { prepare: StageTask[]; recover: StageTask[] };

const PHOTO_DAMAGE: StageTask = { title: "ถ่ายรูปความเสียหายรายแปลง", due_offset_days: 0 };

export const DISASTER_TASK_TEMPLATES: Readonly<Record<DisasterType, StageTasks>> = {
  flood: {
    prepare: [
      { title: "ขุดร่องระบายน้ำรอบแปลง", due_offset_days: 0 },
      { title: "ย้ายปุ๋ย/สารเคมี/เครื่องมือขึ้นที่สูง", due_offset_days: 0 },
    ],
    recover: [
      { title: "ระบายน้ำออกจากแปลง", due_offset_days: 0 },
      PHOTO_DAMAGE,
      { title: "ตรวจรากเน่าและโรคหลังน้ำลด", due_offset_days: 3 },
    ],
  },
  drought: {
    prepare: [
      { title: "ตรวจระบบน้ำและสำรองน้ำ", due_offset_days: 0 },
      { title: "คลุมโคนต้นลดการระเหย", due_offset_days: 2 },
    ],
    recover: [PHOTO_DAMAGE, { title: "ให้น้ำฟื้นฟูตามรอบ", due_offset_days: 1 }],
  },
  storm: {
    prepare: [
      { title: "โยงกิ่ง/ค้ำยันต้น", due_offset_days: 0 },
      { title: "เก็บวัสดุที่ปลิวได้", due_offset_days: 0 },
    ],
    recover: [
      PHOTO_DAMAGE,
      { title: "ตัดแต่งกิ่งหักและทาแผล", due_offset_days: 1 },
      { title: "ตรวจโครงสร้างโรงเรือน/อาคาร", due_offset_days: 1 },
    ],
  },
  pest_disease: {
    prepare: [{ title: "สำรวจการระบาดแปลงข้างเคียง", due_offset_days: 0 }],
    recover: [
      PHOTO_DAMAGE,
      { title: "กำจัดต้น/ส่วนที่ติดโรคและแยกพื้นที่", due_offset_days: 0 },
      { title: "ฉีดพ่นตามคำแนะนำนักวิชาการ", due_offset_days: 2 },
    ],
  },
  fire: {
    prepare: [{ title: "ทำแนวกันไฟรอบแปลง", due_offset_days: 0 }],
    recover: [PHOTO_DAMAGE, { title: "ประเมินต้นที่ยังรอดและตัดส่วนที่ไหม้", due_offset_days: 2 }],
  },
  other: {
    prepare: [{ title: "ตรวจความพร้อมแปลง", due_offset_days: 0 }],
    recover: [PHOTO_DAMAGE],
  },
};

/** Crop-specific additions, keyed by the crop cycle template of the unit's open cycle. */
export const CROP_DISASTER_EXTRAS: Readonly<Partial<Record<TemplateKey, Partial<Record<DisasterType, Partial<StageTasks>>>>>> = {
  durian: {
    storm: { prepare: [{ title: "ตัดแต่งทรงพุ่มลดแรงลม", due_offset_days: 0 }] },
    flood: { recover: [{ title: "ตรวจโรครากเน่าโคนเน่า (ไฟทอฟธอรา)", due_offset_days: 3 }] },
  },
  maize: {
    drought: { recover: [{ title: "ประเมินว่าควรไถกลบปลูกใหม่หรือไม่", due_offset_days: 2 }] },
  },
  melon: {
    storm: { recover: [{ title: "ตรวจมุ้ง/พลาสติกโรงเรือนฉีกขาด", due_offset_days: 0 }] },
  },
};

const STAGE_PREFIX: Record<DisasterStage, string> = { prepare: "เตรียมรับมือ", recover: "ฟื้นฟูหลัง" };

/** "[เตรียมรับมือน้ำท่วม] " / "[ฟื้นฟูหลังพายุ/ลมแรง] " */
export const disasterTaskPrefix = (stage: DisasterStage, type: DisasterType): string =>
  `[${STAGE_PREFIX[stage]}${DISASTER_TYPE_LABELS[type]}] `;

/** Base tasks for (type, stage) plus the crop's extras, without the title prefix. */
export function disasterStageTasks(type: DisasterType, stage: DisasterStage, templateKey: TemplateKey | null): StageTask[] {
  const extras = templateKey === null ? [] : (CROP_DISASTER_EXTRAS[templateKey]?.[type]?.[stage] ?? []);
  return [...DISASTER_TASK_TEMPLATES[type][stage], ...extras];
}

/** Work orders to create for one unit: prefixed titles and due dates offset from `atMs`. */
export function disasterWorkOrders(
  type: DisasterType,
  stage: DisasterStage,
  templateKey: TemplateKey | null,
  atMs: number,
): { title: string; due_at_ms: number }[] {
  const prefix = disasterTaskPrefix(stage, type);
  return disasterStageTasks(type, stage, templateKey).map((t) => ({
    title: prefix + t.title,
    due_at_ms: atMs + t.due_offset_days * DAY_MS,
  }));
}
