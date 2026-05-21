CREATE TABLE "session_events" (
	"uuid" uuid PRIMARY KEY,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"message" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY,
	"user_id" text,
	"title" text,
	"status" text DEFAULT 'init' NOT NULL,
	"sdk_session_id" uuid,
	"context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY,
	"claude_config_backup" text DEFAULT 'auto' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"email" text,
	"is_admin" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "app_settings" ("key", "value") VALUES ('app_title', 'ccbricks');
--> statement-breakpoint
INSERT INTO "app_settings" ("key", "value") VALUES ('welcome_heading', 'Claude Code on Databricks');
--> statement-breakpoint
INSERT INTO "app_settings" ("key", "value") VALUES ('default_new_user_role', 'admin');
--> statement-breakpoint
CREATE INDEX "session_events_session_created_at_idx" ON "session_events" ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_updated_at_idx" ON "sessions" ("updated_at");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" ("status");--> statement-breakpoint
CREATE INDEX "sessions_active_idx" ON "sessions" ("user_id","updated_at") WHERE status != 'archived';--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "sessions_user_isolation_policy" ON "sessions" AS PERMISSIVE FOR ALL TO public USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "user_settings_user_isolation_policy" ON "user_settings" AS PERMISSIVE FOR ALL TO public USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint
-- Force Row Level Security for all RLS-enabled tables
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- DB-managed updated_at triggers (microsecond precision via now())
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_user_settings BEFORE UPDATE ON "user_settings" FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_sessions BEFORE UPDATE ON "sessions" FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at_app_settings BEFORE UPDATE ON "app_settings" FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
