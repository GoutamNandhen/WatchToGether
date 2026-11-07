import type { Session } from "./types";

// Runs on WatchTogether pages. Hands the signed-in session and current room to the extension,
// only when the extension asks (messages from web pages can't reach this listener).
chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type !== "wt:get-session") return;
  try {
    const token = localStorage.getItem("token");
    const user = JSON.parse(localStorage.getItem("user") || "null") as { id: string; name: string } | null;
    const match = location.pathname.match(/^\/room\/([0-9a-f-]{36})/i);
    const session: Session | null = token && user ? { token, user: { id: user.id, name: user.name }, roomId: match ? match[1] : null, roomUrl: location.href } : null;
    sendResponse(session);
  } catch {
    sendResponse(null);
  }
});
