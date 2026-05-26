// =====================================================
// Databricks Apps API Types
// @see https://docs.databricks.com/api/workspace/apps/get
// =====================================================

/**
 * App Deployment Status
 */
export interface AppDeploymentStatus {
  state?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED';
  message?: string;
}

/**
 * App Deployment
 */
export interface AppDeployment {
  deployment_id?: string;
  source_code_path?: string;
  mode?: 'SNAPSHOT' | 'AUTO_SYNC';
  status?: AppDeploymentStatus;
  create_time?: string;
  update_time?: string;
}

/**
 * App Compute Status
 */
export interface AppComputeStatus {
  state?: string;
  message?: string;
}

/**
 * App Status
 */
export interface AppStatus {
  state?: 'RUNNING' | 'DEPLOYING' | 'CRASHED' | 'UNAVAILABLE' | string;
  message?: string;
}

/**
 * Databricks App
 */
export interface DatabricksApp {
  name: string;
  description?: string;
  id?: string;
  creator?: string;
  create_time?: string;
  update_time?: string;
  url?: string;
  active_deployment?: AppDeployment;
  pending_deployment?: AppDeployment;
  compute_status?: AppComputeStatus;
  app_status?: AppStatus;
  default_source_code_path?: string;
  effective_api_scopes?: string[];
}

// =====================================================
// Session App API Types
// =====================================================

/**
 * GET /api/sessions/:session_id/app のレスポンス型
 */
export type SessionAppResponse = DatabricksApp;

/**
 * GET /api/sessions/:session_id/app/create-prerequisites のレスポンス型
 */
export interface SessionAppCreatePrerequisitesResponse {
  has_app_yaml: boolean;
}

export type SessionAppDeployPrerequisitesResponse = SessionAppCreatePrerequisitesResponse;

/**
 * POST /api/generate_app_name のリクエスト型
 */
export interface GenerateAppNameRequest {
  context: string;
}

/**
 * POST /api/generate_app_name のレスポンス型
 */
export interface GenerateAppNameResponse {
  name: string;
}

export interface GenerateAppMetadataResponse {
  name: string;
  description: string;
}

/**
 * POST /api/sessions/:session_id/app/create のリクエスト型
 */
export interface SessionAppCreateRequest {
  context: string;
}

export type SessionAppPermissionStatus = 'granted';
export type SessionAppNotificationStatus = 'sent' | 'failed';

/**
 * POST /api/sessions/:session_id/app/create のレスポンス型
 */
export interface SessionAppCreateResponse {
  session: import('./session.js').SessionResponse;
  name: string;
  description: string;
  workspace_path: string;
  sp_permission_status: SessionAppPermissionStatus;
  notification_status: SessionAppNotificationStatus;
}
