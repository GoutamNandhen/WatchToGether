import { Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthRequest } from "../middlewares/authMiddleware";
import nodemailer from "nodemailer";

const prisma = new PrismaClient();

export const createRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, description, isPrivate, password } = req.body;
    const hostId = req.userId;

    if (!hostId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const room = await prisma.room.create({
      data: {
        name,
        description,
        isPrivate: isPrivate || false,
        password: password || null,
        hostId,
      },
    });

    res.status(201).json({ room });
  } catch (error) {
    console.error("Create Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getRooms = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rooms = await prisma.room.findMany({
      where: { isPrivate: false },
      include: { host: { select: { name: true } }, _count: { select: { participants: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.status(200).json({ rooms });
  } catch (error) {
    console.error("Get Rooms Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getRoomById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const room = await prisma.room.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        isPrivate: true,
        maxParticipants: true,
        hostId: true,
        createdAt: true,
        host: { select: { name: true } },
        coHosts: true
      }
    });

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    res.status(200).json({ room });
  } catch (error) {
    console.error("Get Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const userId = req.userId;

    const room = await prisma.room.findUnique({ where: { id } });

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    if (room.hostId !== userId) {
      res.status(403).json({ error: "Forbidden: Only the host can delete the room" });
      return;
    }

    await prisma.room.delete({ where: { id } });
    res.status(200).json({ message: "Room deleted successfully" });
  } catch (error) {
    console.error("Delete Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const inviteRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const roomId = req.params.id as string;
    const { email } = req.body;
    const userId = req.userId;

    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const room = await prisma.room.findUnique({ where: { id: roomId } });
    const user = await prisma.user.findUnique({ where: { id: userId! } });

    if (!room || !user) {
      res.status(404).json({ error: "Room or User not found" });
      return;
    }

    // Since we don't have real SMTP credentials yet, we can use Ethereal for testing, or just mock it if not configured.
    // In production, you would use a real service like SendGrid, Mailgun, or Gmail.
    const transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: 'mario.conroy@ethereal.email', // Generic test account, might expire but works as a mock
        pass: '6x5aY2zU5Jz5pYgqZq'
      }
    });

    // You could also construct the actual public URL dynamically, assuming client runs on localhost:5173
    const inviteLink = `http://localhost:5173/room/${roomId}`;

    await transporter.sendMail({
      from: '"WatchTogether" <noreply@watchtogether.app>',
      to: email,
      subject: `${user.name} invited you to join a room!`,
      text: `Hello!\n\n${user.name} invited you to join the room: "${room.name}".\n\nClick here to join: ${inviteLink}\n\nHave fun!`,
      html: `
        <div style="font-family: sans-serif; text-align: center; padding: 40px; background-color: #f4f4f5; border-radius: 8px;">
          <h2 style="color: #18181b;">You're Invited!</h2>
          <p style="color: #52525b;"><b>${user.name}</b> invited you to join the room: <b>"${room.name}"</b>.</p>
          <a href="${inviteLink}" style="display: inline-block; background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin-top: 20px;">Join Room</a>
        </div>
      `
    });

    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (targetUser) {
      const io = req.app.get("io");
      if (io) {
        io.to(`user_${targetUser.id}`).emit("notification", {
          title: "Room Invitation",
          body: `${user.name} invited you to join "${room.name}"!`
        });
      }
    }

    res.status(200).json({ message: "Invitation sent successfully" });
  } catch (error) {
    console.error("Invite Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const joinRoom = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { roomId, password } = req.body;
    
    if (!roomId) {
      res.status(400).json({ error: "Room ID is required" });
      return;
    }

    const room = await prisma.room.findUnique({ where: { id: roomId } });

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    if (room.password && room.password !== password && room.hostId !== req.userId) {
      res.status(401).json({ error: "Incorrect password" });
      return;
    }

    res.status(200).json({ message: "Joined successfully", room: { id: room.id, name: room.name } });
  } catch (error) {
    console.error("Join Room Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
