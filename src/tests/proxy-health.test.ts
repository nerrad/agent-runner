import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { probeProxyHealth } from '../server/proxy-health.js';

function listenOnRandomPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected address'));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

test('probeProxyHealth returns true when the port is accepting connections', async () => {
  const { server, port } = await listenOnRandomPort();
  try {
    const result = await probeProxyHealth(`socks5://127.0.0.1:${port}`);
    assert.equal(result, true);
  } finally {
    server.close();
  }
});

test('probeProxyHealth returns false when nothing is listening', async () => {
  // Grab a random port, close the server, then immediately probe it.
  const { server, port } = await listenOnRandomPort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const result = await probeProxyHealth(`socks5://127.0.0.1:${port}`, 500);
  assert.equal(result, false);
});

test('probeProxyHealth returns false on timeout', async () => {
  // 10.255.255.1 is a non-routable address — connect will hang.
  // If this flakes in CI (e.g. an immediate EHOSTUNREACH), the timeout path
  // is also implicitly covered by the "nothing listening" test above.
  const result = await probeProxyHealth('socks5://10.255.255.1:8080', 200);
  assert.equal(result, false);
});

test('probeProxyHealth returns false for invalid URLs', async () => {
  assert.equal(await probeProxyHealth('not-a-url'), false);
  assert.equal(await probeProxyHealth(''), false);
  assert.equal(await probeProxyHealth('socks5://host-without-port'), false);
});

test('probeProxyHealth returns false for out-of-range port', async () => {
  assert.equal(await probeProxyHealth('socks5://127.0.0.1:99999'), false);
});

test('probeProxyHealth returns false after server stops', async () => {
  const { server, port } = await listenOnRandomPort();

  const ok = await probeProxyHealth(`socks5://127.0.0.1:${port}`);
  assert.equal(ok, true);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const dead = await probeProxyHealth(`socks5://127.0.0.1:${port}`, 500);
  assert.equal(dead, false);
});
