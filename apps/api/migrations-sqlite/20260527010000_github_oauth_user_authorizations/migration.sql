CREATE TABLE `github_user_authorizations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`github_user_id` text NOT NULL,
	`github_login` text NOT NULL,
	`access_token_ciphertext` text NOT NULL,
	`access_token_iv` text NOT NULL,
	`access_token_auth_tag` text NOT NULL,
	`access_token_key_version` text NOT NULL,
	`refresh_token_ciphertext` text,
	`refresh_token_iv` text,
	`refresh_token_auth_tag` text,
	`refresh_token_key_version` text,
	`token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `github_user_authorizations_login_idx` ON `github_user_authorizations` (`github_login`);
--> statement-breakpoint
CREATE TRIGGER `set_updated_at_github_user_authorizations`
AFTER UPDATE ON `github_user_authorizations`
FOR EACH ROW
WHEN NEW.`updated_at` = OLD.`updated_at`
BEGIN
	UPDATE `github_user_authorizations`
	SET `updated_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER)
	WHERE `user_id` = NEW.`user_id`;
END;
--> statement-breakpoint
CREATE TABLE `github_oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_verifier_ciphertext` text NOT NULL,
	`code_verifier_iv` text NOT NULL,
	`code_verifier_auth_tag` text NOT NULL,
	`code_verifier_key_version` text NOT NULL,
	`redirect_after` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `github_oauth_states_user_id_idx` ON `github_oauth_states` (`user_id`);
--> statement-breakpoint
CREATE INDEX `github_oauth_states_expires_at_idx` ON `github_oauth_states` (`expires_at`);
