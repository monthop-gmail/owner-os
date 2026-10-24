CREATE TABLE `disaster_event_evidence` (
	`event_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `evidence_id`),
	FOREIGN KEY (`event_id`) REFERENCES `disaster_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_id`) REFERENCES `work_order_evidence`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `disaster_event_units` (
	`event_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`damage_bps` integer NOT NULL,
	`note` text,
	PRIMARY KEY(`event_id`, `unit_id`),
	FOREIGN KEY (`event_id`) REFERENCES `disaster_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `asset_units`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "disaster_event_units_damage_bps_range" CHECK("disaster_event_units"."damage_bps" >= 0 AND "disaster_event_units"."damage_bps" <= 10000)
);
--> statement-breakpoint
CREATE INDEX `disaster_event_units_unit_id_idx` ON `disaster_event_units` (`unit_id`);--> statement-breakpoint
CREATE TABLE `disaster_events` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`ended_at` integer,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `disaster_events_asset_id_idx` ON `disaster_events` (`asset_id`);