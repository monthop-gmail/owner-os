ALTER TABLE `ai_clients` ADD `client_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_clients_client_id_unique` ON `ai_clients` (`client_id`);