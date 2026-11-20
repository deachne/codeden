ALTER TABLE `projects` ADD `plain_words` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `github_prs` ADD `plain_words` text;