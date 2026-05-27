// apps/api/src/db/schema.ts
// 環境に応じて PostgreSQL or SQLite のスキーマを re-export するバレルモジュール
//
// LAKEBASE_ENDPOINT が設定されている場合は PostgreSQL スキーマ、
// 未設定の場合は SQLite スキーマを使用する。
//
// サービスからの import パス（'../db/schema.js'）は変更不要。

import { loadRootEnv } from '../lib/load-env.js';

loadRootEnv();

const useSqlite = !process.env.LAKEBASE_ENDPOINT?.trim();

// any は意図的: PgTable と SQLiteTable は型互換性がないため union 型にできない。
// 行レベルの型（InsertUser, Session 等）は下の re-export で正しく型付けされている。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod: any = useSqlite ? await import('./schema.sqlite.js') : await import('./schema.pg.js');

export const users = mod.users;
export const userSettings = mod.userSettings;
export const sessions = mod.sessions;
export const sessionEvents = mod.sessionEvents;
export const appSettings = mod.appSettings;
export const mcpServers = mod.mcpServers;
export const githubUserAuthorizations = mod.githubUserAuthorizations;
export const githubOAuthStates = mod.githubOAuthStates;

// 行型は PG スキーマから re-export（canonical types）
export type {
  InsertUser,
  User,
  InsertUserSettings,
  UserSettings,
  InsertSession,
  Session,
  InsertSessionEvent,
  SessionEvent,
  InsertAppSettings,
  AppSettings,
  InsertMcpServer,
  McpServer,
  InsertGithubUserAuthorization,
  InsertGithubOAuthState,
  GithubUserAuthorization,
  GithubOAuthState,
} from './schema.pg.js';
