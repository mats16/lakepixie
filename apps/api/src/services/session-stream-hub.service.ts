import type { SDKMessage, WsServerMessage } from '@repo/types';

const NEWLINE_RE = /\r?\n/;

export type SseEventName =
  | 'connected'
  | 'message'
  | 'ask_user_question'
  | 'exit_plan_mode'
  | 'session_context_updated'
  | 'control_response'
  | 'error';

export interface SseWritable {
  write(chunk: string): boolean;
  destroyed?: boolean;
  writableEnded?: boolean;
}

interface SessionStreamConnection {
  stream: SseWritable;
  userId: string;
  sessionId: string;
}

function getEventName(message: WsServerMessage | SDKMessage): SseEventName {
  if (message.type === 'connected') return 'connected';
  if (message.type === 'ask_user_question') return 'ask_user_question';
  if (message.type === 'exit_plan_mode') return 'exit_plan_mode';
  if (message.type === 'session_context_updated') return 'session_context_updated';
  if (message.type === 'control_response') return 'control_response';
  if (message.type === 'error') return 'error';
  return 'message';
}

function getEventId(message: WsServerMessage | SDKMessage): string | undefined {
  if ('uuid' in message && typeof message.uuid === 'string' && message.uuid) {
    return message.uuid;
  }
  return undefined;
}

export function encodeSseEvent(
  event: SseEventName,
  data: unknown,
  id?: string,
  retry?: number
): string {
  const lines: string[] = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  if (retry !== undefined) lines.push(`retry: ${retry}`);
  const payload = JSON.stringify(data);
  for (const line of payload.split(NEWLINE_RE)) {
    lines.push(`data: ${line}`);
  }
  lines.push('', '');
  return lines.join('\n');
}

export function encodeSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}

class SessionStreamHub {
  private connections = new Map<string, Set<SessionStreamConnection>>();

  addConnection(sessionId: string, userId: string, stream: SseWritable): () => void {
    const conn: SessionStreamConnection = { stream, userId, sessionId };

    if (!this.connections.has(sessionId)) {
      this.connections.set(sessionId, new Set());
    }
    this.connections.get(sessionId)!.add(conn);

    return () => this.removeConnection(sessionId, conn);
  }

  private removeConnection(sessionId: string, conn: SessionStreamConnection): void {
    const conns = this.connections.get(sessionId);
    if (!conns) return;

    conns.delete(conn);
    if (conns.size === 0) {
      this.connections.delete(sessionId);
    }
  }

  send(sessionId: string, message: WsServerMessage | SDKMessage): void {
    this.writeToConnections(
      sessionId,
      encodeSseEvent(getEventName(message), message, getEventId(message))
    );
  }

  heartbeat(sessionId: string): void {
    this.writeToConnections(sessionId, encodeSseComment('heartbeat'));
  }

  private writeToConnections(sessionId: string, payload: string): void {
    const conns = this.connections.get(sessionId);
    if (!conns) return;

    const stale: SessionStreamConnection[] = [];
    for (const conn of conns) {
      if (conn.stream.destroyed === true || conn.stream.writableEnded === true) {
        stale.push(conn);
        continue;
      }

      try {
        conn.stream.write(payload);
      } catch {
        stale.push(conn);
      }
    }
    for (const conn of stale) {
      this.removeConnection(sessionId, conn);
    }
  }

  getConnectionCount(sessionId: string): number {
    return this.connections.get(sessionId)?.size ?? 0;
  }
}

export const sessionStreamHub = new SessionStreamHub();
