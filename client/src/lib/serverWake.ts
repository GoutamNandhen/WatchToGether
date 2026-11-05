import { useEffect, useState } from "react";
import { API_BASE } from "./api";

/**
 * The API runs on a host that sleeps when idle, so the first request can take ~30s.
 * Ping /health as early as possible (landing, login, signup) so it is awake by the time
 * the user acts, and expose a "waking" flag so pages can say so instead of looking broken.
 */
let wakePromise: Promise<void> | null = null;
let awake = false;
const listeners = new Set<(waking: boolean) => void>();

export function wakeServer(): Promise<void> {
  if (awake) return Promise.resolve();
  if (wakePromise) return wakePromise;
  const slowTimer = setTimeout(() => listeners.forEach((l) => l(true)), 2500);
  wakePromise = fetch(`${API_BASE}/health`, { cache: "no-store" })
    .then(() => {
      awake = true;
    })
    .catch(() => {
      /* network errors surface on the real request */
    })
    .finally(() => {
      clearTimeout(slowTimer);
      wakePromise = null;
      listeners.forEach((l) => l(false));
    });
  return wakePromise;
}

export function useServerWaking(): boolean {
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    listeners.add(setWaking);
    void wakeServer();
    return () => {
      listeners.delete(setWaking);
    };
  }, []);
  return waking;
}
