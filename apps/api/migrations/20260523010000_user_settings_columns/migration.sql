DROP TABLE IF EXISTS "user_settings" CASCADE;--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
	"opus_model_id" text,
	"sonnet_model_id" text,
	"haiku_model_id" text,
	"allowed_tools" jsonb,
	"disallowed_tools" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_settings_user_isolation_policy" ON "user_settings" AS PERMISSIVE FOR ALL TO public USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "user_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER set_updated_at_user_settings BEFORE UPDATE ON "user_settings" FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
