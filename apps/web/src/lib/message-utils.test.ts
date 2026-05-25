import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@repo/types';
import { extractToolResults } from './message-utils';

describe('extractToolResults', () => {
  it('preserves structured tool_use_result data for tool result consumers', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'answered' }],
      },
      tool_use_result: {
        answers: { Language: 'TypeScript' },
      },
    } satisfies SDKMessage;

    expect(extractToolResults([event]).get('toolu-1')?.toolUseResult).toEqual({
      answers: { Language: 'TypeScript' },
    });
  });
});
