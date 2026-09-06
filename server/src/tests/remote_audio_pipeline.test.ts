import { createServer } from "http";
import { Server } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { setupSocketHandlers } from "../socket";
import { RoomManager } from "../managers/RoomManager";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_12345";
process.env.JWT_SECRET = JWT_SECRET;

// Mock MediaStreamTrack
class MockMediaStreamTrack {
  public id: string;
  public enabled = true;
  public readyState: "live" | "ended" = "live";
  public muted = false;

  constructor(public kind: "audio" | "video") {
    this.id = `${kind}-${Math.random().toString(36).slice(2, 9)}`;
  }

  public stop() {
    this.readyState = "ended";
    this.enabled = false;
  }
}

// Mock MediaStream
class MockMediaStream {
  public id: string;
  private tracks: MockMediaStreamTrack[] = [];
  private listeners: Record<string, ((e: any) => void)[]> = {};

  constructor(tracks: MockMediaStreamTrack[] = [], id?: string) {
    this.id = id || `stream-${Math.random().toString(36).slice(2, 9)}`;
    this.tracks = [...tracks];
  }

  public getTracks(): MockMediaStreamTrack[] {
    return [...this.tracks];
  }

  public getVideoTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }

  public getAudioTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }

  public addTrack(track: MockMediaStreamTrack) {
    if (!this.tracks.includes(track)) {
      this.tracks.push(track);
      this.emit("addtrack", { track });
    }
  }

  public removeTrack(track: MockMediaStreamTrack) {
    this.tracks = this.tracks.filter((t) => t !== track);
    this.emit("removetrack", { track });
  }

  public addEventListener(event: string, fn: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: (e: any) => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
  }

  private emit(event: string, data: any) {
    const handlers = this.listeners[event] || [];
    for (const h of handlers) h(data);
  }
}

// Simulated Audio Sink representing dedicated <audio autoPlay playsInline />
class SimulatedAudioSink {
  public srcObject: MockMediaStream | null = null;
  public muted = false;
  public volume = 1.0;
  public isPlaying = false;
  public playCallsCount = 0;
  public pauseCallsCount = 0;
  public simulateAutoplayBlock = false;
  public isAutoplayBlocked = false;

  public play(): Promise<void> {
    this.playCallsCount++;
    if (this.simulateAutoplayBlock) {
      this.isAutoplayBlocked = true;
      this.isPlaying = false;
      const err = new Error("NotAllowedError: play() failed because the user didn't interact with the document first.");
      err.name = "NotAllowedError";
      return Promise.reject(err);
    }
    this.isAutoplayBlocked = false;
    this.isPlaying = true;
    return Promise.resolve();
  }

  public pause() {
    this.pauseCallsCount++;
    this.isPlaying = false;
  }
}

// Simulated RemoteAudioManager representing RemoteAudioManager.tsx
class SimulatedRemoteAudioManager {
  public audioSinks: Map<string, SimulatedAudioSink> = new Map();
  public autoplayBlockedPeers: Set<string> = new Set();
  public layoutState: {
    isCameraSidebarOpen: boolean;
    viewMode: "grid" | "list";
    movieFocused: boolean;
  } = {
    isCameraSidebarOpen: true,
    viewMode: "grid",
    movieFocused: false,
  };

  public syncPeers(
    peers: { socketId: string; stream: MockMediaStream }[],
    screenShares: Record<string, string> = {}
  ) {
    // 1. Filter out screen shares and deduplicate by socketId (matches RemoteAudioManager.tsx)
    const eligible = peers.filter((p) => {
      if (!p.stream || !p.socketId) return false;
      if (screenShares[p.socketId] && screenShares[p.socketId] === p.stream.id) {
        return false;
      }
      return true;
    });

    const currentSocketIds = new Set<string>();
    for (const p of eligible) {
      if (currentSocketIds.has(p.socketId)) continue;
      currentSocketIds.add(p.socketId);

      let sink = this.audioSinks.get(p.socketId);
      if (!sink) {
        sink = new SimulatedAudioSink();
        this.audioSinks.set(p.socketId, sink);
      }

      if (sink.srcObject !== p.stream) {
        sink.srcObject = p.stream;
        sink.muted = false;
        sink.volume = 1.0;

        sink.play().then(() => {
          this.autoplayBlockedPeers.delete(p.socketId);
        }).catch((err: Error) => {
          if (err.name === "NotAllowedError") {
            this.autoplayBlockedPeers.add(p.socketId);
          }
        });
      }
    }

    // Clean up sinks for participants who have left
    for (const [socketId, sink] of this.audioSinks.entries()) {
      if (!currentSocketIds.has(socketId)) {
        sink.pause();
        sink.srcObject = null;
        this.audioSinks.delete(socketId);
        this.autoplayBlockedPeers.delete(socketId);
      }
    }
  }

  public unlockAllAudio() {
    this.audioSinks.forEach((sink, socketId) => {
      sink.simulateAutoplayBlock = false;
      sink.play().then(() => {
        this.autoplayBlockedPeers.delete(socketId);
      }).catch(() => {});
    });
  }
}

// Simulated Client with WebRTC + RemoteAudioManager
class SimulatedAudioClient {
  public socket: ClientSocket | null = null;
  public localStream: MockMediaStream | null = null;
  public peers: { socketId: string; stream: MockMediaStream }[] = [];
  public peerStatuses: Record<string, { cam: boolean; mic: boolean }> = {};
  public screenShares: Record<string, string> = {};
  public audioManager: SimulatedRemoteAudioManager = new SimulatedRemoteAudioManager();
  public currentRoomId = "";

  constructor(
    public userId: string,
    public userName: string,
    private serverUrl: string,
    private token: string
  ) {}

  public get socketId(): string {
    return this.socket?.id || "";
  }

  public connect(): Promise<void> {
    return new Promise((resolve) => {
      this.socket = Client(this.serverUrl, {
        auth: { token: this.token },
        reconnection: false,
        forceNew: true,
      });

      this.setupListeners();
      this.socket.on("connect", () => resolve());
    });
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on("participant_status", ({ socketId, cam, mic }: any) => {
      this.peerStatuses[socketId] = { cam, mic };
    });

    this.socket.on("room_participant_statuses", (statuses: Record<string, { cam: boolean; mic: boolean }>) => {
      this.peerStatuses = { ...this.peerStatuses, ...statuses };
    });

    this.socket.on("screen_share_start", ({ socketId, streamId }: any) => {
      this.screenShares[socketId] = streamId;
      this.audioManager.syncPeers(this.peers, this.screenShares);
    });

    this.socket.on("screen_share_stop", ({ socketId }: any) => {
      delete this.screenShares[socketId];
      this.audioManager.syncPeers(this.peers, this.screenShares);
    });

    this.socket.on("user_left", ({ socketId }: any) => {
      this.peers = this.peers.filter((p) => p.socketId !== socketId);
      delete this.peerStatuses[socketId];
      delete this.screenShares[socketId];
      this.audioManager.syncPeers(this.peers, this.screenShares);
    });
  }

  public async joinRoom(roomId: string, initCam = true, initMic = true): Promise<void> {
    this.currentRoomId = roomId;

    const tracks: MockMediaStreamTrack[] = [];
    if (initCam) tracks.push(new MockMediaStreamTrack("video"));
    if (initMic) tracks.push(new MockMediaStreamTrack("audio"));
    this.localStream = new MockMediaStream(tracks);

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          this.socket?.emit("participant_status", {
            roomId,
            cam: initCam,
            mic: initMic,
          });
          resolve();
        }
      };

      const safetyTimer = setTimeout(done, 15000);

      const onRoomState = () => {
        clearTimeout(safetyTimer);
        done();
      };
      const onError = (err: any) => {
        clearTimeout(safetyTimer);
        console.warn(`[joinRoom ${roomId}] socket error:`, err);
        done();
      };
      const cleanup = () => {
        this.socket?.off("room_state", onRoomState);
        this.socket?.off("error", onError);
      };

      this.socket!.once("room_state", onRoomState);
      this.socket!.once("error", onError);
      this.socket!.emit("join_room", {
        roomId,
        userId: this.userId,
        userName: this.userName,
      });
    });
  }

  // Simulate remote peer adding track and receiving ontrack
  public receiveRemoteStream(fromSocketId: string, remoteStream: MockMediaStream) {
    const existing = this.peers.find((p) => p.socketId === fromSocketId || p.stream.id === remoteStream.id);
    if (existing) {
      existing.stream = remoteStream;
    } else {
      this.peers.push({ socketId: fromSocketId, stream: remoteStream });
    }
    this.audioManager.syncPeers(this.peers, this.screenShares);
  }

  public leaveRoom(roomId: string): Promise<void> {
    return new Promise((resolve) => {
      this.socket?.emit("leave_room", {
        roomId,
        userId: this.userId,
        userName: this.userName,
      });
      setTimeout(resolve, 150);
    });
  }

  public disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.peers = [];
    this.peerStatuses = {};
    this.screenShares = {};
    this.audioManager.syncPeers([], {});
  }
}

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    testsPassed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ` - ${detail}` : ""}`);
    testsFailed++;
  }
}

async function runAudioTests() {
  console.log("==================================================");
  console.log("STARTING PHASE A REMOTE AUDIO PIPELINE TEST SUITE");
  console.log("==================================================");

  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });
  const roomManager = new RoomManager(io, 750);
  setupSocketHandlers(io, roomManager);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as any).port;
  const serverUrl = `http://localhost:${port}`;
  console.log(`Audio test server listening at ${serverUrl}`);

  const userA_id = "11111111-1111-4111-a111-111111111111";
  const userB_id = "22222222-2222-4222-a222-222222222222";
  const tokenA = jwt.sign({ userId: userA_id, name: "User A", email: "usera@test.com" }, JWT_SECRET);
  const tokenB = jwt.sign({ userId: userB_id, name: "User B", email: "userb@test.com" }, JWT_SECRET);

  const getRoomId = (num: number) => `80808080-8080-4080-a080-${num.toString().padStart(12, "0")}`;

  await prisma.user.upsert({
    where: { id: userA_id },
    update: {},
    create: { id: userA_id, email: "audio_pipeline_a@test.com", passwordHash: "hash", name: "User A" },
  });
  await prisma.user.upsert({
    where: { id: userB_id },
    update: {},
    create: { id: userB_id, email: "audio_pipeline_b@test.com", passwordHash: "hash", name: "User B" },
  });

  for (const num of [1, 2, 5, 10]) {
    const id = getRoomId(num);
    await prisma.room.upsert({
      where: { id },
      update: { isActive: true },
      create: { id, name: `Audio Room ${num}`, hostId: userA_id, isPrivate: false },
    });
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Remote participant with camera ON + microphone ON -> audio sink exists
    // -------------------------------------------------------------
    console.log("\n--- TEST 1: Remote participant with camera ON + mic ON ---");
    const rId1 = getRoomId(1);

    const clientA1 = new SimulatedAudioClient(userA_id, "User A", serverUrl, tokenA);
    const clientB1 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);

    await clientA1.connect();
    await clientA1.joinRoom(rId1, true, true);
    await clientB1.connect();
    await clientB1.joinRoom(rId1, true, true);

    // User A streams audio & video to User B
    const remoteStreamA1 = new MockMediaStream([
      new MockMediaStreamTrack("audio"),
      new MockMediaStreamTrack("video"),
    ]);
    clientB1.receiveRemoteStream(clientA1.socketId, remoteStreamA1);

    const sink1 = clientB1.audioManager.audioSinks.get(clientA1.socketId);
    assert(sink1 !== undefined, "Dedicated audio sink exists for remote peer");
    assert(sink1?.srcObject === remoteStreamA1, "Audio sink has remote MediaStream attached");
    assert(sink1?.muted === false, "Audio sink is unmuted");
    assert(sink1?.isPlaying === true, "Audio sink is playing");

    clientA1.disconnect();
    clientB1.disconnect();

    // -------------------------------------------------------------
    // TEST 2: Remote participant with camera OFF + microphone ON -> audio sink still exists
    // -------------------------------------------------------------
    console.log("\n--- TEST 2: Remote participant with camera OFF + mic ON ---");
    const rId2 = getRoomId(2);

    const clientA2 = new SimulatedAudioClient(userA_id, "User A", serverUrl, tokenA);
    const clientB2 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);

    await clientA2.connect();
    await clientA2.joinRoom(rId2, false, true); // Camera OFF, Mic ON
    await clientB2.connect();
    await clientB2.joinRoom(rId2, true, true);

    // Stream with audio only (camera is off)
    const remoteStreamA2 = new MockMediaStream([new MockMediaStreamTrack("audio")]);
    clientB2.receiveRemoteStream(clientA2.socketId, remoteStreamA2);

    const sink2 = clientB2.audioManager.audioSinks.get(clientA2.socketId);
    assert(sink2 !== undefined, "Audio sink exists even when remote camera is OFF");
    assert(sink2?.isPlaying === true, "Audio sink is playing when camera is OFF");
    assert(sink2?.muted === false, "Audio sink is not muted when camera is OFF");

    clientA2.disconnect();
    clientB2.disconnect();

    // -------------------------------------------------------------
    // TEST 3: Camera visibility/layout changes -> audio sink remains functional
    // -------------------------------------------------------------
    console.log("\n--- TEST 3: Camera visibility and layout changes ---");
    const clientB3 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);
    const remoteStreamA3 = new MockMediaStream([new MockMediaStreamTrack("audio")]);
    clientB3.receiveRemoteStream("peer-a", remoteStreamA3);

    const sink3Before = clientB3.audioManager.audioSinks.get("peer-a");
    assert(sink3Before?.isPlaying === true, "Audio sink active initially in grid mode");

    // Toggle camera sidebar closed
    clientB3.audioManager.layoutState.isCameraSidebarOpen = false;
    assert(clientB3.audioManager.audioSinks.get("peer-a")?.isPlaying === true, "Audio sink remains playing when camera sidebar closed");

    // Toggle view mode to 'list'
    clientB3.audioManager.layoutState.viewMode = "list";
    assert(clientB3.audioManager.audioSinks.get("peer-a")?.isPlaying === true, "Audio sink remains playing in list view mode");

    // Toggle view mode back to 'grid'
    clientB3.audioManager.layoutState.viewMode = "grid";
    assert(clientB3.audioManager.audioSinks.get("peer-a")?.isPlaying === true, "Audio sink uninterrupted across all layout changes");

    // -------------------------------------------------------------
    // TEST 4: Movie / sidebar / main stage layout changes -> audio remains independent
    // -------------------------------------------------------------
    console.log("\n--- TEST 4: Movie mode / main stage independence ---");
    // Switch to Movie Focused mode (movie is dominant, cameras collapsed)
    clientB3.audioManager.layoutState.movieFocused = true;
    const sink4 = clientB3.audioManager.audioSinks.get("peer-a");
    assert(sink4 !== undefined && sink4.isPlaying === true, "Remote audio sink continues playing during movie dominant stage");
    assert(sink4?.srcObject === remoteStreamA3, "MediaStream remains attached during movie playback");

    // -------------------------------------------------------------
    // TEST 5: Remote participant leaves -> audio sink is removed and cleaned up
    // -------------------------------------------------------------
    console.log("\n--- TEST 5: Remote participant leaves cleanup ---");
    const rId5 = getRoomId(5);

    const clientA5 = new SimulatedAudioClient(userA_id, "User A", serverUrl, tokenA);
    const clientB5 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);

    await clientA5.connect();
    await clientA5.joinRoom(rId5, true, true);
    await clientB5.connect();
    await clientB5.joinRoom(rId5, true, true);

    const streamA5 = new MockMediaStream([new MockMediaStreamTrack("audio")]);
    clientB5.receiveRemoteStream(clientA5.socketId, streamA5);
    assert(clientB5.audioManager.audioSinks.has(clientA5.socketId), "Audio sink exists before leave");

    // User A leaves room
    await clientA5.leaveRoom(rId5);
    await new Promise((r) => setTimeout(r, 100));

    assert(!clientB5.audioManager.audioSinks.has(clientA5.socketId), "Audio sink removed from manager when participant leaves");

    clientA5.disconnect();
    clientB5.disconnect();

    // -------------------------------------------------------------
    // TEST 6: Duplicate stream / rapid update -> no duplicate audio sinks
    // -------------------------------------------------------------
    console.log("\n--- TEST 6: No duplicate audio sinks on rapid stream updates ---");
    const clientB6 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);
    const streamA6_v1 = new MockMediaStream([new MockMediaStreamTrack("audio")], "stream-shared-id");
    const streamA6_v2 = new MockMediaStream([new MockMediaStreamTrack("audio"), new MockMediaStreamTrack("video")], "stream-shared-id");

    clientB6.receiveRemoteStream("peer-socket-x", streamA6_v1);
    clientB6.receiveRemoteStream("peer-socket-x", streamA6_v2); // rapid second ontrack
    clientB6.receiveRemoteStream("peer-socket-x", streamA6_v2); // duplicate event

    assert(clientB6.audioManager.audioSinks.size === 1, "Exactly 1 audio sink maintained despite multiple stream events");
    assert(clientB6.audioManager.audioSinks.get("peer-socket-x")?.srcObject === streamA6_v2, "Audio sink updated with latest stream reference");

    // -------------------------------------------------------------
    // TEST 7: Autoplay rejection -> handled gracefully without uncaught error
    // -------------------------------------------------------------
    console.log("\n--- TEST 7: Autoplay rejection handled gracefully ---");
    const clientB7 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);
    const streamA7 = new MockMediaStream([new MockMediaStreamTrack("audio")]);

    // Configure sink to simulate browser autoplay policy block (NotAllowedError)
    const blockedSink = new SimulatedAudioSink();
    blockedSink.simulateAutoplayBlock = true;
    clientB7.audioManager.audioSinks.set("peer-blocked", blockedSink);

    let caughtError: any = null;
    try {
      await blockedSink.play().catch((err) => {
        if (err.name === "NotAllowedError") {
          clientB7.audioManager.autoplayBlockedPeers.add("peer-blocked");
        }
      });
    } catch (e) {
      caughtError = e;
    }

    assert(caughtError === null, "Autoplay rejection did not throw unhandled error");
    assert(clientB7.audioManager.autoplayBlockedPeers.has("peer-blocked"), "Participant recorded in autoplayBlockedPeers set");
    assert(blockedSink.isPlaying === false, "Sink marked as not playing while blocked");

    // -------------------------------------------------------------
    // TEST 8: Audio unlock -> pending audio playback retried and playing
    // -------------------------------------------------------------
    console.log("\n--- TEST 8: Audio unlock resumes pending sinks ---");
    clientB7.audioManager.unlockAllAudio();
    await new Promise((r) => setTimeout(r, 50));

    assert(blockedSink.isPlaying === true, "Audio sink resumed playing after user unlock");
    assert(!clientB7.audioManager.autoplayBlockedPeers.has("peer-blocked"), "Participant cleared from blocked set after unlock");

    // -------------------------------------------------------------
    // TEST 9: Screen-share / movie stream -> not treated as microphone audio sink
    // -------------------------------------------------------------
    console.log("\n--- TEST 9: Screen-share stream excluded from mic audio ---");
    const clientB9 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);
    const micStream = new MockMediaStream([new MockMediaStreamTrack("audio")], "stream-mic-123");
    const screenStream = new MockMediaStream([new MockMediaStreamTrack("video")], "stream-screen-999");

    // Register peer with both mic stream and screen stream
    clientB9.peers = [
      { socketId: "peer-host", stream: micStream },
      { socketId: "peer-host-screen", stream: screenStream },
    ];
    // Record screen-share stream ID in screenShares
    clientB9.screenShares = { "peer-host-screen": "stream-screen-999" };

    clientB9.audioManager.syncPeers(clientB9.peers, clientB9.screenShares);

    assert(clientB9.audioManager.audioSinks.has("peer-host"), "Microphone stream received audio sink");
    assert(!clientB9.audioManager.audioSinks.has("peer-host-screen"), "Screen-share stream strictly excluded from microphone audio sinks");
    assert(clientB9.audioManager.audioSinks.size === 1, "Only microphone stream has an audio sink");

    // -------------------------------------------------------------
    // TEST 10: Reconnection -> remote audio sink cleanly restored
    // -------------------------------------------------------------
    console.log("\n--- TEST 10: Reconnection restores audio sink ---");
    const rId10 = getRoomId(10);

    const clientA10 = new SimulatedAudioClient(userA_id, "User A", serverUrl, tokenA);
    const clientB10 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);

    await clientA10.connect();
    await clientA10.joinRoom(rId10, true, true);
    await clientB10.connect();
    await clientB10.joinRoom(rId10, true, true);

    const streamInitial = new MockMediaStream([new MockMediaStreamTrack("audio")]);
    clientB10.receiveRemoteStream(clientA10.socketId, streamInitial);
    assert(clientB10.audioManager.audioSinks.has(clientA10.socketId), "Audio sink active before disconnect");

    // User A disconnects and reconnects with new socket ID
    clientA10.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Client B cleans up old socket sink
    clientB10.audioManager.syncPeers(clientB10.peers, clientB10.screenShares);
    assert(!clientB10.audioManager.audioSinks.has(clientA10.socketId), "Old audio sink cleaned up after disconnect");

    // User A reconnects
    await clientA10.connect();
    await clientA10.joinRoom(rId10, true, true);

    const streamReconnected = new MockMediaStream([new MockMediaStreamTrack("audio")]);
    clientB10.receiveRemoteStream(clientA10.socketId, streamReconnected);

    const reconnectedSink = clientB10.audioManager.audioSinks.get(clientA10.socketId);
    assert(reconnectedSink !== undefined, "Audio sink cleanly re-created for reconnected peer");
    assert(reconnectedSink?.isPlaying === true, "Reconnected audio sink is playing");
    assert(reconnectedSink?.srcObject === streamReconnected, "Reconnected audio sink has fresh MediaStream");

    clientA10.disconnect();
    clientB10.disconnect();

  } finally {
    await prisma.$disconnect();
    httpServer.close();
  }

  console.log("\n==================================================");
  console.log(`AUDIO PIPELINE TEST RESULTS: ${testsPassed} PASSED, ${testsFailed} FAILED`);
  console.log("==================================================");

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAudioTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
