CREATE TABLE `asset_units` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`name` text NOT NULL,
	`unit_type` text NOT NULL,
	`boundary_geojson` text NOT NULL,
	`area_m2` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_units_asset_id_idx` ON `asset_units` (`asset_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`boundary_geojson` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `farm_crop_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`crop` text NOT NULL,
	`variety` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`started_at` integer,
	`expected_harvest_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `asset_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `farm_crop_cycles_unit_id_idx` ON `farm_crop_cycles` (`unit_id`);--> statement-breakpoint
CREATE TABLE `work_order_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`work_order_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`lat` real,
	`lng` real,
	`accuracy_m` real,
	`captured_at` integer,
	`inside_geofence` integer,
	`distance_outside_m` real,
	`uploaded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_order_evidence_r2_key_unique` ON `work_order_evidence` (`r2_key`);--> statement-breakpoint
CREATE INDEX `work_order_evidence_work_order_id_idx` ON `work_order_evidence` (`work_order_id`);--> statement-breakpoint
CREATE TABLE `work_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`unit_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `asset_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_orders_asset_id_idx` ON `work_orders` (`asset_id`);--> statement-breakpoint
CREATE INDEX `work_orders_status_idx` ON `work_orders` (`status`);