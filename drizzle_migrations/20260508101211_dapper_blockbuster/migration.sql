ALTER TABLE `symbol_calls` ADD `call_line` integer;--> statement-breakpoint
ALTER TABLE `symbol_calls` ADD `call_column` integer;--> statement-breakpoint
ALTER TABLE `symbols` ADD `parameters_json` text;--> statement-breakpoint
ALTER TABLE `symbols` ADD `return_type` text;