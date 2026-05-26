import Fastify from 'fastify';
import compress from '@fastify/compress';
import configPlugin from './plugins/config.js';
import databasePlugin from './plugins/database.js';
import websocketPlugin from './plugins/websocket.js';
import requestDecoratorPlugin from './plugins/request-decorator.js';
import staticPlugin from './plugins/static.js';
import healthRoute from './routes/health.js';
import userRoute from './routes/user.js';
import appSettingsRoute from './routes/app-settings.js';
import sessionRoute from './routes/session.js';
import sessionAppRoute from './routes/session-app.js';
import appNameRoute from './routes/app-name.js';
import titleRoute from './routes/title.js';
import workspaceRoute from './routes/workspace.js';
import reposRoute from './routes/repos.js';
import jobsRoute from './routes/jobs.js';
import userSkillsRoute from './routes/user-skills.js';
import userAgentsRoute from './routes/user-agents.js';
import userSettingsRoute from './routes/user-settings.js';
import genieRoute from './routes/genie.js';
import adminRoute from './routes/admin.js';
import modelsRoute from './routes/models.js';
import mcpServersRoute from './routes/mcp-servers.js';
import externalMcpServersRoute from './routes/external-mcp-servers.js';
import gitRepositoriesRoute from './routes/git-repositories.js';
import gitCredentialRoute from './routes/git-credential.js';
import { startEventBatcher } from './services/event-queue.service.js';

export async function build() {
  const app = Fastify({
    logger: true,
  });

  // 設定プラグイン（最初に登録）
  await app.register(configPlugin);

  // データベースプラグイン（configの後、他のプラグインの前）
  await app.register(databasePlugin);

  // イベントバッチャー（databaseの後）
  await startEventBatcher(app);

  // WebSocket プラグイン
  await app.register(websocketPlugin);

  // リクエストデコレータプラグイン
  await app.register(requestDecoratorPlugin);

  // 圧縮プラグイン（brotli, gzip）
  await app.register(compress, {
    encodings: ['br', 'gzip', 'deflate'],
  });

  // ルート登録（静的ファイルより先に）
  await app.register(healthRoute, { prefix: '/api' });
  await app.register(appSettingsRoute, { prefix: '/api' });
  await app.register(userRoute, { prefix: '/api' });
  await app.register(sessionRoute, { prefix: '/api' });
  await app.register(sessionAppRoute, { prefix: '/api' });
  await app.register(appNameRoute, { prefix: '/api' });
  await app.register(titleRoute, { prefix: '/api' });
  await app.register(workspaceRoute, { prefix: '/api/databricks' });
  await app.register(reposRoute, { prefix: '/api/databricks' });
  await app.register(jobsRoute, { prefix: '/api/databricks' });
  await app.register(userSkillsRoute, { prefix: '/api' });
  await app.register(userAgentsRoute, { prefix: '/api' });
  await app.register(userSettingsRoute, { prefix: '/api' });
  await app.register(genieRoute, { prefix: '/api/databricks' });
  await app.register(adminRoute, { prefix: '/api' });
  await app.register(modelsRoute, { prefix: '/api' });
  await app.register(gitRepositoriesRoute, { prefix: '/api' });
  await app.register(gitCredentialRoute, { prefix: '/api' });
  await app.register(externalMcpServersRoute, { prefix: '/api' });
  await app.register(mcpServersRoute, { prefix: '/api/user' });

  // APIルートのキャッシュ制御
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  });

  // 静的ファイル配信（最後に登録）
  await app.register(staticPlugin);

  return app;
}
