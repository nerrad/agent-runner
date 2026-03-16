import type { Express } from 'express';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { JobRecord } from '../shared/types.js';
import { createBrokerApp } from './broker-app.js';
import type { RuntimeContext } from './runtime.js';

const BROKER_HEALTH_PATH = '/broker/healthz';
const BROKER_READY_ATTEMPTS = 20;
const BROKER_READY_DELAY_MS = 100;

export interface StartedBrokerServer {
  close(): Promise<void>;
  reusedExisting: boolean;
}

export async function runWithBrokerService<T>(
  runtime: RuntimeContext,
  jobId: string,
  task: () => Promise<T>,
): Promise<T> {
  const record = await runtime.manager.getJob(jobId);
  if (!record || !requiresBrokerService(record)) {
    return await task();
  }

  const broker = await ensureBrokerService(runtime);
  try {
    return await task();
  } finally {
    await broker.close();
  }
}

export async function ensureBrokerService(runtime: RuntimeContext): Promise<StartedBrokerServer> {
  if (await isBrokerReachable(runtime.config.brokerPort)) {
    return {
      reusedExisting: true,
      async close() {
        return;
      },
    };
  }

  return await startBrokerServer(runtime);
}

export async function startBrokerServer(runtime: RuntimeContext): Promise<StartedBrokerServer> {
  const app = createBrokerApp(runtime);
  const server = createServer(app as Express);

  try {
    await listenServer(server, runtime.config.brokerPort, '0.0.0.0');
  } catch (error) {
    if (isAddressInUseError(error) && await isBrokerReachable(runtime.config.brokerPort)) {
      return {
        reusedExisting: true,
        async close() {
          return;
        },
      };
    }
    throw error;
  }

  try {
    await waitForBrokerReady(runtime.config.brokerPort);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    throw error;
  }

  return {
    reusedExisting: false,
    async close() {
      await closeServer(server);
    },
  };
}

export async function isBrokerReachable(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    const response = await fetch(`http://127.0.0.1:${port}${BROKER_HEALTH_PATH}`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function requiresBrokerService(_record: JobRecord): boolean {
  return true;
}

async function waitForBrokerReady(port: number): Promise<void> {
  for (let attempt = 0; attempt < BROKER_READY_ATTEMPTS; attempt += 1) {
    if (await isBrokerReachable(port)) {
      return;
    }
    await delay(BROKER_READY_DELAY_MS);
  }

  throw new Error(`Broker service on port ${port} did not become ready`);
}

export function listenServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isAddressInUseError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EADDRINUSE');
}
