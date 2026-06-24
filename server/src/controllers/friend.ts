import { Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthRequest } from "../middlewares/authMiddleware";

const prisma = new PrismaClient();

export const getFriends = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const friends = await prisma.friend.findMany({
      where: {
        OR: [
          { userId },
          { friendId: userId }
        ]
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        friendUser: { select: { id: true, name: true, email: true } }
      }
    });
    
    // Normalize format
    const formattedFriends = friends.map(f => {
      const isSender = f.userId === userId;
      const otherUser = isSender ? f.friendUser : f.user;
      return {
        id: f.id,
        status: f.status, // PENDING, ACCEPTED
        isSender,
        user: otherUser
      };
    });

    res.status(200).json({ friends: formattedFriends });
  } catch (error) {
    console.error("Get Friends Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const sendFriendRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    const userId = req.userId!;

    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (targetUser.id === userId) {
      res.status(400).json({ error: "Cannot add yourself" });
      return;
    }

    const existing = await prisma.friend.findFirst({
      where: {
        OR: [
          { userId, friendId: targetUser.id },
          { userId: targetUser.id, friendId: userId }
        ]
      }
    });

    if (existing) {
      res.status(400).json({ error: "Friend request already exists" });
      return;
    }

    const friend = await prisma.friend.create({
      data: {
        userId,
        friendId: targetUser.id,
        status: "PENDING"
      }
    });

    res.status(201).json({ message: "Friend request sent", friend });
  } catch (error) {
    console.error("Send Request Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const acceptFriendRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const userId = req.userId!;

    const friend = await prisma.friend.findUnique({ where: { id } });
    if (!friend || friend.friendId !== userId) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    await prisma.friend.update({
      where: { id },
      data: { status: "ACCEPTED" }
    });

    res.status(200).json({ message: "Friend request accepted" });
  } catch (error) {
    console.error("Accept Request Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
