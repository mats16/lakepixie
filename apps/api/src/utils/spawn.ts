import { spawn } from 'node:child_process';

export function spawnAsync(
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeoutId = options.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`Command timed out after ${options.timeout}ms`));
        }, options.timeout)
      : null;

    child.on('close', code => {
      if (timeoutId) clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
    });

    child.on('error', error => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
  });
}
