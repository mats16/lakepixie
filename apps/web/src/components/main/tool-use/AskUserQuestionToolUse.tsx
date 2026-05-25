import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { StatusDot } from './BaseToolUse';
import { CollapsibleContent } from '../CollapsibleContent';
import { useAskUserQuestion } from '@/contexts/AskUserQuestionContext';
import type { BaseToolUseProps } from './types';

const OTHER_SENTINEL = '__OTHER__';

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

interface AskUserQuestionInput {
  questions?: Question[];
  question?: string;
}

interface AskUserQuestionToolUseProps extends BaseToolUseProps {
  toolUseId?: string;
}

type AnswerValue = string | string[];
type AnswerSelections = Record<string, AnswerValue>;
type AnswerSource = 'structured' | 'resultText';

interface AnswerSelectionState {
  answers: AnswerSelections;
  source: AnswerSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAnswerValue(value: unknown): value is AnswerValue {
  return (
    typeof value === 'string' || (Array.isArray(value) && value.every(v => typeof v === 'string'))
  );
}

function toAnswerSelections(value: unknown): AnswerSelections | undefined {
  if (!isRecord(value)) return undefined;

  const answers: AnswerSelections = {};
  for (const [key, answer] of Object.entries(value)) {
    if (isAnswerValue(answer)) {
      answers[key] = answer;
    }
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function getToolUseResultAnswers(toolUseResult: unknown): AnswerSelections | undefined {
  return isRecord(toolUseResult) ? toAnswerSelections(toolUseResult.answers) : undefined;
}

function isEmptyAnswer(value: AnswerValue | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function hasAnswer(value: AnswerValue | undefined): value is AnswerValue {
  return !isEmptyAnswer(value);
}

function toMultiSelectValues(value: AnswerValue, source: AnswerSource): string[] {
  if (Array.isArray(value)) return value;
  return source === 'resultText' ? value.split(',') : [value];
}

function toSingleSelectValue(value: AnswerValue): string {
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * tool_result テキストから回答をパース（表示専用）。
 *
 * フォーマット `"header"="label"` は Claude Agent SDK の AskUserQuestion ツールが
 * 生成する結果文字列に依存。パース失敗時は空オブジェクトを返し、選択状態が
 * 表示されないだけで機能には影響しない。
 */
function parseAnswersFromResult(content: string): AnswerSelections {
  const answers: AnswerSelections = {};
  const regex = /"([^"]+)"="([^"]+)"/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    answers[match[1]] = match[2];
  }
  return answers;
}

function getAnsweredSelections(
  result: AskUserQuestionToolUseProps['result']
): AnswerSelectionState | undefined {
  const structuredAnswers = getToolUseResultAnswers(result?.toolUseResult);
  if (structuredAnswers) return { answers: structuredAnswers, source: 'structured' };

  if (!result || result.isError) return undefined;

  const parsedAnswers = parseAnswersFromResult(result.content);
  return Object.keys(parsedAnswers).length > 0
    ? { answers: parsedAnswers, source: 'resultText' }
    : undefined;
}

/** 回答済みの値から selections / otherTexts の初期値を一括生成 */
function buildInitialState(
  questions: Question[],
  answeredSelections?: AnswerSelectionState
): { selections: Record<string, string | string[]>; otherTexts: Record<string, string> } {
  const selections: Record<string, string | string[]> = {};
  const otherTexts: Record<string, string> = {};

  for (const q of questions) {
    const answeredState = answeredSelections;
    const answeredValue = answeredState?.answers[q.header];
    if (!answeredState || !hasAnswer(answeredValue)) {
      selections[q.header] = q.multiSelect ? [] : '';
      otherTexts[q.header] = '';
      continue;
    }

    const optionLabels = (q.options ?? []).map(o => o.label);

    if (q.multiSelect) {
      const vals = toMultiSelectValues(answeredValue, answeredState.source);
      const known = vals.filter(v => optionLabels.includes(v));
      const unknown = vals.filter(v => !optionLabels.includes(v));
      selections[q.header] = unknown.length > 0 ? [...known, OTHER_SENTINEL] : known;
      otherTexts[q.header] = unknown.join(',');
    } else {
      const val = toSingleSelectValue(answeredValue);
      const isKnown = optionLabels.includes(val);
      selections[q.header] = isKnown ? val : OTHER_SENTINEL;
      otherTexts[q.header] = isKnown ? '' : val;
    }
  }

  return { selections, otherTexts };
}

export function AskUserQuestionToolUse({ input, result, toolUseId }: AskUserQuestionToolUseProps) {
  const { t } = useTranslation();
  const typedInput = input as unknown as AskUserQuestionInput;
  const { pendingQuestions, submitAnswer } = useAskUserQuestion();

  const isRunning = !result;
  const isSuccess = result && !result.isError;
  const isError = result?.isError;

  const questions = typedInput.questions;
  const hasTabbed = questions && questions.length > 0;

  const isPending = toolUseId ? pendingQuestions.has(toolUseId) : false;

  const answeredSelections = useMemo(() => getAnsweredSelections(result), [result]);

  const handleSubmit = useCallback(
    (answers: Record<string, string | string[]>) => {
      if (toolUseId) {
        submitAnswer(toolUseId, answers);
      }
    },
    [toolUseId, submitAnswer]
  );

  return (
    <div className="py-1">
      <div className="flex items-start gap-1">
        <StatusDot
          isRunning={isRunning}
          isSuccess={!!isSuccess}
          isError={!!isError}
          className="mt-1.5"
        />
        <span className="font-bold text-sm flex-shrink-0">{t('tools.askUserQuestion')}</span>
      </div>

      {hasTabbed ? (
        <TabbedQuestions
          questions={questions}
          isPending={isPending}
          answeredSelections={answeredSelections}
          onSubmit={handleSubmit}
        />
      ) : typedInput.question ? (
        <div className="mt-2 ml-5 text-sm text-muted-foreground">{typedInput.question}</div>
      ) : null}

      {result && result.isError && (
        <CollapsibleContent content={result.content} isError={result.isError} />
      )}
    </div>
  );
}

interface TabbedQuestionsProps {
  questions: Question[];
  isPending: boolean;
  /** 回答済みの場合、パース結果を渡す（header → label） */
  answeredSelections?: AnswerSelectionState;
  onSubmit: (answers: Record<string, string | string[]>) => void;
}

function TabbedQuestions({
  questions,
  isPending,
  answeredSelections,
  onSubmit,
}: TabbedQuestionsProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);

  const restoredState = useMemo(
    () => buildInitialState(questions, answeredSelections),
    [questions, answeredSelections]
  );
  const [selections, setSelections] = useState(restoredState.selections);
  const [otherTexts, setOtherTexts] = useState(restoredState.otherTexts);

  useEffect(() => {
    if (!answeredSelections || isPending) return;
    setSelections(restoredState.selections);
    setOtherTexts(restoredState.otherTexts);
  }, [answeredSelections, isPending, restoredState]);

  const isLastTab = activeIndex === questions.length - 1;
  const isFirstTab = activeIndex === 0;
  const activeQuestion = questions[activeIndex];

  const goNext = () => {
    if (!isLastTab) setActiveIndex(activeIndex + 1);
  };

  const goPrev = () => {
    if (!isFirstTab) setActiveIndex(activeIndex - 1);
  };

  const handleSelect = (header: string, label: string, multiSelect: boolean) => {
    setSelections(prev => {
      if (multiSelect) {
        const current = (prev[header] as string[]) ?? [];
        const next = current.includes(label)
          ? current.filter(l => l !== label)
          : [...current, label];
        return { ...prev, [header]: next };
      }
      return { ...prev, [header]: label };
    });
  };

  const allAnswered = questions.every(q => {
    const sel = selections[q.header];
    if (q.multiSelect) {
      const arr = sel as string[];
      if (arr.length === 0) return false;
      if (arr.includes(OTHER_SENTINEL) && otherTexts[q.header].trim() === '') return false;
      return true;
    }
    if (sel === OTHER_SENTINEL) return otherTexts[q.header].trim() !== '';
    return (sel as string) !== '';
  });

  const handleSubmit = () => {
    if (!allAnswered) return;
    const resolved: Record<string, string | string[]> = {};
    for (const q of questions) {
      const sel = selections[q.header];
      if (q.multiSelect) {
        resolved[q.header] = (sel as string[]).map(v =>
          v === OTHER_SENTINEL ? otherTexts[q.header].trim() : v
        );
      } else {
        resolved[q.header] = sel === OTHER_SENTINEL ? otherTexts[q.header].trim() : (sel as string);
      }
    }
    onSubmit(resolved);
  };

  const showSubmit = isPending && (questions.length === 1 || isLastTab);

  return (
    <div className="mt-2 ml-5">
      <QuestionPanel
        question={activeQuestion}
        stepLabel={
          questions.length > 1
            ? t('tools.askQuestionStep', { current: activeIndex + 1, total: questions.length })
            : undefined
        }
        selection={selections[activeQuestion.header]}
        isPending={isPending}
        onSelect={label =>
          handleSelect(activeQuestion.header, label, activeQuestion.multiSelect ?? false)
        }
        otherText={otherTexts[activeQuestion.header]}
        onOtherTextChange={text =>
          setOtherTexts(prev => ({ ...prev, [activeQuestion.header]: text }))
        }
        onSelectOther={() =>
          handleSelect(activeQuestion.header, OTHER_SENTINEL, activeQuestion.multiSelect ?? false)
        }
      />

      {(questions.length > 1 || showSubmit) && (
        <div className="flex items-center justify-end mt-3">
          <div className="flex gap-1.5">
            {questions.length > 1 && (
              <button
                type="button"
                onClick={goPrev}
                disabled={isFirstTab}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-md border border-border transition-colors',
                  isFirstTab
                    ? 'text-muted-foreground/40 cursor-not-allowed'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                {t('tools.askQuestionPrev')}
              </button>
            )}
            {questions.length > 1 && !isLastTab && (
              <button
                type="button"
                onClick={goNext}
                className="text-xs px-2.5 py-1 rounded-md border border-border transition-colors text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t('tools.askQuestionNext')}
              </button>
            )}
            {showSubmit && (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!allAnswered}
                className={cn(
                  'text-xs px-3 py-1 rounded-md transition-colors font-medium',
                  allAnswered
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
              >
                {t('tools.askQuestionSubmit')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface QuestionPanelProps {
  question: Question;
  stepLabel?: string;
  selection: string | string[];
  isPending: boolean;
  onSelect: (label: string) => void;
  otherText: string;
  onOtherTextChange: (text: string) => void;
  onSelectOther: () => void;
}

function QuestionPanel({
  question,
  stepLabel,
  selection,
  isPending,
  onSelect,
  otherText,
  onOtherTextChange,
  onSelectOther,
}: QuestionPanelProps) {
  const { t } = useTranslation();
  const isMultiSelect = question.multiSelect ?? false;
  const isOtherSelected = isMultiSelect
    ? (selection as string[]).includes(OTHER_SENTINEL)
    : selection === OTHER_SENTINEL;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{question.question}</p>
        {stepLabel && (
          <span className="text-xs text-muted-foreground flex-shrink-0">{stepLabel}</span>
        )}
      </div>
      {question.options && question.options.length > 0 && (
        <div className="space-y-1.5">
          {question.options.map(option => {
            const isSelected = isMultiSelect
              ? (selection as string[]).includes(option.label)
              : selection === option.label;
            return (
              <OptionCard
                key={option.label}
                option={option}
                isMultiSelect={isMultiSelect}
                isSelected={isSelected}
                isPending={isPending}
                onSelect={() => onSelect(option.label)}
              />
            );
          })}
          <OtherOptionCard
            isMultiSelect={isMultiSelect}
            isSelected={isOtherSelected}
            isPending={isPending}
            otherText={otherText}
            onSelect={onSelectOther}
            onTextChange={onOtherTextChange}
            label={t('tools.askQuestionOther')}
            placeholder={t('tools.askQuestionOtherPlaceholder')}
          />
        </div>
      )}
    </div>
  );
}

function SelectionIndicator({
  isMultiSelect,
  isSelected,
}: {
  isMultiSelect: boolean;
  isSelected: boolean;
}) {
  if (isMultiSelect) {
    return (
      <div
        className={cn(
          'h-3.5 w-3.5 rounded-sm border flex items-center justify-center',
          isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/40'
        )}
      >
        {isSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'h-3.5 w-3.5 rounded-full border flex items-center justify-center',
        isSelected ? 'border-primary' : 'border-muted-foreground/40'
      )}
    >
      {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
    </div>
  );
}

interface OptionCardProps {
  option: QuestionOption;
  isMultiSelect: boolean;
  isSelected: boolean;
  isPending: boolean;
  onSelect: () => void;
}

function OptionCard({ option, isMultiSelect, isSelected, isPending, onSelect }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={isPending ? onSelect : undefined}
      disabled={!isPending}
      className={cn(
        'flex items-start gap-2.5 rounded-md border p-2.5 w-full text-left transition-colors',
        isPending && 'cursor-pointer hover:bg-accent/50',
        !isPending && 'cursor-default',
        isSelected ? 'border-primary bg-primary/5' : 'border-border bg-card'
      )}
    >
      <div className="flex-shrink-0 mt-0.5">
        <SelectionIndicator isMultiSelect={isMultiSelect} isSelected={isSelected} />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium leading-tight">{option.label}</div>
        {option.description && (
          <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {option.description}
          </div>
        )}
      </div>
    </button>
  );
}

interface OtherOptionCardProps {
  isMultiSelect: boolean;
  isSelected: boolean;
  isPending: boolean;
  otherText: string;
  onSelect: () => void;
  onTextChange: (text: string) => void;
  label: string;
  placeholder: string;
}

function OtherOptionCard({
  isMultiSelect,
  isSelected,
  isPending,
  otherText,
  onSelect,
  onTextChange,
  label,
  placeholder,
}: OtherOptionCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isSelected && isPending) {
      inputRef.current?.focus();
    }
  }, [isSelected, isPending]);

  return (
    <div
      role="button"
      tabIndex={isPending ? 0 : -1}
      onClick={isPending && !isSelected ? onSelect : undefined}
      onKeyDown={
        isPending && !isSelected
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      className={cn(
        'flex items-start gap-2.5 rounded-md border p-2.5 w-full text-left transition-colors',
        isPending && !isSelected && 'cursor-pointer hover:bg-accent/50',
        !isPending && 'cursor-default',
        isSelected ? 'border-primary bg-primary/5' : 'border-border bg-card'
      )}
    >
      <div className="flex-shrink-0 mt-0.5">
        <SelectionIndicator isMultiSelect={isMultiSelect} isSelected={isSelected} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-tight">{label}</div>
        {isSelected && (
          <Input
            ref={inputRef}
            type="text"
            value={otherText}
            onChange={e => onTextChange(e.target.value)}
            onClick={e => e.stopPropagation()}
            disabled={!isPending}
            placeholder={placeholder}
            className="mt-1.5 h-auto px-2 py-1 text-sm"
          />
        )}
      </div>
    </div>
  );
}
