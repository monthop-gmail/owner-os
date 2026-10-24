ALTER TABLE `work_orders` ADD `crop_cycle_id` text REFERENCES farm_crop_cycles(id);--> statement-breakpoint
CREATE INDEX `work_orders_crop_cycle_id_idx` ON `work_orders` (`crop_cycle_id`);