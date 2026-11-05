import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  Clapperboard,
  Coffee,
  MessageSquare,
  MonitorUp,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  Volume2,
} from "lucide-react";
import Logo from "../components/ui/Logo";
import Tilt from "../components/ui/Tilt";
import ServerWakeBanner from "../components/ServerWakeBanner";
import { useAuthStore } from "../store/useAuthStore";

// three.js only downloads when the landing page renders, never inside rooms.
const Hero3D = lazy(() => import("../components/Hero3D"));

const FEATURES = [
  { icon: RefreshCcw, title: "Frame-perfect sync", body: "Play, pause and seek once. Drift correction quietly keeps every screen within a second." },
  { icon: Video, title: "Face-to-face", body: "Built-in video and voice with speaker detection and host announcements." },
  { icon: Volume2, title: "Smart volume", body: "The movie dips when friends talk and comes back when they stop. Cinema or chatty mode." },
  { icon: MonitorUp, title: "Share anything", body: "YouTube, any video link, a local file or your whole screen, with shared subtitles." },
  { icon: MessageSquare, title: "Live chat & replay", body: "Reactions, spoiler shields, clickable timestamps, and chat that replays with the movie." },
  { icon: BarChart3, title: "Polls & queue", body: "Vote on what's next, line up a queue and skip together." },
  { icon: Coffee, title: "Breaks & countdowns", body: "Pause for snacks with a timed break, then count everyone back in." },
  { icon: ShieldCheck, title: "Private rooms", body: "Passwords, invite links, co-hosts, mutes and bans keep the room yours." },
  { icon: Users, title: "Made for friends", body: "Friend groups, one-click invites, scheduled parties and push notifications." },
];

const FAQ = [
  { q: "Is it free?", a: "Yes. Create rooms, invite friends and watch together at no cost." },
  { q: "What can we watch?", a: "Anything on YouTube, most direct video links, a video file from your computer, or your whole screen. Load .srt or .vtt subtitles and everyone sees them." },
  { q: "Does everyone need an account?", a: "Yes, a quick sign-up keeps rooms private and lets friends find each other. Invite links skip the room password." },
  { q: "Does it work on phones?", a: "Watching, chat, voice and video all work in mobile browsers. Screen sharing needs Chrome, Edge or Firefox on a computer." },
  { q: "How many people can join?", a: "The host sets a maximum per room. Video calls work best with a small group of friends." },
];

const STEPS = [
  { n: "01", title: "Create a room", body: "Public or locked with a password. You get a code like WT-1234." },
  { n: "02", title: "Invite your crew", body: "Send a link, pick a friend group, or schedule it for later." },
  { n: "03", title: "Press play", body: "Everyone watches the same frame, sees each other and chats live." },
];

export default function Home() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="grain relative min-h-screen overflow-hidden">
      <ServerWakeBanner />

      {/* ---------- 3D hero ---------- */}
      <section className="relative h-[100svh] min-h-[640px] w-full">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-indigo-600/25 blur-[120px]" />
          <div className="absolute bottom-0 right-0 h-[380px] w-[380px] rounded-full bg-fuchsia-700/15 blur-[120px]" />
        </div>
        <Suspense fallback={null}>
          <Hero3D className="absolute inset-0" />
        </Suspense>
        {/* readability fade over the scene */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ink-950/80 via-ink-950/20 to-ink-950" />

        <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-2">
            {user ? (
              <Link to="/dashboard" className="btn-primary whitespace-nowrap">
                Dashboard <ArrowRight size={16} />
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn-ghost whitespace-nowrap">Sign in</Link>
                <Link to="/signup" className="btn-primary hidden whitespace-nowrap sm:inline-flex">Get started</Link>
              </>
            )}
          </nav>
        </header>

        <div className="relative z-10 mx-auto max-w-3xl px-4 pt-10 text-center sm:px-6 sm:pt-16 animate-fade-up">
          <span className="chip mb-6 border-indigo-400/30 bg-indigo-500/10 text-indigo-100">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" />
            Your private cinema, online
          </span>
          <h1 className="font-display text-5xl font-extrabold leading-[1.05] tracking-tight drop-shadow-[0_4px_30px_rgba(0,0,0,0.6)] sm:text-7xl">
            Movie night,
            <br />
            <span className="text-gradient-cinema">wherever you are.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg text-slate-300">
            Every screen in perfect sync, faces and voices in the seats beside you, and a chat that never spoils the twist.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to={user ? "/dashboard" : "/signup"} className="btn-primary px-6 py-3 text-base">
              <Clapperboard size={18} /> Start a watch party
            </Link>
            <Link to={user ? "/dashboard" : "/login"} state={{ from: "/dashboard" }} className="btn-secondary px-6 py-3 text-base backdrop-blur-md">
              Join with a code
            </Link>
          </div>
        </div>

        <a
          href="#features"
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 text-xs uppercase tracking-[0.3em] text-slate-400 transition-colors hover:text-white"
        >
          Scroll
          <span className="mx-auto mt-2 block h-8 w-px animate-pulse bg-gradient-to-b from-slate-400 to-transparent" />
        </a>
      </section>

      <main className="relative mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        {/* ---------- How it works ---------- */}
        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="relative rounded-2xl border border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent p-6">
              <span className="font-display text-4xl font-extrabold text-white/10">{s.n}</span>
              <h3 className="mt-2 font-display text-lg font-semibold text-white">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{s.body}</p>
            </div>
          ))}
        </section>

        {/* ---------- Features ---------- */}
        <section id="features" className="mt-28 scroll-mt-10">
          <div className="mx-auto max-w-2xl text-center">
            <span className="chip border-indigo-400/30 bg-indigo-500/10 text-indigo-200">
              <Sparkles size={12} /> Everything a real cinema has, minus the sticky floors
            </span>
            <h2 className="mt-5 font-display text-3xl font-bold tracking-tight sm:text-5xl">Built for the whole night</h2>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <Tilt key={title} className="card p-6">
                <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500/25 to-fuchsia-500/15 text-indigo-200 ring-1 ring-white/10">
                  <Icon size={20} />
                </div>
                <h3 className="font-display font-semibold text-white">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{body}</p>
              </Tilt>
            ))}
          </div>
        </section>

        {/* ---------- FAQ ---------- */}
        <section className="mx-auto mt-28 max-w-3xl">
          <h2 className="text-center font-display text-3xl font-bold tracking-tight sm:text-4xl">Questions, answered</h2>
          <div className="mt-10 space-y-3">
            {FAQ.map((f) => (
              <details key={f.q} className="card group p-5 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display font-semibold text-white">
                  {f.q}
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/10 text-indigo-300 transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-slate-400">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ---------- Final CTA ---------- */}
        <section className="relative mt-28 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-indigo-600/30 via-violet-600/20 to-fuchsia-600/20 p-10 text-center sm:p-16">
          <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[600px] -translate-x-1/2 rounded-full bg-white/10 blur-3xl" />
          <h2 className="relative font-display text-3xl font-bold tracking-tight sm:text-5xl">The seats are saved.</h2>
          <p className="relative mx-auto mt-4 max-w-md text-slate-300">Grab the popcorn and send the link. It takes ten seconds to open a room.</p>
          <Link to={user ? "/dashboard" : "/signup"} className="btn-primary relative mt-8 px-7 py-3 text-base">
            Open a room <ArrowRight size={18} />
          </Link>
        </section>
      </main>

      <footer className="border-t border-white/5">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-xs text-slate-500 sm:flex-row sm:px-6">
          <span>© {new Date().getFullYear()} WatchTogether. Grab the popcorn.</span>
          <nav className="flex items-center gap-5">
            <Link to="/privacy" className="transition-colors hover:text-white">Privacy</Link>
            <Link to="/terms" className="transition-colors hover:text-white">Terms</Link>
            <a href="https://github.com/GoutamNandhen/WatchToGether" target="_blank" rel="noreferrer" className="transition-colors hover:text-white">GitHub</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
