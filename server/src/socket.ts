import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const setupSocketHandlers = (io: Server) => {
  io.on("connection", (socket: Socket) => {
    console.log("A user connected:", socket.id);

    // Join Room
    socket.on("join_room", async ({ roomId, userId, userName }) => {
      socket.join(roomId);
      socket.data.userId = userId;
      console.log(`User ${userName} (${userId}) joined room ${roomId}`);

      // Broadcast to room that a user joined
      socket.to(roomId).emit("user_joined", { userId, userName, socketId: socket.id });

      // Save participant to DB asynchronously
      try {
        await prisma.participant.upsert({
          where: { userId_roomId: { userId, roomId } },
          update: { joinedAt: new Date() },
          create: { userId, roomId },
        });
      } catch (err) {
        console.error("Error saving participant:", err);
      }
    });

    // Chat Message
    socket.on("send_message", async ({ roomId, userId, userName, content }) => {
      const messageData = {
        id: Date.now().toString(), // temporary ID
        roomId,
        userId,
        userName,
        content,
        createdAt: new Date().toISOString()
      };
      
      io.to(roomId).emit("receive_message", messageData);

      // Save to DB asynchronously
      try {
        await prisma.message.create({
          data: {
            content,
            userId,
            roomId,
          }
        });
      } catch (err) {
        console.error("Error saving message:", err);
      }
    });

    // Leave Room
    socket.on("leave_room", ({ roomId, userId, userName }) => {
      socket.leave(roomId);
      socket.to(roomId).emit("user_left", { userId, userName, socketId: socket.id });
    });

    // Video Sync Events
    socket.on("play_video", ({ roomId, time }) => {
      socket.to(roomId).emit("play_video", { time });
    });

    socket.on("pause_video", ({ roomId, time }) => {
      socket.to(roomId).emit("pause_video", { time });
    });

    socket.on("seek_video", ({ roomId, time }) => {
      socket.to(roomId).emit("seek_video", { time });
    });

    socket.on("change_video", ({ roomId, url }) => {
      socket.to(roomId).emit("change_video", { url });
    });

    // WebRTC Signaling
    socket.on("webrtc_offer", ({ offer, to, from }) => {
      socket.to(to).emit("webrtc_offer", { offer, from });
    });

    socket.on("webrtc_answer", ({ answer, to, from }) => {
      socket.to(to).emit("webrtc_answer", { answer, from });
    });

    socket.on("webrtc_ice_candidate", ({ candidate, to, from }) => {
      socket.to(to).emit("webrtc_ice_candidate", { candidate, from });
    });

    // Audio Prioritization Events
    socket.on("started_speaking", ({ roomId }) => {
      socket.to(roomId).emit("user_speaking", { socketId: socket.id });
    });

    socket.on("stopped_speaking", ({ roomId }) => {
      socket.to(roomId).emit("user_stopped_speaking", { socketId: socket.id });
    });

    socket.on("host_announcement_start", ({ roomId }) => {
      socket.to(roomId).emit("host_announcement_start", { socketId: socket.id });
    });

    socket.on("host_announcement_stop", ({ roomId }) => {
      socket.to(roomId).emit("host_announcement_stop", { socketId: socket.id });
    });

    socket.on("participant_status", ({ roomId, cam, mic }) => {
      socket.to(roomId).emit("participant_status", { socketId: socket.id, cam, mic });
    });

    socket.on("make_cohost", async ({ roomId, targetSocketId }) => {
      try {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        const targetUserId = targetSocket?.data?.userId;
        if (!targetUserId) {
          console.error("Target user ID not found for socket", targetSocketId);
          return;
        }

        await prisma.roomCoHost.upsert({
          where: { roomId_userId: { roomId, userId: targetUserId } },
          update: {},
          create: { roomId, userId: targetUserId }
        });
        io.to(roomId).emit("new_cohost", { userId: targetUserId });
      } catch (err) {
        console.error("Failed to make co-host", err);
      }
    });

    socket.on("screen_share_start", ({ roomId, streamId }) => {
      socket.to(roomId).emit("screen_share_start", { socketId: socket.id, streamId });
    });

    socket.on("screen_share_stop", ({ roomId }) => {
      socket.to(roomId).emit("screen_share_stop", { socketId: socket.id });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });
};
