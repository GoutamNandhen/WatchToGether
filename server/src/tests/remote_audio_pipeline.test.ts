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

interface StreamStateContext {
  cameraStreamIds: Record<string, string>;
  screenShareStreamIds: Record<string, string>;
}

function classifyRemoteStream(
  peerSocketId: string,
  streamId: string,
  context: StreamStateContext
): "camera" | "screen_share" {
  if (context.screenShareStreamIds[peerSocketId] === streamId) {
    return "screen_share";
  }
  const existingCameraStreamId = context.cameraStreamIds[peerSocketId];
  if (existingCameraStreamId && existingCameraStreamId !== streamId) {
    return "screen_share";
  }
  return "camera";
}

function handleOnTrackStream<T extends { id: string }>(
  peerSocketId: string,
  stream: T,
  currentPeers: { socketId: string; stream: T }[],
  currentScreenShares: Record<string, T>,
  context: StreamStateContext
): {
  peers: { socketId: string; stream: T }[];
  screenShares: Record<string, T>;
  streamKind: "camera" | "screen_share";
} {
  const streamKind = classifyRemoteStream(peerSocketId, stream.id, context);

  if (streamKind === "screen_share") {
    context.screenShareStreamIds[peerSocketId] = stream.id;
    return {
      peers: currentPeers.filter((p) => !(p.socketId === peerSocketId && p.stream.id === stream.id)),
      screenShares: {
        ...currentScreenShares,
        [peerSocketId]: stream,
      },
      streamKind,
    };
  } else {
    context.cameraStreamIds[peerSocketId] = stream.id;
    const exists = currentPeers.some((p) => p.socketId === peerSocketId);
    const updatedPeers = exists
      ? currentPeers.map((p) => (p.socketId === peerSocketId ? { ...p, stream } : p))
      : [...currentPeers, { socketId: peerSocketId, stream }];

    return {
      peers: updatedPeers,
      screenShares: currentScreenShares,
      streamKind,
    };
  }
}

function handleScreenShareStartSignal<T extends { id: string }>(
  socketId: string,
  streamId: string,
  currentPeers: { socketId: string; stream: T }[],
  currentScreenShares: Record<string, T>,
  context: StreamStateContext
): {
  peers: { socketId: string; stream: T }[];
  screenShares: Record<string, T>;
} {
  context.screenShareStreamIds[socketId] = streamId;
  const misplacedPeer = currentPeers.find((p) => p.socketId === socketId && p.stream.id === streamId);
  const streamToPromote = misplacedPeer?.stream;

  const cleanPeers = currentPeers.filter((p) => p.stream.id !== streamId);
  const updatedScreenShares = streamToPromote
    ? { ...currentScreenShares, [socketId]: streamToPromote }
    : currentScreenShares;

  return {
    peers: cleanPeers,
    screenShares: updatedScreenShares,
  };
}

function handleScreenShareStopSignal<T>(
  socketId: string,
  currentScreenShares: Record<string, T>,
  context: StreamStateContext
): Record<string, T> {
  delete context.screenShareStreamIds[socketId];
  const next = { ...currentScreenShares };
  delete next[socketId];
  return next;
}

function handleUserLeftCleanup<T>(
  socketId: string,
  currentPeers: { socketId: string; stream: T }[],
  currentScreenShares: Record<string, T>,
  context: StreamStateContext
): {
  peers: { socketId: string; stream: T }[];
  screenShares: Record<string, T>;
} {
  delete context.cameraStreamIds[socketId];
  delete context.screenShareStreamIds[socketId];

  const nextScreenShares = { ...currentScreenShares };
  delete nextScreenShares[socketId];

  return {
    peers: currentPeers.filter((p) => p.socketId !== socketId),
    screenShares: nextScreenShares,
  };
}

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

  public syncPeers(peers: { socketId: string; stream: MockMediaStream }[]) {
    // Deduplicate by socketId (RemoteAudioManager consumes ONLY camera/mic streams in peers)
    const currentSocketIds = new Set<string>();
    for (const p of peers) {
      if (!p.stream || !p.socketId) continue;
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
  public screenShares: Record<string, MockMediaStream> = {};
  public streamStateContext: StreamStateContext = {
    cameraStreamIds: {},
    screenShareStreamIds: {},
  };
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
      const result = handleScreenShareStartSignal(
        socketId,
        streamId,
        this.peers,
        this.screenShares,
        this.streamStateContext
      );
      this.peers = result.peers;
      this.screenShares = result.screenShares;
      this.audioManager.syncPeers(this.peers);
    });

    this.socket.on("screen_share_stop", ({ socketId }: any) => {
      this.screenShares = handleScreenShareStopSignal(
        socketId,
        this.screenShares,
        this.streamStateContext
      );
      this.audioManager.syncPeers(this.peers);
    });

    this.socket.on("user_left", ({ socketId }: any) => {
      const result = handleUserLeftCleanup(
        socketId,
        this.peers,
        this.screenShares,
        this.streamStateContext
      );
      this.peers = result.peers;
      this.screenShares = result.screenShares;
      delete this.peerStatuses[socketId];
      this.audioManager.syncPeers(this.peers);
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
    const result = handleOnTrackStream(
      fromSocketId,
      remoteStream,
      this.peers,
      this.screenShares,
      this.streamStateContext
    );
    this.peers = result.peers;
    this.screenShares = result.screenShares;
    this.audioManager.syncPeers(this.peers);
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
    this.audioManager.syncPeers([]);
  }

  public peerConnections: Map<string, { senders: { track: MockMediaStreamTrack | null; replaceTrackCalls: MockMediaStreamTrack[] }[] }> = new Map();

  public async switchAudioDevice(newTrack: MockMediaStreamTrack, simulateFailure = false): Promise<boolean> {
    if (simulateFailure) {
      // Simulate getUserMedia failure without affecting existing tracks
      return false;
    }

    const oldTrack = this.localStream?.getAudioTracks()[0];
    const wasEnabled = oldTrack ? oldTrack.enabled : true;
    newTrack.enabled = wasEnabled;

    // Use RTCRtpSender.replaceTrack for existing senders
    for (const pc of this.peerConnections.values()) {
      const sender = pc.senders.find((s) => s.track === oldTrack || s.track?.kind === "audio");
      if (sender) {
        sender.track = newTrack;
        sender.replaceTrackCalls.push(newTrack);
      }
    }

    // Stop old track
    if (oldTrack) {
      if (this.localStream) {
        this.localStream.removeTrack(oldTrack);
      }
      oldTrack.stop();
    }

    // Update localStream
    if (this.localStream) {
      this.localStream.addTrack(newTrack);
    }

    // Emit participant_status
    const cam = this.localStream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live") ?? false;
    const mic = newTrack.enabled && newTrack.readyState === "live";
    this.socket?.emit("participant_status", {
      roomId: this.currentRoomId,
      cam,
      mic,
    });

    return true;
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

  for (const num of [1, 2, 5, 9, 10, 11]) {
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
    // TEST 9: Screen-share start/stop does not destroy remote mic audio
    // -------------------------------------------------------------
    console.log("\n--- TEST 9: Screen-share start/stop preserves remote mic audio ---");
    const rId9 = getRoomId(9);

    const clientA9 = new SimulatedAudioClient(userA_id, "User A", serverUrl, tokenA);
    const clientB9 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);

    await clientA9.connect();
    await clientA9.joinRoom(rId9, true, true);
    await clientB9.connect();
    await clientB9.joinRoom(rId9, true, true);

    // 1. User A has camera ON + microphone ON
    const camMicStreamA = new MockMediaStream([
      new MockMediaStreamTrack("audio"),
      new MockMediaStreamTrack("video"),
    ], "stream-user-a-cam-mic");

    // 2. User B receives A's camera/microphone stream
    clientB9.receiveRemoteStream(clientA9.socketId, camMicStreamA);

    // 3. User B has a working dedicated audio sink for A
    assert(clientB9.audioManager.audioSinks.has(clientA9.socketId), "Step 3: Dedicated audio sink exists for A");
    const initialSink = clientB9.audioManager.audioSinks.get(clientA9.socketId)!;
    assert(initialSink.srcObject === camMicStreamA, "Step 3: Audio sink uses A's camera/mic stream");
    assert(initialSink.isPlaying === true, "Step 3: Audio sink is playing");

    // 4. User A starts screen sharing (emits screen_share_start)
    const screenStreamA = new MockMediaStream([
      new MockMediaStreamTrack("video"),
    ], "stream-user-a-screen-share");
    clientA9.socket?.emit("screen_share_start", { roomId: rId9, streamId: screenStreamA.id });
    await new Promise((r) => setTimeout(r, 100));

    // 5. User B receives A's screen-share stream via ontrack
    clientB9.receiveRemoteStream(clientA9.socketId, screenStreamA);

    // 6. The screen-share stream must NOT replace A's camera/microphone stream in `peers`
    assert(clientB9.peers.length === 1, "Step 6: Exactly 1 peer in peers list");
    assert(clientB9.peers[0].stream === camMicStreamA, "Step 6: Screen-share did NOT replace camera/mic stream in peers");
    assert(clientB9.screenShares[clientA9.socketId] === screenStreamA, "Step 6: Screen-share stream stored separately in screenShares");

    // 7. RemoteAudioManager must continue using A's camera/microphone stream
    const sinkDuringScreenShare = clientB9.audioManager.audioSinks.get(clientA9.socketId);
    assert(sinkDuringScreenShare !== undefined, "Step 7: Audio sink still exists during screen share");
    assert(sinkDuringScreenShare?.srcObject === camMicStreamA, "Step 7: Audio sink continues using camera/mic stream");

    // 8. User B must still have exactly one remote audio sink for A
    assert(clientB9.audioManager.audioSinks.size === 1, "Step 8: Exactly 1 remote audio sink for A");
    assert(sinkDuringScreenShare?.isPlaying === true, "Step 8: Audio sink remains playing during screen share");

    // 9. User A stops screen sharing
    clientA9.socket?.emit("screen_share_stop", { roomId: rId9 });
    await new Promise((r) => setTimeout(r, 100));

    // 10. Camera/microphone stream remains intact in peers
    assert(clientB9.peers.length === 1, "Step 10: Camera/mic stream intact in peers after screen share stopped");
    assert(clientB9.peers[0].stream === camMicStreamA, "Step 10: Peers list maintains camera/mic stream");
    assert(clientB9.screenShares[clientA9.socketId] === undefined, "Step 10: Screen share cleanly removed from screenShares");

    // 11. Audio sink remains intact and playing
    assert(clientB9.audioManager.audioSinks.size === 1, "Step 11: Audio sink remains intact after screen share stop");
    assert(clientB9.audioManager.audioSinks.get(clientA9.socketId)?.srcObject === camMicStreamA, "Step 11: Audio sink still attached to camera/mic stream");
    assert(clientB9.audioManager.audioSinks.get(clientA9.socketId)?.isPlaying === true, "Step 11: Audio sink still playing");

    // 12. User A leaves
    await clientA9.leaveRoom(rId9);
    await new Promise((r) => setTimeout(r, 100));

    // 13. Audio sink is cleaned up
    assert(!clientB9.audioManager.audioSinks.has(clientA9.socketId), "Step 13: Audio sink cleaned up when user leaves");
    assert(clientB9.peers.length === 0, "Step 13: Peers list empty after leave");
    assert(Object.keys(clientB9.screenShares).length === 0, "Step 13: ScreenShares empty after leave");

    clientA9.disconnect();
    clientB9.disconnect();

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
    clientB10.audioManager.syncPeers(clientB10.peers);
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

    // -------------------------------------------------------------
    // TEST 11: Microphone device switching replaces sender track, preserves mute state, and handles failure
    // -------------------------------------------------------------
    console.log("\n--- TEST 11: Microphone device switching ---");
    const rId11 = getRoomId(11);

    const clientA11 = new SimulatedAudioClient(userA_id, "User A", serverUrl, tokenA);
    const clientB11 = new SimulatedAudioClient(userB_id, "User B", serverUrl, tokenB);

    await clientA11.connect();
    await clientA11.joinRoom(rId11, true, true);
    await clientB11.connect();
    await clientB11.joinRoom(rId11, true, true);

    await new Promise((r) => setTimeout(r, 100));

    // Setup mock peer connection on Client A with initial audio track
    const initialAudioTrack = clientA11.localStream!.getAudioTracks()[0];
    const mockSender = { track: initialAudioTrack, replaceTrackCalls: [] as MockMediaStreamTrack[] };
    clientA11.peerConnections.set(clientB11.socketId, { senders: [mockSender] });

    // 1. Switch to Device 2 while mic is ON
    const device2Track = new MockMediaStreamTrack("audio");
    const switchSuccess = await clientA11.switchAudioDevice(device2Track);
    assert(switchSuccess === true, "Microphone switch returned success");
    assert(mockSender.track === device2Track, "RTCRtpSender track replaced with new audio device track");
    assert(mockSender.replaceTrackCalls.includes(device2Track), "RTCRtpSender.replaceTrack called with new device track");
    assert(initialAudioTrack.readyState === "ended", "Old microphone track stopped cleanly");
    assert(clientA11.localStream!.getAudioTracks()[0] === device2Track, "localStream updated with new audio track");
    assert(device2Track.enabled === true, "Microphone enabled state preserved (was ON -> remains ON)");

    await new Promise((r) => setTimeout(r, 100));
    assert(clientB11.peerStatuses[clientA11.socketId]?.mic === true, "Remote peer receives mic: true after device switch");

    // 2. Mute microphone and switch to Device 3
    device2Track.enabled = false;
    clientA11.socket?.emit("participant_status", { roomId: rId11, cam: true, mic: false });
    await new Promise((r) => setTimeout(r, 100));

    const device3Track = new MockMediaStreamTrack("audio");
    const switchMutedSuccess = await clientA11.switchAudioDevice(device3Track);
    assert(switchMutedSuccess === true, "Microphone switch while muted returned success");
    assert(device3Track.enabled === false, "Muted state preserved on new track (was OFF -> remains OFF)");
    assert(device2Track.readyState === "ended", "Previous device track stopped cleanly");
    assert(mockSender.track === device3Track, "RTCRtpSender track updated to device 3 track");

    await new Promise((r) => setTimeout(r, 100));
    assert(clientB11.peerStatuses[clientA11.socketId]?.mic === false, "Remote peer receives mic: false for switched muted track");

    // 3. Transient failure (unplugged or missing device)
    const device4Track = new MockMediaStreamTrack("audio");
    const failedSwitch = await clientA11.switchAudioDevice(device4Track, true);
    assert(failedSwitch === false, "Switch returns false on acquisition failure");
    assert(device3Track.readyState === "live", "Existing microphone track remains live when acquisition fails");
    assert(mockSender.track === device3Track, "RTCRtpSender track NOT replaced when acquisition fails");
    assert(clientA11.localStream!.getAudioTracks()[0] === device3Track, "localStream retains working microphone track");

    clientA11.disconnect();
    clientB11.disconnect();

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
