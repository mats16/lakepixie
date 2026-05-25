/**
 * Claude Code ヘルパースクリプトの生成・配置
 *
 * apiKeyHelper / otelHeadersHelper 用のシェルスクリプトを
 * ユーザーの $CLAUDE_CONFIG_DIR に書き出す。
 *
 * apiKeyHelper / otelHeadersHelper は ~/.databrickscfg の Service Principal
 * 認証情報から OAuth トークンを取得する。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATABRICKS_CONFIG_PROFILE } from '../lib/databricks-cli-config.js';
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

const DATABRICKS_SP_TOKEN_HELPER_SCRIPT = `DATABRICKS_CONFIG_FILE="\${DATABRICKS_CONFIG_FILE:-\${HOME}/.databrickscfg}"
DATABRICKS_CONFIG_PROFILE="\${DATABRICKS_CONFIG_PROFILE:-${DATABRICKS_CONFIG_PROFILE}}"

read_databricks_config_value() {
  local target_key="$1"
  awk -F '=' -v profile="\${DATABRICKS_CONFIG_PROFILE}" -v target_key="\${target_key}" '
    function trim(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      return value
    }
    /^[[:space:]]*[#;]/ { next }
    /^[[:space:]]*\\[/ {
      section = $0
      sub(/^[[:space:]]*\\[/, "", section)
      sub(/\\][[:space:]]*$/, "", section)
      in_section = (trim(section) == profile)
      next
    }
    in_section && index($0, "=") {
      key = trim($1)
      value = $0
      sub(/^[^=]*=/, "", value)
      value = trim(value)
      if (key == target_key) {
        print value
        exit
      }
    }
  ' "\${DATABRICKS_CONFIG_FILE}"
}

require_databricks_config_value() {
  local key="$1"
  local value
  if [ ! -f "\${DATABRICKS_CONFIG_FILE}" ]; then
    echo "ERROR: Databricks config file is required at \${DATABRICKS_CONFIG_FILE}" >&2
    return 1
  fi
  if ! value="$(read_databricks_config_value "\${key}")" || [ -z "\${value}" ]; then
    echo "ERROR: Missing \${key} in \${DATABRICKS_CONFIG_PROFILE} profile of \${DATABRICKS_CONFIG_FILE}" >&2
    return 1
  fi
  echo "\${value}"
}

get_databricks_sp_token() {
  local host auth_type client_id client_secret response token
  host="$(require_databricks_config_value "host")"
  auth_type="$(require_databricks_config_value "auth_type")"
  client_id="$(require_databricks_config_value "client_id")"
  client_secret="$(require_databricks_config_value "client_secret")"
  if [ "\${auth_type}" != "oauth-m2m" ]; then
    echo "ERROR: Databricks config profile \${DATABRICKS_CONFIG_PROFILE} must use auth_type = oauth-m2m" >&2
    exit 1
  fi
  host="\${host#https://}"
  host="\${host#http://}"
  response="$(curl -s -X POST "https://\${host}/oidc/v1/token" \\
    -H "Content-Type: application/x-www-form-urlencoded" \\
    --data-urlencode "grant_type=client_credentials" \\
    --data-urlencode "client_id=\${client_id}" \\
    --data-urlencode "client_secret=\${client_secret}" \\
    --data-urlencode "scope=all-apis")"
  token="$(echo "\${response}" | jq -r '.access_token')"
  if [ -z "\${token}" ] || [ "\${token}" = "null" ]; then
    echo "ERROR: Failed to obtain Service Principal access token from \${host}" >&2
    exit 1
  fi
  echo "\${token}"
}
`;

/**
 * Claude Code のモデル呼び出しに使う SP OAuth トークンを返す bash スクリプト本体
 */
export const API_KEY_HELPER_SCRIPT = `#!/bin/bash
set -euo pipefail
${DATABRICKS_SP_TOKEN_HELPER_SCRIPT}
get_databricks_sp_token
`;

/**
 * SP OAuth トークンを取得し、OTel 用の Authorization ヘッダーを JSON で返すスクリプト
 *
 * 出力形式: {"Authorization": "Bearer <token>"}
 */
export const OTEL_HEADERS_HELPER_SCRIPT = `#!/bin/bash
set -euo pipefail
${DATABRICKS_SP_TOKEN_HELPER_SCRIPT}
TOKEN="$(get_databricks_sp_token)"
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
