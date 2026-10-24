CREATE TABLE `farm_harvest_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`crop_cycle_id` text NOT NULL,
	`harvested_at` integer NOT NULL,
	`weight_g` integer NOT NULL,
	`unit_price_satang` integer NOT NULL,
	`revenue_satang` integer NOT NULL,
	`buyer_name` text,
	`slip_r2_key` text NOT NULL,
	`slip_uploaded_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`crop_cycle_id`) REFERENCES `farm_crop_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "farm_harvest_logs_weight_g_positive" CHECK("farm_harvest_logs"."weight_g" > 0),
	CONSTRAINT "farm_harvest_logs_unit_price_non_negative" CHECK("farm_harvest_logs"."unit_price_satang" >= 0),
	CONSTRAINT "farm_harvest_logs_revenue_non_negative" CHECK("farm_harvest_logs"."revenue_satang" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `farm_harvest_logs_slip_r2_key_unique` ON `farm_harvest_logs` (`slip_r2_key`);--> statement-breakpoint
CREATE INDEX `farm_harvest_logs_crop_cycle_id_idx` ON `farm_harvest_logs` (`crop_cycle_id`);