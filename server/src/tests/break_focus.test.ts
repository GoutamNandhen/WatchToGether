import { createServer } from "http";
import { randomUUID } from "crypto";
import { Server } from "socket.io";
import { io as connect, Socket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { RoomManager } from "../managers/RoomManager";
import { setupSocketHandlers } from "../socket";

const prisma = new PrismaClient();
const secret = process.env.JWT_SECRET || "isolated-break-focus-test";
process.env.JWT_SECRET = secret;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`[PASS] ${message}`);
};

async function main() {
  const http = createServer();
  const io = new Server(http, { cors: { origin: "*" } });
  const manager = new RoomManager(io, 1000);
  setupSocketHandlers(io, manager);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const roomId = randomUUID();
  const hostId = randomUUID();
  const guestId = randomUUID();
  const lateId = randomUUID();
  const clients: Socket[] = [];
  const events = new Map<Socket, Record<string, unknown[]>>();
  const open = async (userId: string, name: string) => {
    const socket = connect(url, { auth: { token: jwt.sign({ userId }, secret) }, reconnection: false, forceNew: true });
    const seen: Record<string, unknown[]> = {};
    socket.onAny((event, payload) => (seen[event] ||= []).push(payload));
    events.set(socket, seen);
    clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    socket.emit("join_room", { roomId, userId, userName: name });
    await wait(250);
    return socket;
  };
  const last = <T>(socket: Socket, event: string) => {
    const list = events.get(socket)?.[event];
    return list?.[list.length - 1] as T | undefined;
  };
  try {
    for (const [id, name] of [[hostId, "Break Host"], [guestId, "Break Guest"], [lateId, "Break Late"]]) {
      await prisma.user.create({ data: { id, name, email: `${id}@test.local`, passwordHash: "test-only" } });
    }
    await prisma.room.create({ data: { id: roomId, name: "Break focus test", hostId } });
    const host = await open(hostId, "Break Host");
    const guest = await open(guestId, "Break Guest");
    check(!!last(host, "room_state") && !!last(guest, "room_state"), "host and guest joined isolated room");

    guest.emit("start_break", { roomId, seconds: 300 });
    guest.emit("set_focus_mode", { roomId, enabled: true });
    await wait(100);
    check(manager.getBreakState(roomId) === null && manager.getRoom(roomId)?.focusMode === false, "guest cannot start break or focus mode");
    host.emit("play_video", { roomId, time: 23 });
    await wait(100);
    host.emit("start_break", { roomId, seconds: 300 });
    await wait(100);
    const initial = last<{ state: { status: string; endsAt: number }; serverTime: number }>(guest, "break_state");
    check(initial?.state.status === "counting" && initial.state.endsAt > initial.serverTime, "break broadcasts authoritative deadline");
    const liveRoom = manager.getRoom(roomId);
    check(liveRoom?.playback.playing === false && (liveRoom?.playback.time ?? 0) >= 23, "break pauses playback at current position");

    const pausedAt = manager.getRoom(roomId)!.playback.time;
    host.emit("play_video", { roomId, time: 90 });
    host.emit("sync_time", { roomId, time: 90, playing: true });
    host.emit("play_url", { roomId, url: "https://example.com/next.mp4" });
    guest.emit("end_break_early", { roomId });
    guest.emit("resume_break", { roomId });
    await wait(100);
    check(manager.getRoom(roomId)?.playback.playing === false && manager.getRoom(roomId)?.playback.time === pausedAt, "ordinary playback commands cannot bypass break");
    check(manager.getBreakState(roomId)?.status === "counting", "guest cannot end or resume break");

    host.emit("set_focus_mode", { roomId, enabled: true });
    await wait(100);
    check(last<{ enabled: boolean }>(guest, "focus_mode")?.enabled === true, "host focus change broadcasts to room");
    const late = await open(lateId, "Break Late");
    check(last<{ state: { status: string } }>(late, "break_state")?.state.status === "counting", "late joiner receives active break");
    check(last<{ enabled: boolean }>(late, "focus_mode")?.enabled === true, "late joiner receives focus state");

    guest.disconnect();
    await wait(100);
    const rejoined = await open(guestId, "Break Guest");
    check(last<{ state: { status: string } }>(rejoined, "break_state")?.state.status === "counting", "reconnected participant receives break");
    check(last<{ enabled: boolean }>(rejoined, "focus_mode")?.enabled === true, "reconnected participant receives focus state");

    host.emit("end_break_early", { roomId });
    await wait(100);
    check(manager.getBreakState(roomId)?.status === "ready" && manager.getRoom(roomId)?.playback.playing === false, "ending break early requires separate resume confirmation");
    rejoined.emit("resume_break", { roomId });
    await wait(100);
    check(manager.getBreakState(roomId)?.status === "ready", "guest cannot confirm resume");
    host.emit("resume_break", { roomId });
    await wait(100);
    check(manager.getBreakState(roomId) === null && manager.getRoom(roomId)?.playback.playing === true, "host confirmation resumes synchronized playback");

    // Exercise the deadline transition without waiting five minutes.
    manager.updatePlayback(roomId, { playing: false });
    manager.startBreak(roomId, 0.05, () => io.to(roomId).emit("break_state", { state: manager.getBreakState(roomId), serverTime: Date.now() }));
    await wait(100);
    check(manager.getBreakState(roomId)?.status === "ready" && manager.getRoom(roomId)?.playback.playing === false, "deadline reaches ready without auto-play");
    manager.clearBreak(roomId);
    host.emit("set_focus_mode", { roomId, enabled: false });
    await wait(100);
    check(last<{ enabled: boolean }>(late, "focus_mode")?.enabled === false, "host can disable focus mode");
    await manager.makeCoHost(roomId, guestId);
    host.emit("start_break", { roomId, seconds: 300 });
    await wait(100);
    host.emit("leave_room", { roomId, userId: hostId, userName: "Break Host" });
    await wait(500);
    check(manager.getRoom(roomId)?.hostId === guestId && manager.getBreakState(roomId)?.status === "counting", "break survives host migration");
    rejoined.emit("end_break_early", { roomId });
    await wait(100);
    rejoined.emit("resume_break", { roomId });
    await wait(100);
    check(manager.getBreakState(roomId) === null && manager.getRoom(roomId)?.playback.playing === true, "new host can confirm resume");
    rejoined.emit("start_break", { roomId, seconds: 300 });
    await wait(100);
    manager.evictRoom(roomId);
    await wait(100);
    check(manager.getBreakState(roomId) === null && last<{ roomId: string }>(late, "room_ended")?.roomId === roomId, "room ending removes break state and notifies participants");
  } finally {
    for (const client of clients) client.disconnect();
    io.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: { in: [hostId, guestId, lateId] } } });
    await prisma.$disconnect();
  }
  console.log(`Break/focus: ${passed} passed, 0 failed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
