import type { WsAskUserQuestionRequest } from '@repo/types';
import { broadcastToSession } from './session.service.js';

interface PendingQuestion {
  resolve: (answers: Record<string, string | string[]>) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

type UserAnswerValue = string | string[];
type UserAnswers = Record<string, UserAnswerValue>;

/** AskUserQuestion の回答待ち管理（tool_use_id → PendingQuestion） */
const pendingQuestions = new Map<string, PendingQuestion>();

/** タイムアウト（10 分） */
const ASK_USER_QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getHeaderToQuestionMap(input: Record<string, unknown>): Map<string, string> {
  const questions = input.questions;
  const map = new Map<string, string>();
  if (!Array.isArray(questions)) return map;

  for (const question of questions) {
    if (
      !isRecord(question) ||
      typeof question.header !== 'string' ||
      typeof question.question !== 'string'
    ) {
      continue;
    }
    map.set(question.header, question.question);
  }

  return map;
}

function stringifyAnswer(value: UserAnswerValue): string {
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * UI は header → label/label[] で送るが、Claude Agent SDK の AskUserQuestion は
 * question text → string を期待するため、canUseTool の updatedInput 用に変換する。
 */
export function normalizeAskUserQuestionAnswers(
  input: Record<string, unknown>,
  answers: UserAnswers
): Record<string, string> {
  const headerToQuestion = getHeaderToQuestionMap(input);
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(answers)) {
    const answerKey = headerToQuestion.get(key) ?? key;
    normalized[answerKey] = stringifyAnswer(value);
  }

  return normalized;
}

/**
 * AskUserQuestion をサスペンドし、ユーザーの回答を待つ。
 *
 * 1. WebSocket で全クライアントに質問リクエストを broadcast
 * 2. Promise を返し、resolve されるまでブロック
 *
 * @returns ユーザーの回答（UI から受け取った header → 選択ラベル のマッピング）
 */
export function waitForUserAnswer(
  sessionId: string,
  toolUseId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, string | string[]>> {
  return new Promise<Record<string, string | string[]>>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      pendingQuestions.delete(toolUseId);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('AskUserQuestion timed out waiting for user response'));
    }, ASK_USER_QUESTION_TIMEOUT_MS);

    const onAbort = () => {
      cleanup();
      reject(new Error('AskUserQuestion aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error('AskUserQuestion aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    pendingQuestions.set(toolUseId, {
      resolve: answers => {
        cleanup();
        resolve(answers);
      },
      reject: err => {
        cleanup();
        reject(err);
      },
      timeoutId,
    });

    // リアルタイム接続に質問リクエストを broadcast
    const request: WsAskUserQuestionRequest = {
      type: 'ask_user_question',
      tool_use_id: toolUseId,
      input,
    };
    broadcastToSession(sessionId, request);
  });
}

/**
 * ユーザーからの回答を受信して、対応する Promise を resolve する。
 *
 * @returns true: 回答が受理された, false: 対応する質問が見つからない
 */
export function resolveUserAnswer(
  toolUseId: string,
  answers: Record<string, string | string[]>
): boolean {
  const pending = pendingQuestions.get(toolUseId);
  if (!pending) return false;

  pending.resolve(answers);
  return true;
}
