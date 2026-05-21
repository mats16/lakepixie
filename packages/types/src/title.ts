// =====================================================
// Title Generation Types
// =====================================================

export interface GenerateTitleRequest {
  first_session_message: string;
}

export interface GenerateTitleResponse {
  title: string;
  branch_name: string;
}
