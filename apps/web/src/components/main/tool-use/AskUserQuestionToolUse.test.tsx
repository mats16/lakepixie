import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { AskUserQuestionProvider } from '@/contexts/AskUserQuestionContext';
import { AskUserQuestionToolUse } from './AskUserQuestionToolUse';
import type { ToolResult } from './types';

const input = {
  questions: [
    {
      question: 'Which language do you prefer?',
      header: 'Language',
      multiSelect: false,
      options: [
        { label: 'Python', description: 'For scripts' },
        { label: 'TypeScript', description: 'For web apps' },
      ],
    },
  ],
};

function TestProviders({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <AskUserQuestionProvider value={{ pendingQuestions: new Map(), submitAnswer: vi.fn() }}>
        {children}
      </AskUserQuestionProvider>
    </I18nextProvider>
  );
}

beforeEach(async () => {
  await i18n.init({
    lng: 'en',
    resources: {
      en: {
        translation: {
          tools: {
            askUserQuestion: 'Question',
            askQuestionOther: 'Other',
            askQuestionOtherPlaceholder: 'Enter your answer',
            askQuestionSubmit: 'Submit',
          },
        },
      },
    },
  });
});

function renderTool(result?: ToolResult) {
  return render(
    <TestProviders>
      <AskUserQuestionToolUse
        name="AskUserQuestion"
        input={input}
        result={result}
        toolUseId="toolu-1"
      />
    </TestProviders>
  );
}

describe('AskUserQuestionToolUse', () => {
  it('restores a known answer from structured tool_use_result data', () => {
    renderTool({
      content: 'The user answered.',
      isError: false,
      toolUseResult: { answers: { Language: 'TypeScript' } },
    });

    expect(screen.getByRole('button', { name: /TypeScript/ }).className).toContain(
      'border-primary'
    );
  });

  it('restores an unknown answer as Other from structured tool_use_result data', () => {
    renderTool({
      content: 'The user answered.',
      isError: false,
      toolUseResult: { answers: { Language: 'Rust' } },
    });

    expect(screen.getByDisplayValue('Rust')).toBeTruthy();
  });

  it('updates the restored selection when the result arrives after initial render', () => {
    const { rerender } = renderTool();

    rerender(
      <TestProviders>
        <AskUserQuestionToolUse
          name="AskUserQuestion"
          input={input}
          result={{
            content: 'The user answered.',
            isError: false,
            toolUseResult: { answers: { Language: 'Python' } },
          }}
          toolUseId="toolu-1"
        />
      </TestProviders>
    );

    expect(screen.getByRole('button', { name: /Python/ }).className).toContain('border-primary');
  });
});
