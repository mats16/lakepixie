import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ChevronRight, FolderPlus, X } from 'lucide-react';
import type { WorkspaceObjectType, WorkspaceObjectInfo, WorkspaceSelection } from '@repo/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { extractNameFromPath, safeSanitizePath, getWorkspaceObjectIcon } from '@/lib/workspace';
import { workspaceService, ApiClientError } from '@/services';
import { WorkspaceBreadcrumb } from './WorkspaceBreadcrumb';

interface WorkspaceBrowserModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: WorkspaceSelection) => void;
  /** 初期表示パス */
  initialPath?: string;
  /** 選択可能なオブジェクトタイプ（デフォルト: DIRECTORY, REPO） */
  selectableTypes?: WorkspaceObjectType[];
  /** モーダルタイトル（デフォルト: 翻訳キーから取得） */
  title?: string;
  /** モーダル説明（デフォルト: 翻訳キーから取得） */
  description?: string;
}

const DEFAULT_SELECTABLE_TYPES: WorkspaceObjectType[] = ['DIRECTORY', 'REPO'];

function buildChildPath(parentPath: string, childName: string): string {
  const normalizedParent = parentPath.endsWith('/') ? parentPath.slice(0, -1) : parentPath;
  return `${normalizedParent}/${childName}`;
}

function sortWorkspaceObjects(objects: WorkspaceObjectInfo[]): WorkspaceObjectInfo[] {
  return [...objects].sort((a, b) => {
    if (a.object_type === 'DIRECTORY' && b.object_type !== 'DIRECTORY') return -1;
    if (a.object_type !== 'DIRECTORY' && b.object_type === 'DIRECTORY') return 1;
    if (a.object_type === 'REPO' && b.object_type !== 'REPO') return -1;
    if (a.object_type !== 'REPO' && b.object_type === 'REPO') return 1;
    return extractNameFromPath(a.path).localeCompare(extractNameFromPath(b.path));
  });
}

function getWorkspaceErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

function isInvalidFolderName(folderName: string): boolean {
  return (
    folderName.includes('/') ||
    folderName.includes('\\') ||
    folderName.includes('..') ||
    folderName.includes('\0')
  );
}

export function WorkspaceBrowserModal({
  open,
  onOpenChange,
  onSelect,
  initialPath = '/Workspace',
  selectableTypes = DEFAULT_SELECTABLE_TYPES,
  title,
  description,
}: WorkspaceBrowserModalProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState(initialPath);
  // currentPath の object_type と object_id を追跡（ナビゲーション時に更新）
  const [currentObjectType, setCurrentObjectType] = useState<WorkspaceObjectType>('DIRECTORY');
  const [currentObjectId, setCurrentObjectId] = useState<number | undefined>(undefined);
  const [objects, setObjects] = useState<WorkspaceObjectInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<WorkspaceObjectInfo | null>(null);
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const resetCreateForm = useCallback(() => {
    setCreateError(null);
    setIsCreateFormOpen(false);
    setNewFolderName('');
  }, []);

  const fetchObjects = useCallback(
    async ({ clearSelection = true }: { clearSelection?: boolean } = {}) => {
      setIsLoading(true);
      setError(null);
      if (clearSelection) {
        setSelectedItem(null);
      }

      try {
        const listResponse = await workspaceService.listWorkspace(currentPath);
        setObjects(sortWorkspaceObjects(listResponse.objects ?? []));
      } catch (err) {
        setError(getWorkspaceErrorMessage(err, t('workspace.error')));
        setObjects([]);
      } finally {
        setIsLoading(false);
      }
    },
    [currentPath, t]
  );

  // モーダルが開いた時にパスをリセット
  useEffect(() => {
    if (open) {
      setCurrentPath(initialPath);
      setCurrentObjectType('DIRECTORY'); // 初期パスは通常 DIRECTORY
      setCurrentObjectId(undefined);
      setSelectedItem(null);
      setError(null);
      setSelectError(null);
      resetCreateForm();
    }
  }, [open, initialPath, resetCreateForm]);

  // パスが変わったらオブジェクト一覧を取得
  useEffect(() => {
    if (!open) return;

    void fetchObjects();
  }, [open, fetchObjects]);

  const handleNavigate = useCallback(
    (path: string, objectType: WorkspaceObjectType = 'DIRECTORY', objectId?: number) => {
      setCurrentPath(safeSanitizePath(path));
      setCurrentObjectType(objectType);
      setCurrentObjectId(objectId);
      setSelectError(null);
      resetCreateForm();
    },
    [resetCreateForm]
  );

  const openCreateForm = useCallback(() => {
    setIsCreateFormOpen(true);
    setCreateError(null);
    setSelectError(null);
  }, []);

  const handleFolderNameChange = useCallback((value: string) => {
    setNewFolderName(value);
    setCreateError(null);
  }, []);

  const handleCreateFolder = useCallback(async () => {
    const trimmedName = newFolderName.trim();
    setCreateError(null);
    setSelectError(null);

    if (!trimmedName) {
      setCreateError(t('workspace.folderNameRequired'));
      return;
    }

    if (isInvalidFolderName(trimmedName)) {
      setCreateError(t('workspace.folderNameInvalid'));
      return;
    }

    const newFolderPath = safeSanitizePath(buildChildPath(currentPath, trimmedName));
    if (objects.some(object => object.path === newFolderPath)) {
      setCreateError(t('workspace.folderAlreadyExists'));
      return;
    }

    setIsCreatingFolder(true);
    try {
      await workspaceService.mkdirs(newFolderPath);
      const createdFolder = await workspaceService.getStatus(newFolderPath);
      setSelectedItem(createdFolder);
      resetCreateForm();
      await fetchObjects({ clearSelection: false });
    } catch (err) {
      setCreateError(getWorkspaceErrorMessage(err, t('workspace.createFolderError')));
    } finally {
      setIsCreatingFolder(false);
    }
  }, [currentPath, fetchObjects, newFolderName, objects, resetCreateForm, t]);

  const handleSelectCurrentFolder = useCallback(async () => {
    if (selectedItem) {
      onSelect({
        path: selectedItem.path,
        name: extractNameFromPath(selectedItem.path),
        object_type: selectedItem.object_type,
        object_id: selectedItem.object_id,
      });
      onOpenChange(false);
      return;
    }

    if (currentObjectId !== undefined) {
      onSelect({
        path: currentPath,
        name: extractNameFromPath(currentPath),
        object_type: currentObjectType,
        object_id: currentObjectId,
      });
      onOpenChange(false);
      return;
    }

    setIsSelecting(true);
    setSelectError(null);
    try {
      const statusResponse = await workspaceService.getStatus(currentPath);
      setCurrentObjectId(statusResponse.object_id);
      setCurrentObjectType(statusResponse.object_type);
      onSelect({
        path: currentPath,
        name: extractNameFromPath(currentPath),
        object_type: statusResponse.object_type,
        object_id: statusResponse.object_id,
      });
      onOpenChange(false);
    } catch (err) {
      setSelectError(getWorkspaceErrorMessage(err, t('workspace.error')));
    } finally {
      setIsSelecting(false);
    }
  }, [currentObjectId, currentObjectType, currentPath, onOpenChange, onSelect, selectedItem, t]);

  const handleItemDoubleClick = useCallback(
    (item: WorkspaceObjectInfo) => {
      // ディレクトリまたはリポジトリの場合はナビゲート
      if (item.object_type === 'DIRECTORY' || item.object_type === 'REPO') {
        handleNavigate(item.path, item.object_type, item.object_id);
        return;
      }

      // 選択可能なタイプの場合は即座に選択して閉じる
      if (selectableTypes.includes(item.object_type)) {
        onSelect({
          path: item.path,
          name: extractNameFromPath(item.path),
          object_type: item.object_type,
          object_id: item.object_id,
        });
        onOpenChange(false);
      }
    },
    [selectableTypes, onSelect, onOpenChange, handleNavigate]
  );

  const isSelectable = (item: WorkspaceObjectInfo) => selectableTypes.includes(item.object_type);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{title ?? t('workspace.browserTitle')}</DialogTitle>
          <DialogDescription>{description ?? t('workspace.browserDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0">
          {/* パンくずナビゲーション */}
          <div className="border-b pb-2">
            <WorkspaceBreadcrumb path={currentPath} onNavigate={handleNavigate} />
          </div>

          {/* オブジェクト一覧 */}
          <ScrollArea className="h-[400px]">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground">{t('workspace.loading')}</span>
              </div>
            ) : error ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            ) : objects.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">{t('workspace.empty')}</p>
              </div>
            ) : (
              <div className="space-y-1">
                {objects.map(item => {
                  const Icon = getWorkspaceObjectIcon(item.object_type);
                  const name = extractNameFromPath(item.path);
                  const selectable = isSelectable(item);
                  const isSelected = selectedItem?.path === item.path;
                  const isDirectory = item.object_type === 'DIRECTORY';
                  const canOpen = isDirectory || item.object_type === 'REPO';

                  return (
                    <div
                      key={item.path}
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 rounded-md transition-colors',
                        'hover:bg-accent',
                        isSelected && 'bg-accent',
                        !selectable && !isDirectory && 'opacity-50'
                      )}
                    >
                      <button
                        type="button"
                        className="flex-1 flex items-center gap-3 text-left min-w-0"
                        onClick={() => {
                          if (selectable) {
                            setSelectedItem(prev => (prev?.path === item.path ? null : item));
                          }
                        }}
                        onDoubleClick={() => handleItemDoubleClick(item)}
                        disabled={!selectable && !isDirectory}
                      >
                        <Icon
                          className={cn(
                            'h-5 w-5 shrink-0',
                            isDirectory && 'text-amber-500',
                            item.object_type === 'REPO' && 'text-green-500',
                            item.object_type === 'NOTEBOOK' && 'text-blue-500'
                          )}
                        />
                        <span className="font-medium truncate">{name}</span>
                      </button>
                      {canOpen && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() =>
                            handleNavigate(item.path, item.object_type, item.object_id)
                          }
                          aria-label={t('workspace.open')}
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          {/* 現在のフルパス表示 */}
          <div className="px-1 pt-2 border-t flex items-center gap-2">
            <span className="text-sm text-foreground shrink-0">Path:</span>
            <p
              className={cn(
                'text-sm font-mono truncate',
                selectedItem ? 'text-foreground' : 'text-muted-foreground'
              )}
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {selectedItem?.path ?? currentPath}
            </p>
          </div>
        </div>

        <DialogFooter className="sm:justify-stretch sm:space-x-0">
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              {isCreateFormOpen ? (
                <form
                  className="flex max-w-md flex-col gap-2"
                  onSubmit={event => {
                    event.preventDefault();
                    void handleCreateFolder();
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={newFolderName}
                      onChange={event => handleFolderNameChange(event.target.value)}
                      placeholder={t('workspace.folderNamePlaceholder')}
                      aria-label={t('workspace.folderName')}
                      disabled={isCreatingFolder}
                      autoFocus
                      className="h-10 min-w-0"
                    />
                    <Button type="submit" disabled={isCreatingFolder} className="shrink-0">
                      {isCreatingFolder ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          {t('workspace.creatingFolder')}
                        </>
                      ) : (
                        t('workspace.createFolder')
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      disabled={isCreatingFolder}
                      onClick={resetCreateForm}
                      aria-label={t('workspace.cancel')}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  {createError && <p className="text-sm text-destructive">{createError}</p>}
                </form>
              ) : (
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={openCreateForm}
                    disabled={isCreatingFolder}
                  >
                    <FolderPlus className="h-4 w-4 mr-2" />
                    {t('workspace.newFolder')}
                  </Button>
                  {selectError && <p className="text-sm text-destructive sm:ml-2">{selectError}</p>}
                </div>
              )}
              {isCreateFormOpen && selectError && (
                <p className="mt-2 text-sm text-destructive">{selectError}</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('workspace.cancel')}
              </Button>
              <Button onClick={handleSelectCurrentFolder} disabled={isSelecting}>
                {isSelecting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {t('workspace.loading')}
                  </>
                ) : (
                  t('workspace.selectCurrentFolder')
                )}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
