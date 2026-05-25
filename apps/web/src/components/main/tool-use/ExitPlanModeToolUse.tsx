import { useTranslation } from 'react-i18next';
import { BaseToolUse } from './BaseToolUse';
import { MarkdownContent } from '../MarkdownContent';
import type { BaseToolUseProps, ExitPlanModeOptimisticResult, ToolResult } from './types';

const REJECT_RESULT_MESSAGES = new Set([
  'The user rejected this plan.',
  'このプランはユーザーに拒否されました。',
]);

function isRejectResultMessage(content: string, localizedRejectMessage: string): boolean {
  return (
    content === '' || content === localizedRejectMessage || REJECT_RESULT_MESSAGES.has(content)
  );
}

function getOptimisticToolResult(
  result: ExitPlanModeOptimisticResult | undefined,
  localizedRejectMessage: string
): ToolResult | undefined {
  if (!result) return undefined;

  switch (result.type) {
    case 'approved':
      return { content: '', isError: false };
    case 'rejected':
      return { content: localizedRejectMessage, isError: true };
    case 'suggested':
      return { content: result.message, isError: true };
  }
}

interface ExitPlanModeToolUseProps extends BaseToolUseProps {
  optimisticResult?: ExitPlanModeOptimisticResult;
}

export function ExitPlanModeToolUse({
  name,
  input,
  result,
  optimisticResult,
}: ExitPlanModeToolUseProps) {
  const { t } = useTranslation();
  const plan = typeof input.plan === 'string' ? input.plan : '';
  const displayResult =
    result ?? getOptimisticToolResult(optimisticResult, t('tools.exitPlanRejectMessage'));

  return (
    <BaseToolUse
      name={name}
      displayName={t('tools.exitPlanMode')}
      input={input}
      result={displayResult}
      hideInput
    >
      {plan && (
        <div className="mt-1 ml-4">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <MarkdownContent content={plan} className="text-sm" />
          </div>
        </div>
      )}
      {displayResult && <ExitPlanModeResult result={displayResult} />}
    </BaseToolUse>
  );
}

function ExitPlanModeResult({ result }: { result: ToolResult }) {
  const { t } = useTranslation();
  const content = result.content.trim();
  const isRejected =
    result.isError && isRejectResultMessage(content, t('tools.exitPlanRejectMessage'));
  const isSuggested = result.isError && !isRejected;
  let label = t('tools.exitPlanApproved');
  if (isSuggested) {
    label = t('tools.exitPlanSuggested');
  } else if (isRejected) {
    label = t('tools.exitPlanRejected');
  }

  return (
    <div className="mt-2 ml-4 flex items-start gap-1 text-sm text-muted-foreground">
      <span className="select-none" aria-hidden="true">
        └─
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{label}</div>
        {isSuggested && content && (
          <div className="mt-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-foreground">
            <MarkdownContent content={content} className="text-sm" />
          </div>
        )}
      </div>
    </div>
  );
}
