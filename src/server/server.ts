import path from 'node:path';
import { loadRuntimeConfig } from './config.js';
import { createApp, serveClient } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '4317', 10);

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const { app } = createApp(config);
  await serveClient(app, path.join(config.sourceRoot, 'dist', 'client'));

  app.listen(port, '127.0.0.1', () => {
    process.stdout.write(`agent-runner listening on http://127.0.0.1:${port}\n`);
  });
}

void main();

