CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"url" text,
	"headers" jsonb,
	"command" text,
	"args" jsonb,
	"env" jsonb,
	"managed_type" text,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "mcp_servers_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_policies
		WHERE schemaname = current_schema()
			AND tablename = 'mcp_servers'
			AND policyname = 'mcp_servers_user_isolation_policy'
	) THEN
		CREATE POLICY "mcp_servers_user_isolation_policy" ON "mcp_servers"
			AS PERMISSIVE FOR ALL TO public
			USING (user_id = current_setting('app.user_id', true))
			WITH CHECK (user_id = current_setting('app.user_id', true));
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "mcp_servers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_mcp_servers ON "mcp_servers";
--> statement-breakpoint
CREATE TRIGGER set_updated_at_mcp_servers
	BEFORE UPDATE ON "mcp_servers"
	FOR EACH ROW
	EXECUTE FUNCTION trigger_set_updated_at();
