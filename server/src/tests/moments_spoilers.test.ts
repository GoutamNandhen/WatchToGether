import { createServer } from "http";
import { randomUUID } from "crypto";
import { Server } from "socket.io";
import { io as connect, Socket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { RoomManager } from "../managers/RoomManager";
import { setupSocketHandlers } from "../socket";

const prisma = new PrismaClient();
const secret = process.env.JWT_SECRET || "isolated-moments-spoilers-test";
process.env.JWT_SECRET = secret;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const check = (condition: boolean, label: string) => {
  if (!condition) throw new Error(label);
  passed++;
  console.log(`[PASS] ${label}`);
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
  const outsiderId = randomUUID();
  const clients: Socket[] = [];
  const events = new Map<Socket, Record<string, unknown[]>>();
  const open = async (userId: string, name: string, join = true) => {
    const socket = connect(url, { auth: { token: jwt.sign({ userId }, secret) }, reconnection: false, forceNew: true });
    const seen: Record<string, unknown[]> = {};
    socket.onAny((event, payload) => (seen[event] ||= []).push(payload));
    events.set(socket, seen);
    clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    if (join) {
      socket.emit("join_room", { roomId, userId, userName: name });
      await wait(220);
    }
    return socket;
  };
  const last = <T>(socket: Socket, event: string) => {
    const values = events.get(socket)?.[event];
    return values?.[values.length - 1] as T | undefined;
  };
  const count = (socket: Socket, event: string) => events.get(socket)?.[event]?.length ?? 0;
  const film = "https://example.com/cinema.mp4";

  try {
    for (const [id, name] of [[hostId, "Host"], [guestId, "Guest"], [lateId, "Late"], [outsiderId, "Outsider"]]) {
      await prisma.user.create({ data: { id, name, email: `${id}@test.local`, passwordHash: "test-only" } });
    }
    await prisma.room.create({ data: { id: roomId, name: "A2 isolated test", hostId } });
    const host = await open(hostId, "Host");
    const guest = await open(guestId, "Guest");
    const outsider = await open(outsiderId, "Outsider", false);
    check(!!last(host, "room_state") && !!last(guest, "room_state"), "host and guest join isolated room");

    manager.updatePlayback(roomId, { url: film, time: 42.3, playing: false });
    const firstSession = manager.getRoom(roomId)!.playback.sessionId;
    outsider.emit("save_moment", { roomId, requestId: randomUUID(), note: "no access" });
    await wait(90);
    check(await prisma.cinemaMoment.count({ where: { roomId } }) === 0, "non-member cannot save a moment");

    const requestId = randomUUID();
    guest.emit("save_moment", { roomId, requestId, note: "<b>great scene</b>" });
    await wait(120);
    const saved = await prisma.cinemaMoment.findFirst({ where: { roomId, userId: guestId } });
    check(saved?.videoUrl === film && saved.videoTime === 42 && saved.playbackSessionId === firstSession && saved.note === "<b>great scene</b>", "moment captures authoritative movie, time, session and plain-text note");
    check(last<{ id: string }>(host, "moment_saved")?.id === saved?.id, "saved moment broadcasts to participants");

    guest.emit("save_moment", { roomId, requestId, note: "retry" });
    guest.emit("save_moment", { roomId, requestId: randomUUID(), note: "double click" });
    await wait(130);
    check(await prisma.cinemaMoment.count({ where: { roomId } }) === 1 && count(host, "moment_saved") === 1, "request retry and same-second submission do not duplicate a moment");

    manager.updatePlayback(roomId, { time: Number.POSITIVE_INFINITY, playing: false });
    host.emit("save_moment", { roomId, requestId: randomUUID() });
    await wait(90);
    check(await prisma.cinemaMoment.count({ where: { roomId } }) === 1, "non-finite playback time is rejected");
    manager.updatePlayback(roomId, { url: "javascript:invalid", time: 10, playing: false });
    host.emit("save_moment", { roomId, requestId: randomUUID() });
    await wait(90);
    check(await prisma.cinemaMoment.count({ where: { roomId } }) === 1, "invalid movie URL is rejected");

    manager.updatePlayback(roomId, { url: film, time: 50, playing: false });
    const secondSession = manager.getRoom(roomId)!.playback.sessionId;
    host.emit("change_video", { roomId, url: film });
    await wait(100);
    manager.updatePlayback(roomId, { time: 50, playing: false });
    const thirdSession = manager.getRoom(roomId)!.playback.sessionId;
    check(firstSession !== secondSession && secondSession !== thirdSession, "repeat selection of one URL starts a distinct playback session");
    check(last<{ sessionId: string }>(guest, "playback_session")?.sessionId === thirdSession, "new playback session broadcasts to participants");
    guest.emit("seek_video", { roomId, time: 90 });
    await wait(80);
    check(manager.getRoom(roomId)?.playback.time === 50, "participant cannot change synchronized playback from a moment");

    guest.emit("send_message", { roomId, userId: guestId, userName: "Guest", content: "@Host final twist", isSpoiler: true, autoReveal: true });
    await wait(150);
    const spoiler = await prisma.message.findFirst({ where: { roomId, isSpoiler: true } });
    check(spoiler?.autoReveal === true && spoiler.videoUrl === film && spoiler.videoTime === 50 && spoiler.playbackSessionId === thirdSession, "spoiler metadata persists with the current session and position");
    check(last<{ isSpoiler: boolean; autoReveal: boolean }>(host, "receive_message")?.isSpoiler === true && last<{ autoReveal: boolean }>(host, "receive_message")?.autoReveal === true, "live message preserves spoiler visibility metadata");

    const late = await open(lateId, "Late");
    const history = last<{ isSpoiler: boolean; autoReveal: boolean; playbackSessionId: string }[]>(late, "chat_history");
    const momentHistory = last<{ id: string }[]>(late, "moments_history");
    check(!!history?.some((m) => m.isSpoiler && m.autoReveal && m.playbackSessionId === thirdSession), "late joiner receives spoiler metadata in chat history");
    check(!!momentHistory?.some((m) => m.id === saved?.id), "moment is persisted and sent on late join");
    check(last<{ sessionId: string }>(late, "sync_response")?.sessionId === thirdSession, "late joiner receives current playback session identity");

    guest.disconnect();
    await wait(70);
    guest.emit("save_moment", { roomId, requestId: randomUUID() });
    await wait(70);
    check(await prisma.cinemaMoment.count({ where: { roomId } }) === 1, "disconnected user cannot create another moment");
  } finally {
    for (const client of clients) client.disconnect();
    io.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: { in: [hostId, guestId, lateId, outsiderId] } } });
    await prisma.$disconnect();
  }
  console.log(`Moments/spoilers: ${passed} passed, 0 failed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
