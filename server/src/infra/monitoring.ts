import * as Sentry from "@sentry/node";

let enabled = false;

/** Crash reporting. Off unless SENTRY_DSN is set. */
export function initMonitoring() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "production",
    release: process.env.RENDER_GIT_COMMIT,
    tracesSampleRate: 0.05,
  });
  enabled = true;
  console.log("Sentry monitoring enabled");
}

export function captureError(err: unknown, context?: Record<string, unknown>) {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export async function flushMonitoring() {
  if (enabled) await Sentry.flush(2000);
}
