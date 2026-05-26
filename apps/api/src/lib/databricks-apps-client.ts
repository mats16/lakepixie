/**
 * Databricks Apps API クライアント
 *
 * Databricks Apps の取得、作成、権限更新を行う最小限のクライアントです。
 * AuthProvider を使用して認証します。
 */

import type { AppDeployment, DatabricksApp } from '@repo/types';
import type { AuthProvider } from './databricks-auth.js';
import { normalizeHost } from '../utils/normalize-host.js';

export class DatabricksApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'DatabricksApiError';
  }
}

interface DatabricksAppsTokenProvider {
  host: string;
  getToken(): Promise<string>;
}

interface AppPermissionAssignment {
  service_principal_name?: string;
  user_name?: string;
  group_name?: string;
  permission_level: 'CAN_MANAGE' | 'CAN_USE';
}

interface CreateAppOptions {
  description?: string;
  noCompute?: boolean;
}

function toBaseUrl(host: string): string {
  return `https://${normalizeHost(host)}`;
}

function appPath(appName: string, suffix = ''): string {
  return `/api/2.0/apps/${encodeURIComponent(appName)}${suffix}`;
}

function parseDatabricksApp(data: unknown): DatabricksApp {
  if (
    !data ||
    typeof data !== 'object' ||
    !('name' in data) ||
    typeof (data as Record<string, unknown>).name !== 'string'
  ) {
    throw new DatabricksApiError(
      502,
      "Invalid response from Databricks Apps API: missing 'name' field"
    );
  }
  return data as DatabricksApp;
}

export class DatabricksAppsClient {
  private readonly host: string;
  private readonly getToken: () => Promise<string>;

  constructor(authProvider: AuthProvider | DatabricksAppsTokenProvider) {
    this.host = toBaseUrl(
      'getEnvVars' in authProvider ? authProvider.getEnvVars().DATABRICKS_HOST : authProvider.host
    );
    this.getToken = () => authProvider.getToken();
  }

  static fromToken(host: string, token: string): DatabricksAppsClient {
    return new DatabricksAppsClient({
      host,
      getToken: async () => token,
    });
  }

  /**
   * 認証付きリクエストを送信し、許可されたステータス以外のエラーを throw する
   */
  private async request(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      allowedErrorStatuses?: number[];
      searchParams?: Record<string, string>;
    }
  ): Promise<Response> {
    const token = await this.getToken();
    const url = new URL(path, this.host);
    if (options?.searchParams) {
      for (const [key, value] of Object.entries(options.searchParams)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const allowedErrorStatuses = options?.allowedErrorStatuses ?? [];
    if (!response.ok && !allowedErrorStatuses.includes(response.status)) {
      const errorText = await response.text();
      throw new DatabricksApiError(
        response.status,
        `Databricks API error (${response.status}): ${errorText}`
      );
    }

    return response;
  }

  /**
   * Databricks App の情報を取得
   *
   * @param appName - アプリ名
   * @returns アプリ情報（見つからない場合は null）
   */
  async get(appName: string): Promise<DatabricksApp | null> {
    const response = await this.request('GET', appPath(appName), {
      allowedErrorStatuses: [404],
    });
    if (response.status === 404) return null;
    return parseDatabricksApp(await response.json());
  }

  async create(appName: string, options?: CreateAppOptions): Promise<DatabricksApp> {
    const response = await this.request('POST', '/api/2.0/apps', {
      body: {
        name: appName,
        ...(options?.description ? { description: options.description } : {}),
      },
      ...(options?.noCompute !== undefined
        ? { searchParams: { no_compute: String(options.noCompute) } }
        : {}),
    });
    return parseDatabricksApp(await response.json());
  }

  async start(appName: string): Promise<void> {
    await this.request('POST', appPath(appName, '/start'));
  }

  async deploy(
    appName: string,
    options: { sourceCodePath: string; mode: 'SNAPSHOT' | 'AUTO_SYNC' }
  ): Promise<AppDeployment> {
    const response = await this.request('POST', appPath(appName, '/deployments'), {
      body: {
        source_code_path: options.sourceCodePath,
        mode: options.mode,
      },
    });
    return (await response.json()) as AppDeployment;
  }

  async updatePermissions(
    appName: string,
    accessControlList: AppPermissionAssignment[]
  ): Promise<void> {
    await this.request('PATCH', `/api/2.0/permissions/apps/${encodeURIComponent(appName)}`, {
      body: {
        access_control_list: accessControlList,
      },
    });
  }

  /**
   * Databricks App を削除
   *
   * @param appName - アプリ名
   */
  async delete(appName: string): Promise<void> {
    await this.request('DELETE', appPath(appName));
  }
}
