ALTER TABLE `projects` ADD `plan_status` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `plan_approval` text;