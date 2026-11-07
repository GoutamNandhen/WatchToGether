/**
 * Crash reporting. Off unless VITE_SENTRY_DSN is set at build time, and the SDK is only
 * downloaded when it is, so visitors pay nothing otherwise.
 */
export function initMonitoring() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  void import("@sentry/react").then((Sentry) => {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      release: import.meta.env.VITE_RELEASE as string | undefined,
      tracesSampleRate: 0.1,
      ignoreErrors: ["ResizeObserver loop", "AbortError", "NotAllowedError"],
    });
  });
}
