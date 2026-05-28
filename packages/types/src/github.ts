export type GitHubOAuthAuthorizationStatus =
  | 'not_configured'
  | 'disconnected'
  | 'connected'
  | 'expired';

export interface GitHubOAuthAdminResponse {
  client_id: string | null;
  client_secret_configured: boolean;
  client_secret_last8: string | null;
  redirect_uri: string;
  encryption_key_configured: boolean;
  encryption_key_version: string | null;
}

export interface UpdateGitHubOAuthAdminRequest {
  client_id?: string | null;
  client_secret?: string | null;
}

export interface GitHubOAuthEncryptionKeyRotateResponse {
  encryption_key_version: string;
  reencrypted_authorizations: number;
}

export interface GitHubOAuthAuthorizationResponse {
  status: GitHubOAuthAuthorizationStatus;
  login: string | null;
  token_expires_at: string | null;
}
