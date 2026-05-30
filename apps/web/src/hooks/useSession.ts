import { useState, useEffect, useCallback, useRef } from 'react';
import type { SessionResponse, SessionUpdateRequest } from '@repo/types';
import { sessionService } from '@/services/session.service';

interface UseSessionOptions {
  sessionId: string | null;
}

interface UseSessionReturn {
  session: SessionResponse | null;
  isLoading: boolean;
  error: Error | null;
  updateSession: (request: SessionUpdateRequest) => Promise<SessionResponse | null>;
  patchSessionContext: (nextSession: SessionResponse) => void;
  refetch: () => Promise<void>;
}

export function useSession({ sessionId }: UseSessionOptions): UseSessionReturn {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const activeRequestId = useRef(0);
  const previousSessionIdRef = useRef<string | null>(null);

  const fetchSession = useCallback(async () => {
    const requestId = activeRequestId.current + 1;
    activeRequestId.current = requestId;

    if (!sessionId) {
      previousSessionIdRef.current = null;
      setSession(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      setSession(null);
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await sessionService.getSession(sessionId);
      if (activeRequestId.current !== requestId) return;
      setSession(response);
    } catch (err) {
      if (activeRequestId.current !== requestId) return;
      setError(err instanceof Error ? err : new Error('Failed to fetch session'));
      setSession(null);
    } finally {
      if (activeRequestId.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  const updateSession = useCallback(
    async (request: SessionUpdateRequest): Promise<SessionResponse | null> => {
      if (!sessionId) {
        return null;
      }

      try {
        const response = await sessionService.updateSession(sessionId, request);
        setSession(response);
        return response;
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to update session'));
        return null;
      }
    },
    [sessionId]
  );

  const patchSessionContext = useCallback(
    (nextSession: SessionResponse) => {
      if (nextSession.id !== sessionId) return;
      activeRequestId.current += 1;
      setSession(nextSession);
      setError(null);
      setIsLoading(false);
    },
    [sessionId]
  );

  return {
    session,
    isLoading,
    error,
    updateSession,
    patchSessionContext,
    refetch: fetchSession,
  };
}
