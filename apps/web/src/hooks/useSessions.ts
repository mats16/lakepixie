import { useState, useEffect, useCallback, useRef } from 'react';
import type { SessionResponse } from '@repo/types';
import { sessionService } from '@/services/session.service';

interface UseSessionsReturn {
  sessions: SessionResponse[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refetch: () => Promise<void>;
  addSession: (newSession: SessionResponse) => void;
  updateSession: (updatedSession: SessionResponse) => void;
  getSession: (sessionId: string) => SessionResponse | undefined;
}

interface UseSessionsOptions {
  enabled?: boolean;
}

const PAGE_SIZE = 50;

export function useSessions({ enabled = true }: UseSessionsOptions = {}): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionResponse[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Ref to avoid getSession depending on sessions state
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const cursorRef = useRef<string | undefined>(undefined);
  const isLoadingMoreRef = useRef(false);

  const fetchSessions = useCallback(async () => {
    if (!enabled) {
      setSessions([]);
      setHasMore(false);
      setError(null);
      setIsLoadingMore(false);
      cursorRef.current = undefined;
      isLoadingMoreRef.current = false;
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    cursorRef.current = undefined;

    try {
      const response = await sessionService.getSessions({
        limit: PAGE_SIZE,
      });
      setSessions(response.data);
      setHasMore(response.has_more);
      cursorRef.current = response.last_id || undefined;
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to load sessions'));
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  const loadMore = useCallback(async () => {
    if (!enabled) return;
    if (!cursorRef.current || isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);

    try {
      const response = await sessionService.getSessions({
        limit: PAGE_SIZE,
        after: cursorRef.current,
      });
      setSessions(prev => [...prev, ...response.data]);
      setHasMore(response.has_more);
      const nextCursor = response.last_id || undefined;
      if (nextCursor === cursorRef.current) {
        setHasMore(false);
      } else {
        cursorRef.current = nextCursor;
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to load more sessions'));
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [enabled]);

  const addSession = useCallback((newSession: SessionResponse) => {
    setSessions(prev => [newSession, ...prev]);
  }, []);

  const updateSession = useCallback((updatedSession: SessionResponse) => {
    setSessions(prevSessions =>
      prevSessions.map(s => (s.id === updatedSession.id ? updatedSession : s))
    );
  }, []);

  const getSession = useCallback(
    (sessionId: string) => sessionsRef.current.find(s => s.id === sessionId),
    []
  );

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return {
    sessions,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    loadMore,
    refetch: fetchSessions,
    addSession,
    updateSession,
    getSession,
  };
}
