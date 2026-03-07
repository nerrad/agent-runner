import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { RuntimeConfig } from './config.js';
import { JobEvents } from './job-events.js';
import { JobStore } from './job-store.js';
import { GitManager } from './git-manager.js';
import { DockerRunner } from './docker-runner.js';
import { AgentAdapters } from './agent-adapters.js';
import { JobManager } from './job-manager.js';
import { JobSpecSchema } from '../shared/types.js';

export interface AppContext {
  app: express.Express;
  manager: JobManager;
  events: JobEvents;
}

export function createApp(config: RuntimeConfig): AppContext {
  const app = express();
  const events = new JobEvents();
  const store = new JobStore(config);
  const git = new GitManager();
  const docker = new DockerRunner(config);
  const adapters = new AgentAdapters();
  const manager = new JobManager(config, store, events, git, docker, adapters);

  app.use(express.json());

  app.get('/api/healthz', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/jobs', async (_request, response, next) => {
    try {
      response.json(await manager.listJobs());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/jobs', async (request, response, next) => {
    try {
      const spec = JobSpecSchema.parse(request.body);
      const record = await manager.createJob(spec);
      response.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:jobId', async (request, response, next) => {
    try {
      const record = await manager.getJob(request.params.jobId);
      if (!record) {
        response.status(404).json({ error: 'Job not found' });
        return;
      }
      response.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/jobs/:jobId/cancel', async (request, response, next) => {
    try {
      const record = await manager.cancelJob(request.params.jobId);
      if (!record) {
        response.status(404).json({ error: 'Job not found' });
        return;
      }
      response.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:jobId/logs', async (request, response, next) => {
    try {
      const wantsStream = request.query.follow === '1' || request.get('accept')?.includes('text/event-stream');
      if (!wantsStream) {
        const log = await manager.readLog(request.params.jobId);
        response.type('text/plain').send(log);
        return;
      }

      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');

      const existing = await manager.readLog(request.params.jobId);
      if (existing) {
        response.write(`data: ${JSON.stringify({ type: 'bootstrap', chunk: existing })}\n\n`);
      }

      const unsubscribe = events.subscribe(request.params.jobId, (event) => {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      request.on('close', () => {
        unsubscribe();
        response.end();
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/artifacts', express.static(config.artifactsDir));

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    response.status(500).json({ error: message });
  });

  return { app, manager, events };
}

export async function serveClient(app: express.Express, clientRoot: string): Promise<void> {
  app.use(express.static(clientRoot));
  app.get('*', async (_request, response) => {
    const html = await readFile(path.join(clientRoot, 'index.html'), 'utf8');
    response.type('html').send(html);
  });
}

