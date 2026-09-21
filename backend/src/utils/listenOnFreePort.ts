import type { Server } from 'http';
import type { Application } from 'express';

/**
 * Backends step by two so that several copies of this project settle into the pairs the
 * frontends leave free: 3000/3001, then 3002/3003, then 3004/3005.
 */
export const PORT_STEP = 2;
export const DEFAULT_PORT_ATTEMPTS = 25;

export interface ListenOnFreePortOptions {
  host: string;
  /** First port to try; the search walks upwards from here. */
  port: number;
  step?: number;
  attempts?: number;
}

export interface ListeningServer {
  server: Server;
  port: number;
}

/**
 * Binds the first free port at or above `port`, stepping by `step`.
 *
 * Several copies of this project are meant to run side by side, so the port cannot be a
 * fixed number: the copy that starts second has to move up instead of dying with
 * EADDRINUSE. Binding is what claims a port — probing for a free one and binding it
 * afterwards would let two copies that probe at the same moment choose the same port.
 */
export function listenOnFreePort(
  app: Application,
  options: ListenOnFreePortOptions
): Promise<ListeningServer> {
  const step = options.step ?? PORT_STEP;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_PORT_ATTEMPTS);

  return new Promise<ListeningServer>((resolve, reject) => {
    let port = options.port;
    let attemptsLeft = attempts;

    const attempt = (): void => {
      const server = app.listen(port, options.host);

      const onError = (error: NodeJS.ErrnoException): void => {
        if (error.code !== 'EADDRINUSE' || attemptsLeft <= 1) {
          reject(error);
          return;
        }
        attemptsLeft -= 1;
        port += step;
        server.close();
        setImmediate(attempt);
      };

      server.once('listening', () => {
        // Detached so that errors after start-up surface normally instead of being read as
        // another port collision.
        server.off('error', onError);
        // Read back rather than reported from the request: port 0 means "any free port",
        // and then only the socket knows which one that turned out to be.
        const address = server.address();
        resolve({ server, port: typeof address === 'object' && address ? address.port : port });
      });
      server.on('error', onError);
    };

    attempt();
  });
}
