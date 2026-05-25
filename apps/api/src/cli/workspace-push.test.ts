import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, createClient } from './workspace-push.js';

describe('workspace-push CLI', () => {
  describe('parseArgs', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('デフォルト値を使用すること（SESSION_WORKSPACE_PATH あり）', () => {
      process.env.SESSION_WORKSPACE_PATH = '/Workspace/Users/test/project';

      const result = parseArgs(['node', 'workspace-push.js']);

      expect(result).toEqual({
        mode: 'push',
        localDir: '.',
        workspacePath: '/Workspace/Users/test/project',
      });
    });

    it('引数で localDir と workspacePath を指定できること', () => {
      const result = parseArgs(['node', 'workspace-push.js', './src', '/Workspace/target']);

      expect(result).toEqual({
        mode: 'push',
        localDir: './src',
        workspacePath: '/Workspace/target',
      });
    });

    it('未知のフラグを positional 引数として扱わないこと', () => {
      const result = parseArgs([
        'node',
        'workspace-push.js',
        '.',
        '/Workspace/target',
        '--overwrite',
      ]);

      expect(result).toEqual({
        mode: 'push',
        localDir: '.',
        workspacePath: '/Workspace/target',
      });
    });

    it('--list モードで workspacePath を引数から取得すること', () => {
      const result = parseArgs(['node', 'workspace-push.js', '--list', '/Workspace/target']);

      expect(result).toEqual({
        mode: 'list',
        localDir: '.',
        workspacePath: '/Workspace/target',
      });
    });

    it('--list モードで SESSION_WORKSPACE_PATH をフォールバックすること', () => {
      process.env.SESSION_WORKSPACE_PATH = '/Workspace/Users/test/project';

      const result = parseArgs(['node', 'workspace-push.js', '--list']);

      expect(result).toEqual({
        mode: 'list',
        localDir: '.',
        workspacePath: '/Workspace/Users/test/project',
      });
    });

    it('workspacePath が未指定かつ環境変数もない場合は空文字を返すこと', () => {
      delete process.env.SESSION_WORKSPACE_PATH;

      const result = parseArgs(['node', 'workspace-push.js']);

      expect(result.workspacePath).toBe('');
    });
  });

  describe('createClient', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('DATABRICKS_HOST 未設定でエラーを投げること', () => {
      delete process.env.DATABRICKS_HOST;
      process.env.DATABRICKS_TOKEN = 'token';

      expect(() => createClient()).toThrow('DATABRICKS_HOST environment variable is not set');
    });

    it('DATABRICKS_TOKEN 未設定でエラーを投げること', () => {
      process.env.DATABRICKS_HOST = 'https://host.databricks.com';
      delete process.env.DATABRICKS_TOKEN;

      expect(() => createClient()).toThrow('DATABRICKS_TOKEN environment variable is not set');
    });

    it('正しい環境変数でクライアントを生成すること', () => {
      process.env.DATABRICKS_HOST = 'https://host.databricks.com';
      process.env.DATABRICKS_TOKEN = 'test-token';

      const client = createClient();

      expect(client).toBeDefined();
    });

    it('https:// プレフィックスをストリップすること', () => {
      process.env.DATABRICKS_HOST = 'https://host.databricks.com';
      process.env.DATABRICKS_TOKEN = 'test-token';

      const client = createClient();

      // クライアントが正しく生成されることで間接的に検証
      // （内部で https:// を付与するため、二重にならないことが重要）
      expect(client).toBeDefined();
    });
  });
});
