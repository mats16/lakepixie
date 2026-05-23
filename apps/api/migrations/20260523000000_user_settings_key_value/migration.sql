DROP POLICY IF EXISTS "user_settings_user_isolation_policy" ON "user_settings";--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_user_settings ON "user_settings";--> statement-breakpoint
DROP TABLE IF EXISTS "user_settings";--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_pkey" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "user_settings_user_isolation_policy" ON "user_settings" AS PERMISSIVE FOR ALL TO public USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "user_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER set_updated_at_user_settings BEFORE UPDATE ON "user_settings" FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
