import { createServer as createViteServer } from 'vite';
import type { Server } from 'node:http';
import { ensureBrokerService } from './broker-service.js';
import { loadRuntimeConfig } from './config.js';
import { createApp } from './app.js';
import { listenOnAvailablePort } from './listen.js';
import { createRuntime } from './runtime.js';

const port = Number.parseInt(process.env.PORT ?? '4317', 10);

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const runtime = createRuntime(config);
  const { app } = createApp(runtime);
  const broker = await ensureBrokerService(runtime);
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom',
  });

  app.use(vite.middlewares);
  let appServer: Server | undefined;
  try {
    const listening = await listenOnAvailablePort(app, port);
    appServer = listening.server;
    process.stdout.write(`agent-runner dev server listening on http://127.0.0.1:${listening.port}\n`);
    process.stdout.write(`agent-runner broker listening on ${config.brokerUrl}${broker.reusedExisting ? ' (reused existing)' : ''}\n`);
  } catch (error) {
    runtime.sleepGuard.dispose();
    await broker.close().catch(() => undefined);
    await vite.close().catch(() => undefined);
    appServer?.close();
    throw error;
  }

  const shutdown = async () => {
    runtime.sleepGuard.dispose();
    await broker.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      appServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }).catch(() => undefined);
    await vite.close().catch(() => undefined);
  };

  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

void main();
