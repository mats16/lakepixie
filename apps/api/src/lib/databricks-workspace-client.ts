/**
 * Databricks Workspace REST API クライアント
 *
 * Bearer トークンを使用して Workspace API を直接呼び出す。
 * CLI の export-dir / import-dir 相当の機能を提供する。
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { DatabricksApiError } from './databricks-apps-client.js';
import { ensureDirectory } from '../utils/directory.js';

interface WorkspaceObject {
  path: string;
  object_type: 'DIRECTORY' | 'FILE' | 'NOTEBOOK' | 'LIBRARY' | 'REPO' | 'DASHBOARD';
  object_id?: number;
  language?: string;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_CONCURRENCY = 10;
/** Workspace import API の payload 上限 (~10MB) を考慮した raw ファイルサイズ上限。base64 で ~33% 膨張するため ~7.5MB */
const MAX_IMPORT_FILE_SIZE = 7_500_000;

/**
 * インスタンス横断でリクエスト同時実行数を制限するセマフォ。
 * importDir/exportDir の再帰で同時実行数が無制限に膨らむのを防ぐ。
 */
class Semaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.running--;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class DatabricksWorkspaceClient {
  private readonly baseUrl: string;
  private readonly semaphore = new Semaphore(MAX_CONCURRENCY);

  constructor(
    host: string,
    private readonly token: string
  ) {
    this.baseUrl = `https://${host}`;
  }

  /**
   * 認証付き JSON リクエストを送信（429 は指数バックオフでリトライ）
   */
  private async request(
    method: string,
    path: string,
    options?: { body?: unknown; searchParams?: Record<string, string> }
  ): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    if (options?.searchParams) {
      for (const [key, value] of Object.entries(options.searchParams)) {
        url.searchParams.set(key, value);
      }
    }

    const requestInit: RequestInit = {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url.toString(), requestInit);

      if (response.status !== 429 || attempt === MAX_RETRIES) {
        return response;
      }

      const retryAfterSec = parseInt(response.headers.get('retry-after') ?? '', 10);
      const waitMs = !isNaN(retryAfterSec)
        ? retryAfterSec * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);

      // レスポンスボディを消費してコネクションを解放
      await response.text();
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    // ここには到達しないが TypeScript の型推論のため
    throw new Error('Unreachable');
  }

  /**
   * 非 OK レスポンスを DatabricksApiError として throw する
   */
  private async throwIfNotOk(response: Response, operation: string): Promise<void> {
    if (!response.ok) {
      const errorText = await response.text();
      throw new DatabricksApiError(
        response.status,
        `Workspace ${operation} failed (${response.status}): ${errorText}`
      );
    }
  }

  /**
   * Workspace パスを削除
   * 404 は無視する（既に存在しないケース）
   */
  async delete(path: string, recursive: boolean): Promise<void> {
    const response = await this.request('POST', '/api/2.0/workspace/delete', {
      body: { path, recursive },
    });
    if (response.status === 404) {
      // レスポンスボディを消費してコネクションを解放
      await response.text();
      return;
    }
    await this.throwIfNotOk(response, 'delete');
  }

  async mkdirs(path: string): Promise<void> {
    const response = await this.request('POST', '/api/2.0/workspace/mkdirs', {
      body: { path },
    });
    await this.throwIfNotOk(response, 'mkdirs');
  }

  async importFile(
    path: string,
    content: Buffer,
    options?: { overwrite?: boolean }
  ): Promise<void> {
    if (content.length > MAX_IMPORT_FILE_SIZE) {
      throw new DatabricksApiError(
        413,
        `File too large for Workspace import: ${(content.length / 1_000_000).toFixed(1)}MB exceeds the ~${(MAX_IMPORT_FILE_SIZE / 1_000_000).toFixed(1)}MB limit (path: ${path})`
      );
    }

    const body = {
      path,
      content: content.toString('base64'),
      format: 'AUTO',
      overwrite: options?.overwrite ?? true,
    };

    const response = await this.request('POST', '/api/2.0/workspace/import', { body });

    if (response.ok) return;

    const errorText = await response.text();

    // 型不一致 (FILE vs NOTEBOOK) の場合は削除してリトライ
    if (response.status === 400 && errorText.includes('type mismatch')) {
      await this.delete(path, false);
      const retry = await this.request('POST', '/api/2.0/workspace/import', { body });
      await this.throwIfNotOk(retry, 'import');
      return;
    }

    throw new DatabricksApiError(
      response.status,
      `Workspace import failed (${response.status}): ${errorText}`
    );
  }

  /**
   * Workspace ディレクトリの内容を一覧取得
   * 404 の場合は空配列を返す
   */
  async list(path: string): Promise<WorkspaceObject[]> {
    const response = await this.request('GET', '/api/2.0/workspace/list', {
      searchParams: { path },
    });
    if (response.status === 404) {
      // レスポンスボディを消費してコネクションを解放
      await response.text();
      return [];
    }
    await this.throwIfNotOk(response, 'list');

    const data = (await response.json()) as { objects?: WorkspaceObject[] };
    return data.objects ?? [];
  }

  async exportFile(path: string): Promise<Buffer> {
    const response = await this.request('GET', '/api/2.0/workspace/export', {
      searchParams: { path, format: 'AUTO' },
    });
    await this.throwIfNotOk(response, 'export');

    const data = (await response.json()) as { content: string };
    return Buffer.from(data.content, 'base64');
  }

  /**
   * ローカルディレクトリを Workspace に再帰的にアップロード
   * セマフォで全再帰レベルの合計同時実行数を制限する
   */
  async importDir(localPath: string, workspacePath: string): Promise<void> {
    await this.semaphore.run(() => this.mkdirs(workspacePath));

    const entries = await readdir(localPath, { withFileTypes: true });

    await Promise.all(
      entries.map(async entry => {
        const localEntryPath = join(localPath, entry.name);
        const workspaceEntryPath = `${workspacePath}/${entry.name}`;

        if (entry.isDirectory()) {
          await this.importDir(localEntryPath, workspaceEntryPath);
        } else if (entry.isFile()) {
          await this.semaphore.run(async () => {
            const content = await readFile(localEntryPath);
            await this.importFile(workspaceEntryPath, content, { overwrite: true });
          });
        }
      })
    );
  }

  /**
   * Workspace からローカルディレクトリに再帰的にダウンロード
   * セマフォで全再帰レベルの合計同時実行数を制限する
   */
  async exportDir(workspacePath: string, localPath: string): Promise<void> {
    await ensureDirectory(localPath);

    const objects = await this.semaphore.run(() => this.list(workspacePath));

    await Promise.all(
      objects.map(async obj => {
        const localEntryPath = join(localPath, basename(obj.path));

        if (obj.object_type === 'DIRECTORY') {
          await this.exportDir(obj.path, localEntryPath);
        } else if (obj.object_type === 'REPO') {
          // REPO はエクスポート不可のためスキップ
        } else {
          // FILE, NOTEBOOK, LIBRARY, DASHBOARD などをエクスポート
          await this.semaphore.run(async () => {
            const content = await this.exportFile(obj.path);
            await writeFile(localEntryPath, content);
          });
        }
      })
    );
  }
}
