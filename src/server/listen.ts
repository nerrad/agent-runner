import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface ListeningServer {
  server: Server;
  port: number;
}

export async function listenOnAvailablePort(
  app: Express,
  preferredPort: number,
  host = '127.0.0.1',
): Promise<ListeningServer> {
  try {
    return await listen(app, preferredPort, host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') {
      throw error;
    }

    return await listen(app, 0, host);
  }
}

function listen(app: Express, port: number, host: string): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to determine bound port'));
        return;
      }

      resolve({
        server,
        port: (address as AddressInfo).port,
      });
    });

    server.once('error', reject);
  });
}
