CREATE TABLE `symbol_calls` (
	`id` text PRIMARY KEY,
	`caller_id` text NOT NULL,
	`callee_name` text NOT NULL,
	CONSTRAINT `fk_symbol_calls_caller_id_symbols_id_fk` FOREIGN KEY (`caller_id`) REFERENCES `symbols`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_caller` ON `symbol_calls` (`caller_id`);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_callee` ON `symbol_calls` (`callee_name`);