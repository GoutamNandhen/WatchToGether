import { useEffect, useState } from "react";
import { useSocketStore } from "../store/useSocketStore";

export default function BreakOverlay({ roomId, canControl }: { roomId: string; canControl: boolean }) {
  const state = useSocketStore((s) => s.breakState);
  const focusMode = useSocketStore((s) => s.focusMode);
  const socket = useSocketStore((s) => s.socket);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!state || state.status !== "counting") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state]);

  if (!state) return null;
  const remaining = Math.max(0, Math.ceil((state.localEndsAt - now) / 1000));
  const ready = state.status === "ready";
  const clock = `${Math.floor(remaining / 60).toString().padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`;

  return (
    <div className={`pointer-events-none absolute inset-x-0 z-[9700] flex justify-center px-3 ${focusMode ? "top-28" : "top-16"}`} role="status" aria-live="polite">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-3 rounded-xl border border-amber-300/30 bg-ink-950/90 px-4 py-3 text-sm text-white shadow-xl backdrop-blur">
        <span className="font-semibold">{ready ? "Ready to Resume" : `Break · ${clock} remaining`}</span>
        {canControl && (ready ? (
          <button type="button" onClick={() => socket?.emit("resume_break", { roomId })} className="btn-primary px-3 py-1.5 text-xs">Resume movie</button>
        ) : (
          <button type="button" onClick={() => socket?.emit("end_break_early", { roomId })} className="btn-secondary px-3 py-1.5 text-xs">End break early</button>
        ))}
        {!canControl && <span className="text-xs text-slate-300">Waiting for the host to resume</span>}
      </div>
    </div>
  );
}
