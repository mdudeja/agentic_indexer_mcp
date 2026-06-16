PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_symbol_calls` (
	`id` text PRIMARY KEY,
	`caller_id` text NOT NULL,
	`callee_name` text NOT NULL,
	`language_name` text NOT NULL,
	`caller_file_path` text NOT NULL,
	`call_text` text NOT NULL,
	`docstring` text,
	`callee_id` text,
	`imports_id` text,
	`is_lang_feature` integer,
	`call_line` integer,
	`call_column` integer,
	CONSTRAINT `fk_symbol_calls_caller_id_symbols_id_fk` FOREIGN KEY (`caller_id`) REFERENCES `symbols`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_symbol_calls_caller_file_path_files_path_fk` FOREIGN KEY (`caller_file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE,
	CONSTRAINT `fk_symbol_calls_callee_id_symbols_id_fk` FOREIGN KEY (`callee_id`) REFERENCES `symbols`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_symbol_calls_imports_id_imports_id_fk` FOREIGN KEY (`imports_id`) REFERENCES `imports`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_symbol_calls`(`id`, `caller_id`, `callee_name`, `language_name`, `caller_file_path`, `call_text`, `docstring`, `callee_id`, `imports_id`, `is_lang_feature`, `call_line`, `call_column`) SELECT `id`, `caller_id`, `callee_name`, `language_name`, `caller_file_path`, `call_text`, `docstring`, `callee_id`, `imports_id`, `is_lang_feature`, `call_line`, `call_column` FROM `symbol_calls`;--> statement-breakpoint
DROP TABLE `symbol_calls`;--> statement-breakpoint
ALTER TABLE `__new_symbol_calls` RENAME TO `symbol_calls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_caller` ON `symbol_calls` (`caller_id`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_callee` ON `symbol_calls` (`callee_name`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_callee_id` ON `symbol_calls` (`callee_id`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_imports_id` ON `symbol_calls` (`imports_id`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_file` ON `symbol_calls` (`caller_file_path`);