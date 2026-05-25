#!/usr/bin/env node
/**
 * workspace-push CLI
 *
 * Workspace REST API を使用してローカルディレクトリを Databricks Workspace にアップロードする。
 * OBO トークンでユーザー権限の Workspace API を呼び出す。
 *
 * Usage:
 *   workspace-push [localDir] [workspacePath]
 *   workspace-push --list [workspacePath]
 *
 * Environment:
 *   DATABRICKS_HOST  - Databricks ホスト (https:// 付きでも可)
 *   DATABRICKS_TOKEN - OBO トークン
 *   SESSION_WORKSPACE_PATH - デフォルトの Workspace パス
 */

import { fileURLToPath } from 'node:url';
import { DatabricksWorkspaceClient } from '../lib/databricks-workspace-client.js';
import { normalizeHost } from '../utils/normalize-host.js';

interface ParsedArgs {
  mode: 'push' | 'list';
  localDir: string;
  workspacePath: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  const listMode = args.includes('--list');
  const positional = args.filter(a => !a.startsWith('--'));

  if (listMode) {
    const workspacePath = positional[0] || process.env.SESSION_WORKSPACE_PATH || '';
    return { mode: 'list', localDir: '.', workspacePath };
  }

  const localDir = positional[0] || '.';
  const workspacePath = positional[1] || process.env.SESSION_WORKSPACE_PATH || '';

  return { mode: 'push', localDir, workspacePath };
}

export function createClient(): DatabricksWorkspaceClient {
  const host = process.env.DATABRICKS_HOST;
  const token = process.env.DATABRICKS_TOKEN;

  if (!host) {
    throw new Error('DATABRICKS_HOST environment variable is not set');
  }
  if (!token) {
    throw new Error('DATABRICKS_TOKEN environment variable is not set');
  }

  return new DatabricksWorkspaceClient(normalizeHost(host), token);
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (!parsed.workspacePath) {
    console.error(
      'Error: workspace path is required. Provide as argument or set SESSION_WORKSPACE_PATH.'
    );
    process.exit(1);
  }

  const client = await createClient();

  if (parsed.mode === 'list') {
    const objects = await client.list(parsed.workspacePath);
    if (objects.length === 0) {
      console.log(`No objects found at ${parsed.workspacePath}`);
    } else {
      for (const obj of objects) {
        console.log(`${obj.object_type.padEnd(10)} ${obj.path}`);
      }
    }
  } else {
    console.log(`Uploading ${parsed.localDir} → ${parsed.workspacePath} ...`);
    await client.importDir(parsed.localDir, parsed.workspacePath);
    console.log('Upload complete.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
