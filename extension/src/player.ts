import { PLAYER_PORT, type BackgroundMessage, type PlayerMessage } from "./types";

// Runs on streaming sites. Finds the main <video>, reports the host's play/pause/seek, and
// applies the room's position. It never touches the video's pixels or the site's DRM.

const SITE = location.hostname.replace(/^www\./, "");
const DRIFT_TOLERANCE = 1.5; // seconds before a viewer gets nudged back into sync
const SUPPRESS_MS = 900; // ignore our own changes so they don't echo back to the room

let port: chrome.runtime.Port | null = null;
let video: HTMLVideoElement | null = null;
let linked = false;
let controller = false;
let suppressUntil = 0;
let tickTimer: number | undefined;

const send = (message: PlayerMessage) => {
  try {
    port?.postMessage(message);
  } catch {
    port = null;
  }
};

/** The biggest visible video on the page is the one being watched. */
const findVideo = (): HTMLVideoElement | null => {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  document.querySelectorAll("video").forEach((v) => {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea && v.readyState > 0) {
      best = v;
      bestArea = area;
    }
  });
  return best;
};

const seekTo = (time: number) => {
  if (!video) return;
  if (SITE === "netflix.com") {
    // Netflix errors out if currentTime is set directly; its own player API seeks safely.
    window.postMessage({ source: "watchtogether", type: "seek", ms: Math.round(time * 1000) }, location.origin);
  } else {
    video.currentTime = time;
  }
};

const apply = async (playing: boolean | null, time: number) => {
  if (!video) return;
  suppressUntil = Date.now() + SUPPRESS_MS;
  if (Math.abs(video.currentTime - time) > DRIFT_TOLERANCE) seekTo(time);
  try {
    if (playing === true && video.paused) await video.play();
    if (playing === false && !video.paused) video.pause();
  } catch {
    showToast("Click play once so the browser lets WatchTogether control this video.");
  }
};

const onLocal = (event: "play" | "pause" | "seek") => () => {
  if (!linked || !controller || !video || Date.now() < suppressUntil) return;
  send({ type: "event", event, time: video.currentTime });
};

const handlers = { play: onLocal("play"), pause: onLocal("pause"), seeked: onLocal("seek") };

const attach = (next: HTMLVideoElement | null) => {
  if (next === video) return;
  if (video) for (const [name, fn] of Object.entries(handlers)) video.removeEventListener(name, fn);
  video = next;
  if (video) for (const [name, fn] of Object.entries(handlers)) video.addEventListener(name, fn);
  if (video && linked) send({ type: "hello", site: SITE, hasVideo: true });
};

const startTicks = () => {
  window.clearInterval(tickTimer);
  tickTimer = window.setInterval(() => {
    if (linked && controller && video && !video.paused) send({ type: "tick", time: video.currentTime, playing: true });
  }, 5000);
};

const connect = () => {
  port = chrome.runtime.connect({ name: PLAYER_PORT });
  port.onMessage.addListener((message: BackgroundMessage) => {
    if (message.type === "status") {
      const wasLinked = linked;
      linked = message.linked;
      controller = message.controller;
      if (linked && !wasLinked) {
        showToast(controller ? "Linked. You're the host: your play, pause and seek control the room." : "Linked. This video follows the host.");
        send({ type: "hello", site: SITE, hasVideo: !!video });
      }
    } else if (message.type === "apply" && linked) {
      void apply(message.playing, message.time);
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // The service worker restarted; reconnect and re-announce.
    window.setTimeout(() => {
      connect();
      send({ type: "hello", site: SITE, hasVideo: !!video });
    }, 1000);
  });
};

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;
const showToast = (text: string) => {
  if (!toastEl) {
    toastEl = document.createElement("div");
    Object.assign(toastEl.style, {
      position: "fixed", zIndex: "2147483647", left: "50%", bottom: "48px", transform: "translateX(-50%)",
      padding: "10px 16px", borderRadius: "12px", font: "500 14px system-ui, sans-serif", color: "#fff",
      background: "linear-gradient(135deg, #6366f1, #8b5cf6)", boxShadow: "0 8px 30px rgba(99,102,241,.45)",
      pointerEvents: "none", transition: "opacity .3s",
    });
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.opacity = "1";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl && (toastEl.style.opacity = "0"), 4000);
};

connect();
startTicks();
send({ type: "hello", site: SITE, hasVideo: false });
// Streaming sites swap video elements between titles and ads; keep looking.
window.setInterval(() => attach(findVideo()), 1000);
