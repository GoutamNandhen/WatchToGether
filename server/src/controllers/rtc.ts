import { Response } from "express";
import crypto from "crypto";
import { AuthRequest } from "../middlewares/authMiddleware";

const STUN_FALLBACK = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
const TTL_SECONDS = 12 * 60 * 60;

/**
 * ICE servers for WebRTC. With TURN_SECRET set this issues short-lived credentials using the
 * TURN REST API scheme coturn supports (`use-auth-secret`), so no long-lived TURN password
 * ever reaches the browser. Static TURN_USERNAME/TURN_CREDENTIAL are supported too.
 */
// Cloudflare Realtime TURN (free tier): credentials are minted per request from a TURN key.
// Set CF_TURN_KEY_ID and CF_TURN_API_TOKEN on the server. Results are cached briefly per user.
const cfCache = new Map<string, { iceServers: unknown[]; expires: number }>();

const cloudflareIceServers = async (userId: string): Promise<unknown[] | null> => {
  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_API_TOKEN;
  if (!keyId || !token) return null;
  const cached = cfCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.iceServers;
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error("Cloudflare TURN credential request failed:", response.status);
      return null;
    }
    const data = (await response.json()) as { iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }> };
    // Port 53 is blocked by browsers and only causes ICE timeouts.
    const iceServers = (data.iceServers || []).map((server) => ({
      ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => !/:53(\?|$)/.test(u)),
    }));
    if (!iceServers.length) return null;
    if (cfCache.size > 5000) cfCache.clear();
    cfCache.set(userId, { iceServers, expires: Date.now() + (TTL_SECONDS - 3600) * 1000 });
    return iceServers;
  } catch (error) {
    console.error("Cloudflare TURN error:", error);
    return null;
  }
};

export const getIceServers = async (req: AuthRequest, res: Response): Promise<void> => {
  const cloudflare = await cloudflareIceServers(req.userId!);
  if (cloudflare) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ iceServers: cloudflare, turn: true, ttl: TTL_SECONDS, provider: "cloudflare" });
    return;
  }
  const urls = (process.env.TURN_URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
  const stunUrls = (process.env.STUN_URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
  const stun = stunUrls.length ? [{ urls: stunUrls }] : STUN_FALLBACK;

  if (!urls.length) {
    res.status(200).json({ iceServers: stun, turn: false });
    return;
  }

  let username: string;
  let credential: string;
  if (process.env.TURN_SECRET) {
    username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${req.userId}`;
    credential = crypto.createHmac("sha1", process.env.TURN_SECRET).update(username).digest("base64");
  } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    username = process.env.TURN_USERNAME;
    credential = process.env.TURN_CREDENTIAL;
  } else {
    res.status(200).json({ iceServers: stun, turn: false });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ iceServers: [...stun, { urls, username, credential }], turn: true, ttl: TTL_SECONDS });
};
