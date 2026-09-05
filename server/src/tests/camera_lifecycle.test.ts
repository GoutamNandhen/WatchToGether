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
  public muted = false;
  public onmute: (() => void) | null = null;
  public onunmute: (() => void) | null = null;

  constructor(public kind: "audio" | "video") {
    this.id = `${kind}-${Math.random().toString(36).slice(2, 9)}`;
  }

  public stop() {
    this.readyState = "ended";
    this.enabled = false;
  }

  public triggerMute() {
    this.muted = true;
    if (this.onmute) this.onmute();
  }

  public triggerUnmute() {
    this.muted = false;
    if (this.onunmute) this.onunmute();
  }
}

// Mock MediaStream
class MockMediaStream {
  public id: string;
  private tracks: MockMediaStreamTrack[] = [];

  constructor(tracks: MockMediaStreamTrack[] = []) {
    this.id = `stream-${Math.random().toString(36).slice(2, 9)}`;
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
    }
  }

  public removeTrack(track: MockMediaStreamTrack) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

// Mock RTCRtpSender
class MockRTCRtpSender {
  constructor(public track: MockMediaStreamTrack | null) {}

  public async replaceTrack(newTrack: MockMediaStreamTrack | null): Promise<void> {
    this.track = newTrack;
  }
}

// Mock RTCRtpTransceiver
class MockRTCRtpTransceiver {
  public sender: MockRTCRtpSender;
  public receiver: { track: MockMediaStreamTrack };
  public direction: string;

  constructor(kind: "audio" | "video", senderTrack: MockMediaStreamTrack | null, direction: string = "sendrecv") {
    this.sender = new MockRTCRtpSender(senderTrack);
    this.receiver = { track: new MockMediaStreamTrack(kind) };
    this.direction = direction;
  }
}

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  private transceivers: MockRTCRtpTransceiver[] = [];
  public ontrack: ((event: { streams: MockMediaStream[]; track: MockMediaStreamTrack }) => void) | null = null;
  public onnegotiationneeded: (() => void) | null = null;
  public isClosed = false;

  public getTransceivers(): MockRTCRtpTransceiver[] {
    return [...this.transceivers];
  }

  public getSenders(): MockRTCRtpSender[] {
    return this.transceivers.map((t) => t.sender);
  }

  public addTrack(track: MockMediaStreamTrack, _stream: MockMediaStream): MockRTCRtpSender {
    let transceiver = this.transceivers.find(
      (t) => t.receiver.track.kind === track.kind && t.sender.track === null
    );
    if (transceiver) {
      transceiver.sender.track = track;
      return transceiver.sender;
    }
    transceiver = new MockRTCRtpTransceiver(track.kind, track);
    this.transceivers.push(transceiver);
    return transceiver.sender;
  }

  public addTransceiver(kind: "audio" | "video", init?: { direction?: string; streams?: MockMediaStream[] }): MockRTCRtpTransceiver {
    const transceiver = new MockRTCRtpTransceiver(kind, null, init?.direction || "sendrecv");
    this.transceivers.push(transceiver);
    return transceiver;
  }

  public close() {
    this.isClosed = true;
    this.transceivers = [];
  }
}

// Simulated Client representing useWebRTC behavior
class SimulatedCameraClient {
  public socket: ClientSocket | null = null;
  public peerConnections: Record<string, MockRTCPeerConnection> = {};
  public peerStatuses: Record<string, { cam: boolean; mic: boolean }> = {};
  public localStream: MockMediaStream | null = null;
  public isTogglingVideo = false;
  public pendingVideoToggle = false;
  public statusEventsReceived: any[] = [];
  public roomStatusEventsReceived: any[] = [];
  public userJoinedEvents: any[] = [];
  public userLeftEvents: any[] = [];

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

      this.socket.on("connect", () => {
        resolve();
      });
    });
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on("participant_status", (data: any) => {
      this.statusEventsReceived.push(data);
      this.peerStatuses[data.socketId] = { cam: data.cam, mic: data.mic };
    });

    this.socket.on("room_participant_statuses", (statuses: Record<string, { cam: boolean; mic: boolean }>) => {
      this.roomStatusEventsReceived.push(statuses);
      this.peerStatuses = { ...this.peerStatuses, ...statuses };
    });

    this.socket.on("user_joined", (data: any) => {
      this.userJoinedEvents.push(data);
      // Create peer connection for new user
      if (this.localStream) {
        this.createPeerConnection(data.socketId, this.localStream);
        const cam = this.localStream.getVideoTracks().some((t) => t.enabled && t.readyState === "live");
        const mic = this.localStream.getAudioTracks().some((t) => t.enabled && t.readyState === "live");
        this.socket?.emit("participant_status", { roomId: this.currentRoomId, cam, mic });
      }
    });

    this.socket.on("user_left", (data: any) => {
      this.userLeftEvents.push(data);
      if (this.peerConnections[data.socketId]) {
        this.peerConnections[data.socketId].close();
        delete this.peerConnections[data.socketId];
      }
      delete this.peerStatuses[data.socketId];
    });
  }

  public currentRoomId: string = "";

  public joinRoom(roomId: string, password?: string): Promise<any> {
    this.currentRoomId = roomId;
    return new Promise((resolve) => {
      this.socket!.emit("join_room", { roomId, userId: this.userId, userName: this.userName, password });
      this.socket!.once("room_state", (state: any) => {
        resolve(state);
      });
    });
  }

  public initLocalMedia(cameraOn: boolean, micOn: boolean = true) {
    const tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack("audio")];
    if (cameraOn) {
      tracks.push(new MockMediaStreamTrack("video"));
    }
    this.localStream = new MockMediaStream(tracks);
    const cam = this.localStream.getVideoTracks().some((t) => t.enabled && t.readyState === "live");
    const mic = this.localStream.getAudioTracks().some((t) => t.enabled && t.readyState === "live");
    this.socket?.emit("participant_status", { roomId: this.currentRoomId, cam, mic });
  }

  public createPeerConnection(peerSocketId: string, stream: MockMediaStream): MockRTCPeerConnection {
    const pc = new MockRTCPeerConnection();
    const hasVideo = stream.getVideoTracks().some((t) => t.readyState === "live");

    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });

    // Pre-negotiate video transceiver if initially camera off
    if (!hasVideo) {
      pc.addTransceiver("video", { direction: "sendrecv", streams: [stream] });
    }

    pc.ontrack = (event) => {
      if (event.track) {
        event.track.onmute = () => {
          if (event.track.kind === "video") {
            this.peerStatuses[peerSocketId] = {
              ...(this.peerStatuses[peerSocketId] || { mic: true }),
              cam: false,
            };
          }
        };
        event.track.onunmute = () => {
          if (event.track.kind === "video") {
            this.peerStatuses[peerSocketId] = {
              ...(this.peerStatuses[peerSocketId] || { mic: true }),
              cam: true,
            };
          }
        };
      }
    };

    this.peerConnections[peerSocketId] = pc;
    return pc;
  }

  public findVideoSender(pc: MockRTCPeerConnection): MockRTCRtpSender | undefined {
    const videoTransceiver = pc.getTransceivers().find(
      (t: MockRTCRtpTransceiver) => t.receiver?.track?.kind === "video" || (t.sender?.track && t.sender.track.kind === "video")
    );
    if (videoTransceiver) return videoTransceiver.sender;
    const senders = pc.getSenders();
    return senders.find((s) => s.track && s.track.kind === "video") || senders.find((s) => s.track === null);
  }

  private togglePromiseQueue: Promise<void> = Promise.resolve();

  public leaveRoom(roomId: string): Promise<void> {
    if (this.socket && this.socket.connected) {
      this.socket.emit("leave_room", { roomId, userId: this.userId, userName: this.userName });
    }
    return new Promise((r) => setTimeout(r, 200));
  }

  public async toggleVideo(simulateError: boolean = false): Promise<void> {
    this.togglePromiseQueue = this.togglePromiseQueue.then(async () => {
      if (!this.localStream) return;

      const currentVideoTrack = this.localStream.getVideoTracks().find((t) => t.readyState === "live");
      const mic = this.localStream.getAudioTracks().some((t) => t.enabled && t.readyState === "live");

      if (currentVideoTrack) {
        // --- CAMERA OFF ---
        await Promise.all(
          Object.values(this.peerConnections).map(async (pc) => {
            const sender = this.findVideoSender(pc);
            if (sender) {
              await sender.replaceTrack(null);
            }
          })
        );

        currentVideoTrack.stop();
        this.localStream.removeTrack(currentVideoTrack);
        this.socket?.emit("participant_status", { roomId: this.currentRoomId, cam: false, mic });
      } else {
        // --- CAMERA ON ---
        try {
          if (simulateError) {
            throw new Error("NotAllowedError: Permission denied");
          }
          const newVideoTrack = new MockMediaStreamTrack("video");
          this.localStream.addTrack(newVideoTrack);

          await Promise.all(
            Object.values(this.peerConnections).map(async (pc) => {
              const sender = this.findVideoSender(pc);
              if (sender) {
                await sender.replaceTrack(newVideoTrack);
              } else {
                pc.addTrack(newVideoTrack, this.localStream!);
              }
            })
          );

          this.socket?.emit("participant_status", { roomId: this.currentRoomId, cam: true, mic });
        } catch (err) {
          this.socket?.emit("participant_status", { roomId: this.currentRoomId, cam: false, mic });
        }
      }
    }).catch((err) => {
      console.error("toggleVideo error:", err);
    });

    return this.togglePromiseQueue;
  }

  public disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    Object.values(this.peerConnections).forEach((pc) => pc.close());
    this.peerConnections = {};
  }
}

// Test Runner
async function runCameraLifecycleTests() {
  console.log("==================================================");
  console.log("STARTING P2 CAMERA LIFECYCLE AUTOMATED TEST SUITE");
  console.log("==================================================");

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition: boolean, message: string, expected?: any, actual?: any) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passedTests++;
    } else {
      console.error(`  [FAIL] ${message}`);
      if (expected !== undefined || actual !== undefined) {
        console.error(`    Expected: ${expected}`);
        console.error(`    Actual:   ${actual}`);
      }
      failedTests++;
    }
  }

  // Create isolated test server
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });
  setupSocketHandlers(io);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address() as any;
  const serverUrl = `http://localhost:${address.port}`;
  console.log(`Camera test server listening at ${serverUrl}`);

  // Neon DB seed with retry
  const userAId = "11111111-1111-4111-a111-111111111111";
  const userBId = "22222222-2222-4222-a222-222222222222";
  const userCId = "33333333-3333-4333-a333-333333333333";

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await prisma.user.upsert({
        where: { id: userAId },
        update: { name: "User A" },
        create: { id: userAId, email: "camA@test.com", name: "User A", passwordHash: "pwd" },
      });
      await prisma.user.upsert({
        where: { id: userBId },
        update: { name: "User B" },
        create: { id: userBId, email: "camB@test.com", name: "User B", passwordHash: "pwd" },
      });
      await prisma.user.upsert({
        where: { id: userCId },
        update: { name: "User C" },
        create: { id: userCId, email: "camC@test.com", name: "User C", passwordHash: "pwd" },
      });
      break;
    } catch (e: any) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const tokenA = jwt.sign({ userId: userAId, email: "camA@test.com", name: "User A" }, JWT_SECRET);
  const tokenB = jwt.sign({ userId: userBId, email: "camB@test.com", name: "User B" }, JWT_SECRET);
  const tokenC = jwt.sign({ userId: userCId, email: "camC@test.com", name: "User C" }, JWT_SECRET);

  let testRoomIdx = 1;
  const getNextRoom = async () => {
    const roomId = `60606060-6060-4060-a060-${testRoomIdx.toString().padStart(12, "0")}`;
    testRoomIdx++;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await prisma.room.upsert({
          where: { id: roomId },
          update: {},
          create: { id: roomId, name: `CamRoom ${testRoomIdx}`, hostId: userAId, isPrivate: false },
        });
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return roomId;
  };

  try {
    // --- TEST 1: Camera initially ON ---
    console.log("\n--- TEST 1: Camera initially ON ---");
    const r1 = await getNextRoom();
    const clientA1 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB1 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA1.connect();
    await clientA1.joinRoom(r1);
    clientA1.initLocalMedia(true);

    await clientB1.connect();
    await clientB1.joinRoom(r1);
    clientB1.initLocalMedia(true);

    await new Promise((r) => setTimeout(r, 300));
    const bStatusOfA = clientB1.peerStatuses[clientA1.socketId];
    assert(bStatusOfA?.cam === true, "Remote participant sees User A camera ON", true, bStatusOfA?.cam);
    assert(clientA1.localStream!.getVideoTracks().length === 1, "User A local stream contains 1 video track", 1, clientA1.localStream!.getVideoTracks().length);
    clientA1.disconnect();
    clientB1.disconnect();

    // --- TEST 2: Camera initially OFF ---
    console.log("\n--- TEST 2: Camera initially OFF ---");
    const r2 = await getNextRoom();
    const clientA2 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB2 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA2.connect();
    await clientA2.joinRoom(r2);
    clientA2.initLocalMedia(false); // Initially OFF

    await clientB2.connect();
    await clientB2.joinRoom(r2);
    clientB2.initLocalMedia(true);

    await new Promise((r) => setTimeout(r, 300));
    const bStatusOfA2 = clientB2.peerStatuses[clientA2.socketId];
    assert(bStatusOfA2?.cam === false, "Remote participant sees User A camera OFF initially without defaulting to true", false, bStatusOfA2?.cam);

    const pcA2 = clientA2.peerConnections[clientB2.socketId];
    const transceivers = pcA2?.getTransceivers() || [];
    const hasVideoTransceiver = transceivers.some((t: MockRTCRtpTransceiver) => t.receiver.track.kind === "video");
    assert(hasVideoTransceiver, "Video transceiver pre-negotiated even when camera initially OFF", true, hasVideoTransceiver);
    clientA2.disconnect();
    clientB2.disconnect();

    // --- TEST 3: Camera ON → OFF ---
    console.log("\n--- TEST 3: Camera ON -> OFF ---");
    const r3 = await getNextRoom();
    const clientA3 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB3 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA3.connect();
    await clientA3.joinRoom(r3);
    clientA3.initLocalMedia(true);

    await clientB3.connect();
    await clientB3.joinRoom(r3);
    clientB3.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 200));

    // Turn camera OFF
    await clientA3.toggleVideo();
    await new Promise((r) => setTimeout(r, 300));

    const pcA3 = clientA3.peerConnections[clientB3.socketId];
    const videoSender = clientA3.findVideoSender(pcA3);
    assert(videoSender?.track === null, "Sender track replaced with null on camera OFF", null, videoSender?.track);
    assert(clientA3.localStream!.getVideoTracks().length === 0, "Local video track removed from stream", 0, clientA3.localStream!.getVideoTracks().length);
    assert(clientB3.peerStatuses[clientA3.socketId]?.cam === false, "Remote peer receives cam: false status", false, clientB3.peerStatuses[clientA3.socketId]?.cam);
    clientA3.disconnect();
    clientB3.disconnect();

    // --- TEST 4: Camera OFF → ON ---
    console.log("\n--- TEST 4: Camera OFF -> ON ---");
    const r4 = await getNextRoom();
    const clientA4 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB4 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA4.connect();
    await clientA4.joinRoom(r4);
    clientA4.initLocalMedia(false); // starts OFF

    await clientB4.connect();
    await clientB4.joinRoom(r4);
    clientB4.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 200));

    // Turn camera ON
    await clientA4.toggleVideo();
    await new Promise((r) => setTimeout(r, 300));

    const pcA4 = clientA4.peerConnections[clientB4.socketId];
    const videoSender4 = clientA4.findVideoSender(pcA4);
    assert(videoSender4?.track !== null && videoSender4?.track?.readyState === "live", "Sender reattached with live video track", "live", videoSender4?.track?.readyState);
    assert(clientB4.peerStatuses[clientA4.socketId]?.cam === true, "Remote peer receives cam: true status", true, clientB4.peerStatuses[clientA4.socketId]?.cam);
    clientA4.disconnect();
    clientB4.disconnect();

    // --- TEST 5: Rapid camera toggling ---
    console.log("\n--- TEST 5: Rapid camera toggling ---");
    const r5 = await getNextRoom();
    const clientA5 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB5 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA5.connect();
    await clientA5.joinRoom(r5);
    clientA5.initLocalMedia(false);

    await clientB5.connect();
    await clientB5.joinRoom(r5);
    clientB5.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 200));

    // Fire 5 rapid toggles: ON -> OFF -> ON -> OFF -> ON
    const t1 = clientA5.toggleVideo();
    const t2 = clientA5.toggleVideo();
    const t3 = clientA5.toggleVideo();
    const t4 = clientA5.toggleVideo();
    const t5 = clientA5.toggleVideo();
    await Promise.all([t1, t2, t3, t4, t5]);
    await new Promise((r) => setTimeout(r, 300));

    const pcA5 = clientA5.peerConnections[clientB5.socketId];
    const senders5 = pcA5.getSenders();
    assert(senders5.length <= 2, "No duplicate senders created during rapid toggle", "<= 2", senders5.length);
    assert(clientA5.localStream!.getVideoTracks().length === 1, "Local stream has exactly 1 live video track after rapid toggle", 1, clientA5.localStream!.getVideoTracks().length);
    assert(clientB5.peerStatuses[clientA5.socketId]?.cam === true, "Remote peer converges to correct final camera ON state", true, clientB5.peerStatuses[clientA5.socketId]?.cam);
    clientA5.disconnect();
    clientB5.disconnect();

    // --- TEST 6: Two participants receive camera-off state ---
    console.log("\n--- TEST 6: Two participants receive camera-off state ---");
    const r6 = await getNextRoom();
    const clientA6 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB6 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    const clientC6 = new SimulatedCameraClient(userCId, "User C", serverUrl, tokenC);
    await clientA6.connect();
    await clientA6.joinRoom(r6);
    clientA6.initLocalMedia(true);

    await clientB6.connect();
    await clientB6.joinRoom(r6);
    clientB6.initLocalMedia(true);

    await clientC6.connect();
    await clientC6.joinRoom(r6);
    clientC6.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 300));

    // A turns camera OFF
    await clientA6.toggleVideo();
    await new Promise((r) => setTimeout(r, 300));

    assert(clientB6.peerStatuses[clientA6.socketId]?.cam === false, "User B sees User A camera OFF", false, clientB6.peerStatuses[clientA6.socketId]?.cam);
    assert(clientC6.peerStatuses[clientA6.socketId]?.cam === false, "User C sees User A camera OFF", false, clientC6.peerStatuses[clientA6.socketId]?.cam);
    clientA6.disconnect();
    clientB6.disconnect();
    clientC6.disconnect();

    // --- TEST 7: One participant turns camera OFF without affecting another participant's video ---
    console.log("\n--- TEST 7: Isolation between participants ---");
    const r7 = await getNextRoom();
    const clientA7 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB7 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    const clientC7 = new SimulatedCameraClient(userCId, "User C", serverUrl, tokenC);
    await clientA7.connect();
    await clientA7.joinRoom(r7);
    clientA7.initLocalMedia(true);

    await clientB7.connect();
    await clientB7.joinRoom(r7);
    clientB7.initLocalMedia(true);

    await clientC7.connect();
    await clientC7.joinRoom(r7);
    clientC7.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 300));

    // User A turns camera OFF
    await clientA7.toggleVideo();
    await new Promise((r) => setTimeout(r, 300));

    // Verify User B and User C still see each other's camera as ON
    assert(clientB7.peerStatuses[clientC7.socketId]?.cam === true, "User B still sees User C camera ON", true, clientB7.peerStatuses[clientC7.socketId]?.cam);
    assert(clientC7.peerStatuses[clientB7.socketId]?.cam === true, "User C still sees User B camera ON", true, clientC7.peerStatuses[clientB7.socketId]?.cam);
    clientA7.disconnect();
    clientB7.disconnect();
    clientC7.disconnect();

    // --- TEST 8: Camera permission failure ---
    console.log("\n--- TEST 8: Camera permission failure ---");
    const r8 = await getNextRoom();
    const clientA8 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB8 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA8.connect();
    await clientA8.joinRoom(r8);
    clientA8.initLocalMedia(false); // starts OFF

    await clientB8.connect();
    await clientB8.joinRoom(r8);
    clientB8.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 200));

    // Attempt to turn camera ON with simulated hardware error
    await clientA8.toggleVideo(true);
    await new Promise((r) => setTimeout(r, 200));

    assert(clientA8.localStream!.getVideoTracks().length === 0, "No invalid video track added on failure", 0, clientA8.localStream!.getVideoTracks().length);
    assert(clientA8.localStream!.getAudioTracks().length === 1, "Microphone track remains intact and functional", 1, clientA8.localStream!.getAudioTracks().length);
    assert(clientB8.peerStatuses[clientA8.socketId]?.cam === false, "Peers receive cam: false on acquisition failure", false, clientB8.peerStatuses[clientA8.socketId]?.cam);
    clientA8.disconnect();
    clientB8.disconnect();

    // --- TEST 9: Camera OFF during socket reconnect ---
    console.log("\n--- TEST 9: Camera OFF during socket reconnect ---");
    const r9 = await getNextRoom();
    const clientA9 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB9 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA9.connect();
    await clientA9.joinRoom(r9);
    clientA9.initLocalMedia(false); // Camera OFF

    await clientB9.connect();
    await clientB9.joinRoom(r9);
    clientB9.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 300));

    // Disconnect A temporarily and reconnect
    clientA9.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const clientA9Reconnected = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    await clientA9Reconnected.connect();
    await clientA9Reconnected.joinRoom(r9);
    clientA9Reconnected.initLocalMedia(false); // Maintain camera OFF state
    await new Promise((r) => setTimeout(r, 300));

    assert(clientB9.peerStatuses[clientA9Reconnected.socketId]?.cam === false, "Reconnected user camera state remains OFF", false, clientB9.peerStatuses[clientA9Reconnected.socketId]?.cam);
    clientA9Reconnected.disconnect();
    clientB9.disconnect();

    // --- TEST 10: Camera ON after reconnect ---
    console.log("\n--- TEST 10: Camera ON after reconnect ---");
    const r10 = await getNextRoom();
    const clientA10 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB10 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA10.connect();
    await clientA10.joinRoom(r10);
    clientA10.initLocalMedia(false); // Camera starts OFF

    await clientB10.connect();
    await clientB10.joinRoom(r10);
    clientB10.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 200));

    // Turn camera ON after reconnect
    await clientA10.toggleVideo();
    await new Promise((r) => setTimeout(r, 300));

    assert(clientA10.localStream!.getVideoTracks().length === 1, "User A successfully acquired video track", 1, clientA10.localStream!.getVideoTracks().length);
    assert(clientB10.peerStatuses[clientA10.socketId]?.cam === true, "User B receives camera ON after reconnect", true, clientB10.peerStatuses[clientA10.socketId]?.cam);
    clientA10.disconnect();
    clientB10.disconnect();

    // --- TEST 11: Participant leaves while camera is OFF ---
    console.log("\n--- TEST 11: Participant leaves while camera is OFF ---");
    const r11 = await getNextRoom();
    const clientA11 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB11 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA11.connect();
    await clientA11.joinRoom(r11);
    clientA11.initLocalMedia(true);

    await clientB11.connect();
    await clientB11.joinRoom(r11);
    clientB11.initLocalMedia(false); // B camera OFF
    await new Promise((r) => setTimeout(r, 200));

    const bSocketId = clientB11.socketId;
    assert(clientA11.peerStatuses[bSocketId]?.cam === false, "User A records User B camera OFF", false, clientA11.peerStatuses[bSocketId]?.cam);

    // User B leaves
    await clientB11.leaveRoom(r11);
    clientB11.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    assert(clientA11.peerStatuses[bSocketId] === undefined, "User B status cleaned up from User A on leave", undefined, clientA11.peerStatuses[bSocketId]);
    assert(clientA11.peerConnections[bSocketId] === undefined, "Peer connection for User B closed and deleted", undefined, clientA11.peerConnections[bSocketId]);
    clientA11.disconnect();

    // --- TEST 12: No duplicate tracks/senders after repeated toggling ---
    console.log("\n--- TEST 12: No duplicate tracks/senders ---");
    const r12 = await getNextRoom();
    const clientA12 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB12 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA12.connect();
    await clientA12.joinRoom(r12);
    clientA12.initLocalMedia(true);

    await clientB12.connect();
    await clientB12.joinRoom(r12);
    clientB12.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 200));

    // Perform 6 sequential toggles (OFF, ON, OFF, ON, OFF, ON)
    for (let i = 0; i < 6; i++) {
      await clientA12.toggleVideo();
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));

    const pcA12 = clientA12.peerConnections[clientB12.socketId];
    const senders12 = pcA12.getSenders();
    assert(senders12.length <= 2, "Sender count strictly bounded (1 audio + 1 video sender)", 2, senders12.length);
    assert(clientA12.localStream!.getVideoTracks().length <= 1, "Local stream tracks strictly bounded (<= 1 video track)", 1, clientA12.localStream!.getVideoTracks().length);
    clientA12.disconnect();
    clientB12.disconnect();

    // --- TEST 13: No duplicate signaling/listeners ---
    console.log("\n--- TEST 13: No duplicate signaling/listeners ---");
    const r13 = await getNextRoom();
    const clientA13 = new SimulatedCameraClient(userAId, "User A", serverUrl, tokenA);
    const clientB13 = new SimulatedCameraClient(userBId, "User B", serverUrl, tokenB);
    await clientA13.connect();
    await clientA13.joinRoom(r13);
    clientA13.initLocalMedia(true);

    await clientB13.connect();
    await clientB13.joinRoom(r13);
    clientB13.initLocalMedia(true);
    await new Promise((r) => setTimeout(r, 200));

    clientB13.statusEventsReceived = [];
    await clientA13.toggleVideo(); // 1 toggle
    await new Promise((r) => setTimeout(r, 300));

    assert(clientB13.statusEventsReceived.length === 1, "Exactly one participant_status event received per toggle", 1, clientB13.statusEventsReceived.length);
    clientA13.disconnect();
    clientB13.disconnect();
  } finally {
    httpServer.close();
    await prisma.$disconnect();
  }

  console.log("\n==================================================");
  console.log(`TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log("==================================================");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runCameraLifecycleTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
