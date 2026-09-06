import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { RoomManager } from "./managers/RoomManager";
import * as schemas from "./schemas/socketSchemas";

const prisma = new PrismaClient();

export const setupSocketHandlers = (io: Server, gracePeriodOrManager?: number | RoomManager) => {
  const roomManager =
    gracePeriodOrManager instanceof RoomManager
      ? gracePeriodOrManager
      : new RoomManager(io, typeof gracePeriodOrManager === "number" ? gracePeriodOrManager : 10000);

  // Authentication Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string };
      socket.data.userId = decoded.userId;
      next();
    } catch (err) {
      next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId;
    console.log(`User connected: ${userId} (Socket: ${socket.id})`);

    socket.on("join_global_room", (data) => {
      const payload = schemas.validateSocketPayload(schemas.joinGlobalRoomSchema, data, socket);
      if (!payload) return;
      socket.join(`user_${payload.userId}`);
    });

    socket.on("join_room", async (data) => {
      try {
        const payload = schemas.validateSocketPayload(schemas.joinRoomSchema, data, socket);
        if (!payload) return;

        const { roomId, userName, password } = payload;

        // Ensure the user joins the room with their authenticated userId, not whatever they pass
        if (payload.userId !== userId) {
          socket.emit("error", { message: "Unauthorized userId mismatch" });
          return;
        }

        // Authoritative check
        const roomAuth = await prisma.room.findUnique({
          where: { id: roomId },
          select: { isPrivate: true, password: true, hostId: true }
        });

        if (!roomAuth) {
          socket.emit("error", { message: "Room not found" });
          return;
        }

        if (roomAuth.isPrivate) {
          // Only require password if the user is not the host
          if (roomAuth.hostId !== userId) {
            // Check if user is a co-host, they bypass password
            const cohost = await prisma.roomCoHost.findUnique({
              where: { roomId_userId: { roomId, userId } }
            });

            if (!cohost) {
              if (!password) {
                socket.emit("error", { message: "Password required for private room" });
                return;
              }
              if (roomAuth.password && roomAuth.password !== password) {
                socket.emit("error", { message: "Incorrect password" });
                return;
              }
            }
          }
        }

        const success = await roomManager.handleJoin(roomId, socket.id, userId, userName);
        if (!success) {
          socket.emit("error", { message: "Room not found" });
          return;
        }

        socket.join(roomId);
        console.log(`User ${userName} (${userId}) joined room ${roomId} on socket ${socket.id}`);

        const room = roomManager.getRoom(roomId);

        // Send the current authoritative state to the joining user
        if (room) {
          socket.emit("sync_response", { ...room.playback, serverTime: Date.now() });
          socket.emit("room_state", { hostId: room.hostId, coHosts: Array.from(room.coHosts) });
          socket.emit("room_participant_statuses", roomManager.getParticipantStatuses(roomId));
        }

        // Broadcast to room that a user joined
        socket.to(roomId).emit("user_joined", { userId, userName, socketId: socket.id });
      } catch (err) {
        console.error("Error in join_room:", err);
        socket.emit("error", { message: "Internal server error joining room" });
      }
    });

    socket.on("send_message", async (data) => {
      const payload = schemas.validateSocketPayload(schemas.sendMessageSchema, data, socket);
      if (!payload) return;
      
      const { roomId, userName, content } = payload;
      
      if (payload.userId !== userId) return; // Ignore spoofed

      const messageData = {
        id: Date.now().toString(),
        roomId,
        userId,
        userName,
        content, // Length validation done by zod (max 1000). React safely renders text.
        createdAt: new Date().toISOString()
      };
      
      io.to(roomId).emit("receive_message", messageData);

      try {
        await prisma.message.create({
          data: { content, userId, roomId }
        });
      } catch (err) {
        console.error("Error saving message:", err);
      }
    });

    socket.on("leave_room", async (data, callback?: () => void) => {
      const payload = schemas.validateSocketPayload(schemas.joinRoomSchema, data, socket);
      if (!payload) return;
      if (payload.userId !== userId) return;

      socket.leave(payload.roomId);
      await roomManager.handleLeave(payload.roomId, socket.id, userId);
      if (typeof callback === "function") {
        callback();
      }
    });

    // --- HOST/CO-HOST PRIVILEGED EVENTS ---

    socket.on("play_video", (data) => {
      const payload = schemas.validateSocketPayload(schemas.roomTimeSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, { playing: true, time: payload.time });
      socket.to(senderRoomId).emit("play_video", { time: payload.time, serverTime: Date.now() });
    });

    socket.on("pause_video", (data) => {
      const payload = schemas.validateSocketPayload(schemas.roomTimeSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, { playing: false, time: payload.time });
      socket.to(senderRoomId).emit("pause_video", { time: payload.time, serverTime: Date.now() });
    });

    socket.on("seek_video", (data) => {
      const payload = schemas.validateSocketPayload(schemas.roomTimeSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, { time: payload.time });
      socket.to(senderRoomId).emit("seek_video", { time: payload.time, serverTime: Date.now() });
    });

    socket.on("sync_time", (data) => {
      const payload = schemas.validateSocketPayload(schemas.syncTimeSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, {
        time: payload.time,
        ...(payload.playing !== undefined ? { playing: payload.playing } : {}),
      });
      const room = roomManager.getRoom(senderRoomId);
      if (room) {
        socket.to(senderRoomId).emit("sync_response", { ...room.playback, serverTime: Date.now() });
      }
    });

    socket.on("change_video", (data) => {
      const payload = schemas.validateSocketPayload(schemas.changeVideoSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      if (!roomManager.isAuthorized(senderRoomId, userId)) return;

      roomManager.updatePlayback(senderRoomId, { url: payload.url, time: 0 });
      socket.to(senderRoomId).emit("change_video", { url: payload.url });
    });

    socket.on("request_sync", (data) => {
      const payload = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      
      const room = roomManager.getRoom(senderRoomId);
      if (room) {
        socket.emit("sync_response", { ...room.playback, serverTime: Date.now() });
      }
    });

    socket.on("make_cohost", async (data) => {
      const payload = schemas.validateSocketPayload(schemas.makeCohostSchema, data, socket);
      if (!payload) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== payload.roomId) return;
      
      const room = roomManager.getRoom(senderRoomId);
      if (!room) return;
      
      // ONLY the HOST can make someone a co-host
      if (room.hostId !== userId) {
        socket.emit("error", { message: "Only the host can assign co-hosts" });
        return;
      }
      
      const targetSocket = io.sockets.sockets.get(payload.targetSocketId);
      const targetUserId = targetSocket?.data?.userId;
      if (!targetUserId) return;

      const success = await roomManager.makeCoHost(senderRoomId, targetUserId);
      if (success) {
        io.to(senderRoomId).emit("new_cohost", { userId: targetUserId });
      }
    });

    // --- WEBRTC SIGNALING ---
    
    socket.on("webrtc_offer", (data) => {
      const p = schemas.validateSocketPayload(schemas.webrtcOfferAnswerSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      const targetRoomId = roomManager.getSocketRoomId(p.to);
      if (!senderRoomId || senderRoomId !== targetRoomId) {
        socket.emit("error", { message: "Unauthorized cross-room signaling" });
        return;
      }
      socket.to(p.to).emit("webrtc_offer", { offer: p.offer, from: socket.id });
    });

    socket.on("webrtc_answer", (data) => {
      const p = schemas.validateSocketPayload(schemas.webrtcOfferAnswerSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      const targetRoomId = roomManager.getSocketRoomId(p.to);
      if (!senderRoomId || senderRoomId !== targetRoomId) return;
      socket.to(p.to).emit("webrtc_answer", { answer: p.answer, from: socket.id });
    });

    socket.on("webrtc_ice_candidate", (data) => {
      const p = schemas.validateSocketPayload(schemas.webrtcCandidateSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      const targetRoomId = roomManager.getSocketRoomId(p.to);
      if (!senderRoomId || senderRoomId !== targetRoomId) return;
      socket.to(p.to).emit("webrtc_ice_candidate", { candidate: p.candidate, from: socket.id });
    });

    // --- AUDIO PRIORITIZATION & SCREEN SHARE ---

    socket.on("started_speaking", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      socket.to(senderRoomId).emit("user_speaking", { socketId: socket.id });
    });

    socket.on("stopped_speaking", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      socket.to(senderRoomId).emit("user_stopped_speaking", { socketId: socket.id });
    });

    socket.on("host_announcement_start", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      if (roomManager.isAuthorized(senderRoomId, userId)) {
        socket.to(senderRoomId).emit("host_announcement_start", { socketId: socket.id });
      }
    });

    socket.on("host_announcement_stop", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      if (roomManager.isAuthorized(senderRoomId, userId)) {
        socket.to(senderRoomId).emit("host_announcement_stop", { socketId: socket.id });
      }
    });

    socket.on("participant_status", (data) => {
      const p = schemas.validateSocketPayload(schemas.participantStatusSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      roomManager.updateParticipantStatus(senderRoomId, socket.id, p.cam, p.mic);
      socket.to(senderRoomId).emit("participant_status", { socketId: socket.id, cam: p.cam, mic: p.mic });
    });

    socket.on("screen_share_start", (data) => {
      const p = schemas.validateSocketPayload(schemas.screenShareStartSchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (!senderRoomId || senderRoomId !== p.roomId) {
        socket.emit("error", { message: "Unauthorized screen share" });
        return;
      }
      socket.to(senderRoomId).emit("screen_share_start", { socketId: socket.id, streamId: p.streamId });
    });

    socket.on("screen_share_stop", (data) => {
      const p = schemas.validateSocketPayload(schemas.roomOnlySchema, data, socket);
      if (!p) return;
      const senderRoomId = roomManager.getSocketRoomId(socket.id);
      if (senderRoomId !== p.roomId) return;
      socket.to(senderRoomId).emit("screen_share_stop", { socketId: socket.id });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      roomManager.handleDisconnect(socket.id);
    });
  });
  return roomManager;
};
