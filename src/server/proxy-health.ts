import { Socket } from 'node:net';

/**
 * Probe whether a SOCKS proxy (or any TCP endpoint) is accepting connections.
 *
 * Opens a raw TCP connection to the host:port parsed from `proxyUrl`.
 * If the port accepts the connection, the proxy is considered healthy.
 * No SOCKS handshake is performed — if the port isn't even listening,
 * the proxy is definitely not usable.
 *
 * @returns `true` if the connection succeeds, `false` on error or timeout.
 */
export async function probeProxyHealth(proxyUrl: string, timeoutMs = 2000): Promise<boolean> {
  const { host, port } = parseProxyUrl(proxyUrl);
  if (!host || !port) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect({ port, host, timeout: timeoutMs });
  });
}

function parseProxyUrl(proxyUrl: string): { host: string | null; port: number | null } {
  try {
    // socks5://host:port — URL constructor handles this fine.
    const url = new URL(proxyUrl);
    const host = url.hostname || null;
    const port = url.port ? Number.parseInt(url.port, 10) : null;
    if (port !== null && (Number.isNaN(port) || port <= 0 || port > 65535)) {
      return { host: null, port: null };
    }
    return { host, port };
  } catch {
    return { host: null, port: null };
  }
}
