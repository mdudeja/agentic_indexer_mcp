CREATE TABLE `imports` (
	`id` text PRIMARY KEY,
	`file_path` text NOT NULL,
	`module_name` text NOT NULL,
	`imported_name` text,
	CONSTRAINT `fk_imports_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `symbol_references` (
	`id` text PRIMARY KEY,
	`file_path` text NOT NULL,
	`caller_symbol_id` text,
	`callee_name` text NOT NULL,
	CONSTRAINT `fk_symbol_references_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_imports_file` ON `imports` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_imports_module` ON `imports` (`module_name`);--> statement-breakpoint
CREATE INDEX `idx_refs_file` ON `symbol_references` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_refs_callee` ON `symbol_references` (`callee_name`);--> statement-breakpoint
CREATE INDEX `idx_refs_caller` ON `symbol_references` (`caller_symbol_id`);