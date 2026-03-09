import express from 'express';
import type { RuntimeContext } from './runtime.js';

export function createBrokerApp(runtime: RuntimeContext): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/broker/jobs/:jobId/repo/git-read', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.repoBroker.runGitRead(record, asStringArray(request.body.args, 'args'));
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/repo/gh-read', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.repoBroker.runGhRead(record, asStringArray(request.body.args, 'args'));
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/repo/fetch', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.repoBroker.fetch(record, typeof request.body.remote === 'string' ? request.body.remote : undefined);
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/repo/create-branch', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.repoBroker.createBranch(record, asString(request.body.branchName, 'branchName'));
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/repo/push', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.repoBroker.pushBranch(record, {
        remote: typeof request.body.remote === 'string' ? request.body.remote : undefined,
        branch: typeof request.body.branch === 'string' ? request.body.branch : undefined,
      });
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/repo/open-pr', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.repoBroker.openPr(record, {
        title: asString(request.body.title, 'title'),
        body: typeof request.body.body === 'string' ? request.body.body : undefined,
        base: typeof request.body.base === 'string' ? request.body.base : undefined,
      });
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/repo/comment-pr', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.repoBroker.commentPr(record, {
        pr: asString(request.body.pr, 'pr'),
        body: asString(request.body.body, 'body'),
      });
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/docker/compose/:subcommand', async (request, response, next) => {
    try {
      const subcommand = asComposeCommand(request.params.subcommand);
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.dockerBroker.compose(record, subcommand, asStringArray(request.body.args, 'args'));
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/docker/compose-exec', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.dockerBroker.composeExec(
        record,
        asString(request.body.service, 'service'),
        asStringArray(request.body.command, 'command'),
      );
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/docker/build', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.dockerBroker.imageBuild(record, asStringArray(request.body.args, 'args'));
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/docker/run', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.dockerBroker.containerRun(record, asStringArray(request.body.args, 'args'));
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/docker/stop', async (request, response, next) => {
    try {
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.dockerBroker.containerStop(record, asString(request.body.containerId, 'containerId'));
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/broker/jobs/:jobId/wp-env/:subcommand', async (request, response, next) => {
    try {
      const subcommand = asWpEnvCommand(request.params.subcommand);
      const record = await authorizeBrokerJob(runtime, request.params.jobId, request.body.token);
      const result = await runtime.dockerBroker.wpEnv(record, subcommand, asStringArray(request.body.args, 'args'));
      response.status(result.exitCode === 0 ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Broker error' });
  });

  return app;
}

async function authorizeBrokerJob(runtime: RuntimeContext, jobId: string, token: unknown) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Missing broker token');
  }
  await runtime.brokerLeaseStore.validate(jobId, token);
  const record = await runtime.manager.getJob(jobId);
  if (!record) {
    throw new Error('Job not found');
  }
  if (record.spec.capabilityProfile !== 'repo-broker' && record.spec.capabilityProfile !== 'docker-broker') {
    throw new Error('Broker access is not enabled for this job');
  }
  return record;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid ${label}`);
  }
  return value as string[];
}

function asComposeCommand(value: string): 'up' | 'down' | 'ps' | 'logs' {
  if (value === 'up' || value === 'down' || value === 'ps' || value === 'logs') {
    return value;
  }
  throw new Error(`Unsupported compose command: ${value}`);
}

function asWpEnvCommand(value: string): 'start' | 'stop' | 'run' | 'logs' {
  if (value === 'start' || value === 'stop' || value === 'run' || value === 'logs') {
    return value;
  }
  throw new Error(`Unsupported wp-env command: ${value}`);
}
