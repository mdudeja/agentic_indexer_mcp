CREATE TABLE `files` (
	`path` text PRIMARY KEY,
	`hash` text NOT NULL,
	`indexed_at` integer NOT NULL,
	`language` text
);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY,
	`file_path` text NOT NULL,
	`module_name` text NOT NULL,
	`imported_name` text,
	CONSTRAINT `fk_imports_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `symbol_calls` (
	`id` text PRIMARY KEY,
	`caller_id` text NOT NULL,
	`callee_name` text NOT NULL,
	`language_name` text NOT NULL,
	`caller_file_path` text NOT NULL,
	`callee_id` text,
	`call_line` integer,
	`call_column` integer,
	CONSTRAINT `fk_symbol_calls_caller_id_symbols_id_fk` FOREIGN KEY (`caller_id`) REFERENCES `symbols`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_symbol_calls_callee_id_symbols_id_fk` FOREIGN KEY (`callee_id`) REFERENCES `symbols`(`id`) ON DELETE SET NULL
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
	`parameters_json` text,
	`return_type` text,
	`docstring` text,
	`parent_id` text,
	`decorator` text,
	`exported` integer DEFAULT false,
	CONSTRAINT `fk_symbols_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_files_path` ON `files` (`path`);--> statement-breakpoint
CREATE INDEX `idx_files_hash` ON `files` (`hash`);--> statement-breakpoint
CREATE INDEX `idx_files_indexed_at` ON `files` (`indexed_at`);--> statement-breakpoint
CREATE INDEX `idx_imports_file` ON `imports` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_imports_module` ON `imports` (`module_name`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_caller` ON `symbol_calls` (`caller_id`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_callee` ON `symbol_calls` (`callee_name`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_callee_id` ON `symbol_calls` (`callee_id`);--> statement-breakpoint
CREATE INDEX `idx_symbols_name` ON `symbols` (`name`);--> statement-breakpoint
CREATE INDEX `idx_symbols_kind` ON `symbols` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_symbols_file` ON `symbols` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_symbols_decorator` ON `symbols` (`decorator`);