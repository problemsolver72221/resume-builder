/**
 * A deadline for the long routes.
 *
 * A build can legitimately take minutes — an AI call retried for up to AI_RETRY_BUDGET_MS,
 * then two PDF renders — but one that never answers used to hold the browser's batch loop
 * forever, seen live as "some process is not finished". Past the deadline the request is
 * answered with a retryable 503, so the loop moves on and tries the build again in a later
 * pass; if the late handler ever finishes, it finds the response already sent and its
 * result is dropped. Files it wrote are found by the skip-existing check on the retry.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const DEADLINE_ENV = 'BUILD_DEADLINE_MS';
export const DEFAULT_DEADLINE_MS = 30 * 60_000;

/** BUILD_DEADLINE_MS when it is a non-negative number (0 disables), otherwise 30 minutes. */
export function readDeadlineMs(raw: string | undefined = process.env[DEADLINE_ENV]): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_DEADLINE_MS;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DEADLINE_MS;
}

export function requestDeadline(deadlineMs: number = readDeadlineMs()): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (deadlineMs <= 0) {
      next();
      return;
    }
    const minutes = Math.max(1, Math.round(deadlineMs / 60_000));
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      res.status(503).json({
        error: `The backend did not finish this request within ${minutes} minute(s); the build is abandoned here and tried again later`,
        retryable: true,
        retryLater: false,
      });
    }, deadlineMs);
    timer.unref?.();
    // The handler keeps running after the deadline answer; its own res.json must become a
    // no-op instead of throwing "headers already sent" into an async route Express 4 cannot catch.
    const sendJson = res.json.bind(res);
    res.json = ((body?: unknown) => (res.headersSent ? res : sendJson(body))) as Response['json'];
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
}
