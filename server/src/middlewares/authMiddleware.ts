import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface AuthRequest extends Request {
  userId?: string;
}

// Tokens issued before a password change are rejected. The lookup is cached briefly so
// every request doesn't hit the database.
const CACHE_TTL_MS = 30_000;
const passwordChangedCache = new Map<string, { changedAt: number | null; exists: boolean; cachedAt: number }>();

export const invalidateAuthCache = (userId: string) => {
  passwordChangedCache.delete(userId);
};

const getPasswordChangedAt = async (userId: string) => {
  const cached = passwordChangedCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordChangedAt: true } });
  const entry = { changedAt: user?.passwordChangedAt?.getTime() ?? null, exists: !!user, cachedAt: Date.now() };
  passwordChangedCache.set(userId, entry);
  return entry;
};

/** Returns the user id for a valid, still-current token, otherwise null. */
export const verifyAuthToken = async (token: string): Promise<string | null> => {
  let decoded: { userId: string; iat?: number };
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string; iat?: number };
  } catch {
    return null;
  }
  try {
    const { changedAt, exists } = await getPasswordChangedAt(decoded.userId);
    if (!exists) return null;
    // iat has second precision; allow the token minted in the same second as the change.
    if (changedAt && decoded.iat && decoded.iat * 1000 < changedAt - 1000) return null;
  } catch (err) {
    console.error("Auth lookup failed:", err);
    return null;
  }
  return decoded.userId;
};

/** Guests join from an invite link with just a name. Their placeholder email uses a reserved TLD. */
export const GUEST_EMAIL_DOMAIN = "guest.watchtogether.invalid";
export const isGuestEmail = (email: string) => email.toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`);

/** Blocks guest accounts from actions that need a real account (hosting, friends, invites). */
export const requireFullAccount = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { email: true } });
    if (user && isGuestEmail(user.email)) {
      res.status(403).json({ error: "Create a free account to do this. It only takes a few seconds.", code: "GUEST_ACCOUNT" });
      return;
    }
  } catch (err) {
    console.error("Account check failed:", err);
  }
  next();
};

/** Sets req.userId when a valid token is present, but never rejects. */
export const optionalAuth = async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const userId = await verifyAuthToken(authHeader.split(" ")[1]);
    if (userId) req.userId = userId;
  }
  next();
};

export const signAuthToken = (userId: string) =>
  jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn: "7d" });

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const userId = await verifyAuthToken(authHeader.split(" ")[1]);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
};
