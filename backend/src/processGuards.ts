/**
 * Last-resort handlers so a long batch run never dies silently.
 *
 * Node's default for an unhandled rejection is to crash the process, and this is Express 4,
 * which does not forward errors from async handlers. Every route body is wrapped in its own
 * try/catch, so anything that reaches here escaped by a path nobody anticipated. The useful
 * response is to say so loudly and keep serving: request state is not shared between calls,
 * and a batch that is hours in is worth more than a theoretically pristine process. If either
 * line shows up in the log, restart the server once the batch has finished.
 */
export type ProcessGuardLogger = (message: string) => void;

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Installs the handlers once; returns a function that removes them again (for tests). */
export function installProcessGuards(log: ProcessGuardLogger = (message) => console.error(message)): () => void {
  const onRejection = (reason: unknown): void => {
    log(`[${new Date().toISOString()}] Unhandled promise rejection — the server keeps running. ${describe(reason)}`);
  };
  const onException = (error: Error): void => {
    log(
      `[${new Date().toISOString()}] Uncaught exception — the server keeps running, but restart it ` +
        `once the current batch finishes. ${describe(error)}`
    );
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}
