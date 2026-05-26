import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabricksWorkspaceClient } from './databricks-workspace-client.js';
import { DatabricksApiError } from './databricks-apps-client.js';

const TEST_HOST = 'test-workspace.databricks.com';
const TEST_TOKEN = 'test-token-123';

function createMockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('DatabricksWorkspaceClient', () => {
  let client: DatabricksWorkspaceClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new DatabricksWorkspaceClient(TEST_HOST, TEST_TOKEN);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('delete', () => {
    it('成功時にエラーを投げないこと', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

      await expect(client.delete('/test/path', true)).resolves.toBeUndefined();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test-workspace.databricks.com/api/2.0/workspace/delete');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body as string)).toEqual({ path: '/test/path', recursive: true });
      expect((options.headers as Record<string, string>).authorization).toBe(
        `Bearer ${TEST_TOKEN}`
      );
    });

    it('404 を無視すること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(404, { error_code: 'RESOURCE_NOT_FOUND' }));

      await expect(client.delete('/nonexistent', true)).resolves.toBeUndefined();
    });

    it('その他のエラーは throw すること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(500, { message: 'Internal error' }));

      await expect(client.delete('/test', false)).rejects.toThrow(DatabricksApiError);
    });
  });

  describe('mkdirs', () => {
    it('成功時にエラーを投げないこと', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

      await expect(client.mkdirs('/test/dir')).resolves.toBeUndefined();

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test-workspace.databricks.com/api/2.0/workspace/mkdirs');
      expect(JSON.parse(options.body as string)).toEqual({ path: '/test/dir' });
    });

    it('エラー時に throw すること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(403, { message: 'Forbidden' }));

      await expect(client.mkdirs('/test/dir')).rejects.toThrow(DatabricksApiError);
    });
  });

  describe('importFile', () => {
    it('ファイルを base64 エンコードして送信すること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

      const content = Buffer.from('Hello, World!');
      await client.importFile('/test/file.md', content);

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test-workspace.databricks.com/api/2.0/workspace/import');
      const body = JSON.parse(options.body as string);
      expect(body.path).toBe('/test/file.md');
      expect(body.content).toBe(content.toString('base64'));
      expect(body.format).toBe('AUTO');
      expect(body.overwrite).toBe(true);
    });

    it('overwrite を指定できること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

      await client.importFile('/test/file.md', Buffer.from('content'), { overwrite: false });

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.overwrite).toBe(false);
    });

    it('エラー時に throw すること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(400, { message: 'Bad request' }));

      await expect(client.importFile('/test/file.md', Buffer.from('x'))).rejects.toThrow(
        DatabricksApiError
      );
    });

    it('ファイルサイズ制限を超える場合にエラーを投げること', async () => {
      const largeContent = Buffer.alloc(8_000_000); // 8MB > 7.5MB limit

      await expect(client.importFile('/test/large-file.bin', largeContent)).rejects.toThrow(
        'File too large for Workspace import'
      );
    });

    it('ファイルサイズ制限内のファイルは送信できること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

      const content = Buffer.alloc(100); // well within limit
      await expect(client.importFile('/test/ok-file.bin', content)).resolves.toBeUndefined();
    });

    it('型不一致エラー時に削除してリトライすること', async () => {
      // 1回目: 型不一致エラー
      fetchSpy.mockResolvedValueOnce(
        createMockResponse(400, {
          error_code: 'INVALID_PARAMETER_VALUE',
          message:
            'Cannot overwrite the asset at /test/hello.py due to type mismatch (asked: FILE, actual: NOTEBOOK).',
        })
      );
      // 2回目: delete 成功
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));
      // 3回目: リトライ import 成功
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

      await client.importFile('/test/hello.py', Buffer.from('print("hello")'));

      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // delete が呼ばれたことを確認
      const [deleteUrl, deleteOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(deleteUrl).toBe('https://test-workspace.databricks.com/api/2.0/workspace/delete');
      expect(JSON.parse(deleteOptions.body as string)).toEqual({
        path: '/test/hello.py',
        recursive: false,
      });

      // リトライ import が呼ばれたことを確認
      const [retryUrl] = fetchSpy.mock.calls[2] as [string];
      expect(retryUrl).toBe('https://test-workspace.databricks.com/api/2.0/workspace/import');
    });
  });

  describe('list', () => {
    it('オブジェクト一覧を返すこと', async () => {
      const objects = [
        { path: '/test/dir/file1.md', object_type: 'FILE' },
        { path: '/test/dir/subdir', object_type: 'DIRECTORY' },
      ];
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, { objects }));

      const result = await client.list('/test/dir');

      expect(result).toEqual(objects);
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('/api/2.0/workspace/list');
      expect(url).toContain('path=%2Ftest%2Fdir');
    });

    it('空の応答時は空配列を返すこと', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

      const result = await client.list('/empty');

      expect(result).toEqual([]);
    });

    it('404 時は空配列を返すこと', async () => {
      fetchSpy.mockResolvedValueOnce(
        createMockResponse(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' })
      );

      const result = await client.list('/nonexistent');

      expect(result).toEqual([]);
    });

    it('その他のエラーは throw すること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(500, { message: 'error' }));

      await expect(client.list('/test')).rejects.toThrow(DatabricksApiError);
    });
  });

  describe('getStatus', () => {
    it('Workspace object status を返すこと', async () => {
      fetchSpy.mockResolvedValueOnce(
        createMockResponse(200, {
          path: '/Workspace/Users/test/app',
          object_type: 'DIRECTORY',
          object_id: 12345,
        })
      );

      const result = await client.getStatus('/Workspace/Users/test/app');

      expect(result.object_id).toBe(12345);
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('/api/2.0/workspace/get-status');
      expect(url).toContain('path=%2FWorkspace%2FUsers%2Ftest%2Fapp');
    });

    it('object_id 0 を有効な ID として扱うこと', async () => {
      fetchSpy.mockResolvedValueOnce(
        createMockResponse(200, {
          path: '/Workspace/Users/test/root',
          object_type: 'DIRECTORY',
          object_id: 0,
        })
      );

      const result = await client.getStatus('/Workspace/Users/test/root');

      expect(result.object_id).toBe(0);
    });
  });

  describe('updateDirectoryPermissions', () => {
    it('ディレクトリに service principal の CAN_READ 権限を付与すること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, {}));

      await client.updateDirectoryPermissions(12345, [
        {
          service_principal_name: 'sp-client-id',
          permission_level: 'CAN_READ',
        },
      ]);

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://test-workspace.databricks.com/api/2.0/permissions/directories/12345'
      );
      expect(options.method).toBe('PATCH');
      expect(JSON.parse(options.body as string)).toEqual({
        access_control_list: [
          {
            service_principal_name: 'sp-client-id',
            permission_level: 'CAN_READ',
          },
        ],
      });
    });
  });

  describe('exportFile', () => {
    it('base64 デコードした Buffer を返すこと', async () => {
      const originalContent = 'Hello, exported content!';
      const base64Content = Buffer.from(originalContent).toString('base64');
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, { content: base64Content }));

      const result = await client.exportFile('/test/file.md');

      expect(result.toString('utf-8')).toBe(originalContent);
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('/api/2.0/workspace/export');
      expect(url).toContain('path=%2Ftest%2Ffile.md');
      expect(url).toContain('format=AUTO');
    });

    it('エラー時に throw すること', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(404, { message: 'Not found' }));

      await expect(client.exportFile('/nonexistent')).rejects.toThrow(DatabricksApiError);
    });
  });

  describe('importDir', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = join(tmpdir(), `test-import-dir-${randomUUID()}`);
      await mkdir(tempDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('ローカルディレクトリを再帰的にアップロードすること', async () => {
      // テスト用のファイル構成を作成
      await mkdir(join(tempDir, 'subdir'), { recursive: true });
      await writeFile(join(tempDir, 'file1.md'), 'content1');
      await writeFile(join(tempDir, 'subdir', 'file2.md'), 'content2');

      // すべての API 呼び出しを成功させる
      fetchSpy.mockResolvedValue(createMockResponse(200, {}));

      await client.importDir(tempDir, '/workspace/target');

      // mkdirs が呼ばれたことを確認
      const mkdirsCalls = (fetchSpy.mock.calls as [string, RequestInit][]).filter(call =>
        call[0].includes('/workspace/mkdirs')
      );
      expect(mkdirsCalls.length).toBe(2); // ルート + subdir

      // import が呼ばれたことを確認
      const importCalls = (fetchSpy.mock.calls as [string, RequestInit][]).filter(call =>
        call[0].includes('/workspace/import')
      );
      expect(importCalls.length).toBe(2); // file1.md + file2.md
    });

    it('空ディレクトリでは mkdirs のみ呼ぶこと', async () => {
      fetchSpy.mockResolvedValue(createMockResponse(200, {}));

      await client.importDir(tempDir, '/workspace/empty');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('/workspace/mkdirs');
    });
  });

  describe('exportDir', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = join(tmpdir(), `test-export-dir-${randomUUID()}`);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('Workspace からローカルに再帰的にダウンロードすること', async () => {
      const fileContent = 'exported content';
      const base64Content = Buffer.from(fileContent).toString('base64');

      // 1. list: ルートディレクトリ
      fetchSpy.mockResolvedValueOnce(
        createMockResponse(200, {
          objects: [
            { path: '/ws/root/file1.md', object_type: 'FILE' },
            { path: '/ws/root/subdir', object_type: 'DIRECTORY' },
          ],
        })
      );

      // 2. export: file1.md
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, { content: base64Content }));

      // 3. list: subdir
      fetchSpy.mockResolvedValueOnce(
        createMockResponse(200, {
          objects: [{ path: '/ws/root/subdir/file2.md', object_type: 'FILE' }],
        })
      );

      // 4. export: file2.md
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, { content: base64Content }));

      await client.exportDir('/ws/root', tempDir);

      // ファイルが正しく書き込まれたことを確認
      const file1 = await readFile(join(tempDir, 'file1.md'), 'utf-8');
      expect(file1).toBe(fileContent);

      const file2 = await readFile(join(tempDir, 'subdir', 'file2.md'), 'utf-8');
      expect(file2).toBe(fileContent);
    });

    it('空のワークスペースディレクトリではファイルを作成しないこと', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, { objects: [] }));

      await client.exportDir('/ws/empty', tempDir);

      const entries = await readdir(tempDir);
      expect(entries).toEqual([]);
    });

    it('404 のワークスペースパスではファイルを作成しないこと', async () => {
      fetchSpy.mockResolvedValueOnce(createMockResponse(404, {}));

      await client.exportDir('/ws/nonexistent', tempDir);

      const entries = await readdir(tempDir);
      expect(entries).toEqual([]);
    });

    it('NOTEBOOK オブジェクトもダウンロードすること', async () => {
      const notebookContent = '# Databricks notebook source\nprint("hello")';
      const base64Content = Buffer.from(notebookContent).toString('base64');

      // 1. list: NOTEBOOK を含むディレクトリ
      fetchSpy.mockResolvedValueOnce(
        createMockResponse(200, {
          objects: [{ path: '/ws/root/notebook.py', object_type: 'NOTEBOOK' }],
        })
      );

      // 2. export: notebook.py
      fetchSpy.mockResolvedValueOnce(createMockResponse(200, { content: base64Content }));

      await client.exportDir('/ws/root', tempDir);

      const file = await readFile(join(tempDir, 'notebook.py'), 'utf-8');
      expect(file).toBe(notebookContent);
    });

    it('REPO オブジェクトをスキップすること', async () => {
      fetchSpy.mockResolvedValueOnce(
        createMockResponse(200, {
          objects: [{ path: '/ws/root/my-repo', object_type: 'REPO' }],
        })
      );

      await client.exportDir('/ws/root', tempDir);

      // export API が呼ばれていないことを確認
      const exportCalls = (fetchSpy.mock.calls as [string, RequestInit][]).filter(call =>
        call[0].includes('/workspace/export')
      );
      expect(exportCalls).toHaveLength(0);
    });
  });
});
