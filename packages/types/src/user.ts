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

export interface UserModelSettings {
  opus_model_id: string;
  sonnet_model_id: string;
  haiku_model_id: string;
}

export interface UserSettingsResponse extends UserModelSettings {
  allowed_model_ids: {
    opus: string[];
    sonnet: string[];
    haiku: string[];
  };
}

export interface UpdateUserSettingsRequest {
  opus_model_id?: string | null;
  sonnet_model_id?: string | null;
  haiku_model_id?: string | null;
}
