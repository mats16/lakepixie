/**
 * Claude Code ヘルパースクリプトの生成・配置
 *
 * apiKeyHelper / otelHeadersHelper 用のシェルスクリプトを
 * ユーザーの $CLAUDE_CONFIG_DIR に書き出す。
 *
 * apiKeyHelper は Claude Code のモデル呼び出しに使う OBO トークンを返す。
 * otelHeadersHelper は OTel エクスポート用に SP OAuth トークンを取得する。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory } from '../utils/directory.js';

/** ヘルパースクリプトのファイル名 */
export const API_KEY_HELPER_FILENAME = 'generate_temp_api_key.sh';
export const OTEL_HEADERS_HELPER_FILENAME = 'generate_otel_headers.sh';

export interface HelperScriptPaths {
  /** generate_temp_api_key.sh の絶対パス */
  apiKeyHelper: string;
  /** generate_otel_headers.sh の絶対パス */
  otelHeadersHelper: string;
}

/**
 * Claude Code のモデル呼び出しに使う OBO トークンを返す bash スクリプト本体
 *
 * 環境変数 DATABRICKS_TOKEN を使用。
 */
export const API_KEY_HELPER_SCRIPT = `#!/bin/bash
set -euo pipefail
if [ -z "\${DATABRICKS_TOKEN:-}" ]; then
  echo "ERROR: DATABRICKS_TOKEN is not set; OBO token is required for Claude Code model access" >&2
  exit 1
fi
echo "\${DATABRICKS_TOKEN}"
`;

/**
 * SP OAuth トークンを取得し、OTel 用の Authorization ヘッダーを JSON で返すスクリプト
 *
 * 出力形式: {"Authorization": "Bearer <token>"}
 */
export const OTEL_HEADERS_HELPER_SCRIPT = `#!/bin/bash
set -euo pipefail
HOST="\${DATABRICKS_HOST#https://}"
HOST="\${HOST#http://}"
RESPONSE=$(curl -s -X POST "https://\${HOST}/oidc/v1/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials&client_id=\${DATABRICKS_CLIENT_ID}&client_secret=\${DATABRICKS_CLIENT_SECRET}&scope=all-apis")
TOKEN=$(echo "\${RESPONSE}" | jq -r '.access_token')
if [ -z "\${TOKEN}" ] || [ "\${TOKEN}" = "null" ]; then
  echo "ERROR: Failed to obtain access token from \${DATABRICKS_HOST}" >&2
  exit 1
fi
echo "{\\"Authorization\\": \\"Bearer \${TOKEN}\\"}"
`;

/** 書き出し済みの userHome を記憶（プロセスライフタイム中に1回だけ書き出す） */
const provisionedHomes = new Set<string>();

/**
 * ヘルパースクリプトを {userHome}/.claude/ に書き出す
 *
 * 内容は静的なので、同一 userHome に対してはプロセス内で1回だけ書き出す。
 *
 * @returns 各スクリプトの絶対パス
 */
export async function writeHelperScripts(userHome: string): Promise<HelperScriptPaths> {
  const claudeDir = path.join(userHome, '.claude');
  const apiKeyPath = path.join(claudeDir, API_KEY_HELPER_FILENAME);
  const otelHeadersPath = path.join(claudeDir, OTEL_HEADERS_HELPER_FILENAME);

  if (!provisionedHomes.has(userHome)) {
    await ensureDirectory(claudeDir);
    await Promise.all([
      writeFile(apiKeyPath, API_KEY_HELPER_SCRIPT, { encoding: 'utf-8', mode: 0o755 }),
      writeFile(otelHeadersPath, OTEL_HEADERS_HELPER_SCRIPT, { encoding: 'utf-8', mode: 0o755 }),
    ]);
    provisionedHomes.add(userHome);
  }

  return {
    apiKeyHelper: apiKeyPath,
    otelHeadersHelper: otelHeadersPath,
  };
}
