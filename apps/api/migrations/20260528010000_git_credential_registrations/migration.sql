CREATE TABLE "git_credential_registrations" (
	"bearer_token" text PRIMARY KEY,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"repo_full_name" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "git_credential_registrations_expires_at_idx" ON "git_credential_registrations" ("expires_at");
--> statement-breakpoint
CREATE INDEX "git_credential_registrations_user_id_idx" ON "git_credential_registrations" ("user_id");
--> statement-breakpoint
CREATE TRIGGER set_updated_at_git_credential_registrations BEFORE UPDATE ON "git_credential_registrations" FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
