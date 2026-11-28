CREATE TABLE `project_plan_reviews` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`review` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_plan_reviews_project` ON `project_plan_reviews` (`project_id`,`created_at`);