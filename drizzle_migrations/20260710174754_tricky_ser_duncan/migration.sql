CREATE TABLE `env_vars` (
	`id` text PRIMARY KEY,
	`symbol_id` text NOT NULL,
	`file_path` text NOT NULL,
	`name` text NOT NULL,
	`line` integer NOT NULL,
	`column` integer NOT NULL,
	CONSTRAINT `fk_env_vars_symbol_id_symbols_id_fk` FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_env_vars_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `exceptions` (
	`id` text PRIMARY KEY,
	`symbol_id` text NOT NULL,
	`file_path` text NOT NULL,
	`exception_type` text NOT NULL,
	`line` integer NOT NULL,
	`column` integer NOT NULL,
	CONSTRAINT `fk_exceptions_symbol_id_symbols_id_fk` FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_exceptions_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `files` (
	`path` text PRIMARY KEY,
	`hash` text NOT NULL,
	`indexed_at` integer NOT NULL,
	`language` text,
	`estimated_tokens` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY,
	`file_path` text NOT NULL,
	`sourceModule` text NOT NULL,
	`importedNames` text,
	`resolvedPath` text,
	`resolvedKind` text NOT NULL,
	`isExternal` integer DEFAULT false,
	`isRuntimeDependency` integer DEFAULT false,
	`importKind` text NOT NULL,
	`resolutionSource` text NOT NULL,
	`edgeKind` text NOT NULL,
	`confidence` integer DEFAULT 0,
	`reason` text,
	CONSTRAINT `fk_imports_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `symbol_calls` (
	`id` text PRIMARY KEY,
	`caller_id` text NOT NULL,
	`callee_name` text NOT NULL,
	`language_name` text NOT NULL,
	`caller_file_path` text NOT NULL,
	`call_text` text NOT NULL,
	`docstring` text,
	`callee_id` text,
	`imports_id` text,
	`is_lang_feature` integer DEFAULT false NOT NULL,
	`call_line` integer,
	`call_column` integer,
	CONSTRAINT `fk_symbol_calls_caller_id_symbols_id_fk` FOREIGN KEY (`caller_id`) REFERENCES `symbols`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_symbol_calls_caller_file_path_files_path_fk` FOREIGN KEY (`caller_file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE,
	CONSTRAINT `fk_symbol_calls_callee_id_symbols_id_fk` FOREIGN KEY (`callee_id`) REFERENCES `symbols`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_symbol_calls_imports_id_imports_id_fk` FOREIGN KEY (`imports_id`) REFERENCES `imports`(`id`) ON DELETE SET NULL
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
	`language` text NOT NULL,
	`inheritence` text,
	CONSTRAINT `fk_symbols_file_path_files_path_fk` FOREIGN KEY (`file_path`) REFERENCES `files`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tool_usage` (
	`id` text PRIMARY KEY,
	`tool_name` text NOT NULL,
	`called_at` integer NOT NULL,
	`tokens_saved` integer NOT NULL,
	`source_tokens` integer NOT NULL,
	`response_tokens` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_env_vars_symbol` ON `env_vars` (`symbol_id`);--> statement-breakpoint
CREATE INDEX `idx_env_vars_file` ON `env_vars` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_exceptions_symbol` ON `exceptions` (`symbol_id`);--> statement-breakpoint
CREATE INDEX `idx_exceptions_file` ON `exceptions` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_files_path` ON `files` (`path`);--> statement-breakpoint
CREATE INDEX `idx_files_hash` ON `files` (`hash`);--> statement-breakpoint
CREATE INDEX `idx_files_indexed_at` ON `files` (`indexed_at`);--> statement-breakpoint
CREATE INDEX `idx_imports_file` ON `imports` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_imports_source_module` ON `imports` (`sourceModule`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_caller` ON `symbol_calls` (`caller_id`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_callee` ON `symbol_calls` (`callee_name`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_callee_id` ON `symbol_calls` (`callee_id`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_imports_id` ON `symbol_calls` (`imports_id`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_file` ON `symbol_calls` (`caller_file_path`);--> statement-breakpoint
CREATE INDEX `idx_symbols_name` ON `symbols` (`name`);--> statement-breakpoint
CREATE INDEX `idx_symbols_kind` ON `symbols` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_symbols_file` ON `symbols` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_symbols_decorator` ON `symbols` (`decorator`);--> statement-breakpoint
CREATE INDEX `idx_tool_usage_tool_name` ON `tool_usage` (`tool_name`);--> statement-breakpoint
CREATE INDEX `idx_tool_usage_called_at` ON `tool_usage` (`called_at`);