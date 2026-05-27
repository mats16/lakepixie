import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@repo/types';
import {
  getToolResultIdsFromEvent,
  shouldRefreshGitDiffForEvent,
  shouldRefreshGitRepositoryStatusForEvent,
} from './useSessionEvents';

describe('shouldRefreshGitDiffForEvent', () => {
  it('detects user tool_result events from the agent stream', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'toolu_bdrk_01Y1uayqjzm1Anbs6ikkejbu',
            type: 'tool_result',
            content: 'The file /tmp/sessions/session/src/main.ts has been updated successfully.',
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'f829f7b9-63c8-4b55-ae46-f72a25f8d9c2',
      uuid: '34510614-aaf6-46be-9b3b-5fa7b62fec28',
      timestamp: '2026-05-21T06:33:21.564Z',
      tool_use_result: {
        filePath: '/tmp/sessions/session/src/main.ts',
      },
    } satisfies SDKMessage;

    expect(shouldRefreshGitDiffForEvent(event)).toBe(true);
  });

  it('detects result events', () => {
    expect(shouldRefreshGitDiffForEvent({ type: 'result' })).toBe(true);
  });

  it('ignores ordinary user text events', () => {
    expect(
      shouldRefreshGitDiffForEvent({
        type: 'user',
        message: {
          role: 'user',
          content: 'hello',
        },
      })
    ).toBe(false);
  });
});

describe('shouldRefreshGitRepositoryStatusForEvent', () => {
  it('detects result events', () => {
    expect(shouldRefreshGitRepositoryStatusForEvent({ type: 'result' })).toBe(true);
  });

  it('ignores failed result events', () => {
    expect(
      shouldRefreshGitRepositoryStatusForEvent({
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['failed'],
      } as SDKMessage)
    ).toBe(false);
  });

  it('ignores tool_result events', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' }],
      },
    } satisfies SDKMessage;

    expect(shouldRefreshGitRepositoryStatusForEvent(event)).toBe(false);
  });
});

describe('getToolResultIdsFromEvent', () => {
  it('extracts tool_result ids from one event without scanning session history', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'done' },
          { type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'toolu-2', content: 'ok' },
        ],
      },
    } satisfies SDKMessage;

    expect(getToolResultIdsFromEvent(event)).toEqual(['toolu-1', 'toolu-2']);
  });
});
