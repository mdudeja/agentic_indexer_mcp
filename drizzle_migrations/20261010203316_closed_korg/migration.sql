PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_call_edges` (
	`id` text PRIMARY KEY,
	`call_site_id` text NOT NULL,
	`caller_id` text NOT NULL,
	`target_kind` text DEFAULT 'unresolved' NOT NULL,
	`callee_id` text,
	`imports_id` text,
	`resolution_source` text DEFAULT 'unresolved' NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`reason` text,
	CONSTRAINT `fk_call_edges_call_site_id_call_sites_id_fk` FOREIGN KEY (`call_site_id`) REFERENCES `call_sites`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_call_edges_caller_id_symbols_id_fk` FOREIGN KEY (`caller_id`) REFERENCES `symbols`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_call_edges_callee_id_symbols_id_fk` FOREIGN KEY (`callee_id`) REFERENCES `symbols`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_call_edges_imports_id_imports_id_fk` FOREIGN KEY (`imports_id`) REFERENCES `imports`(`id`) ON DELETE SET NULL,
	CONSTRAINT `unique_call_edges_site_caller` UNIQUE(`call_site_id`,`caller_id`)
);
--> statement-breakpoint
INSERT INTO `__new_call_edges`(`id`, `call_site_id`, `caller_id`, `target_kind`, `callee_id`, `imports_id`, `resolution_source`, `confidence`, `reason`) SELECT `id`, `call_site_id`, `caller_id`, `target_kind`, `callee_id`, `imports_id`, `resolution_source`, `confidence`, `reason` FROM `call_edges`;--> statement-breakpoint
DROP TABLE `call_edges`;--> statement-breakpoint
ALTER TABLE `__new_call_edges` RENAME TO `call_edges`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_call_edges_site` ON `call_edges` (`call_site_id`);--> statement-breakpoint
CREATE INDEX `idx_call_edges_caller` ON `call_edges` (`caller_id`);--> statement-breakpoint
CREATE INDEX `idx_call_edges_target_kind` ON `call_edges` (`target_kind`);--> statement-breakpoint
CREATE INDEX `idx_call_edges_callee` ON `call_edges` (`callee_id`);--> statement-breakpoint
CREATE INDEX `idx_call_edges_import` ON `call_edges` (`imports_id`);--> statement-breakpoint
CREATE INDEX `idx_call_edges_resolution_source` ON `call_edges` (`resolution_source`);