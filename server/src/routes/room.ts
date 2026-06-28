import { Router } from "express";
import { createRoom, getRooms, getRoomById, deleteRoom, inviteRoom, joinRoom } from "../controllers/room";
import { authenticate } from "../middlewares/authMiddleware";

const router = Router();

router.post("/", authenticate, createRoom);
router.post("/join", authenticate, joinRoom);
router.get("/", authenticate, getRooms);
router.get("/:id", authenticate, getRoomById);
router.delete("/:id", authenticate, deleteRoom);
router.post("/:id/invite", authenticate, inviteRoom);

export default router;
