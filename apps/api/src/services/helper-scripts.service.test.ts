import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  buildDatabricksConfigContent,
  getDatabricksConfigPath,
  writeDatabricksConfig,
} from '../lib/databricks-cli-config.js';
import { API_KEY_HELPER_SCRIPT } from './helper-scripts.service.js';

const execFileAsync = promisify(execFile);

async function runApiKeyHelper(
  setup?: (dir: string) => Promise<NodeJS.ProcessEnv | void>,
  env: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccbricks-api-key-helper-'));
  const scriptPath = path.join(dir, 'generate_temp_api_key.sh');

  try {
    await writeFile(scriptPath, API_KEY_HELPER_SCRIPT, { encoding: 'utf-8' });
    await chmod(scriptPath, 0o755);
    const setupEnv = (await setup?.(dir)) ?? {};
    return await execFileAsync(scriptPath, {
      encoding: 'utf8',
      env: {
        HOME: dir,
        PATH: process.env.PATH,
        ...setupEnv,
        ...env,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFakeTokenCommands(dir: string): Promise<string> {
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir);
  const curlPath = path.join(binDir, 'curl');
  const jqPath = path.join(binDir, 'jq');

  await writeFile(
    curlPath,
    `#!/bin/sh
case "$*" in
  *"https://example.databricks.com/oidc/v1/token"* )
    printf '{"access_token":"sp-token-123"}'
    ;;
  * )
    echo "unexpected curl args: $*" >&2
    exit 2
    ;;
esac
`,
    { encoding: 'utf-8' }
  );
  await writeFile(
    jqPath,
    `#!/bin/sh
cat >/dev/null
printf 'sp-token-123\\n'
`,
    { encoding: 'utf-8' }
  );
  await chmod(curlPath, 0o755);
  await chmod(jqPath, 0o755);

  return binDir;
}

async function writeDatabricksConfigFixture(dir: string): Promise<void> {
  await writeFile(
    path.join(dir, '.databrickscfg'),
    buildDatabricksConfigContent({
      host: 'example.databricks.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }),
    { encoding: 'utf-8' }
  );
}

async function writeFailingAwkCommand(dir: string): Promise<string> {
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir);
  const awkPath = path.join(binDir, 'awk');

  await writeFile(
    awkPath,
    `#!/bin/sh
exit 1
`,
    { encoding: 'utf-8' }
  );
  await chmod(awkPath, 0o755);

  return binDir;
}

describe('buildDatabricksConfigContent', () => {
  it('creates a DEFAULT oauth-m2m profile with normalized host', () => {
    expect(
      buildDatabricksConfigContent({
        host: 'https://example.databricks.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      })
    ).toBe(`[DEFAULT]
host = https://example.databricks.com
auth_type = oauth-m2m
client_id = client-id
client_secret = client-secret
`);
  });

  it('rejects multi-line values', () => {
    expect(() =>
      buildDatabricksConfigContent({
        host: 'example.databricks.com',
        clientId: 'client-id',
        clientSecret: 'client-secret\ninjected = value',
      })
    ).toThrow('DATABRICKS_CLIENT_SECRET must be a single line');
  });
});

describe('writeDatabricksConfig', () => {
  it('writes ~/.databrickscfg with restricted permissions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ccbricks-databrickscfg-'));

    try {
      const configPath = await writeDatabricksConfig(dir, {
        host: 'example.databricks.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      });

      expect(configPath).toBe(path.join(dir, '.databrickscfg'));
      await expect(readFile(configPath, 'utf-8')).resolves.toContain('auth_type = oauth-m2m');
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('getDatabricksConfigPath', () => {
  it('falls back to the OS home directory when HOME is empty', () => {
    expect(getDatabricksConfigPath({ HOME: '' })).not.toBe('.databrickscfg');
  });
});

describe('API_KEY_HELPER_SCRIPT', () => {
  it('exits when config value command substitutions fail', async () => {
    await expect(
      runApiKeyHelper(async dir => {
        const binDir = await writeFailingAwkCommand(dir);
        await writeDatabricksConfigFixture(dir);
        return { PATH: `${binDir}:${process.env.PATH ?? ''}` };
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Missing host in DEFAULT profile'),
    });
  });

  it('returns a Service Principal token from ~/.databrickscfg', async () => {
    await expect(
      runApiKeyHelper(async dir => {
        const binDir = await writeFakeTokenCommands(dir);
        await writeDatabricksConfigFixture(dir);
        return { PATH: `${binDir}:${process.env.PATH ?? ''}` };
      })
    ).resolves.toMatchObject({
      stdout: 'sp-token-123\n',
      stderr: '',
    });
  });

  it('fails when the Databricks config is unavailable', async () => {
    await expect(
      runApiKeyHelper(async dir => {
        const binDir = await writeFakeTokenCommands(dir);
        return { PATH: `${binDir}:${process.env.PATH ?? ''}` };
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Databricks config file is required'),
    });
  });
});
