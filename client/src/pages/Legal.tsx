import { Link } from "react-router-dom";
import Logo from "../components/ui/Logo";
import Backdrop from "../components/Backdrop";

type Section = { heading: string; body: string[] };

const PRIVACY: Section[] = [
  {
    heading: "What we collect",
    body: [
      "Your account details: display name, email address, a hashed password and an optional avatar.",
      "Room data: room names, settings, chat messages, polls, saved moments and watch history, so features like chat replay work.",
      "Technical data needed to run the service, such as connection logs and push-notification subscriptions if you turn them on.",
    ],
  },
  {
    heading: "Camera, microphone and screen",
    body: [
      "Video, voice and screen sharing travel peer-to-peer between people in your room over WebRTC. When a direct connection isn't possible, they pass through an encrypted relay (TURN) server. We don't record or store them.",
      "Local video files you play are streamed from your browser and never uploaded to our servers.",
    ],
  },
  {
    heading: "How we use it",
    body: [
      "Only to run WatchTogether: signing you in, syncing playback, showing friends and rooms, and sending emails you ask for, like password resets and invites.",
      "We don't sell your data or use it for advertising.",
    ],
  },
  {
    heading: "Your choices",
    body: [
      "You can edit your profile, remove your avatar, delete rooms and history, and turn off notifications from Settings.",
      "To delete your account and its data, contact the site owner using the details on the project's GitHub page.",
    ],
  },
];

const TERMS: Section[] = [
  {
    heading: "Using WatchTogether",
    body: [
      "WatchTogether is a free hobby project for watching videos with friends. It's provided as is, without guarantees of uptime or availability.",
      "You're responsible for your account and for keeping your password safe.",
    ],
  },
  {
    heading: "Content you share",
    body: [
      "Only play or share content you have the right to watch and share. Respect copyright and the terms of services like YouTube.",
      "Don't use rooms or chat to harass people, share illegal content, or disrupt the service. Hosts can mute, remove and ban participants, and accounts that break these rules may be removed.",
    ],
  },
  {
    heading: "Changes",
    body: ["These terms may change as the project grows. Continuing to use the site means you accept the current version."],
  },
];

export default function Legal({ kind }: { kind: "privacy" | "terms" }) {
  const sections = kind === "privacy" ? PRIVACY : TERMS;
  const title = kind === "privacy" ? "Privacy Policy" : "Terms of Use";
  return (
    <div className="grain min-h-screen">
      <Backdrop density={0.6} />
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <Link to={kind === "privacy" ? "/terms" : "/privacy"} className="btn-ghost text-xs">
          {kind === "privacy" ? "Terms of Use" : "Privacy Policy"}
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-8 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-indigo-300/80">The fine print</p>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
        <p className="mt-3 text-sm text-slate-500">Plain-language summary of how WatchTogether works.</p>
        <div className="mt-10 space-y-8">
          {sections.map((s) => (
            <section key={s.heading} className="card p-6">
              <h2 className="font-display text-lg font-semibold text-white">{s.heading}</h2>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-slate-400">
                {s.body.map((line) => (
                  <li key={line} className="flex gap-2">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
