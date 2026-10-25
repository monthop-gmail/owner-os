CREATE TABLE `mcp_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`user_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`tool` text NOT NULL,
	`ok` integer NOT NULL,
	`error_code` text,
	`ms` integer NOT NULL,
	CONSTRAINT "mcp_audit_ok_bool" CHECK("mcp_audit"."ok" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `mcp_audit_at_idx` ON `mcp_audit` (`at`);