import { Router } from "express";
import { getInvite, acceptInvite } from "../controllers/inviteLinks";
import { authenticate, optionalAuth, AuthRequest } from "../middlewares/authMiddleware";
import { rateLimit, clientIp } from "../middlewares/rateLimit";

const router = Router();

// Tokens are 192-bit, but there's no reason to allow unbounded lookups.
const lookupLimit = rateLimit({ name: "invite-lookup", windowMs: 15 * 60 * 1000, max: 60, key: (req) => (req as AuthRequest).userId ?? `ip:${clientIp(req)}` });

// Public so people without an account can see the invite and join as a guest.
router.get("/:token", optionalAuth, lookupLimit, getInvite);
router.post("/:token/accept", authenticate, lookupLimit, acceptInvite);

export default router;
