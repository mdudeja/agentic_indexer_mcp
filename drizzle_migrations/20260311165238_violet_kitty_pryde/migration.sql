CREATE TABLE `files` (
	`path` text PRIMARY KEY,
	`hash` text NOT NULL,
	`indexed_at` integer NOT NULL,
	`language` text
);
--> statement-breakpoint
CREATE TABLE `symbols` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`file_path` text NOT NULL,
	`line` integer NOT NULL,
	`column` integer NOT NULL,
	`end_line` integer,
	`end_column` integer,
	`signature` text,
	`docstring` text,
	`parent_id` text,
	`exported` integer DEFAULT false,
	CONSTRAINT `fk_symbols_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_symbols_name` ON `symbols` (`name`);--> statement-breakpoint
CREATE INDEX `idx_symbols_kind` ON `symbols` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_symbols_file` ON `symbols` (`file_path`);