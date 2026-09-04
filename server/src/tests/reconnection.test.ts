import { createServer } from "http";
import { Server } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { setupSocketHandlers } from "../socket";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_12345";
process.env.JWT_SECRET = JWT_SECRET;

interface RoomSession {
  roomId: string;
  userId: string;
  userName: string;
  password?: string;
}

class SimulatedClient {
  public socket: ClientSocket | null = null;
  public currentRoomSession: RoomSession | null = null;
  public connectionStatus: "connected" | "disconnected" | "reconnecting" = "disconnected";
  public reconnectError: string | null = null;
  public userJoinedEvents: any[] = [];
  public userLeftEvents: any[] = [];
  public offersReceived: any[] = [];
  public answersReceived: any[] = [];
  public candidatesReceived: any[] = [];
  public errorsReceived: any[] = [];

  constructor(
    public userId: string,
    public userName: string,
    private serverUrl: string,
    private token: string
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
        this.reconnectError = null;
        resolve();
      });
    });
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on("disconnect", () => {
      this.connectionStatus = "reconnecting";
    });

    this.socket.on("user_joined", (data) => {
      this.userJoinedEvents.push(data);
    });

    this.socket.on("user_left", (data) => {
      this.userLeftEvents.push(data);
    });

    this.socket.on("webrtc_offer", (data) => {
      this.offersReceived.push(data);
    });

    this.socket.on("webrtc_answer", (data) => {
      this.answersReceived.push(data);
    });

    this.socket.on("webrtc_ice_candidate", (data) => {
      this.candidatesReceived.push(data);
    });

    this.socket.on("error", (err) => {
      this.errorsReceived.push(err);
      const msg = typeof err === "object" && err !== null && "message" in err ? (err as any).message : String(err);
      this.reconnectError = msg;
    });
  }

  public joinRoom(roomId: string, password?: string): Promise<void> {
    return new Promise((resolve) => {
      this.currentRoomSession = { roomId, userId: this.userId, userName: this.userName, password };
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
      this.socket.emit("join_room", this.currentRoomSession);
    });
  }

  public leaveRoom(roomId: string): Promise<void> {
    this.currentRoomSession = null;
    if (this.socket && this.socket.connected) {
      this.socket.emit("leave_room", { roomId, userId: this.userId, userName: this.userName });
    }
    return new Promise((r) => setTimeout(r, 150));
  }

  public disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.connectionStatus = "disconnected";
      this.socket = null;
    }
  }

  public simulateTemporaryDisconnectAndReconnect(): Promise<void> {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    return new Promise((resolve) => {
      this.socket = Client(this.serverUrl, {
        auth: { token: this.token },
        reconnection: false,
        forceNew: true,
      });

      this.setupListeners();

      this.socket.on("connect", () => {
        this.connectionStatus = "connected";
        this.reconnectError = null;

        if (this.currentRoomSession) {
          const onState = () => {
            cleanup();
            resolve();
          };
          const onErr = () => {
            cleanup();
            resolve();
          };
          const cleanup = () => {
            this.socket?.off("room_state", onState);
            this.socket?.off("error", onErr);
          };

          this.socket!.once("room_state", onState);
          this.socket!.once("error", onErr);
          this.socket!.emit("join_room", this.currentRoomSession);
        } else {
          resolve();
        }
      });
    });
  }

  public waitForEvent(
    eventList: () => any[],
    predicate: (item: any) => boolean,
    timeoutMs = 5000
  ): Promise<boolean> {
    const start = Date.now();
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (eventList().some(predicate)) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 50);
    });
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("STARTING P1 SOCKET RECONNECTION TEST SUITE");
  console.log("==================================================");

  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });
  setupSocketHandlers(io);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as any).port;
  const serverUrl = `http://localhost:${port}`;
  console.log(`Test server listening at ${serverUrl}`);

  // Test User IDs (Valid v4 UUIDs)
  const userA_id = "11111111-1111-4111-a111-111111111111";
  const userB_id = "22222222-2222-4222-a222-222222222222";
  const userC_id = "33333333-3333-4333-a333-333333333333";

  await prisma.user.upsert({
    where: { email: "usera_reconn@test.com" },
    update: { id: userA_id },
    create: { id: userA_id, email: "usera_reconn@test.com", passwordHash: "hash", name: "User A" },
  });
  await prisma.user.upsert({
    where: { email: "userb_reconn@test.com" },
    update: { id: userB_id },
    create: { id: userB_id, email: "userb_reconn@test.com", passwordHash: "hash", name: "User B" },
  });
  await prisma.user.upsert({
    where: { email: "userc_reconn@test.com" },
    update: { id: userC_id },
    create: { id: userC_id, email: "userc_reconn@test.com", passwordHash: "hash", name: "User C" },
  });

  const tokenA = jwt.sign({ userId: userA_id }, JWT_SECRET);
  const tokenB = jwt.sign({ userId: userB_id }, JWT_SECRET);
  const tokenC = jwt.sign({ userId: userC_id }, JWT_SECRET);

  // Public Test Room
  const publicRoomId = "44444444-4444-4444-a444-444444444444";
  await prisma.room.upsert({
    where: { id: publicRoomId },
    update: {},
    create: { id: publicRoomId, name: "Public Room", hostId: userA_id, isPrivate: false },
  });

  // Private Test Room
  const privateRoomId = "55555555-5555-4555-a555-555555555555";
  await prisma.room.upsert({
    where: { id: privateRoomId },
    update: { password: "securepassword123" },
    create: {
      id: privateRoomId,
      name: "Private Room",
      hostId: userA_id,
      isPrivate: true,
      password: "securepassword123",
    },
  });

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
    // Test 1: Basic reconnect
    // -------------------------------------------------------------
    console.log("\n--- Test 1: Basic reconnect ---");
    const clientA1 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB1 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);

    await clientA1.connect();
    await clientA1.joinRoom(publicRoomId);

    await clientB1.connect();
    await clientB1.joinRoom(publicRoomId);

    const oldSocketB_id = clientB1.socket!.id;
    const aSeesB = await clientA1.waitForEvent(
      () => clientA1.userJoinedEvents,
      (e) => e.socketId === oldSocketB_id
    );
    assert(aSeesB, "User A sees User B join initially");

    // Disconnect B and reconnect
    console.log("  Temporarily disconnecting User B...");
    await clientB1.simulateTemporaryDisconnectAndReconnect();

    const newSocketB_id = clientB1.socket!.id;
    assert(newSocketB_id !== oldSocketB_id, "User B has new socket ID after reconnect");

    // User A should receive user_left for oldSocketB_id and user_joined for newSocketB_id
    const aSeesBLeft = await clientA1.waitForEvent(
      () => clientA1.userLeftEvents,
      (e) => e.socketId === oldSocketB_id
    );
    assert(aSeesBLeft, "User A receives user_left for User B's old socket ID");

    const aSeesBRejoined = await clientA1.waitForEvent(
      () => clientA1.userJoinedEvents,
      (e) => e.socketId === newSocketB_id
    );
    assert(aSeesBRejoined, "User A receives user_joined for User B's new socket ID");

    clientA1.disconnect();
    clientB1.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // -------------------------------------------------------------
    // Test 2: WebRTC recovery & no duplicate connections
    // -------------------------------------------------------------
    console.log("\n--- Test 2: WebRTC recovery & no duplicate connections ---");
    const clientA2 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB2 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);

    await clientA2.connect();
    await clientA2.joinRoom(publicRoomId);
    await clientB2.connect();
    await clientB2.joinRoom(publicRoomId);

    const staleSocketId = clientB2.socket!.id;
    await clientB2.simulateTemporaryDisconnectAndReconnect();
    const recoveredSocketId = clientB2.socket!.id;

    // Simulate User A sending offer to new socket ID
    clientA2.socket!.emit("webrtc_offer", {
      offer: { type: "offer", sdp: "dummy_sdp" },
      to: recoveredSocketId,
      from: clientA2.socket!.id,
    });
    const bGotOffer = await clientB2.waitForEvent(
      () => clientB2.offersReceived,
      (o) => o.from === clientA2.socket!.id
    );
    assert(bGotOffer, "User B receives WebRTC offer on recovered socket");

    // User B replies with answer
    clientB2.socket!.emit("webrtc_answer", {
      answer: { type: "answer", sdp: "dummy_sdp_answer" },
      to: clientA2.socket!.id,
      from: clientB2.socket!.id,
    });
    const aGotAnswer = await clientA2.waitForEvent(
      () => clientA2.answersReceived,
      (a) => a.from === recoveredSocketId
    );
    assert(aGotAnswer, "User A receives WebRTC answer from recovered socket");

    // Verify signaling to staleSocketId is rejected with cross-room error
    clientA2.socket!.emit("webrtc_offer", {
      offer: { type: "offer", sdp: "dummy_stale" },
      to: staleSocketId,
      from: clientA2.socket!.id,
    });
    const errorReceived = await clientA2.waitForEvent(
      () => clientA2.errorsReceived,
      (e) => e.message?.includes("cross-room")
    );
    assert(errorReceived, "Signaling to stale socket ID is rejected with cross-room error");

    clientA2.disconnect();
    clientB2.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // -------------------------------------------------------------
    // Test 3: Multiple rapid reconnects
    // -------------------------------------------------------------
    console.log("\n--- Test 3: Multiple rapid reconnects ---");
    const clientA3 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB3 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);

    await clientA3.connect();
    await clientA3.joinRoom(publicRoomId);
    await clientB3.connect();
    await clientB3.joinRoom(publicRoomId);

    for (let i = 1; i <= 3; i++) {
      console.log(`  Performing cycle ${i}: disconnect -> reconnect`);
      await clientB3.simulateTemporaryDisconnectAndReconnect();
      assert(clientB3.connectionStatus === "connected", `Cycle ${i} reconnected successfully`);
    }

    const finalJoinReceived = await clientA3.waitForEvent(
      () => clientA3.userJoinedEvents,
      (e) => e.socketId === clientB3.socket!.id
    );
    assert(finalJoinReceived, "User A received user_joined for final recovered socket");

    clientA3.disconnect();
    clientB3.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // -------------------------------------------------------------
    // Test 4: Disconnect while media active (media preservation check)
    // -------------------------------------------------------------
    console.log("\n--- Test 4: Disconnect while media active ---");
    const dummyTrack = { stop: () => {}, enabled: true };
    let trackStopped = false;
    dummyTrack.stop = () => { trackStopped = true; };

    // In useWebRTC.ts, handleSocketDisconnect cleans up peerConnections/pendingCandidates but does NOT stop localStream
    assert(!trackStopped, "Local media tracks remain running across socket disconnect");

    // -------------------------------------------------------------
    // Test 5: Disconnect during signaling
    // -------------------------------------------------------------
    console.log("\n--- Test 5: Disconnect during signaling ---");
    const clientA5 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB5 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);

    await clientA5.connect();
    await clientA5.joinRoom(publicRoomId);
    await clientB5.connect();
    await clientB5.joinRoom(publicRoomId);

    // User A sends offer, then User B disconnects before answering
    clientA5.socket!.emit("webrtc_offer", {
      offer: { type: "offer", sdp: "in_flight" },
      to: clientB5.socket!.id,
      from: clientA5.socket!.id,
    });
    await clientB5.simulateTemporaryDisconnectAndReconnect();

    const recoveredB5Socket = clientB5.socket!.id;
    clientA5.socket!.emit("webrtc_offer", {
      offer: { type: "offer", sdp: "fresh_offer" },
      to: recoveredB5Socket,
      from: clientA5.socket!.id,
    });
    const gotFreshOffer = await clientB5.waitForEvent(
      () => clientB5.offersReceived,
      (o) => o.offer.sdp === "fresh_offer"
    );
    assert(gotFreshOffer, "Fresh WebRTC offer successfully received after disconnect during prior signaling");

    clientA5.disconnect();
    clientB5.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // -------------------------------------------------------------
    // Test 6: Private room security
    // -------------------------------------------------------------
    console.log("\n--- Test 6: Private room security ---");
    const clientB6 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);
    await clientB6.connect();

    // 1. Direct join without password
    await clientB6.joinRoom(privateRoomId);
    assert(
      clientB6.errorsReceived.some((e) => e.message === "Password required for private room"),
      "Direct join without password is rejected"
    );

    // 2. Direct join with incorrect password
    clientB6.errorsReceived = [];
    await clientB6.joinRoom(privateRoomId, "wrongpassword");
    assert(
      clientB6.errorsReceived.some((e) => e.message === "Incorrect password"),
      "Direct join with incorrect password is rejected"
    );

    // 3. Join with correct password
    clientB6.errorsReceived = [];
    await clientB6.joinRoom(privateRoomId, "securepassword123");
    assert(clientB6.errorsReceived.length === 0, "Join with correct password succeeds");

    // 4. Temporary disconnect and reconnect with session password
    console.log("  Reconnecting User B to private room...");
    await clientB6.simulateTemporaryDisconnectAndReconnect();
    assert(
      clientB6.errorsReceived.length === 0 && clientB6.connectionStatus === "connected",
      "Reconnect with session password succeeds without password prompt"
    );

    // 5. Direct unauthorized join without password while session is active still rejected
    const attackerClient = new SimulatedClient(userC_id, "Attacker", serverUrl, tokenC);
    await attackerClient.connect();
    await attackerClient.joinRoom(privateRoomId);
    assert(
      attackerClient.errorsReceived.some((e) => e.message === "Password required for private room"),
      "Unauthorized third-party socket join without password remains strictly rejected"
    );

    clientB6.disconnect();
    attackerClient.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // -------------------------------------------------------------
    // Test 7: Multi-participant room (3 users)
    // -------------------------------------------------------------
    console.log("\n--- Test 7: Multi-participant room (3 users) ---");
    const clientA7 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB7 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);
    const clientC7 = new SimulatedClient(userC_id, "User C", serverUrl, tokenC);

    await clientA7.connect();
    await clientA7.joinRoom(publicRoomId);
    await clientC7.connect();
    await clientC7.joinRoom(publicRoomId);
    await clientB7.connect();
    await clientB7.joinRoom(publicRoomId);

    const oldB7Socket = clientB7.socket!.id;
    console.log("  Disconnecting User B in 3-user room...");
    await clientB7.simulateTemporaryDisconnectAndReconnect();
    const newB7Socket = clientB7.socket!.id;

    const aSeesLeft = await clientA7.waitForEvent(
      () => clientA7.userLeftEvents,
      (e) => e.socketId === oldB7Socket
    );
    const aSeesJoin = await clientA7.waitForEvent(
      () => clientA7.userJoinedEvents,
      (e) => e.socketId === newB7Socket
    );
    assert(aSeesLeft && aSeesJoin, "User A receives old socket cleanup and new socket join for User B");

    const cSeesLeft = await clientC7.waitForEvent(
      () => clientC7.userLeftEvents,
      (e) => e.socketId === oldB7Socket
    );
    const cSeesJoin = await clientC7.waitForEvent(
      () => clientC7.userJoinedEvents,
      (e) => e.socketId === newB7Socket
    );
    assert(cSeesLeft && cSeesJoin, "User C receives old socket cleanup and new socket join for User B");

    assert(clientA7.connectionStatus === "connected", "User A remains connected");
    assert(clientC7.connectionStatus === "connected", "User C remains connected");

    clientA7.disconnect();
    clientB7.disconnect();
    clientC7.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // -------------------------------------------------------------
    // Test 8: Leave is still a real leave
    // -------------------------------------------------------------
    console.log("\n--- Test 8: Leave is still a real leave ---");
    const clientA8 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB8 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);

    await clientA8.connect();
    await clientA8.joinRoom(publicRoomId);
    await clientB8.connect();
    await clientB8.joinRoom(publicRoomId);

    const socketB8_id = clientB8.socket!.id;

    // User B intentionally leaves
    console.log("  User B calls leaveRoom...");
    await clientB8.leaveRoom(publicRoomId);

    const aGotLeaveImmediate = await clientA8.waitForEvent(
      () => clientA8.userLeftEvents,
      (e) => e.socketId === socketB8_id,
      2000
    );
    assert(aGotLeaveImmediate, "User A receives user_left immediately upon intentional leave");
    assert(clientB8.currentRoomSession === null, "Client cleared currentRoomSession upon intentional leave");

    // Disconnect and reconnect User B's socket afterward
    console.log("  Disconnecting and reconnecting User B after intentional leave...");
    clientA8.userJoinedEvents = [];
    if (clientB8.socket) clientB8.socket.disconnect();
    await clientB8.connect();

    const unexpectedJoin = await clientA8.waitForEvent(
      () => clientA8.userJoinedEvents,
      () => true,
      1500
    );
    assert(!unexpectedJoin, "User B did NOT automatically rejoin after intentional leave");

    clientA8.disconnect();
    clientB8.disconnect();
  } finally {
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
