import { createServer as createViteServer } from 'vite';
import { createBrokerApp } from './broker-app.js';
import { loadRuntimeConfig } from './config.js';
import { createApp } from './app.js';
import { createRuntime } from './runtime.js';

const port = Number.parseInt(process.env.PORT ?? '4317', 10);

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const runtime = createRuntime(config);
  const { app } = createApp(runtime);
  const brokerApp = createBrokerApp(runtime);
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom',
  });

  app.use(vite.middlewares);
  app.listen(port, '127.0.0.1', () => {
    process.stdout.write(`agent-runner dev server listening on http://127.0.0.1:${port}\n`);
  });
  brokerApp.listen(config.brokerPort, '0.0.0.0', () => {
    process.stdout.write(`agent-runner broker listening on ${config.brokerUrl}\n`);
  });
}

void main();
