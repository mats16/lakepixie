// =====================================================
// User Types
// =====================================================

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  is_admin: boolean;
}

export interface UserResponse {
  user: UserInfo;
  databricks_host: string;
  claude_agent_sdk_version: string | null;
  claude_code_version: string | null;
}
