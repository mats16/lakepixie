import type { WsExitPlanModeRequest } from '@repo/types';
import { broadcastToSession } from './session.service.js';

export type ExitPlanModeDecision = { approved: true } | { approved: false; message: string };

interface PendingExitPlanMode {
  resolve: (decision: ExitPlanModeDecision) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** ExitPlanMode の承認待ち管理（tool_use_id → PendingExitPlanMode） */
const pendingExitPlanModes = new Map<string, PendingExitPlanMode>();

/** タイムアウト（10 分） */
const EXIT_PLAN_MODE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * ExitPlanMode をサスペンドし、ユーザーの承認または修正指示を待つ。
 */
export function waitForExitPlanModeDecision(
  sessionId: string,
  toolUseId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ExitPlanModeDecision> {
  return new Promise<ExitPlanModeDecision>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      pendingExitPlanModes.delete(toolUseId);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('ExitPlanMode timed out waiting for user response'));
    }, EXIT_PLAN_MODE_TIMEOUT_MS);

    const onAbort = () => {
      cleanup();
      reject(new Error('ExitPlanMode aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error('ExitPlanMode aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    pendingExitPlanModes.set(toolUseId, {
      resolve: decision => {
        cleanup();
        resolve(decision);
      },
      reject: err => {
        cleanup();
        reject(err);
      },
      timeoutId,
    });

    const request: WsExitPlanModeRequest = {
      type: 'exit_plan_mode',
      tool_use_id: toolUseId,
      input,
    };
    broadcastToSession(sessionId, request);
  });
}

/**
 * ユーザーからの承認/修正指示を受信して、対応する Promise を resolve する。
 *
 * @returns true: 応答が受理された, false: 対応する ExitPlanMode が見つからない
 */
export function resolveExitPlanModeDecision(
  toolUseId: string,
  decision: ExitPlanModeDecision
): boolean {
  const pending = pendingExitPlanModes.get(toolUseId);
  if (!pending) return false;

  pending.resolve(decision);
  return true;
}

export const __testing = {
  clearPendingExitPlanModes: () => {
    for (const pending of pendingExitPlanModes.values()) {
      clearTimeout(pending.timeoutId);
    }
    pendingExitPlanModes.clear();
  },
};
