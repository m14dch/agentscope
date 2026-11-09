import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local HTTP proxy that refuses every connection and records its target.
 * The browser sends all non-localhost traffic through it, so even requests
 * Playwright cannot observe (for example beacons sent while a page unloads)
 * are blocked and counted.
 */
export class EgressProxy {
  readonly attempts: string[] = [];
  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
    server.on('request', (req, res) => {
      this.attempts.push(req.url ?? '');
      res.writeHead(403).end();
    });
    server.on('connect', (req, socket) => {
      this.attempts.push(req.url ?? '');
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
  }

  static async start(): Promise<EgressProxy> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return new EgressProxy(server);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
