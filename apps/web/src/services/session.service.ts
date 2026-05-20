import { apiClient } from './api-client';
import type {
  SessionCreateRequest,
  SessionCreateResponse,
  SessionEventsResponse,
  SessionEventCreateResponse,
  SessionEventPostResponse,
  SessionListResponse,
  SessionListQuery,
  SessionResponse,
  SessionArchiveResponse,
  SessionUpdateRequest,
  GenerateTitleRequest,
  GenerateTitleResponse,
  SDKUserMessage,
  WsControlRequest,
} from '@repo/types';

export const sessionService = {
  async createSession(request: SessionCreateRequest): Promise<SessionCreateResponse> {
    return apiClient<SessionCreateResponse>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async getSessions(options?: SessionListQuery): Promise<SessionListResponse> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options?.status !== undefined) {
      params.set('status', options.status);
    }
    if (options?.after !== undefined) {
      params.set('after', options.after);
    }
    const queryString = params.toString();
    const url = `/api/sessions${queryString ? `?${queryString}` : ''}`;
    return apiClient<SessionListResponse>(url);
  },

  async getSessionEvents(
    sessionId: string,
    options?: { after?: string; limit?: number }
  ): Promise<SessionEventsResponse> {
    const params = new URLSearchParams();
    if (options?.after !== undefined) {
      params.set('after', String(options.after));
    }
    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    const queryString = params.toString();
    const url = `/api/sessions/${sessionId}/events${queryString ? `?${queryString}` : ''}`;
    return apiClient<SessionEventsResponse>(url);
  },

  async generateTitle(message: string): Promise<GenerateTitleResponse | null> {
    try {
      const response = await apiClient<GenerateTitleResponse>('/api/generate_title', {
        method: 'POST',
        body: JSON.stringify({
          first_session_message: message,
        } satisfies GenerateTitleRequest),
      });
      return response;
    } catch {
      return null;
    }
  },

  async getSession(sessionId: string): Promise<SessionResponse> {
    return apiClient<SessionResponse>(`/api/sessions/${sessionId}`);
  },

  async sendMessage(
    sessionId: string,
    message: SDKUserMessage
  ): Promise<SessionEventCreateResponse> {
    return apiClient<SessionEventCreateResponse>(`/api/sessions/${sessionId}/events`, {
      method: 'POST',
      body: JSON.stringify(message),
    });
  },

  async sendControlRequest(
    sessionId: string,
    request: WsControlRequest
  ): Promise<SessionEventPostResponse> {
    return apiClient<SessionEventPostResponse>(`/api/sessions/${sessionId}/events`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async updateSession(sessionId: string, request: SessionUpdateRequest): Promise<SessionResponse> {
    return apiClient<SessionResponse>(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(request),
    });
  },

  async archiveSession(sessionId: string): Promise<SessionArchiveResponse> {
    return apiClient<SessionArchiveResponse>(`/api/sessions/${sessionId}/archive`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};
