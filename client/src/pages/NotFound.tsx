import { Link } from "react-router-dom";
import Logo from "../components/ui/Logo";
import Backdrop from "../components/Backdrop";

export default function NotFound() {
  return (
    <div className="grain relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden px-4 text-center">
      <Backdrop density={0.6} />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-indigo-600/20 blur-[120px]" />
      <Logo />
      <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-fuchsia-400">Reel missing</p>
      <p className="font-display text-8xl font-extrabold text-gradient sm:text-9xl">404</p>
      <p className="max-w-sm text-slate-400">This page wandered off mid-movie. Let's get you back to the lobby.</p>
      <Link to="/" className="btn-primary">Back to the lobby</Link>
    </div>
  );
}
