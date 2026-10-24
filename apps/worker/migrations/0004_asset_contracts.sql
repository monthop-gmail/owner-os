CREATE TABLE `asset_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`contract_type` text NOT NULL,
	`partner_label` text NOT NULL,
	`terms_json` text NOT NULL,
	`is_active` integer NOT NULL,
	`rules_status` text DEFAULT 'draft_unconfirmed' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`created_at` integer NOT NULL,
	`deactivated_at` integer,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `asset_contracts_asset_id_idx` ON `asset_contracts` (`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_contracts_one_active_per_asset` ON `asset_contracts` (`asset_id`) WHERE "asset_contracts"."is_active" = 1;