import { useServerWaking } from "../lib/serverWake";

/** Small fixed pill shown only while the sleeping API is starting up. */
export default function ServerWakeBanner() {
  const waking = useServerWaking();
  if (!waking) return null;
  return (
    <div
      role="status"
      className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-amber-400/30 bg-ink-900/90 px-4 py-2 text-xs text-amber-100 shadow-card backdrop-blur-xl animate-fade-up"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
      </span>
      Warming up the projector… first load can take up to 30 seconds.
    </div>
  );
}
