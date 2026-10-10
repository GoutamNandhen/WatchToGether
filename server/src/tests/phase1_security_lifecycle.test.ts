import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { createApp } from "../app";

// Keep this suite safe even if someone bypasses the guarded npm test runner.
const testUrl = process.env.TEST_DATABASE_URL;
let parsed: URL | null = null;
try { parsed = testUrl ? new URL(testUrl) : null; } catch { /* invalid URL */ }
if (
  !parsed ||
  process.env.DATABASE_URL !== testUrl ||
  !["postgres:", "postgresql:"].includes(parsed.protocol) ||
  !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname) ||
  !/(^|[_-])test([_-]|$)/i.test(decodeURIComponent(parsed.pathname.slice(1)))
) {
  throw new Error("This suite requires the guarded runner and a separate local PostgreSQL test database");
}

const prisma = new PrismaClient();
const secret = process.env.JWT_SECRET || "phase1-isolated-test-secret";
const waitFor = <T>(socket: ClientSocket, event: string, timeoutMs = 5000) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off(event, onEvent);
    reject(new Error(`Timed out waiting for ${event}`));
  }, timeoutMs);
  const onEvent = (value: T) => {
    clearTimeout(timer);
    resolve(value);
  };
  socket.once(event, onEvent);
});

async function run() {
  const { httpServer, io, roomManager } = createApp({ gracePeriodMs: 100 });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  const ids = { host: randomUUID(), banned: randomUUID(), former: randomUUID(), target: randomUUID() };
  const roomIds = { main: randomUUID(), idle: randomUUID(), failed: randomUUID(), startup: randomUUID() };
  const sockets: ClientSocket[] = [];
  const call = async (method: string, endpoint: string, token: string, body?: unknown) => {
    const response = await fetch(`${base}/api${endpoint}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const connect = async (userId: string) => {
    const socket = Client(base, { auth: { token: jwt.sign({ userId }, secret) }, reconnection: false, forceNew: true });
    sockets.push(socket);
    await waitFor(socket, "connect");
    return socket;
  };
  const join = (socket: ClientSocket, roomId: string, userId: string) =>
    socket.emit("join_room", { roomId, userId, userName: "Test User" });
  const hostToken = jwt.sign({ userId: ids.host }, secret);
  const bannedToken = jwt.sign({ userId: ids.banned }, secret);
  const formerToken = jwt.sign({ userId: ids.former }, secret);

  try {
    for (const [name, id] of Object.entries(ids)) {
      await prisma.user.create({ data: { id, email: `${name}-${id}@phase1.test`, name, passwordHash: "test-only" } });
    }
    for (const [name, id] of Object.entries(roomIds)) {
      await prisma.room.create({ data: { id, name: `Phase 1 ${name}`, hostId: ids.host, isActive: name !== "idle" } });
    }
    await prisma.roomHistoryEntry.create({ data: { roomId: roomIds.main, userId: ids.former } });

    const host = await connect(ids.host);
    const banned = await connect(ids.banned);
    const hostJoined = waitFor(host, "room_state");
    join(host, roomIds.main, ids.host);
    await hostJoined;
    const bannedJoined = waitFor(banned, "room_state");
    join(banned, roomIds.main, ids.banned);
    await bannedJoined;

    const invitePath = `/rooms/${roomIds.main}/invite`;
    assert.equal((await call("POST", invitePath, formerToken, { email: `target-${ids.target}@phase1.test` })).status, 403);
    assert.equal((await call("POST", `/rooms/${roomIds.main}/invite-group`, formerToken, { groupId: randomUUID() })).status, 403);
    assert.equal((await call("GET", `/rooms/${roomIds.main}/replays`, formerToken)).status, 200);
    console.log("[PASS] A former visitor may view replay history but cannot invite others");

    const kicked = waitFor(banned, "kicked");
    host.emit("kick_participant", { roomId: roomIds.main, targetSocketId: banned.id });
    await kicked;
    assert.equal((await call("POST", invitePath, bannedToken, { email: `target-${ids.target}@phase1.test` })).status, 403);
    assert.equal((await call("POST", `/rooms/${roomIds.main}/invite-group`, bannedToken, { groupId: randomUUID() })).status, 403);
    assert.equal((await call("GET", `/rooms/${roomIds.main}/replays`, bannedToken)).status, 403);
    assert.equal((await call("GET", `/rooms/${roomIds.main}/replay?url=${encodeURIComponent("https://example.test/video.mp4")}`, bannedToken)).status, 403);
    console.log("[PASS] A kicked user immediately loses invite and replay access");

    assert.equal((await call("POST", `/rooms/${roomIds.main}/end`, hostToken)).status, 200);
    assert.ok((await prisma.room.findUniqueOrThrow({ where: { id: roomIds.main } })).endedAt);
    assert.equal((await call("POST", "/rooms/join", hostToken, { roomId: roomIds.main })).status, 410);
    const endedError = waitFor<{ message: string }>(host, "error");
    join(host, roomIds.main, ids.host);
    assert.equal((await endedError).message, "This room has ended");
    assert.equal(roomManager.getRoom(roomIds.main), undefined);
    console.log("[PASS] An explicitly ended room cannot be reopened by HTTP or Socket.IO joins");

    const idleJoined = waitFor(host, "room_state");
    join(host, roomIds.idle, ids.host);
    await idleJoined;
    assert.equal((await prisma.room.findUniqueOrThrow({ where: { id: roomIds.idle } })).endedAt, null);
    console.log("[PASS] An idle room remains joinable");

    const failingSocket = await connect(ids.host);
    const managerWithSeam = roomManager as unknown as { persistJoin: (roomId: string, userId: string) => Promise<void> };
    const originalPersistJoin = managerWithSeam.persistJoin;
    managerWithSeam.persistJoin = async () => { throw new Error("injected join persistence failure"); };
    try {
      const failure = waitFor<{ message: string }>(failingSocket, "error", 6000);
      join(failingSocket, roomIds.failed, ids.host);
      assert.equal((await failure).message, "Unable to join this room right now");
      assert.equal(roomManager.getRoom(roomIds.failed)?.participants.has(failingSocket.id!), false);
      assert.equal(await prisma.participant.findUnique({ where: { userId_roomId: { roomId: roomIds.failed, userId: ids.host } } }), null);
      console.log("[PASS] Three failed persistence attempts never produce a successful socket join");
    } finally {
      managerWithSeam.persistJoin = originalPersistJoin;
    }

    await prisma.participant.create({ data: { roomId: roomIds.startup, userId: ids.host } });
    const child = spawn(process.execPath, [require.resolve("ts-node/dist/bin"), path.join(__dirname, "..", "index.ts")], {
      cwd: path.join(__dirname, "..", ".."),
      env: { ...process.env, PORT: "0", JWT_SECRET: secret, REDIS_URL: "", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Test server did not start")), 30000);
        child.stdout?.on("data", (chunk) => {
          if (String(chunk).includes("Server running")) { clearTimeout(timer); resolve(); }
        });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Test server exited early (${code})`)); });
      });
      assert.ok(await prisma.participant.findUnique({ where: { userId_roomId: { roomId: roomIds.startup, userId: ids.host } } }));
      console.log("[PASS] Starting another server leaves existing participant rows intact");
    } finally {
      child.kill();
    }
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    for (const roomId of Object.values(roomIds)) roomManager.evictRoom(roomId);
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.room.deleteMany({ where: { id: { in: Object.values(roomIds) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error("Phase 1 security/lifecycle test failed:", err);
  process.exitCode = 1;
});
