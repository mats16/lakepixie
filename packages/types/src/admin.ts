// =====================================================
// Admin Types
// =====================================================

export interface AdminUserInfo {
  id: string;
  email: string | null;
  is_admin: boolean;
  created_at: string;
}

export interface AdminUserListResponse {
  users: AdminUserInfo[];
}

export interface UpdateUserRoleRequest {
  is_admin: boolean;
}

export type UserRole = 'admin' | 'member';

export interface AppSettingsResponse {
  app_title: string;
  welcome_heading: string;
  databricks_app_name: string;
  default_new_user_role: UserRole;
  default_opus_model: string;
  default_sonnet_model: string;
  default_haiku_model: string;
  otel_metrics_table_name: string | null;
  otel_logs_table_name: string | null;
  otel_traces_table_name: string | null;
}

export interface AppPublicSettingsResponse {
  app_title: string;
  welcome_heading: string;
  github_app_id: string | null;
}

export interface UpdateAppSettingsRequest {
  app_title?: string | null;
  welcome_heading?: string | null;
  default_new_user_role?: UserRole;
  default_opus_model?: string | null;
  default_sonnet_model?: string | null;
  default_haiku_model?: string | null;
  otel_metrics_table_name?: string | null;
  otel_logs_table_name?: string | null;
  otel_traces_table_name?: string | null;
}

export interface GitHubAppAuthResponse {
  secret_scope: string;
  github_app_id: string | null;
  private_key_configured: boolean;
}

export interface UpdateGitHubAppAuthRequest {
  github_app_id?: string | null;
  github_app_private_key?: string | null;
}

export interface ServingEndpointsByTier {
  opus: string[];
  sonnet: string[];
  haiku: string[];
}

export interface TelemetryCatalogListResponse {
  catalogs: string[];
}

export interface TelemetrySchemaListResponse {
  schemas: string[];
}

export interface TelemetrySetupRequest {
  catalog_name: string;
  schema_name: string;
  table_prefix: string;
  experiment_name: string;
}

export interface TelemetrySetupResponse {
  otel_metrics_table_name: string;
  otel_logs_table_name: string;
  otel_traces_table_name: string;
  experiment_id: string;
  experiment_path: string;
}
