CREATE TABLE `factory_owner_check_runs` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`item_id` text,
	`session_id` text,
	`run` text NOT NULL,
	`started_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `factory_owner_checks` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`check` text NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text
);
--> statement-breakpoint
CREATE INDEX `factory_owner_check_runs_project` ON `factory_owner_check_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `factory_owner_check_runs_item` ON `factory_owner_check_runs` (`item_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `factory_owner_check_runs_session` ON `factory_owner_check_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `factory_owner_checks_project` ON `factory_owner_checks` (`project_id`,`created_at`);