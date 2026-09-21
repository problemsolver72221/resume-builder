/**
 * Bounds shared by every Chrome render in the app.
 *
 * A render that hangs must fail its build — which is then retried by the passes above it —
 * rather than hold the request until the route deadline and leave a Chrome process behind:
 * `browser.close()` lives in a `finally`, so a launch or a `page.pdf` that never settles
 * never reaches it. The resume render used to carry no bounds at all while the cover letter
 * carried all three, so the two drifted apart; they read the values from here now.
 */
import type { LaunchOptions } from 'puppeteer';

/** Longest one Chrome start-up may take before the render is abandoned. */
export const CHROME_LAUNCH_TIMEOUT_MS = 60_000;
/** Longest any single DevTools call may take; the ceiling for a browser that stops answering. */
export const CHROME_PROTOCOL_TIMEOUT_MS = 180_000;
/** Templates are self-contained, so loading one is fast or it is stuck. */
export const CHROME_SET_CONTENT_TIMEOUT_MS = 60_000;
/** Laying out and printing a page or two; generous, but finite. */
export const CHROME_PDF_TIMEOUT_MS = 120_000;

export const CHROME_LAUNCH_OPTIONS: LaunchOptions = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  timeout: CHROME_LAUNCH_TIMEOUT_MS,
  protocolTimeout: CHROME_PROTOCOL_TIMEOUT_MS,
};
