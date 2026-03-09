import path from 'node:path';
import { createBrokerApp } from './broker-app.js';
import { loadRuntimeConfig } from './config.js';
import { createApp, serveClient } from './app.js';
import { createRuntime } from './runtime.js';

const port = Number.parseInt(process.env.PORT ?? '4317', 10);

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const runtime = createRuntime(config);
  const { app } = createApp(runtime);
  const brokerApp = createBrokerApp(runtime);
  await serveClient(app, path.join(config.sourceRoot, 'dist', 'client'));

  app.listen(port, '127.0.0.1', () => {
    process.stdout.write(`agent-runner listening on http://127.0.0.1:${port}\n`);
  });
  brokerApp.listen(config.brokerPort, '0.0.0.0', () => {
    process.stdout.write(`agent-runner broker listening on ${config.brokerUrl}\n`);
  });
}

void main();
