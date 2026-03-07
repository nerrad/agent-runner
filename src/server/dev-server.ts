import { createServer as createViteServer } from 'vite';
import { loadRuntimeConfig } from './config.js';
import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '4317', 10);

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const { app } = createApp(config);
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom',
  });

  app.use(vite.middlewares);
  app.listen(port, '127.0.0.1', () => {
    process.stdout.write(`agent-runner dev server listening on http://127.0.0.1:${port}\n`);
  });
}

void main();
