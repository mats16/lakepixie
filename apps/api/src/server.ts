import type { FastifyInstance } from 'fastify';
import { build } from './app.js';

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;

function setupGracefulShutdown(app: FastifyInstance): void {
  let isShuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info({ signal }, 'Received shutdown signal');
    const timeout = setTimeout(() => {
      app.log.error({ signal }, 'Graceful shutdown timed out');
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    app
      .close()
      .then(() => {
        clearTimeout(timeout);
        process.exit(0);
      })
      .catch(err => {
        clearTimeout(timeout);
        app.log.error({ err, signal }, 'Graceful shutdown failed');
        process.exit(1);
      });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const start = async () => {
  const app = await build();
  setupGracefulShutdown(app);

  try {
    const isDevelopment = app.config.NODE_ENV === 'development';
    const port = isDevelopment ? app.config.PORT : app.config.DATABRICKS_APP_PORT;

    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
