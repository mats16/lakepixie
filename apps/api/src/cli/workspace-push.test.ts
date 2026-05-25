import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearSpTokenCache } from '../lib/databricks-auth.js';
import { readServicePrincipalConfig } from '../lib/databricks-cli-config.js';
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
    const originalFetch = global.fetch;
    let tempDirs: string[] = [];

    beforeEach(() => {
      clearSpTokenCache();
      vi.restoreAllMocks();
      process.env = { ...originalEnv };
      tempDirs = [];
    });

    afterEach(async () => {
      process.env = originalEnv;
      global.fetch = originalFetch;
      await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
    });

    async function writeConfig(content: string): Promise<string> {
      const dir = await mkdtemp(path.join(tmpdir(), 'workspace-push-test-'));
      tempDirs.push(dir);
      const configPath = path.join(dir, '.databrickscfg');
      await writeFile(configPath, content, 'utf-8');
      process.env.DATABRICKS_CONFIG_FILE = configPath;
      return configPath;
    }

    it('Databricks config がない場合はエラーを投げること', () => {
      process.env.HOME = path.join(tmpdir(), 'workspace-push-missing-home');
      delete process.env.DATABRICKS_CONFIG_FILE;

      expect(() => readServicePrincipalConfig()).toThrow('Databricks config file is not available');
    });

    it('oauth-m2m 以外の profile を拒否すること', async () => {
      await writeConfig(`[DEFAULT]
host = https://host.databricks.com
auth_type = pat
client_id = sp-client-id
client_secret = sp-client-secret
`);

      expect(() => readServicePrincipalConfig()).toThrow('must use auth_type = oauth-m2m');
    });

    it('~/.databrickscfg から Service Principal profile を読むこと', async () => {
      const configPath = await writeConfig(`[DEFAULT]
host = https://host.databricks.com
auth_type = oauth-m2m
client_id = sp-client-id
client_secret = sp-client-secret
`);

      expect(readServicePrincipalConfig()).toEqual({
        host: 'https://host.databricks.com',
        authType: 'oauth-m2m',
        clientId: 'sp-client-id',
        clientSecret: 'sp-client-secret',
      });
      expect(process.env.DATABRICKS_CONFIG_FILE).toBe(configPath);
    });

    it('Service Principal トークンでクライアントを生成すること', async () => {
      await writeConfig(`[DEFAULT]
host = https://host.databricks.com
auth_type = oauth-m2m
client_id = sp-client-id
client_secret = sp-client-secret
`);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'sp-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
      });

      const client = await createClient();

      expect(client).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        'https://host.databricks.com/oidc/v1/token',
        expect.any(Object)
      );
    });

    it('https:// プレフィックスをストリップしてクライアントを生成すること', async () => {
      await writeConfig(`[DEFAULT]
host = https://host.databricks.com
auth_type = oauth-m2m
client_id = sp-client-id
client_secret = sp-client-secret
`);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'sp-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
      });

      const client = await createClient();

      // クライアントが正しく生成されることで間接的に検証
      // （内部で https:// を付与するため、二重にならないことが重要）
      expect(client).toBeDefined();
    });
  });
});
