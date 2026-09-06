import { createServer } from "http";
import { Server } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { setupSocketHandlers } from "../socket";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_12345";
process.env.JWT_SECRET = JWT_SECRET;

// Mock MediaStreamTrack
class MockMediaStreamTrack {
  public id: string;
  public enabled = true;
  public readyState: "live" | "ended" = "live";
  public onended: (() => void) | null = null;

  constructor(public kind: "audio" | "video") {
    this.id = `${kind}-${Math.random().toString(36).slice(2, 9)}`;
  }

  public stop() {
    this.readyState = "ended";
    this.enabled = false;
    if (this.onended) this.onended();
  }
}

// Mock MediaStream
class MockMediaStream {
  public id: string;
  private tracks: MockMediaStreamTrack[] = [];

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
    this.tracks.push(track);
  }

  public removeTrack(track: MockMediaStreamTrack) {
    this.tracks = this.tracks.filter((t) => t.id !== track.id);
  }
}

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

// Simulated Participant with Room & useWebRTC stream routing logic
class SimulatedParticipant {
  public socket: ClientSocket | null = null;
  public peers: { socketId: string; stream: MockMediaStream }[] = [];
  public screenShares: Record<string, MockMediaStream | string> = {};
  public streamStateContext: StreamStateContext = {
    cameraStreamIds: {},
    screenShareStreamIds: {},
  };
  public mainScreenSource: "url" | string = "url";
  public localScreenStream: MockMediaStream | null = null;
  private prevRemoteStreamIds: string[] = [];

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

    this.socket.on("screen_share_start", ({ socketId, streamId }) => {
      this.streamStateContext.screenShareStreamIds[socketId] = streamId;

      // Promote any misplaced stream already in peers
      const misplacedIdx = this.peers.findIndex((p) => p.socketId === socketId && p.stream.id === streamId);
      let streamToPromote: MockMediaStream | undefined;
      if (misplacedIdx !== -1) {
        streamToPromote = this.peers[misplacedIdx].stream;
        this.peers.splice(misplacedIdx, 1);
      }

      this.screenShares[socketId] = streamToPromote || this.screenShares[socketId] || streamId;
      this.syncMainScreenSource();
    });

    this.socket.on("screen_share_stop", ({ socketId }) => {
      delete this.streamStateContext.screenShareStreamIds[socketId];
      delete this.screenShares[socketId];
      this.syncMainScreenSource();
    });
  }

  // Simulate ontrack event
  public handleOnTrack(peerSocketId: string, stream: MockMediaStream) {
    const kind = classifyRemoteStream(peerSocketId, stream.id, this.streamStateContext);

    if (kind === "screen_share") {
      this.streamStateContext.screenShareStreamIds[peerSocketId] = stream.id;
      this.screenShares[peerSocketId] = stream;
      this.peers = this.peers.filter((p) => !(p.socketId === peerSocketId && p.stream.id === stream.id));
    } else {
      this.streamStateContext.cameraStreamIds[peerSocketId] = stream.id;
      const idx = this.peers.findIndex((p) => p.socketId === peerSocketId);
      if (idx !== -1) {
        this.peers[idx] = { socketId: peerSocketId, stream };
      } else {
        this.peers.push({ socketId: peerSocketId, stream });
      }
    }

    this.syncMainScreenSource();
  }

  // Exact reproduction of Room.tsx useEffect for main stage stream synchronization
  public syncMainScreenSource() {
    const activeRemoteStreams = Object.values(this.screenShares)
      .map((s) => (typeof s === "string" ? null : s))
      .filter((s): s is MockMediaStream => !!s);

    const activeRemoteStreamIds = activeRemoteStreams.map((s) => s.id);
    const prevStreamIds = this.prevRemoteStreamIds;

    // Detect newly arrived remote broadcast/screen-share stream
    const newlyArrivedStream = activeRemoteStreams.find((s) => !prevStreamIds.includes(s.id));

    if (newlyArrivedStream) {
      this.mainScreenSource = newlyArrivedStream.id;
    } else if (this.mainScreenSource !== "url") {
      const isLocalActive = this.localScreenStream && this.localScreenStream.id === this.mainScreenSource;
      const isRemoteActive = activeRemoteStreamIds.includes(this.mainScreenSource);

      if (!isLocalActive && !isRemoteActive) {
        this.mainScreenSource = "url";
      }
    }

    this.prevRemoteStreamIds = activeRemoteStreamIds;
  }

  // Movie stage stream resolver (strictly excludes camera/mic streams)
  public getMovieStageStream(): MockMediaStream | null {
    if (this.mainScreenSource === "url") return null;

    const availableStreams = [
      ...(this.localScreenStream ? [this.localScreenStream] : []),
      ...Object.values(this.screenShares).filter((s): s is MockMediaStream => typeof s !== "string" && !!s),
    ];

    return availableStreams.find((s) => s.id === this.mainScreenSource) || null;
  }

  public joinRoom(roomId: string): Promise<any> {
    return new Promise((resolve) => {
      this.socket!.emit("join_room", { roomId, userId: this.userId, userName: this.userName });
      this.socket!.once("room_state", (state: any) => resolve(state));
    });
  }

  public broadcastLocalVideo(stream: MockMediaStream, roomId: string) {
    this.localScreenStream = stream;
    this.socket?.emit("screen_share_start", { roomId, streamId: stream.id });
  }

  public stopLocalVideo(roomId: string) {
    this.localScreenStream = null;
    this.socket?.emit("screen_share_stop", { roomId });
  }

  public disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

async function runLocalVideoPresentationTests() {
  console.log("==================================================");
  console.log("STARTING PHASE B.5 LOCAL VIDEO PRESENTATION TESTS");
  console.log("==================================================");

  const server = createServer();
  const io = new Server(server, { cors: { origin: "*" } });
  setupSocketHandlers(io);

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as any).port;
  const serverUrl = `http://localhost:${port}`;

  const results: { name: string; pass: boolean; expected: any; actual: any }[] = [];
  function assert(condition: boolean, name: string, expected: any, actual: any) {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      results.push({ name, pass: true, expected, actual });
    } else {
      console.error(`  [FAIL] ${name} (Expected: ${expected}, Actual: ${actual})`);
      results.push({ name, pass: false, expected, actual });
    }
  }

  try {
    const userAId = "11111111-1111-4111-a111-111111111111";
    const userBId = "22222222-2222-4222-a222-222222222222";
    const tokenA = jwt.sign({ userId: userAId, email: "usera@test.com" }, JWT_SECRET);
    const tokenB = jwt.sign({ userId: userBId, email: "userb@test.com" }, JWT_SECRET);

    // Create test room
    const testRoom = await prisma.room.upsert({
      where: { id: "90909090-9090-4090-a090-000000000001" },
      update: { isActive: true },
      create: {
        id: "90909090-9090-4090-a090-000000000001",
        name: "B.5 Local Video Room",
        hostId: userAId,
        isActive: true,
      },
    });

    const host = new SimulatedParticipant(userAId, "Host A", serverUrl, tokenA);
    const participant = new SimulatedParticipant(userBId, "Participant B", serverUrl, tokenB);

    await host.connect();
    await host.joinRoom(testRoom.id);
    await participant.connect();
    await participant.joinRoom(testRoom.id);

    // Establish primary camera/mic streams initially
    const hostCamStream = new MockMediaStream([new MockMediaStreamTrack("video"), new MockMediaStreamTrack("audio")], "host-cam-stream");
    participant.handleOnTrack(host.socketId, hostCamStream);

    console.log("\n--- TEST 1: Initial state before local video ---");
    assert(participant.mainScreenSource === "url", "Initial mainScreenSource defaults to 'url'", "url", participant.mainScreenSource);
    assert(participant.getMovieStageStream() === null, "Movie stage stream is null while on 'url'", null, participant.getMovieStageStream());
    assert(participant.peers.length === 1, "Camera stream correctly stored in peers", 1, participant.peers.length);
    assert(participant.peers[0].stream.id === "host-cam-stream", "Peers contains host camera stream", "host-cam-stream", participant.peers[0].stream.id);

    console.log("\n--- TEST 2: Host starts local video -> automatic main-stage presentation ---");
    const capturedVideoStream = new MockMediaStream([new MockMediaStreamTrack("video")], "captured-local-movie-123");
    
    // Host broadcasts captured local video
    host.broadcastLocalVideo(capturedVideoStream, testRoom.id);
    await new Promise((r) => setTimeout(r, 100));

    // WebRTC ontrack arrives on participant
    participant.handleOnTrack(host.socketId, capturedVideoStream);

    assert(participant.mainScreenSource === "captured-local-movie-123", "Remote mainScreenSource automatically switches to captured local video stream", "captured-local-movie-123", participant.mainScreenSource);
    assert(participant.getMovieStageStream()?.id === "captured-local-movie-123", "Movie stage renders captured local video stream", "captured-local-movie-123", participant.getMovieStageStream()?.id);
    assert(participant.screenShares[host.socketId] !== undefined, "Captured stream stored in screenShares", true, participant.screenShares[host.socketId] !== undefined);

    console.log("\n--- TEST 3: Camera/mic streams remain strictly isolated from movie stage ---");
    assert(participant.peers.length === 1, "Host camera stream remains in peers", 1, participant.peers.length);
    assert(participant.peers[0].stream.id === "host-cam-stream", "Peers does NOT contain the captured local video stream", "host-cam-stream", participant.peers[0].stream.id);
    
    // If someone attempts to set mainScreenSource to camera stream ID, movie stage refuses to render it
    participant.mainScreenSource = "host-cam-stream";
    assert(participant.getMovieStageStream() === null, "Movie stage strictly refuses to render camera/mic stream", null, participant.getMovieStageStream());
    // Restore back
    participant.mainScreenSource = "captured-local-movie-123";

    console.log("\n--- TEST 4: Host stops local video -> automatic return to 'url' ---");
    host.stopLocalVideo(testRoom.id);
    await new Promise((r) => setTimeout(r, 100));

    assert(participant.screenShares[host.socketId] === undefined, "Captured stream cleanly deleted from screenShares", undefined, participant.screenShares[host.socketId]);
    assert(participant.mainScreenSource === "url", "Remote mainScreenSource automatically reverts to 'url'", "url", participant.mainScreenSource);
    assert(participant.getMovieStageStream() === null, "Movie stage returns to normal URL movie player", null, participant.getMovieStageStream());
    assert(participant.peers.length === 1, "Camera stream remains completely intact in peers after local video stops", 1, participant.peers.length);

    console.log("\n--- TEST 5: Ordering resilience: ontrack arrives BEFORE screen_share_start ---");
    const streamArrivingFirst = new MockMediaStream([new MockMediaStreamTrack("video")], "stream-arriving-early-456");
    
    // WebRTC ontrack fires before socket event
    participant.handleOnTrack(host.socketId, streamArrivingFirst);
    assert(participant.mainScreenSource === "stream-arriving-early-456", "Stream automatically promoted when ontrack arrives first", "stream-arriving-early-456", participant.mainScreenSource);

    // Socket screen_share_start arrives later
    host.socket?.emit("screen_share_start", { roomId: testRoom.id, streamId: "stream-arriving-early-456" });
    await new Promise((r) => setTimeout(r, 100));

    assert(participant.mainScreenSource === "stream-arriving-early-456", "Main stage remains on stream after delayed signal", "stream-arriving-early-456", participant.mainScreenSource);
    assert(participant.peers.some((p) => p.stream.id === "stream-arriving-early-456") === false, "Screen-share stream is never in peers", false, participant.peers.some((p) => p.stream.id === "stream-arriving-early-456"));

    // Cleanup Test 5
    host.stopLocalVideo(testRoom.id);
    await new Promise((r) => setTimeout(r, 100));
    assert(participant.mainScreenSource === "url", "Reverts to 'url' after cleanup", "url", participant.mainScreenSource);

    console.log("\n--- TEST 6: Ordering resilience: screen_share_start arrives BEFORE ontrack ---");
    const streamArrivingLate = new MockMediaStream([new MockMediaStreamTrack("video")], "stream-arriving-late-789");

    // Socket signal arrives first
    host.socket?.emit("screen_share_start", { roomId: testRoom.id, streamId: "stream-arriving-late-789" });
    await new Promise((r) => setTimeout(r, 100));

    // WebRTC ontrack arrives later
    participant.handleOnTrack(host.socketId, streamArrivingLate);

    assert(participant.mainScreenSource === "stream-arriving-late-789", "Stream automatically promoted when ontrack arrives after signal", "stream-arriving-late-789", participant.mainScreenSource);
    assert(participant.getMovieStageStream()?.id === "stream-arriving-late-789", "Movie stage renders correctly", "stream-arriving-late-789", participant.getMovieStageStream()?.id);

    // Clean up
    host.stopLocalVideo(testRoom.id);
    await new Promise((r) => setTimeout(r, 100));
    assert(participant.mainScreenSource === "url", "Cleanly returns to 'url'", "url", participant.mainScreenSource);

    host.disconnect();
    participant.disconnect();
  } finally {
    server.close();
    await prisma.$disconnect();
  }

  console.log("\n==================================================");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`PHASE B.5 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runLocalVideoPresentationTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
