CREATE TABLE `ai_clients` (
	`name` text PRIMARY KEY NOT NULL,
	`scopes` text NOT NULL,
	`rate_per_minute` integer DEFAULT 60 NOT NULL,
	`rate_per_day` integer DEFAULT 5000 NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
