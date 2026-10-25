CREATE TABLE `ai_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`asset_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_user_hash` text NOT NULL,
	`created_by_client_id` text NOT NULL,
	`decided_at` integer,
	`decision_note` text,
	`result_ref` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_drafts_kind_valid" CHECK("ai_drafts"."kind" IN ('disaster_event', 'disaster_prep', 'recovery_tasks')),
	CONSTRAINT "ai_drafts_status_valid" CHECK("ai_drafts"."status" IN ('pending', 'confirmed', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `ai_drafts_status_created_at_idx` ON `ai_drafts` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_drafts_asset_id_idx` ON `ai_drafts` (`asset_id`);