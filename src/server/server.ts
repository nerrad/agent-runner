import path from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { ensureBrokerService, listenServer } from './broker-service.js';
import { loadRuntimeConfig } from './config.js';
import { createApp, serveClient } from './app.js';
import { createRuntime } from './runtime.js';

const port = Number.parseInt(process.env.PORT ?? '4317', 10);

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const runtime = createRuntime(config);
  const { app } = createApp(runtime);
  await serveClient(app, path.join(config.sourceRoot, 'dist', 'client'));
  const broker = await ensureBrokerService(runtime);

  const appServer: Server = createServer(app);
  try {
    await listenServer(appServer, port, '127.0.0.1');
    process.stdout.write(`agent-runner listening on http://127.0.0.1:${port}\n`);
    process.stdout.write(`agent-runner broker listening on ${config.brokerUrl}${broker.reusedExisting ? ' (reused existing)' : ''}\n`);
  } catch (error) {
    await broker.close().catch(() => undefined);
    appServer.close();
    throw error;
  }

  const shutdown = async () => {
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
  };

  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

void main();
