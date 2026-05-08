ALTER TABLE `symbol_calls` ADD `callee_id` text REFERENCES symbols(id);--> statement-breakpoint
CREATE INDEX `idx_symbol_calls_callee_id` ON `symbol_calls` (`callee_id`);