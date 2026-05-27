CREATE TABLE "github_user_authorizations" (
	"user_id" text PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
	"github_user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"access_token_iv" text NOT NULL,
	"access_token_auth_tag" text NOT NULL,
	"access_token_key_version" text NOT NULL,
	"refresh_token_ciphertext" text,
	"refresh_token_iv" text,
	"refresh_token_auth_tag" text,
	"refresh_token_key_version" text,
	"token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "github_user_authorizations_login_idx" ON "github_user_authorizations" ("github_login");
--> statement-breakpoint
ALTER TABLE "github_user_authorizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "github_user_authorizations_user_isolation_policy" ON "github_user_authorizations" AS PERMISSIVE FOR ALL TO public USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE TRIGGER set_updated_at_github_user_authorizations BEFORE UPDATE ON "github_user_authorizations" FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
--> statement-breakpoint
CREATE TABLE "github_oauth_states" (
	"state" text PRIMARY KEY,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"code_verifier_ciphertext" text NOT NULL,
	"code_verifier_iv" text NOT NULL,
	"code_verifier_auth_tag" text NOT NULL,
	"code_verifier_key_version" text NOT NULL,
	"redirect_after" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "github_oauth_states_user_id_idx" ON "github_oauth_states" ("user_id");
--> statement-breakpoint
CREATE INDEX "github_oauth_states_expires_at_idx" ON "github_oauth_states" ("expires_at");
--> statement-breakpoint
ALTER TABLE "github_oauth_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "github_oauth_states_user_isolation_policy" ON "github_oauth_states" AS PERMISSIVE FOR ALL TO public USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
