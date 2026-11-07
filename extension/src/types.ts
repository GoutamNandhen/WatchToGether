export interface Session {
  token: string;
  user: { id: string; name: string };
  roomId: string | null;
  roomUrl: string;
}

export interface LinkState {
  token: string;
  user: { id: string; name: string };
  roomId: string;
  roomUrl: string;
  tabId: number;
}

/** Player content script → background. */
export type PlayerMessage =
  | { type: "hello"; site: string; hasVideo: boolean }
  | { type: "event"; event: "play" | "pause" | "seek"; time: number }
  | { type: "tick"; time: number; playing: boolean };

/** Background → player content script. */
export type BackgroundMessage =
  | { type: "apply"; playing: boolean | null; time: number }
  | { type: "status"; linked: boolean; controller: boolean; connected: boolean };

export interface PopupStatus {
  linked: boolean;
  connected: boolean;
  controller: boolean;
  roomUrl: string | null;
  userName: string | null;
  linkedTabId: number | null;
  error: string | null;
}

export const PLAYER_PORT = "wt-player";
