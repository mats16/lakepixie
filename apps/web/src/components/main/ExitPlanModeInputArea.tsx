import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type ExitPlanModeInputDecision =
  | { kind: 'approve'; approved: true }
  | { kind: 'reject'; approved: false; message: string }
  | { kind: 'suggest'; approved: false; message: string };

interface ExitPlanModeInputAreaProps {
  toolUseId: string;
  onDecision: (toolUseId: string, decision: ExitPlanModeInputDecision) => Promise<void> | void;
  isSuggestOpen: boolean;
  onSuggestOpenChange: (open: boolean) => void;
}

export function ExitPlanModeInputArea({
  toolUseId,
  onDecision,
  isSuggestOpen,
  onSuggestOpenChange,
}: ExitPlanModeInputAreaProps) {
  const { t } = useTranslation();
  const [revisionMessage, setRevisionMessage] = useState('');
  const [isSending, setIsSending] = useState(false);

  const submitDecision = useCallback(
    async (decision: ExitPlanModeInputDecision) => {
      if (isSending) return;
      setIsSending(true);
      try {
        await onDecision(toolUseId, decision);
      } finally {
        setIsSending(false);
      }
    },
    [isSending, onDecision, toolUseId]
  );

  const approvePlan = useCallback(() => {
    void submitDecision({ kind: 'approve', approved: true });
  }, [submitDecision]);

  const rejectPlan = useCallback(() => {
    void submitDecision({
      kind: 'reject',
      approved: false,
      message: t('tools.exitPlanRejectMessage'),
    });
  }, [submitDecision, t]);

  const sendRevision = useCallback(() => {
    const message = revisionMessage.trim();
    if (!message) return;
    void submitDecision({ kind: 'suggest', approved: false, message });
  }, [revisionMessage, submitDecision]);

  const toggleSuggestOpen = useCallback(() => {
    onSuggestOpenChange(!isSuggestOpen);
  }, [isSuggestOpen, onSuggestOpenChange]);

  return (
    <div className="absolute bottom-0 left-0 right-0 p-4 pointer-events-none">
      <div className="relative w-full max-w-[735px] mx-auto pointer-events-auto">
        <div className="relative flex flex-col rounded-xl border border-border bg-background p-3 shadow-lg">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium">{t('tools.exitPlanPrompt')}</p>
            <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={rejectPlan}
                disabled={isSending}
              >
                {t('tools.exitPlanReject')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={toggleSuggestOpen}
                disabled={isSending}
                className={cn(isSuggestOpen && 'bg-accent text-accent-foreground')}
              >
                {t('tools.exitPlanSuggest')}
              </Button>
              <Button type="button" size="sm" onClick={approvePlan} disabled={isSending}>
                {t('tools.exitPlanApprove')}
              </Button>
            </div>
          </div>
          {isSuggestOpen && (
            <div className="mt-2 rounded-md border border-input bg-background p-2">
              <Textarea
                value={revisionMessage}
                onChange={event => setRevisionMessage(event.target.value)}
                placeholder={t('tools.exitPlanRevisionPlaceholder')}
                disabled={isSending}
                className="min-h-[76px] resize-none border-0 bg-transparent px-1 py-0 text-sm focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <div className="mt-1 flex justify-end">
                <Button
                  type="button"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={sendRevision}
                  disabled={isSending || revisionMessage.trim().length === 0}
                  aria-label={t('tools.exitPlanSendRevision')}
                  title={t('tools.exitPlanSendRevision')}
                >
                  {isSending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
