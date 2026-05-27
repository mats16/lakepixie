import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
            askQuestionNext: 'Next',
            askQuestionSubmit: 'Submit',
          },
        },
      },
    },
  });
});

function renderTool({
  result,
  toolInput = input,
}: {
  result?: ToolResult;
  toolInput?: typeof input;
} = {}) {
  return render(
    <TestProviders>
      <AskUserQuestionToolUse
        name="AskUserQuestion"
        input={toolInput}
        result={result}
        toolUseId="toolu-1"
      />
    </TestProviders>
  );
}

function renderPendingTool(result?: ToolResult) {
  return render(
    <TestProvidersWithPending pending={true}>
      <AskUserQuestionToolUse
        name="AskUserQuestion"
        input={input}
        result={result}
        toolUseId="toolu-1"
      />
    </TestProvidersWithPending>
  );
}

function TestProvidersWithPending({
  children,
  pending,
}: {
  children: React.ReactNode;
  pending: boolean;
}) {
  const pendingQuestions = pending ? new Map([['toolu-1', {}]]) : new Map();
  return (
    <I18nextProvider i18n={i18n}>
      <AskUserQuestionProvider value={{ pendingQuestions, submitAnswer: vi.fn() }}>
        {children}
      </AskUserQuestionProvider>
    </I18nextProvider>
  );
}

describe('AskUserQuestionToolUse', () => {
  it('restores a known answer from structured tool_use_result data', () => {
    renderTool({
      result: {
        content: 'The user answered.',
        isError: false,
        toolUseResult: { answers: { Language: 'TypeScript' } },
      },
    });

    expect(screen.getByRole('button', { name: /TypeScript/ }).className).toContain(
      'border-primary'
    );
  });

  it('restores a known answer from SDK question-keyed tool_use_result data', () => {
    renderTool({
      result: {
        content: 'The user answered.',
        isError: false,
        toolUseResult: { answers: { 'Which language do you prefer?': 'TypeScript' } },
      },
    });

    expect(screen.getByRole('button', { name: /TypeScript/ }).className).toContain(
      'border-primary'
    );
  });

  it('restores an unknown answer as Other from structured tool_use_result data', () => {
    renderTool({
      result: {
        content: 'The user answered.',
        isError: false,
        toolUseResult: { answers: { Language: 'Rust' } },
      },
    });

    expect(screen.getByDisplayValue('Rust')).toBeTruthy();
  });

  it('restores valid entries when structured answers contain malformed extra data', () => {
    renderTool({
      result: {
        content: 'The user answered.',
        isError: false,
        toolUseResult: { answers: { Language: 'TypeScript', Confidence: 0.9 } },
      },
    });

    expect(screen.getByRole('button', { name: /TypeScript/ }).className).toContain(
      'border-primary'
    );
  });

  it('restores structured answers even when the tool result is an error', () => {
    renderTool({
      result: {
        content: 'Downstream failed.',
        isError: true,
        toolUseResult: { answers: { Language: 'Python' } },
      },
    });

    expect(screen.getByRole('button', { name: /Python/ }).className).toContain('border-primary');
  });

  it('does not split comma-containing structured string answers for multi-select questions', () => {
    renderTool({
      toolInput: {
        questions: [
          {
            question: 'Which company?',
            header: 'Company',
            multiSelect: true,
            options: [{ label: 'Apple, Inc.', description: 'Company name with comma' }],
          },
        ],
      },
      result: {
        content: 'The user answered.',
        isError: false,
        toolUseResult: { answers: { Company: 'Apple, Inc.' } },
      },
    });

    expect(screen.getByRole('button', { name: /Apple, Inc./ }).className).toContain(
      'border-primary'
    );
  });

  it('restores comma-separated structured multi-select answers from SDK data', () => {
    renderTool({
      toolInput: {
        questions: [
          {
            question: 'Which languages should we use?',
            header: 'Language',
            multiSelect: true,
            options: [
              { label: 'Python', description: 'For scripts' },
              { label: 'TypeScript', description: 'For web apps' },
            ],
          },
        ],
      },
      result: {
        content: 'The user answered.',
        isError: false,
        toolUseResult: { answers: { 'Which languages should we use?': 'Python,TypeScript' } },
      },
    });

    expect(screen.getByRole('button', { name: /Python/ }).className).toContain('border-primary');
    expect(screen.getByRole('button', { name: /TypeScript/ }).className).toContain(
      'border-primary'
    );
  });

  it('prefers SDK question-keyed answers over colliding header keys', () => {
    renderTool({
      toolInput: {
        questions: [
          {
            question: 'Library',
            header: 'Lang',
            options: [{ label: 'TypeScript', description: 'Language choice' }],
          },
          {
            question: 'Which database?',
            header: 'Library',
            options: [{ label: 'Postgres', description: 'Database choice' }],
          },
        ],
      },
      result: {
        content: 'The user answered.',
        isError: false,
        toolUseResult: {
          answers: {
            Library: 'TypeScript',
            'Which database?': 'Postgres',
          },
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    expect(screen.getByRole('button', { name: /Postgres/ }).className).toContain('border-primary');
  });

  it('shows multi-value arrays on single-select questions without truncating them', () => {
    renderTool({
      result: {
        content: 'The user answered.',
        isError: false,
        toolUseResult: { answers: { Language: ['Python', 'TypeScript'] } },
      },
    });

    expect(screen.getByDisplayValue('Python,TypeScript')).toBeTruthy();
  });

  it('does not clear pending selections when an empty answer result arrives', () => {
    const { rerender } = renderPendingTool();

    fireEvent.click(screen.getByRole('button', { name: /Python/ }));

    rerender(
      <TestProvidersWithPending pending={false}>
        <AskUserQuestionToolUse
          name="AskUserQuestion"
          input={input}
          result={{
            content: 'The user answered.',
            isError: false,
            toolUseResult: { answers: {} },
          }}
          toolUseId="toolu-1"
        />
      </TestProvidersWithPending>
    );

    expect(screen.getByRole('button', { name: /Python/ }).className).toContain('border-primary');
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
