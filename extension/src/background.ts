import { io, type Socket } from "socket.io-client";
import { PLAYER_PORT, type BackgroundMessage, type LinkState, type PlayerMessage, type PopupStatus, type Session } from "./types";

declare const __API_URL__: string;

// One WatchTogether room linked to one streaming tab. The link survives service-worker restarts
// through storage.session; the socket is rebuilt on demand.
let link: LinkState | null = null;
let socket: Socket | null = null;
let controller = false;
let lastError: string | null = null;
const ports = new Map<number, chrome.runtime.Port>();

const restore = async () => {
  if (link) return;
  const saved = await chrome.storage.session.get("link");
  if (saved.link) link = saved.link as LinkState;
};

const sendToPlayer = (message: BackgroundMessage) => {
  if (!link) return;
  ports.get(link.tabId)?.postMessage(message);
};

const pushStatus = () => sendToPlayer({ type: "status", linked: !!link, controller, connected: !!socket?.connected });

const setBadge = () => {
  const text = !link ? "" : socket?.connected ? (controller ? "HOST" : "ON") : "…";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
};

/** Position now, given a playback snapshot taken at lastUpdatedAt (server clock). */
const extrapolate = (p: { playing: boolean; time: number; lastUpdatedAt?: number; serverTime?: number }) =>
  p.playing && p.lastUpdatedAt && p.serverTime ? p.time + Math.max(0, (p.serverTime - p.lastUpdatedAt) / 1000) : p.time;

const connect = () => {
  if (!link || socket) return;
  const current = link;
  const s = io(__API_URL__, { auth: { token: current.token }, transports: ["websocket"], reconnectionDelayMax: 10_000 });
  socket = s;

  s.on("connect", () => {
    lastError = null;
    s.emit("join_room", { roomId: current.roomId, userId: current.user.id, userName: current.user.name });
    setBadge();
    pushStatus();
  });
  s.on("disconnect", () => {
    setBadge();
    pushStatus();
  });
  s.on("connect_error", (err) => {
    lastError = err.message.includes("token") ? "Sign in to WatchTogether again, then relink." : "Can't reach the WatchTogether server. It may be waking up.";
    setBadge();
  });
  s.on("error", (data: { message?: string }) => {
    lastError = data?.message || "Something went wrong";
  });

  s.on("room_state", (state: { hostId: string; coHosts: string[] }) => {
    controller = state.hostId === current.user.id || state.coHosts.includes(current.user.id);
    setBadge();
    pushStatus();
  });
  s.on("sync_response", (p: { playing: boolean; time: number; lastUpdatedAt?: number; serverTime?: number }) => {
    sendToPlayer({ type: "apply", playing: p.playing, time: extrapolate(p) });
  });
  s.on("play_video", (p: { time: number }) => sendToPlayer({ type: "apply", playing: true, time: p.time }));
  s.on("pause_video", (p: { time: number }) => sendToPlayer({ type: "apply", playing: false, time: p.time }));
  s.on("seek_video", (p: { time: number }) => sendToPlayer({ type: "apply", playing: null, time: p.time }));
};

const disconnect = () => {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  controller = false;
};

const unlink = async () => {
  if (link && socket?.connected) socket.emit("leave_room", { roomId: link.roomId });
  disconnect();
  const oldTab = link?.tabId;
  link = null;
  await chrome.storage.session.remove("link");
  if (oldTab !== undefined) ports.get(oldTab)?.postMessage({ type: "status", linked: false, controller: false, connected: false } satisfies BackgroundMessage);
  setBadge();
};

/** Reads the signed-in user and room from an open WatchTogether tab. */
const findSession = async (): Promise<Session | null> => {
  const tabs = await chrome.tabs.query({ url: ["https://watch-to-gether.vercel.app/*", "http://localhost:5173/*"] });
  // Prefer a tab that is inside a room.
  const sorted = tabs.sort((a, b) => Number(/\/room\//.test(b.url || "")) - Number(/\/room\//.test(a.url || "")));
  for (const tab of sorted) {
    if (tab.id === undefined) continue;
    try {
      const session = (await chrome.tabs.sendMessage(tab.id, { type: "wt:get-session" })) as Session | null;
      if (session?.token && session.roomId) return session;
    } catch {
      // Tab has no bridge script (opened before install); skip it.
    }
  }
  return null;
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PLAYER_PORT || port.sender?.tab?.id === undefined) return;
  const tabId = port.sender.tab.id;
  ports.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
  port.onMessage.addListener(async (message: PlayerMessage) => {
    await restore();
    if (!link || link.tabId !== tabId) return;
    connect();
    if (message.type === "hello") {
      pushStatus();
      if (socket?.connected) socket.emit("request_sync", { roomId: link.roomId });
      return;
    }
    if (!socket?.connected || !controller) return;
    const roomId = link.roomId;
    const time = Math.max(0, message.time);
    if (message.type === "event") {
      const name = message.event === "play" ? "play_video" : message.event === "pause" ? "pause_video" : "seek_video";
      socket.emit(name, { roomId, time });
    } else if (message.type === "tick") {
      socket.emit("sync_time", { roomId, time, playing: message.playing });
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (link?.tabId === tabId) void unlink();
});

chrome.runtime.onMessage.addListener((message: { type: string; tabId?: number }, _sender, sendResponse) => {
  (async () => {
    await restore();
    if (message.type === "popup:status") {
      if (link) connect();
      const status: PopupStatus = {
        linked: !!link,
        connected: !!socket?.connected,
        controller,
        roomUrl: link?.roomUrl ?? null,
        userName: link?.user.name ?? null,
        linkedTabId: link?.tabId ?? null,
        error: lastError,
      };
      sendResponse(status);
    } else if (message.type === "popup:link" && message.tabId !== undefined) {
      const session = await findSession();
      if (!session || !session.roomId) {
        sendResponse({ ok: false, error: "Open your WatchTogether room in another tab first (and make sure you're signed in)." });
        return;
      }
      await unlink();
      link = { token: session.token, user: session.user, roomId: session.roomId, roomUrl: session.roomUrl, tabId: message.tabId };
      await chrome.storage.session.set({ link });
      connect();
      // Ask the player to say hello so it receives the room's position.
      ports.get(message.tabId)?.postMessage({ type: "status", linked: true, controller, connected: !!socket?.connected } satisfies BackgroundMessage);
      setBadge();
      sendResponse({ ok: true });
    } else if (message.type === "popup:unlink") {
      await unlink();
      sendResponse({ ok: true });
    }
  })();
  return true;
});
