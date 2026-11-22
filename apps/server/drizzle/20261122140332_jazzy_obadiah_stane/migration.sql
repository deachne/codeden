CREATE TABLE `factory_parked_ideas` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`status` text NOT NULL,
	`idea` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `factory_parked_ideas_project_key` ON `factory_parked_ideas` (`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `factory_parked_ideas_project_status` ON `factory_parked_ideas` (`project_id`,`status`);