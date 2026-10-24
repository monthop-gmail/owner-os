ALTER TABLE `disaster_events` ADD `recovery_tasks_created_at` integer;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `disaster_event_id` text REFERENCES disaster_events(id);--> statement-breakpoint
CREATE INDEX `work_orders_disaster_event_id_idx` ON `work_orders` (`disaster_event_id`);