import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import express from 'express';
import { listenOnAvailablePort } from '../server/listen.js';

function reserveLocalPort(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve local port'));
        return;
      }

      resolve({
        port: address.port,
        close: async () => {
          await new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          });
        },
      });
    });
  });
}

test('listenOnAvailablePort falls back when the preferred port is already in use', async () => {
  const reserved = await reserveLocalPort();
  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const listening = await listenOnAvailablePort(app, reserved.port);

  try {
    assert.notEqual(listening.port, reserved.port);

    const response = await fetch(`http://127.0.0.1:${listening.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await reserved.close();
    await new Promise<void>((resolve, reject) => {
      listening.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
