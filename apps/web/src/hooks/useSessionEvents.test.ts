import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@repo/types';
import { shouldRefreshGitDiffForEvent } from './useSessionEvents';

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
