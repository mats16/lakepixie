import type { WsAskUserQuestionRequest } from '@repo/types';
import { broadcastToSession } from './session.service.js';

interface PendingQuestion {
  resolve: (answers: Record<string, string | string[]>) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

type UserAnswerValue = string | string[];
type UserAnswers = Record<string, UserAnswerValue>;

interface QuestionMapping {
  headerToQuestion: Map<string, string>;
  questionTexts: Set<string>;
}

/** AskUserQuestion の回答待ち管理（tool_use_id → PendingQuestion） */
const pendingQuestions = new Map<string, PendingQuestion>();

/** タイムアウト（10 分） */
const ASK_USER_QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getQuestionMapping(input: Record<string, unknown>): QuestionMapping {
  const questions = input.questions;
  const headerToQuestion = new Map<string, string>();
  const questionTexts = new Set<string>();
  if (!Array.isArray(questions)) return { headerToQuestion, questionTexts };

  for (const question of questions) {
    if (
      !isRecord(question) ||
      typeof question.header !== 'string' ||
      typeof question.question !== 'string'
    ) {
      throw new Error('AskUserQuestion input questions must include string header and question');
    }
    if (headerToQuestion.has(question.header)) {
      throw new Error(`AskUserQuestion input contains duplicate header '${question.header}'`);
    }
    headerToQuestion.set(question.header, question.question);
    questionTexts.add(question.question);
  }

  return { headerToQuestion, questionTexts };
}

function stringifyAnswer(value: UserAnswerValue): string {
  return Array.isArray(value) ? value.join(',') : value;
}

function assertNoCommaInMultiSelectAnswer(key: string, value: UserAnswerValue): void {
  if (!Array.isArray(value)) return;
  const invalid = value.find(answer => answer.includes(','));
  if (invalid) {
    throw new Error(
      `AskUserQuestion multi-select answer for '${key}' cannot contain a comma: '${invalid}'`
    );
  }
}

/**
 * UI は header → label/label[] で送るが、Claude Agent SDK の AskUserQuestion は
 * question text → string を期待するため、canUseTool の updatedInput 用に変換する。
 */
export function normalizeAskUserQuestionAnswers(
  input: Record<string, unknown>,
  answers: UserAnswers
): Record<string, string> {
  const { headerToQuestion, questionTexts } = getQuestionMapping(input);
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(answers)) {
    assertNoCommaInMultiSelectAnswer(key, value);
    const answerKey = headerToQuestion.get(key) ?? (questionTexts.has(key) ? key : undefined);
    if (!answerKey) {
      throw new Error(`AskUserQuestion answer key '${key}' does not match any question`);
    }
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

export const __testing = {
  clearPendingQuestions: () => {
    for (const pending of pendingQuestions.values()) {
      clearTimeout(pending.timeoutId);
    }
    pendingQuestions.clear();
  },
};
