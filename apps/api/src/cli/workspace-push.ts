#!/usr/bin/env node
/**
 * workspace-push CLI
 *
 * Workspace REST API を使用してローカルディレクトリを Databricks Workspace にアップロードする。
 * セッション用の ~/.databrickscfg から Service Principal トークンを取得する。
 *
 * Usage:
 *   workspace-push [localDir] [workspacePath]
 *   workspace-push --list [workspacePath]
 *
 * Environment:
 *   DATABRICKS_CONFIG_FILE - Databricks config path (default: ~/.databrickscfg)
 *   DATABRICKS_CONFIG_PROFILE - Databricks config profile (default: DEFAULT)
 *   SESSION_WORKSPACE_PATH - デフォルトの Workspace パス
 */

import { fileURLToPath } from 'node:url';
import { getServicePrincipalToken } from '../lib/databricks-auth.js';
import { readServicePrincipalConfig } from '../lib/databricks-cli-config.js';
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

export async function createClient(): Promise<DatabricksWorkspaceClient> {
  const config = readServicePrincipalConfig();
  const token = await getServicePrincipalToken(config.host, config.clientId, config.clientSecret);
  if (!token) {
    throw new Error('Service Principal token is not available');
  }

  return new DatabricksWorkspaceClient(normalizeHost(config.host), token);
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
