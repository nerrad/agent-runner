import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  JobArtifactIdSchema,
  JobSummaryArtifactSchema,
  JobSpecSchema,
} from '../shared/types.js';
import type { JobArtifactId, JobRecord, JobSummaryArtifact } from '../shared/types.js';
import type { RuntimeContext } from './runtime.js';

export interface AppContext {
  app: express.Express;
}

export function createApp(runtime: RuntimeContext): AppContext {
  const app = express();

  app.use(express.json());

  app.get('/api/healthz', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/jobs', async (_request, response, next) => {
    try {
      response.json(await runtime.manager.listJobs());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/jobs', async (request, response, next) => {
    try {
      const spec = JobSpecSchema.parse(request.body);
      const record = await runtime.manager.createJob(spec);
      response.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:jobId', async (request, response, next) => {
    try {
      const record = await runtime.manager.getJob(request.params.jobId);
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
      const record = await runtime.manager.cancelJob(request.params.jobId);
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
      const kind = request.query.kind === 'debug' ? 'debug' : 'run';
      const wantsStream = request.query.follow === '1' || request.get('accept')?.includes('text/event-stream');
      if (!wantsStream) {
        const log = await runtime.manager.readLog(request.params.jobId, kind);
        response.type('text/plain').send(log);
        return;
      }

      const record = await runtime.manager.getJob(request.params.jobId);
      if (!record) {
        response.status(404).json({ error: 'Job not found' });
        return;
      }

      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');

      let sentLength = 0;
      const bootstrap = await runtime.manager.readLog(request.params.jobId, kind);
      if (bootstrap) {
        sentLength = bootstrap.length;
        response.write(`data: ${JSON.stringify({ type: 'bootstrap', chunk: bootstrap, start: 0, end: sentLength })}\n\n`);
      }

      const interval = windowedLogFollower(async () => {
        const nextRecord = await runtime.manager.getJob(request.params.jobId);
        if (!nextRecord) {
          response.end();
          return true;
        }

        const content = await runtime.manager.readLog(request.params.jobId, kind);
        if (content.length > sentLength) {
          const start = sentLength;
          const chunk = content.slice(sentLength);
          sentLength = content.length;
          response.write(`data: ${JSON.stringify({ type: 'log', log: { chunk, start, end: sentLength } })}\n\n`);
        }

        if ([ 'blocked', 'completed', 'failed', 'canceled' ].includes(nextRecord.status) && content.length === sentLength) {
          response.end();
          return true;
        }

        return false;
      });

      request.on('close', () => {
        interval();
        response.end();
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:jobId/artifacts/:artifactId', async (request, response, next) => {
    try {
      const record = await runtime.manager.getJob(request.params.jobId);
      if (!record) {
        response.status(404).json({ error: 'Job not found' });
        return;
      }

      const artifactId = JobArtifactIdSchema.parse(request.params.artifactId);
      const descriptor = getArtifactDescriptor(record, artifactId);

      let content = '';
      let available = true;

      try {
        content = await readFile(descriptor.absolutePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          available = false;
        } else {
          throw error;
        }
      }

      let summary: JobSummaryArtifact | undefined;
      if (artifactId === 'summary' && content) {
        summary = JobSummaryArtifactSchema.parse(JSON.parse(content));
      }

      response.json({
        artifactId,
        label: descriptor.label,
        available,
        content,
        summary,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/artifacts', express.static(runtime.config.artifactsDir));

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    response.status(500).json({ error: message });
  });

  return { app };
}

function windowedLogFollower(tick: () => Promise<boolean>): () => void {
  const timer = setInterval(() => {
    void tick().then((done) => {
      if (done) {
        clearInterval(timer);
      }
    });
  }, 500);

  return () => clearInterval(timer);
}

function getArtifactDescriptor(
  record: JobRecord,
  artifactId: JobArtifactId,
): { absolutePath: string; label: string } {
  switch (artifactId) {
    case 'summary':
      return { absolutePath: record.artifacts.summaryPath, label: 'summary' };
    case 'gitDiff':
      return { absolutePath: record.artifacts.gitDiffPath, label: 'git diff' };
    case 'transcript':
      return { absolutePath: record.artifacts.agentTranscriptPath, label: 'transcript' };
  }
}

export async function serveClient(app: express.Express, clientRoot: string): Promise<void> {
  app.use(express.static(clientRoot));
  app.get('*', async (_request, response) => {
    const html = await readFile(path.join(clientRoot, 'index.html'), 'utf8');
    response.type('html').send(html);
  });
}
