import { AssetKind, AssetUnitType, WorkOrderStatus } from "@owner-os/shared";
import { describe, expect, it } from "vitest";
import { asset_units, assets, work_orders } from "../src/db/schema";

// tsconfig only loads workers types, so node:fs is imported untyped (tests run under Node).
type Fs = { readFileSync(path: URL, encoding: "utf8"): string };
const { readFileSync } = (await import("node:fs" as string)) as Fs;
const here = (import.meta as ImportMeta & { url: string }).url;
const sql = readFileSync(new URL("../migrations/0000_init.sql", here), "utf8");

const TABLES = ["assets", "asset_units", "work_orders", "work_order_evidence", "farm_crop_cycles"];

function tableDdl(name: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE \`${name}\` \\(([\\s\\S]*?)\\n\\);`));
  if (!match?.[1]) throw new Error(`CREATE TABLE ${name} not found`);
  return match[1];
}

describe("0000_init.sql", () => {
  it.each(TABLES)("creates table %s", (name) => {
    expect(sql).toContain(`CREATE TABLE \`${name}\``);
  });

  it("declares the expected foreign keys", () => {
    expect(tableDdl("asset_units")).toMatch(
      /FOREIGN KEY \(`asset_id`\) REFERENCES `assets`\(`id`\).*ON DELETE cascade/,
    );
    expect(tableDdl("work_orders")).toContain("FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`)");
    expect(tableDdl("work_orders")).toContain("FOREIGN KEY (`unit_id`) REFERENCES `asset_units`(`id`)");
    expect(tableDdl("work_order_evidence")).toContain(
      "FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`)",
    );
    expect(tableDdl("farm_crop_cycles")).toContain("FOREIGN KEY (`unit_id`) REFERENCES `asset_units`(`id`)");
  });

  it("makes work_order_evidence.r2_key unique", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX `[^`]+` ON `work_order_evidence` \(`r2_key`\);/);
  });
});

describe("schema enums match @owner-os/shared", () => {
  it("work_orders.status", () => {
    expect(work_orders.status.enumValues).toEqual(WorkOrderStatus.options);
  });

  it("assets.kind and asset_units.unit_type", () => {
    expect(assets.kind.enumValues).toEqual(AssetKind.options);
    expect(asset_units.unit_type.enumValues).toEqual(AssetUnitType.options);
  });
});
