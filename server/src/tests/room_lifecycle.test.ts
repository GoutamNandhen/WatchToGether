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
  public userTempDisconnectedEvents: any[] = [];
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

    this.socket.on("user_disconnected_temp", (data) => {
      this.userTempDisconnectedEvents.push(data);
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
        console.log(`[joinRoom ${roomId}] early return !socket.connected: socketExists=${!!this.socket}, connected=${this.socket?.connected}`);
        return resolve();
      }

      let resolved = false;
      const done = (reason: string) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          console.log(`[joinRoom ${roomId}] resolved via: ${reason}`);
          resolve();
        }
      };
      const safetyTimer = setTimeout(() => done("safetyTimer 15000ms"), 15000);

      const onRoomState = (data: any) => {
        clearTimeout(safetyTimer);
        done("room_state received");
      };
      const onError = (err: any) => {
        clearTimeout(safetyTimer);
        done("error event received: " + JSON.stringify(err));
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
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      const fallbackTimer = setTimeout(done, 8000);
      if (this.socket && this.socket.connected) {
        this.socket.emit("leave_room", { roomId, userId: this.userId, userName: this.userName }, () => {
          clearTimeout(fallbackTimer);
          done();
        });
      } else {
        clearTimeout(fallbackTimer);
        done();
      }
    });
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
          let resolved = false;
          const done = () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(safety);
              cleanup();
              resolve();
            }
          };
          const safety = setTimeout(done, 15000);

          const onState = () => {
            done();
          };
          const onErr = () => {
            done();
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
    timeoutMs = 3000
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
      }, 25);
    });
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

async function runTests() {
  console.log("==================================================");
  console.log("STARTING P2 ROOM LIFECYCLE & ACTIVE ROOMS TEST SUITE");
  console.log("==================================================");

  // Use a grace period of 750ms for tests (fast, but comfortably exceeds network ping to cloud DB)
  const TEST_GRACE_PERIOD_MS = 750;
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });
  const roomManager = new RoomManager(io, TEST_GRACE_PERIOD_MS);
  setupSocketHandlers(io, roomManager);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as any).port;
  const serverUrl = `http://localhost:${port}`;
  console.log(`Test server listening at ${serverUrl} (Grace period: ${TEST_GRACE_PERIOD_MS}ms)`);

  const userA_id = "12121212-1212-4212-a212-121212121212";
  const userB_id = "23232323-2323-4323-a323-232323232323";
  const userC_id = "34343434-3434-4343-a343-343434343434";

  await prisma.user.upsert({
    where: { email: "lifecycle_user_a@test.com" },
    update: { id: userA_id },
    create: { id: userA_id, email: "lifecycle_user_a@test.com", passwordHash: "hash", name: "User A" },
  });
  await prisma.user.upsert({
    where: { email: "lifecycle_user_b@test.com" },
    update: { id: userB_id },
    create: { id: userB_id, email: "lifecycle_user_b@test.com", passwordHash: "hash", name: "User B" },
  });
  await prisma.user.upsert({
    where: { email: "lifecycle_user_c@test.com" },
    update: { id: userC_id },
    create: { id: userC_id, email: "lifecycle_user_c@test.com", passwordHash: "hash", name: "User C" },
  });

  const tokenA = jwt.sign({ userId: userA_id }, JWT_SECRET);
  const tokenB = jwt.sign({ userId: userB_id }, JWT_SECRET);
  const tokenC = jwt.sign({ userId: userC_id }, JWT_SECRET);

  const getRoomId = (num: number) => `77777777-7777-4777-a777-${String(num).padStart(12, "0")}`;

  try {
    // -------------------------------------------------------------
    // Test 1: Room starts active after creation
    // -------------------------------------------------------------
    console.log("\n--- Test 1: Room starts active after creation ---");
    const rId1 = getRoomId(1);
    await prisma.room.upsert({
      where: { id: rId1 },
      update: { isActive: true },
      create: { id: rId1, name: "Test Room 1", hostId: userA_id, isPrivate: false },
    });

    const room1 = await prisma.room.findUnique({ where: { id: rId1 } });
    assert(room1 !== null && room1.isActive === true, "Room starts active after creation in database");

    // -------------------------------------------------------------
    // Test 2: Participant joins active room
    // -------------------------------------------------------------
    console.log("\n--- Test 2: Participant joins active room ---");
    const rId2 = getRoomId(2);
    await prisma.room.upsert({
      where: { id: rId2 },
      update: { isActive: true },
      create: { id: rId2, name: "Test Room 2", hostId: userA_id, isPrivate: false },
    });

    const clientA2 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA2.connect();
    await clientA2.joinRoom(rId2);

    const roomState2 = roomManager.getRoom(rId2);
    assert(roomState2 !== undefined && roomState2.participants.size === 1, "Participant recorded in RoomManager");

    const dbParticipant2 = await prisma.participant.findUnique({
      where: { userId_roomId: { userId: userA_id, roomId: rId2 } },
    });
    assert(dbParticipant2 !== null, "Participant recorded in PostgreSQL Participant table");

    const dbHistory2 = await prisma.roomHistoryEntry.findUnique({
      where: { userId_roomId: { userId: userA_id, roomId: rId2 } },
    });
    assert(dbHistory2 !== null, "Visit recorded in PostgreSQL RoomHistoryEntry table");

    await clientA2.leaveRoom(rId2);
    clientA2.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    // -------------------------------------------------------------
    // Test 3: Last participant intentionally leaves -> Room.isActive becomes false
    // -------------------------------------------------------------
    console.log("\n--- Test 3: Last participant intentionally leaves -> Room.isActive becomes false ---");
    const rId3 = getRoomId(3);
    await prisma.room.upsert({
      where: { id: rId3 },
      update: { isActive: true },
      create: { id: rId3, name: "Test Room 3", hostId: userA_id, isPrivate: false },
    });

    const clientA3 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA3.connect();
    await clientA3.joinRoom(rId3);

    // Intentional leave
    await clientA3.leaveRoom(rId3);
    clientA3.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const dbRoom3 = await prisma.room.findUnique({ where: { id: rId3 } });
    assert(dbRoom3 !== null && dbRoom3.isActive === false, "Room.isActive becomes false in DB when last participant leaves");
    assert(roomManager.getRoom(rId3) === undefined, "Room cleanly removed from RoomManager memory");

    // -------------------------------------------------------------
    // Test 4: Non-last participant leaves -> room remains active
    // -------------------------------------------------------------
    console.log("\n--- Test 4: Non-last participant leaves -> room remains active ---");
    const rId4 = getRoomId(4);
    await prisma.room.upsert({
      where: { id: rId4 },
      update: { isActive: true },
      create: { id: rId4, name: "Test Room 4", hostId: userA_id, isPrivate: false },
    });

    const clientA4 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB4 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);
    await clientA4.connect();
    await clientA4.joinRoom(rId4);
    await clientB4.connect();
    await clientB4.joinRoom(rId4);

    // User B leaves, User A remains
    await clientB4.leaveRoom(rId4);
    clientB4.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const dbRoom4 = await prisma.room.findUnique({ where: { id: rId4 } });
    assert(dbRoom4 !== null && dbRoom4.isActive === true, "Room remains active in DB when non-last participant leaves");
    const dbPartB4 = await prisma.participant.findUnique({
      where: { userId_roomId: { userId: userB_id, roomId: rId4 } },
    });
    assert(dbPartB4 === null, "Departed participant cleanly removed from DB");

    await clientA4.leaveRoom(rId4);
    clientA4.disconnect();

    // -------------------------------------------------------------
    // Test 5: Temporary disconnect -> room remains active during grace period
    // -------------------------------------------------------------
    console.log("\n--- Test 5: Temporary disconnect -> room remains active during grace period ---");
    const rId5 = getRoomId(5);
    await prisma.room.upsert({
      where: { id: rId5 },
      update: { isActive: true },
      create: { id: rId5, name: "Test Room 5", hostId: userA_id, isPrivate: false },
    });

    const clientA5 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA5.connect();
    await clientA5.joinRoom(rId5);

    // Disconnect socket abruptly
    clientA5.disconnect();
    await new Promise((r) => setTimeout(r, 100)); // 100ms < 750ms grace period

    const roomState5 = roomManager.getRoom(rId5);
    assert(roomState5 !== undefined && roomState5.disconnectedParticipants.size === 1, "User is tracked in disconnectedParticipants grace period");

    const dbRoom5 = await prisma.room.findUnique({ where: { id: rId5 } });
    assert(dbRoom5 !== null && dbRoom5.isActive === true, "Room remains active in DB during grace period");

    // Clean up
    await new Promise((r) => setTimeout(r, 1200)); // let it expire + DB latency

    // -------------------------------------------------------------
    // Test 6: Reconnect before grace expiry -> participant restored and room remains active
    // -------------------------------------------------------------
    console.log("\n--- Test 6: Reconnect before grace expiry -> participant restored and room remains active ---");
    const rId6 = getRoomId(6);
    await prisma.room.upsert({
      where: { id: rId6 },
      update: { isActive: true },
      create: { id: rId6, name: "Test Room 6", hostId: userA_id, isPrivate: false },
    });

    const clientA6 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA6.connect();
    await clientA6.joinRoom(rId6);

    // Disconnect and reconnect before grace expiry (< 250ms)
    await clientA6.simulateTemporaryDisconnectAndReconnect();

    const roomState6 = roomManager.getRoom(rId6);
    assert(roomState6 !== undefined && roomState6.disconnectedParticipants.size === 0, "Grace period timeout cancelled on reconnect");
    assert(roomState6 !== undefined && roomState6.participants.size === 1, "User restored to active participants");

    const dbRoom6 = await prisma.room.findUnique({ where: { id: rId6 } });
    assert(dbRoom6 !== null && dbRoom6.isActive === true, "Room remains active in DB after successful reconnection");

    await clientA6.leaveRoom(rId6);
    clientA6.disconnect();

    // -------------------------------------------------------------
    // Test 7: Grace expiry with no participants -> room becomes inactive
    // -------------------------------------------------------------
    console.log("\n--- Test 7: Grace expiry with no participants -> room becomes inactive ---");
    const rId7 = getRoomId(7);
    await prisma.room.upsert({
      where: { id: rId7 },
      update: { isActive: true },
      create: { id: rId7, name: "Test Room 7", hostId: userA_id, isPrivate: false },
    });

    const clientA7 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA7.connect();
    await clientA7.joinRoom(rId7);

    // Disconnect and wait past grace period (1800ms > 750ms + DB latency)
    clientA7.disconnect();
    await new Promise((r) => setTimeout(r, 1800));

    const dbRoom7 = await prisma.room.findUnique({ where: { id: rId7 } });
    assert(dbRoom7 !== null && dbRoom7.isActive === false, "Room.isActive becomes false in DB upon grace period expiry");
    assert(roomManager.getRoom(rId7) === undefined, "Room state cleaned from RoomManager after grace expiry");

    const remainingParticipants7 = await prisma.participant.findMany({ where: { roomId: rId7 } });
    assert(remainingParticipants7.length === 0, "All participant records cleaned up in DB when room empties");

    // -------------------------------------------------------------
    // Test 8: Multiple sockets for same participant -> one disconnect does not incorrectly remove participant
    // -------------------------------------------------------------
    console.log("\n--- Test 8: Multiple sockets for same participant -> one disconnect does not remove participant ---");
    const rId8 = getRoomId(8);
    await prisma.room.upsert({
      where: { id: rId8 },
      update: { isActive: true },
      create: { id: rId8, name: "Test Room 8", hostId: userA_id, isPrivate: false },
    });

    // Tab 1 and Tab 2
    const tab1 = new SimulatedClient(userA_id, "User A (Tab 1)", serverUrl, tokenA);
    const tab2 = new SimulatedClient(userA_id, "User A (Tab 2)", serverUrl, tokenA);
    await tab1.connect();
    await tab1.joinRoom(rId8);
    await tab2.connect();
    await tab2.joinRoom(rId8);

    const roomState8 = roomManager.getRoom(rId8);
    assert(roomState8 !== undefined && roomState8.participants.size === 2, "Both tabs connected and tracked in participants");

    // Close Tab 1
    tab1.disconnect();
    await new Promise((r) => setTimeout(r, 80));

    // Tab 2 is still active -> no grace timeout should be scheduled
    assert(roomState8 !== undefined && roomState8.disconnectedParticipants.size === 0, "No disconnect timeout scheduled because Tab 2 remains active");
    assert(roomState8 !== undefined && roomState8.participants.size === 1, "User A still active via Tab 2");

    const dbRoom8 = await prisma.room.findUnique({ where: { id: rId8 } });
    assert(dbRoom8 !== null && dbRoom8.isActive === true, "Room remains active in DB with remaining tab");

    // Close Tab 2
    tab2.disconnect();
    await new Promise((r) => setTimeout(r, 1800)); // let grace expire + DB latency

    const dbRoom8Final = await prisma.room.findUnique({ where: { id: rId8 } });
    console.log("    [Test 8 debug] dbRoom8Final isActive:", dbRoom8Final?.isActive, "roomState8:", roomManager.getRoom(rId8));
    assert(dbRoom8Final !== null && dbRoom8Final.isActive === false, "Room deactivates after all tabs close and grace expires");

    // -------------------------------------------------------------
    // Test 9: Multiple participants disconnect independently
    // -------------------------------------------------------------
    console.log("\n--- Test 9: Multiple participants disconnect independently ---");
    const rId9 = getRoomId(9);
    await prisma.room.upsert({
      where: { id: rId9 },
      update: { isActive: true },
      create: { id: rId9, name: "Test Room 9", hostId: userA_id, isPrivate: false },
    });

    const clientA9 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB9 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);
    await clientA9.connect();
    await clientA9.joinRoom(rId9);
    await clientB9.connect();
    await clientB9.joinRoom(rId9);

    // Disconnect A at T=0
    clientA9.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Disconnect B at T=100
    clientB9.disconnect();

    // At T=200, neither has reached 750ms since their respective disconnect
    await new Promise((r) => setTimeout(r, 100)); // total T=200
    const roomState9_t200 = roomManager.getRoom(rId9);
    assert(roomState9_t200 !== undefined && roomState9_t200.disconnectedParticipants.size === 2, "Both participants in independent grace periods");

    const dbRoom9_t200 = await prisma.room.findUnique({ where: { id: rId9 } });
    assert(dbRoom9_t200 !== null && dbRoom9_t200.isActive === true, "Room remains active while independent grace periods run");

    // Wait until both have expired and DB writes finished (750ms from T=100 is T=850, so waiting 1200ms reaches T=1400)
    await new Promise((r) => setTimeout(r, 1200));

    const dbRoom9Final = await prisma.room.findUnique({ where: { id: rId9 } });
    assert(dbRoom9Final !== null && dbRoom9Final.isActive === false, "Room deactivates only after the last grace period expires");

    // -------------------------------------------------------------
    // Test 10: Leave + reconnect race
    // -------------------------------------------------------------
    console.log("\n--- Test 10: Leave + reconnect race ---");
    const rId10 = getRoomId(10);
    await prisma.room.upsert({
      where: { id: rId10 },
      update: { isActive: true },
      create: { id: rId10, name: "Test Room 10", hostId: userA_id, isPrivate: false },
    });

    const clientA10 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA10.connect();
    await clientA10.joinRoom(rId10);

    // Intentional leave and immediate rejoin
    await clientA10.leaveRoom(rId10);
    await clientA10.joinRoom(rId10);

    const roomState10 = roomManager.getRoom(rId10);
    assert(roomState10 !== undefined && roomState10.participants.size === 1, "User safely active after leave + immediate rejoin");

    const dbRoom10 = await prisma.room.findUnique({ where: { id: rId10 } });
    assert(dbRoom10 !== null && dbRoom10.isActive === true, "Room remains active in DB after leave + immediate rejoin");

    await clientA10.leaveRoom(rId10);
    clientA10.disconnect();

    // -------------------------------------------------------------
    // Test 11: Reconnect + stale disconnect callback race
    // -------------------------------------------------------------
    console.log("\n--- Test 11: Reconnect + stale disconnect callback race ---");
    const rId11 = getRoomId(11);
    await prisma.room.upsert({
      where: { id: rId11 },
      update: { isActive: true },
      create: { id: rId11, name: "Test Room 11", hostId: userA_id, isPrivate: false },
    });

    const clientA11 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA11.connect();
    await clientA11.joinRoom(rId11);

    // Disconnect, wait 100ms, then reconnect with fresh socket
    clientA11.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const clientA11Reconnected = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA11Reconnected.connect();
    await clientA11Reconnected.joinRoom(rId11);

    // Wait 500ms (well past the 250ms mark where old timer would have fired)
    await new Promise((r) => setTimeout(r, 500));

    const roomState11 = roomManager.getRoom(rId11);
    assert(roomState11 !== undefined && roomState11.participants.size === 1, "Stale disconnect callback safely ignored; reconnected user remains in room");

    const dbRoom11 = await prisma.room.findUnique({ where: { id: rId11 } });
    assert(dbRoom11 !== null && dbRoom11.isActive === true, "Room remains active in DB despite stale disconnect timer firing");

    await clientA11Reconnected.leaveRoom(rId11);
    clientA11Reconnected.disconnect();

    // -------------------------------------------------------------
    // Test 12: Room history remains after room becomes inactive
    // -------------------------------------------------------------
    console.log("\n--- Test 12: Room history remains after room becomes inactive ---");
    const rId12 = getRoomId(12);
    await prisma.room.upsert({
      where: { id: rId12 },
      update: { isActive: true },
      create: { id: rId12, name: "Test Room 12", hostId: userA_id, isPrivate: false },
    });

    const clientA12 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    const clientB12 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);
    await clientA12.connect();
    await clientA12.joinRoom(rId12);
    await clientB12.connect();
    await clientB12.joinRoom(rId12);

    // Both leave intentionally -> room becomes inactive
    await clientA12.leaveRoom(rId12);
    await clientB12.leaveRoom(rId12);
    clientA12.disconnect();
    clientB12.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const dbRoom12 = await prisma.room.findUnique({ where: { id: rId12 } });
    assert(dbRoom12 !== null && dbRoom12.isActive === false, "Room became inactive");

    const histories12 = await prisma.roomHistoryEntry.findMany({ where: { roomId: rId12 } });
    assert(histories12.length === 2, "RoomHistoryEntry records for both users are permanently retained");

    // -------------------------------------------------------------
    // Test 13: Inactive rooms are excluded from Active Rooms
    // -------------------------------------------------------------
    console.log("\n--- Test 13: Inactive rooms are excluded from Active Rooms ---");
    const activeRooms = await prisma.room.findMany({
      where: { isPrivate: false, isActive: true },
    });
    const inactiveRoom12Found = activeRooms.some((r) => r.id === rId12);
    assert(!inactiveRoom12Found, "Inactive room 12 is excluded from Active Rooms query");

    // -------------------------------------------------------------
    // Test 14: Existing room history/rejoin behavior still works
    // -------------------------------------------------------------
    console.log("\n--- Test 14: Rejoining an inactive historical room reactivates it ---");
    // rId12 is currently inactive (isActive: false)
    const clientA14 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA14.connect();
    await clientA14.joinRoom(rId12);

    const dbRoom14 = await prisma.room.findUnique({ where: { id: rId12 } });
    assert(dbRoom14 !== null && dbRoom14.isActive === true, "Rejoining historical room reactivates Room.isActive to true");

    await clientA14.leaveRoom(rId12);
    clientA14.disconnect();

    // -------------------------------------------------------------
    // Test 15: Private room security still works
    // -------------------------------------------------------------
    console.log("\n--- Test 15: Private room security still works ---");
    const rId15 = getRoomId(15);
    await prisma.room.upsert({
      where: { id: rId15 },
      update: { isPrivate: true, password: "SecretPassword123" },
      create: { id: rId15, name: "Private Room", hostId: userA_id, isPrivate: true, password: "SecretPassword123" },
    });

    const clientB15 = new SimulatedClient(userB_id, "User B", serverUrl, tokenB);
    await clientB15.connect();

    // Try joining with wrong password
    await clientB15.joinRoom(rId15, "WrongPassword");
    assert(clientB15.reconnectError === "Incorrect password", "Joining private room with incorrect password rejected");

    // Join with correct password
    await clientB15.joinRoom(rId15, "SecretPassword123");
    const roomState15 = roomManager.getRoom(rId15);
    const socketId15 = clientB15.socket?.id || "";
    assert(roomState15 !== undefined && roomState15.participants.has(socketId15), "Joining private room with correct password succeeds");

    await clientB15.leaveRoom(rId15);
    clientB15.disconnect();

    // -------------------------------------------------------------
    // Test 16: Host manual room termination (forceEndRoom)
    // -------------------------------------------------------------
    console.log("\n--- Test 16: Host manual room termination (forceEndRoom) ---");
    const rId16 = getRoomId(16);
    await prisma.room.upsert({
      where: { id: rId16 },
      update: { isActive: true },
      create: { id: rId16, name: "Test Room 16", hostId: userA_id, isPrivate: false },
    });

    const clientA16 = new SimulatedClient(userA_id, "User A", serverUrl, tokenA);
    await clientA16.connect();
    await clientA16.joinRoom(rId16);

    await roomManager.forceEndRoom(rId16);

    const dbRoom16 = await prisma.room.findUnique({ where: { id: rId16 } });
    assert(dbRoom16 !== null && dbRoom16.isActive === false, "forceEndRoom sets Room.isActive = false in DB");
    assert(roomManager.getRoom(rId16) === undefined, "forceEndRoom cleans up in-memory room");

    clientA16.disconnect();
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
