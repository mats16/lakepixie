import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { getAuthProvider, type AuthProvider } from './databricks-auth.js';

/**
 * ユーザーコンテキスト
 *
 * リクエストごとのユーザー情報とトークンを管理する。
 * 認証は AuthProvider に委譲し、キャッシュされる。
 */
export class UserContext {
  /** ユーザー ID */
  readonly userId: string;
  /** ユーザー名 (x-forwarded-preferred-username) */
  readonly userName: string;
  /** ユーザーのメールアドレス (x-forwarded-email) */
  readonly userEmail: string;
  /** ユーザーのホームディレクトリ */
  readonly userHome: string;

  /** AuthProvider キャッシュ（リクエストスコープ） */
  private _authProvider: AuthProvider | null = null;

  constructor(
    private readonly fastify: FastifyInstance,
    private readonly request: FastifyRequest
  ) {
    if (!request.ctx?.user) {
      throw new Error('User context is not available');
    }
    const user = request.ctx.user;
    this.userId = user.id;
    this.userName = user.name;
    this.userEmail = user.email;
    this.userHome = path.join(fastify.config.CCBRICKS_BASE_DIR, 'users', user.id.split('@')[0]);
  }

  /**
   * AuthProvider を取得（リクエストスコープでキャッシュ）
   * Service Principal を使用
   */
  getAuthProvider(): AuthProvider {
    if (this._authProvider === null) {
      this._authProvider = getAuthProvider(this.fastify);
    }
    return this._authProvider;
  }

  /**
   * Databricks ワークスペースホスト名を取得（プロトコルなし）
   */
  get databricksHost(): string {
    return this.fastify.config.DATABRICKS_HOST;
  }

  /**
   * OBO トークンを取得（即時）
   * リクエストヘッダーから取得済みなので同期的
   */
  get oboAccessToken(): string | undefined {
    const token = this.request.ctx?.user.oboAccessToken;
    return token && token !== '' ? token : undefined;
  }
}

/**
 * UserContext を作成するファクトリ関数
 */
export function createUserContext(fastify: FastifyInstance, request: FastifyRequest): UserContext {
  return new UserContext(fastify, request);
}
