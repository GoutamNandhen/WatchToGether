import { createServer } from "http";
import { Server } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { setupSocketHandlers } from "../socket";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_12345";
process.env.JWT_SECRET = JWT_SECRET;

interface SyncState {
  time: number;
  playing: boolean;
  url?: string;
  lastUpdatedAt: number;
  localReceiptTime: number;
  serverTime?: number;
}

class SimulatedPlaybackClient {
  public socket: ClientSocket | null = null;
  public connectionStatus: "connected" | "disconnected" | "reconnecting" = "disconnected";
  public playEvents: any[] = [];
  public pauseEvents: any[] = [];
  public seekEvents: any[] = [];
  public syncResponses: any[] = [];
  public errorsReceived: any[] = [];

  // Simulated player state
  public currentPosition = 0;
  public playing = false;
  public playbackRate = 1.0;
  public seekHistory: number[] = [];
  public isHandlingRemote = false;
  public lastSyncState: SyncState | null = null;
  private remoteHandlingTimer: NodeJS.Timeout | null = null;

  constructor(
    public userId: string,
    public userName: string,
    private serverUrl: string,
    private token: string,
    public isHost: boolean = false
  ) {}

  public connect(): Promise<void> {
    return new Promise((resolve) => {
      this.socket = Client(this.serverUrl, {
        auth: { token: this.token },
        reconnection: false,
        forceNew: true,
      });

      this.setupListeners();

      this.socket.on("connect", () => {
        this.connectionStatus = "connected";
        resolve();
      });
    });
  }

  private markHandlingRemote(duration = 800) {
    if (this.remoteHandlingTimer) clearTimeout(this.remoteHandlingTimer);
    this.isHandlingRemote = true;
    this.remoteHandlingTimer = setTimeout(() => {
      this.isHandlingRemote = false;
      this.remoteHandlingTimer = null;
    }, duration);
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on("disconnect", () => {
      this.connectionStatus = "reconnecting";
    });

    this.socket.on("error", (err: any) => {
      this.errorsReceived.push(err);
    });

    this.socket.on("play_video", (data: any) => {
      this.playEvents.push(data);
      if (this.isHost) return;
      this.markHandlingRemote();
      this.playing = true;
      if (Math.abs(this.currentPosition - data.time) > 1.0) {
        this.currentPosition = data.time;
        this.seekHistory.push(data.time);
      }
      this.playbackRate = 1.0;
    });

    this.socket.on("pause_video", (data: any) => {
      this.pauseEvents.push(data);
      if (this.isHost) return;
      this.markHandlingRemote();
      this.playing = false;
      this.currentPosition = data.time;
      this.seekHistory.push(data.time);
      this.playbackRate = 1.0;
    });

    this.socket.on("seek_video", (data: any) => {
      this.seekEvents.push(data);
      if (this.isHost) return;
      this.markHandlingRemote();
      this.currentPosition = data.time;
      this.seekHistory.push(data.time);
      this.playbackRate = 1.0;
    });

    this.socket.on("sync_response", (data: any) => {
      this.syncResponses.push(data);
      if (this.isHost || !data) return;
      this.markHandlingRemote();

      const now = Date.now();
      this.lastSyncState = {
        time: data.time,
        playing: data.playing,
        url: data.url,
        lastUpdatedAt: data.lastUpdatedAt || now,
        localReceiptTime: now,
        serverTime: data.serverTime || now,
      };

      this.playing = data.playing;
      const expectedTime = this.calculateExpectedTime(this.lastSyncState);
      this.applyDriftCorrection(expectedTime, data.playing);
    });
  }

  public calculateExpectedTime(syncState: SyncState): number {
    if (!syncState.playing) {
      return syncState.time;
    }
    const elapsedSinceReceipt = (Date.now() - syncState.localReceiptTime) / 1000;
    const serverDelay = syncState.serverTime && syncState.lastUpdatedAt
      ? Math.max(0, (syncState.serverTime - syncState.lastUpdatedAt) / 1000)
      : 0;
    return syncState.time + serverDelay + elapsedSinceReceipt;
  }

  public applyDriftCorrection(expectedTime: number, isPlaying: boolean) {
    const drift = expectedTime - this.currentPosition;

    if (!isPlaying) {
      if (Math.abs(drift) > 0.5) {
        this.currentPosition = expectedTime;
        this.seekHistory.push(expectedTime);
      }
      this.playbackRate = 1.0;
    } else {
      if (Math.abs(drift) > 3.0) {
        // Hard seek
        this.currentPosition = expectedTime;
        this.seekHistory.push(expectedTime);
        this.playbackRate = 1.0;
      } else if (drift > 1.0) {
        // Behind: gentle speedup
        this.playbackRate = 1.05;
      } else if (drift < -1.0) {
        // Ahead: gentle slowdown
        this.playbackRate = 0.95;
      } else {
        // In-sync
        this.playbackRate = 1.0;
      }
    }
  }

  public joinRoom(roomId: string, password?: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket || !this.socket.connected) {
        return resolve();
      }

      const onRoomState = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        this.socket?.off("room_state", onRoomState);
        this.socket?.off("error", onError);
      };

      this.socket.once("room_state", onRoomState);
      this.socket.once("error", onError);
      this.socket.emit("join_room", {
        roomId,
        userId: this.userId,
        userName: this.userName,
        password,
      });
    });
  }

  public leaveRoom(roomId: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket && this.socket.connected) {
        this.socket.emit("leave_room", { roomId, userId: this.userId, userName: this.userName });
      }
      setTimeout(resolve, 100);
    });
  }

  public waitForEvent<T>(
    getArray: () => T[],
    predicate: (item: T) => boolean,
    timeoutMs = 4000
  ): Promise<boolean> {
    const start = Date.now();
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (getArray().some(predicate)) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 50);
    });
  }

  public disconnect() {
    if (this.remoteHandlingTimer) clearTimeout(this.remoteHandlingTimer);
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connectionStatus = "disconnected";
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("STARTING P1-B PLAYBACK SYNCHRONIZATION TEST SUITE");
  console.log("==================================================");

  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });
  const roomManager = setupSocketHandlers(io);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as any).port;
  const serverUrl = `http://localhost:${port}`;
  console.log(`Playback test server listening at ${serverUrl}`);

  // Test User IDs
  const hostId = "10101010-1010-4010-a010-101010101010";
  const userBId = "20202020-2020-4020-a020-202020202020";

  const hostToken = jwt.sign({ userId: hostId }, JWT_SECRET);
  const userBToken = jwt.sign({ userId: userBId }, JWT_SECRET);

  // Helper to generate distinct test room IDs
  const getRoomId = (idx: number) => `30303030-3030-4030-a030-${idx.toString().padStart(12, "0")}`;

  // Database seeding with retry for serverless database cold-start
  let dbReady = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await prisma.user.upsert({
        where: { email: "host_sync@test.com" },
        update: { id: hostId },
        create: { id: hostId, email: "host_sync@test.com", passwordHash: "hash", name: "Host User" },
      });
      await prisma.user.upsert({
        where: { email: "userb_sync@test.com" },
        update: { id: userBId },
        create: { id: userBId, email: "userb_sync@test.com", passwordHash: "hash", name: "Peer User" },
      });

      for (let i = 1; i <= 13; i++) {
        const rId = getRoomId(i);
        await prisma.room.upsert({
          where: { id: rId },
          update: { hostId, playbackTime: 0, playbackUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" },
          create: {
            id: rId,
            name: `Sync Test Room ${i}`,
            hostId,
            isPrivate: false,
            playbackTime: 0,
            playbackUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
          },
        });
      }
      dbReady = true;
      break;
    } catch (err) {
      console.log(`Database connection attempt ${attempt} failed (waking up Neon compute...):`, (err as any).message || err);
      if (attempt < 4) await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!dbReady) {
    throw new Error("Failed to connect to database after 4 attempts");
  }

  let testsPassed = 0;
  let testsFailed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      testsPassed++;
    } else {
      console.error(`  [FAIL] ${testName} ${detail ? "- " + detail : ""}`);
      testsFailed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Play synchronization
    // -------------------------------------------------------------
    console.log("\n--- Test 1: Play synchronization ---");
    const rId1 = getRoomId(1);
    const host1 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer1 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host1.connect();
    await host1.joinRoom(rId1);
    await peer1.connect();
    await peer1.joinRoom(rId1);

    host1.socket!.emit("play_video", { roomId: rId1, time: 14.5 });
    const peerGotPlay = await peer1.waitForEvent(
      () => peer1.playEvents,
      (e) => e.time === 14.5 && typeof e.serverTime === "number"
    );
    assert(peerGotPlay, "Peer receives play_video with matching time and serverTime");
    assert(peer1.playing === true, "Peer playback state updated to playing");

    await host1.leaveRoom(rId1);
    await peer1.leaveRoom(rId1);
    host1.disconnect();
    peer1.disconnect();

    // -------------------------------------------------------------
    // Test 2: Pause synchronization
    // -------------------------------------------------------------
    console.log("\n--- Test 2: Pause synchronization ---");
    const rId2 = getRoomId(2);
    const host2 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer2 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host2.connect();
    await host2.joinRoom(rId2);
    await peer2.connect();
    await peer2.joinRoom(rId2);

    host2.socket!.emit("pause_video", { roomId: rId2, time: 42.0 });
    const peerGotPause = await peer2.waitForEvent(
      () => peer2.pauseEvents,
      (e) => e.time === 42.0 && typeof e.serverTime === "number"
    );
    assert(peerGotPause, "Peer receives pause_video with matching time and serverTime");
    assert(peer2.playing === false, "Peer playback state updated to paused");

    await host2.leaveRoom(rId2);
    await peer2.leaveRoom(rId2);
    host2.disconnect();
    peer2.disconnect();

    // -------------------------------------------------------------
    // Test 3: Seek synchronization
    // -------------------------------------------------------------
    console.log("\n--- Test 3: Seek synchronization ---");
    const rId3 = getRoomId(3);
    const host3 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer3 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host3.connect();
    await host3.joinRoom(rId3);
    await peer3.connect();
    await peer3.joinRoom(rId3);

    host3.socket!.emit("seek_video", { roomId: rId3, time: 125.0 });
    const peerGotSeek = await peer3.waitForEvent(
      () => peer3.seekEvents,
      (e) => e.time === 125.0 && typeof e.serverTime === "number"
    );
    assert(peerGotSeek, "Peer receives seek_video with target timestamp");
    assert(peer3.currentPosition === 125.0, "Peer converged to seek position");

    await host3.leaveRoom(rId3);
    await peer3.leaveRoom(rId3);
    host3.disconnect();
    peer3.disconnect();

    // -------------------------------------------------------------
    // Test 4: Continuous playback drift correction (Gentle speedup)
    // -------------------------------------------------------------
    console.log("\n--- Test 4: Continuous playback drift correction (Gentle speedup) ---");
    const rId4 = getRoomId(4);
    const host4 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer4 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host4.connect();
    await host4.joinRoom(rId4);
    await peer4.connect();
    await peer4.joinRoom(rId4);

    // Peer is slightly behind at 100.0s while Host is at 101.8s (1.8s drift, inside gentle zone 1.0 - 3.0s)
    peer4.currentPosition = 100.0;
    host4.socket!.emit("sync_time", { roomId: rId4, time: 101.8, playing: true });

    const peerGotSync = await peer4.waitForEvent(
      () => peer4.syncResponses,
      (e) => e.time === 101.8 && e.playing === true
    );
    assert(peerGotSync, "Peer receives periodic sync_response from host heartbeat");
    assert(peer4.playbackRate === 1.05, "Peer smoothly accelerates playbackRate to 1.05x for gentle catch-up");
    assert(!peer4.seekHistory.includes(101.8), "Peer did NOT hard-seek during gentle drift correction");

    await host4.leaveRoom(rId4);
    await peer4.leaveRoom(rId4);
    host4.disconnect();
    peer4.disconnect();

    // -------------------------------------------------------------
    // Test 5: Small drift below threshold (Deadband)
    // -------------------------------------------------------------
    console.log("\n--- Test 5: Small drift below threshold (Deadband) ---");
    const rId5 = getRoomId(5);
    const host5 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer5 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host5.connect();
    await host5.joinRoom(rId5);
    await peer5.connect();
    await peer5.joinRoom(rId5);

    // Peer is at 150.0s, Host is at 150.4s (drift = 0.4s, within <= 1.0s deadband)
    peer5.currentPosition = 150.0;
    peer5.playbackRate = 1.0;
    host5.socket!.emit("sync_time", { roomId: rId5, time: 150.4, playing: true });

    await peer5.waitForEvent(() => peer5.syncResponses, (e) => e.time === 150.4);
    assert(peer5.playbackRate === 1.0, "Playback rate remains normal 1.0x within in-sync deadband");
    assert(!peer5.seekHistory.includes(150.4), "No seek triggered for tiny sub-second drift");

    await host5.leaveRoom(rId5);
    await peer5.leaveRoom(rId5);
    host5.disconnect();
    peer5.disconnect();

    // -------------------------------------------------------------
    // Test 6: Large drift above threshold (Hard seek)
    // -------------------------------------------------------------
    console.log("\n--- Test 6: Large drift above threshold (Hard seek) ---");
    const rId6 = getRoomId(6);
    const host6 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer6 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host6.connect();
    await host6.joinRoom(rId6);
    await peer6.connect();
    await peer6.joinRoom(rId6);

    // Peer is at 200.0s, Host jumps to 215.0s (15s drift, > 3.0s hard-seek threshold)
    peer6.currentPosition = 200.0;
    host6.socket!.emit("sync_time", { roomId: rId6, time: 215.0, playing: true });

    await peer6.waitForEvent(() => peer6.syncResponses, (e) => e.time === 215.0);
    assert(Math.abs(peer6.currentPosition - 215.0) < 0.2, "Peer performed hard seek to converge with host");
    assert(peer6.playbackRate === 1.0, "Playback rate reset to 1.0x after hard seek");

    await host6.leaveRoom(rId6);
    await peer6.leaveRoom(rId6);
    host6.disconnect();
    peer6.disconnect();

    // -------------------------------------------------------------
    // Test 7: Rapid play/pause
    // -------------------------------------------------------------
    console.log("\n--- Test 7: Rapid play/pause ---");
    const rId7 = getRoomId(7);
    const host7 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer7 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host7.connect();
    await host7.joinRoom(rId7);
    await peer7.connect();
    await peer7.joinRoom(rId7);

    // Rapid toggle sequence
    host7.socket!.emit("play_video", { roomId: rId7, time: 10.0 });
    host7.socket!.emit("pause_video", { roomId: rId7, time: 10.2 });
    host7.socket!.emit("play_video", { roomId: rId7, time: 10.5 });
    host7.socket!.emit("pause_video", { roomId: rId7, time: 10.6 });

    await peer7.waitForEvent(() => peer7.pauseEvents, (e) => e.time === 10.6);
    await new Promise((r) => setTimeout(r, 200));

    // Final state on server and peer must be paused at 10.6
    const roomState7 = roomManager.getRoom(rId7);
    assert(roomState7?.playback.playing === false, "Server resolved final state to paused");
    assert(roomState7?.playback.time === 10.6, "Server resolved final time to 10.6");
    assert(peer7.playing === false, "Peer resolved to paused without runaway loop");

    await host7.leaveRoom(rId7);
    await peer7.leaveRoom(rId7);
    host7.disconnect();
    peer7.disconnect();

    // -------------------------------------------------------------
    // Test 8: Rapid seek
    // -------------------------------------------------------------
    console.log("\n--- Test 8: Rapid seek ---");
    const rId8 = getRoomId(8);
    const host8 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer8 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host8.connect();
    await host8.joinRoom(rId8);
    await peer8.connect();
    await peer8.joinRoom(rId8);

    // 01:20 (80s) -> 10:30 (630s) -> 02:00 (120s)
    host8.socket!.emit("seek_video", { roomId: rId8, time: 80.0 });
    host8.socket!.emit("seek_video", { roomId: rId8, time: 630.0 });
    host8.socket!.emit("seek_video", { roomId: rId8, time: 120.0 });

    await peer8.waitForEvent(() => peer8.seekEvents, (e) => e.time === 120.0);
    await new Promise((r) => setTimeout(r, 200));

    const roomState8 = roomManager.getRoom(rId8);
    assert(roomState8?.playback.time === 120.0, "Server accurately records final seek position 120.0s");
    assert(peer8.currentPosition === 120.0, "Peer accurately converged to final seek position 120.0s");

    await host8.leaveRoom(rId8);
    await peer8.leaveRoom(rId8);
    host8.disconnect();
    peer8.disconnect();

    // -------------------------------------------------------------
    // Test 9: Late join while playing
    // -------------------------------------------------------------
    console.log("\n--- Test 9: Late join while playing ---");
    const rId9 = getRoomId(9);
    const host9 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    await host9.connect();
    await host9.joinRoom(rId9);

    // Host establishes playback at 1542.0s (25:42)
    host9.socket!.emit("play_video", { roomId: rId9, time: 1542.0 });
    await new Promise((r) => setTimeout(r, 200));

    // Peer joins late
    const latePeer = new SimulatedPlaybackClient(userBId, "LatePeer", serverUrl, userBToken, false);
    await latePeer.connect();
    await latePeer.joinRoom(rId9);

    const gotSyncOnJoin = await latePeer.waitForEvent(
      () => latePeer.syncResponses,
      (e) => e.time >= 1542.0 && e.playing === true
    );
    assert(gotSyncOnJoin, "Late-joining peer receives authoritative sync_response upon joining");
    assert(latePeer.currentPosition >= 1542.0, "Late-joining peer converged to current position (not 00:00)");
    assert(latePeer.playing === true, "Late-joining peer initiated playback");

    await host9.leaveRoom(rId9);
    await latePeer.leaveRoom(rId9);
    host9.disconnect();
    latePeer.disconnect();

    // -------------------------------------------------------------
    // Test 10: Late join while paused
    // -------------------------------------------------------------
    console.log("\n--- Test 10: Late join while paused ---");
    const rId10 = getRoomId(10);
    const host10 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    await host10.connect();
    await host10.joinRoom(rId10);

    // Host establishes paused state at 500.0s
    host10.socket!.emit("pause_video", { roomId: rId10, time: 500.0 });
    await new Promise((r) => setTimeout(r, 200));

    const latePeerPaused = new SimulatedPlaybackClient(userBId, "LatePeerPaused", serverUrl, userBToken, false);
    await latePeerPaused.connect();
    await latePeerPaused.joinRoom(rId10);

    const gotPausedSync = await latePeerPaused.waitForEvent(
      () => latePeerPaused.syncResponses,
      (e) => e.time === 500.0 && e.playing === false
    );
    assert(gotPausedSync, "Late-joining peer receives paused sync_response at 500.0s");
    assert(latePeerPaused.currentPosition === 500.0, "Late peer converged to 500.0s");
    assert(latePeerPaused.playing === false, "Late peer remained paused");

    await host10.leaveRoom(rId10);
    await latePeerPaused.leaveRoom(rId10);
    host10.disconnect();
    latePeerPaused.disconnect();

    // -------------------------------------------------------------
    // Test 11: Reconnection playback recovery
    // -------------------------------------------------------------
    console.log("\n--- Test 11: Reconnection playback recovery ---");
    const rId11 = getRoomId(11);
    const host11 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer11 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host11.connect();
    await host11.joinRoom(rId11);
    await peer11.connect();
    await peer11.joinRoom(rId11);

    // Temporarily disconnect peer
    peer11.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Host updates playback while peer is away
    host11.socket!.emit("sync_time", { roomId: rId11, time: 720.0, playing: true });
    await new Promise((r) => setTimeout(r, 200));

    // Peer reconnects and rejoins
    await peer11.connect();
    await peer11.joinRoom(rId11);

    const recoveredSync = await peer11.waitForEvent(
      () => peer11.syncResponses,
      (e) => e.time >= 720.0 && e.playing === true
    );
    assert(recoveredSync, "Reconnected peer receives up-to-date playback snapshot on rejoin");
    assert(peer11.currentPosition >= 720.0, "Reconnected peer synchronized to latest playback position");

    await host11.leaveRoom(rId11);
    await peer11.leaveRoom(rId11);
    host11.disconnect();
    peer11.disconnect();

    // -------------------------------------------------------------
    // Test 12: No synchronization feedback loop
    // -------------------------------------------------------------
    console.log("\n--- Test 12: No synchronization feedback loop ---");
    const rId12 = getRoomId(12);
    const host12 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer12 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host12.connect();
    await host12.joinRoom(rId12);
    await peer12.connect();
    await peer12.joinRoom(rId12);

    // Host plays
    host12.socket!.emit("play_video", { roomId: rId12, time: 30.0 });
    await peer12.waitForEvent(() => peer12.playEvents, (e) => e.time === 30.0);

    // Peer is in isHandlingRemote mode; verify peer does not echo play_video
    assert(peer12.isHandlingRemote === true, "Peer suppression flag active upon receiving remote play event");

    // Furthermore, if an unauthorized peer attempts to emit play_video, server rejects it
    host12.playEvents = [];
    peer12.socket!.emit("play_video", { roomId: rId12, time: 999.0 });
    await new Promise((r) => setTimeout(r, 200));

    assert(host12.playEvents.length === 0, "Unauthorized peer play command ignored by server; no loop created");

    await host12.leaveRoom(rId12);
    await peer12.leaveRoom(rId12);
    host12.disconnect();
    peer12.disconnect();

    // -------------------------------------------------------------
    // Test 13: No duplicate synchronization listeners
    // -------------------------------------------------------------
    console.log("\n--- Test 13: No duplicate synchronization listeners ---");
    const rId13 = getRoomId(13);
    const host13 = new SimulatedPlaybackClient(hostId, "Host", serverUrl, hostToken, true);
    const peer13 = new SimulatedPlaybackClient(userBId, "Peer", serverUrl, userBToken, false);

    await host13.connect();
    await host13.joinRoom(rId13);
    await peer13.connect();
    await peer13.joinRoom(rId13);

    // Clear and send single sync_time event
    peer13.syncResponses = [];
    host13.socket!.emit("sync_time", { roomId: rId13, time: 888.0, playing: true });
    await peer13.waitForEvent(() => peer13.syncResponses, (e) => e.time === 888.0);
    await new Promise((r) => setTimeout(r, 200));

    assert(peer13.syncResponses.length === 1, "Exactly one sync_response processed per broadcast (no duplicates)");

    await host13.leaveRoom(rId13);
    await peer13.leaveRoom(rId13);
    host13.disconnect();
    peer13.disconnect();
  } finally {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.$disconnect();
  }

  console.log("\n==================================================");
  console.log(`TEST RESULTS: ${testsPassed} PASSED, ${testsFailed} FAILED`);
  console.log("==================================================");

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
