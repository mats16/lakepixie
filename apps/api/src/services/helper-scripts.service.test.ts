import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { API_KEY_HELPER_SCRIPT } from './helper-scripts.service.js';

const execFileAsync = promisify(execFile);

async function runApiKeyHelper(
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccbricks-api-key-helper-'));
  const scriptPath = path.join(dir, 'generate_temp_api_key.sh');

  try {
    await writeFile(scriptPath, API_KEY_HELPER_SCRIPT, { encoding: 'utf-8' });
    await chmod(scriptPath, 0o755);
    return await execFileAsync(scriptPath, {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        ...env,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('API_KEY_HELPER_SCRIPT', () => {
  it('returns the OBO token from DATABRICKS_TOKEN', async () => {
    await expect(runApiKeyHelper({ DATABRICKS_TOKEN: 'obo-token-123' })).resolves.toMatchObject({
      stdout: 'obo-token-123\n',
      stderr: '',
    });
  });

  it('fails when the OBO token is unavailable', async () => {
    await expect(runApiKeyHelper({})).rejects.toMatchObject({
      stderr: expect.stringContaining('OBO token is required for Claude Code model access'),
    });
  });
});
