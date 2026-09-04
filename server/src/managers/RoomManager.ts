import { PrismaClient } from "@prisma/client";
import { Server } from "socket.io";

const prisma = new PrismaClient();

interface PlaybackState {
  playing: boolean;
  time: number;
  url: string;
  lastUpdatedAt: number;
}

interface RoomState {
  roomId: string;
  hostId: string;
  coHosts: Set<string>;
  participants: Map<string, string>; // socketId -> userId
  playback: PlaybackState;
  disconnectedParticipants: Map<string, { userId: string; timeout: NodeJS.Timeout }>;
}

export class RoomManager {
  private rooms: Map<string, RoomState> = new Map();
  private io: Server;

  constructor(io: Server) {
    this.io = io;
  }

  public async getOrCreateRoom(roomId: string): Promise<RoomState | null> {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId)!;
    }

    try {
      const dbRoom = await prisma.room.findUnique({
        where: { id: roomId },
        include: { coHosts: true },
      });

      if (!dbRoom) return null;

      const newRoom: RoomState = {
        roomId,
        hostId: dbRoom.hostId,
        coHosts: new Set(dbRoom.coHosts.map((ch) => ch.userId)),
        participants: new Map(),
        disconnectedParticipants: new Map(),
        playback: {
          playing: false,
          time: dbRoom.playbackTime ?? 0,
          url: dbRoom.playbackUrl ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
          lastUpdatedAt: Date.now(),
        },
      };

      this.rooms.set(roomId, newRoom);
      return newRoom;
    } catch (err) {
      console.error("Failed to load room from DB:", err);
      return null;
    }
  }

  public getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  public getSocketRoomId(socketId: string): string | undefined {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.has(socketId)) {
        return roomId;
      }
    }
    return undefined;
  }

  public isAuthorized(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.hostId === userId || room.coHosts.has(userId);
  }

  public async handleJoin(roomId: string, socketId: string, userId: string, userName: string) {
    const room = await this.getOrCreateRoom(roomId);
    if (!room) return false;

    // Check if user was in disconnected state and cancel the timeout
    const staleSocketIds: string[] = [];
    for (const [discSocketId, data] of room.disconnectedParticipants.entries()) {
      if (data.userId === userId) {
        clearTimeout(data.timeout);
        room.disconnectedParticipants.delete(discSocketId);
        staleSocketIds.push(discSocketId);
      }
    }

    // Check if user already had another active socket in the room and clean it up
    for (const [sId, uId] of room.participants.entries()) {
      if (uId === userId && sId !== socketId) {
        room.participants.delete(sId);
        if (!staleSocketIds.includes(sId)) {
          staleSocketIds.push(sId);
        }
      }
    }

    // Inform existing participants to tear down WebRTC/peer state for any stale socket IDs
    for (const staleId of staleSocketIds) {
      this.io.to(roomId).emit("user_left", { userId, socketId: staleId });
    }

    room.participants.set(socketId, userId);

    // Save to DB
    try {
      await prisma.participant.upsert({
        where: { userId_roomId: { userId, roomId } },
        update: { joinedAt: new Date() },
        create: { userId, roomId },
      });

      // Track historical visit
      await prisma.roomHistoryEntry.upsert({
        where: { userId_roomId: { userId, roomId } },
        update: { visitedAt: new Date() },
        create: { userId, roomId },
      });
    } catch (err) {
      console.error("Error saving participant or history entry:", err);
    }

    return true;
  }

  public handleDisconnect(socketId: string) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.has(socketId)) {
        const userId = room.participants.get(socketId)!;
        room.participants.delete(socketId);

        // If the user still has another active socket in the room, do not schedule removal
        const hasOtherActiveSocket = Array.from(room.participants.values()).includes(userId);
        if (hasOtherActiveSocket) {
          return;
        }

        // Schedule permanent removal
        const timeout = setTimeout(async () => {
          room.disconnectedParticipants.delete(socketId);
          await this.permanentlyRemoveUser(roomId, userId, socketId);
        }, 10000); // 10 seconds reconnect window

        room.disconnectedParticipants.set(socketId, { userId, timeout });
        this.io.to(roomId).emit("user_disconnected_temp", { socketId, userId });
      }
    }
  }

  public async handleLeave(roomId: string, socketId: string, userId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [discSocketId, data] of room.disconnectedParticipants.entries()) {
      if (data.userId === userId) {
        clearTimeout(data.timeout);
        room.disconnectedParticipants.delete(discSocketId);
      }
    }

    room.participants.delete(socketId);
    await this.permanentlyRemoveUser(roomId, userId, socketId);
  }

  private async permanentlyRemoveUser(roomId: string, userId: string, oldSocketId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // Notify room
    this.io.to(roomId).emit("user_left", { userId, socketId: oldSocketId });

    try {
      await prisma.participant.delete({
        where: { userId_roomId: { userId, roomId } },
      });
    } catch (err) {
      console.error("Failed to delete participant", err);
    }

    // Host migration if host left and didn't reconnect
    if (room.hostId === userId) {
      this.migrateHost(roomId);
    }
  }

  public async makeCoHost(roomId: string, targetUserId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.coHosts.add(targetUserId);
    try {
      await prisma.roomCoHost.upsert({
        where: { roomId_userId: { roomId, userId: targetUserId } },
        update: {},
        create: { roomId, userId: targetUserId },
      });
      return true;
    } catch (err) {
      console.error("Failed to add co-host to DB", err);
      return false;
    }
  }

  private async migrateHost(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    let newHostId: string | null = null;

    // 1. Try to find an active co-host
    for (const activeSocketId of room.participants.keys()) {
      const uid = room.participants.get(activeSocketId);
      if (uid && room.coHosts.has(uid)) {
        newHostId = uid;
        break;
      }
    }

    // 2. Try to find any active participant
    if (!newHostId && room.participants.size > 0) {
      const firstActiveSocket = Array.from(room.participants.keys())[0];
      newHostId = room.participants.get(firstActiveSocket)!;
    }

    if (newHostId) {
      room.hostId = newHostId;
      room.coHosts.delete(newHostId);
      
      try {
        await prisma.room.update({
          where: { id: roomId },
          data: { hostId: newHostId },
        });
        // Remove from co-hosts in DB if they were one
        await prisma.roomCoHost.deleteMany({
          where: { roomId, userId: newHostId }
        });
      } catch (err) {
        console.error("Failed to update new host in DB", err);
      }

      this.io.to(roomId).emit("new_host", { userId: newHostId });
    } else {
      // Room empty, clean up in-memory state and save playback state
      try {
        await prisma.room.update({
          where: { id: roomId },
          data: {
            playbackUrl: room.playback.url,
            playbackTime: room.playback.time,
          },
        });
      } catch (err) {
        console.error("Failed to save playback state", err);
      }
      this.rooms.delete(roomId);
    }
  }

  public updatePlayback(roomId: string, update: Partial<PlaybackState>) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.playback = { ...room.playback, ...update, lastUpdatedAt: Date.now() };
    }
  }
}
