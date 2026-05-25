import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import useLocalStorageState from 'use-local-storage-state';
import { Send, Image, Loader2, Square, ChevronDown, Check, ListTodo } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TEXTAREA_MAX_HEIGHT_MAIN } from '@/constants';
import { useImageAttachment } from '@/hooks/useImageAttachment';
import { useDragDrop } from '@/hooks/useDragDrop';
import { buildMessageContent } from '@/lib/content-builder';
import { ImagePreview } from './ImagePreview';
import { DropZoneOverlay } from './DropZoneOverlay';
import type { UserMessageContentBlock, WsEffortLevel } from '@repo/types';
import { EFFORT_LEVEL_OPTIONS, type ClaudeModel } from '@/constants';
import { cn } from '@/lib/utils';

interface InputAreaProps {
  sessionId?: string;
  onSend?: (content: UserMessageContentBlock[]) => Promise<void> | void;
  onAbort?: () => Promise<boolean>;
  isAgentThinking?: boolean;
  disabled?: boolean;
  currentModelId?: string;
  modelOptions?: ClaudeModel[];
  modelControlDisabled?: boolean;
  currentEffortLevel?: WsEffortLevel;
  effortControlDisabled?: boolean;
  isPlanMode?: boolean;
  planModeDisabled?: boolean;
  onModelChange?: (modelId: string) => Promise<void>;
  onEffortChange?: (effortLevel: WsEffortLevel) => Promise<void>;
  onPlanModeChange?: (enabled: boolean) => Promise<void>;
}

export function InputArea({
  sessionId,
  onSend,
  onAbort,
  isAgentThinking = false,
  disabled,
  currentModelId,
  modelOptions = [],
  modelControlDisabled,
  currentEffortLevel,
  effortControlDisabled,
  isPlanMode = false,
  planModeDisabled,
  onModelChange,
  onEffortChange,
  onPlanModeChange,
}: InputAreaProps) {
  const { t } = useTranslation();
  const storageKey = sessionId ? `chat-draft-${sessionId}` : 'chat-draft-temp';
  const [content, setContent] = useLocalStorageState(storageKey, {
    defaultValue: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 画像添付フック
  const { images, isProcessing, addImages, removeImage, clearImages, hasImages } =
    useImageAttachment({
      onError: message => {
        toast.error(message);
      },
    });

  // ドラッグ&ドロップフック
  const { isDragging } = useDragDrop(containerRef, {
    onDrop: addImages,
    disabled: disabled || isSubmitting,
  });

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, TEXTAREA_MAX_HEIGHT_MAIN)}px`;
    }
  }, [content]);

  const handleSubmit = async () => {
    const hasContent = content.trim() || hasImages;
    if (!hasContent || disabled || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const messageContent = buildMessageContent(content.trim(), images);
      await onSend?.(messageContent);
      setContent('');
      clearImages();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        addImages(imageFiles);
      }
    },
    [addImages]
  );

  const handleAbort = async () => {
    if (isAborting || !onAbort) return;

    setIsAborting(true);
    try {
      await onAbort();
    } finally {
      setIsAborting(false);
    }
  };

  const handleImageButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        addImages(files);
      }
      // 同じファイルを再選択できるようにリセット
      e.target.value = '';
    },
    [addImages]
  );

  const canSubmit = useMemo(
    () => (content.trim() || hasImages) && !disabled && !isSubmitting,
    [content, hasImages, disabled, isSubmitting]
  );

  // 停止ボタン表示条件：テキストがブランク かつ 画像もなし かつ thinking 中
  const showStopButton = isAgentThinking && !content.trim() && !hasImages;
  const currentModel =
    modelOptions.find(model => model.id === currentModelId) ??
    (currentModelId
      ? { id: currentModelId, name: currentModelId, shortName: currentModelId }
      : null);

  return (
    <div className="absolute bottom-0 left-0 right-0 p-4 pointer-events-none">
      <div ref={containerRef} className="relative w-full max-w-[735px] mx-auto pointer-events-auto">
        <DropZoneOverlay isVisible={isDragging} />
        <div className="relative flex flex-col rounded-xl border border-border bg-background p-2 shadow-lg">
          {/* 画像プレビュー */}
          <ImagePreview
            images={images}
            onRemove={removeImage}
            disabled={disabled || isSubmitting}
          />

          <Textarea
            ref={textareaRef}
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('main.inputPlaceholder')}
            disabled={disabled}
            className="min-h-[40px] max-h-[150px] w-full resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none px-1 py-0"
            rows={1}
          />
          <div className="flex items-center justify-between shrink-0 mt-1">
            <div className="flex items-center gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={handleImageButtonClick}
                      disabled={disabled || isSubmitting || isProcessing}
                    >
                      {isProcessing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Image className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('main.attachImage')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'h-8 shrink-0 gap-1 px-2 text-xs text-muted-foreground',
                        isPlanMode && 'bg-primary/10 text-primary'
                      )}
                      onClick={() => {
                        void onPlanModeChange?.(!isPlanMode);
                      }}
                      disabled={planModeDisabled || !onPlanModeChange}
                      aria-label={t('main.planMode')}
                      aria-pressed={isPlanMode}
                    >
                      <ListTodo
                        className={cn(
                          'h-4 w-4',
                          isPlanMode ? 'text-primary stroke-[2.5]' : 'text-muted-foreground'
                        )}
                      />
                      <span>{t('main.planMode')}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('main.planModeTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <div className="flex items-center gap-1">
              {currentModel && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 max-w-[10rem] px-2 text-xs text-muted-foreground hover:text-foreground"
                      disabled={modelControlDisabled || !onModelChange}
                      title={t('main.modelControl')}
                    >
                      <span className="truncate">
                        {currentModel.shortName ?? currentModel.name}
                      </span>
                      <ChevronDown className="ml-1 h-3 w-3 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {modelOptions.map(model => (
                      <DropdownMenuItem
                        key={model.id}
                        onClick={() => {
                          void onModelChange?.(model.id);
                        }}
                        className="flex items-start justify-between py-2"
                      >
                        <div className="flex min-w-0 flex-col">
                          <span className="font-medium">{model.name}</span>
                          {model.descriptionKey && (
                            <span className="text-xs text-muted-foreground">
                              {t(model.descriptionKey)}
                            </span>
                          )}
                        </div>
                        {currentModelId === model.id && (
                          <Check className="ml-2 h-4 w-4 shrink-0 text-primary" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {currentEffortLevel && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                      disabled={effortControlDisabled || !onEffortChange}
                      title={t('main.effortControl')}
                    >
                      <span className="truncate">{currentEffortLevel}</span>
                      <ChevronDown className="ml-1 h-3 w-3 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    {EFFORT_LEVEL_OPTIONS.map(effortLevel => (
                      <DropdownMenuItem
                        key={effortLevel}
                        onClick={() => {
                          void onEffortChange?.(effortLevel);
                        }}
                        className="flex items-center justify-between py-2"
                      >
                        <span className="font-medium">{effortLevel}</span>
                        {currentEffortLevel === effortLevel && (
                          <Check className="ml-2 h-4 w-4 shrink-0 text-primary" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {showStopButton ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="destructive"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={handleAbort}
                        disabled={isAborting}
                      >
                        {isAborting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('main.stop')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                      >
                        {isSubmitting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('main.send')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}
