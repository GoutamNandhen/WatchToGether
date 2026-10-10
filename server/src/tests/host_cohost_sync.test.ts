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

class SimulatedHostClient {
  public socket: ClientSocket | null = null;
  public currentRoomSession: RoomSession | null = null;
  public connectionStatus: "connected" | "disconnected" | "reconnecting" = "disconnected";
  public currentHostId: string | null = null;
  public coHosts: string[] = [];
  public isHost: boolean = false;

  public hostChangedEvents: any[] = [];
  public roomStateEvents: any[] = [];
  public newHostEvents: any[] = [];
  public newCohostEvents: any[] = [];
  public cohostRemovedEvents: any[] = [];
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
        resolve();
      });
    });
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on("disconnect", () => {
      this.connectionStatus = "disconnected";
    });

    this.socket.on("room_state", (data: { hostId: string; coHosts?: string[] }) => {
      this.roomStateEvents.push(data);
      this.currentHostId = data.hostId;
      this.coHosts = data.coHosts || [];
      this.isHost = data.hostId === this.userId || this.coHosts.includes(this.userId);
    });

    this.socket.on("host_changed", (data: { hostId: string; coHosts?: string[] }) => {
      this.hostChangedEvents.push(data);
      this.currentHostId = data.hostId;
      if (data.coHosts) {
        this.coHosts = data.coHosts;
      }
      this.isHost = data.hostId === this.userId || this.coHosts.includes(this.userId);
    });

    this.socket.on("new_host", (data: { userId: string }) => {
      this.newHostEvents.push(data);
      this.currentHostId = data.userId;
      this.coHosts = this.coHosts.filter((id) => id !== data.userId);
      this.isHost = data.userId === this.userId || this.coHosts.includes(this.userId);
    });

    this.socket.on("new_cohost", (data: { userId: string }) => {
      this.newCohostEvents.push(data);
      if (!this.coHosts.includes(data.userId)) {
        this.coHosts.push(data.userId);
      }
      if (data.userId === this.userId) {
        this.isHost = true;
      }
    });

    this.socket.on("cohost_removed", (data: { userId: string }) => {
      this.cohostRemovedEvents.push(data);
      this.coHosts = this.coHosts.filter((id) => id !== data.userId);
      if (data.userId === this.userId) {
        this.isHost = this.currentHostId === this.userId;
      }
    });

    this.socket.on("error", (err) => {
      this.errorsReceived.push(err);
    });
  }

  public joinRoom(roomId: string, password?: string): Promise<void> {
    return new Promise((resolve) => {
      this.currentRoomSession = { roomId, userId: this.userId, userName: this.userName, password };
      if (!this.socket || !this.socket.connected) {
        return resolve();
      }

      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve();
        }
      };
      const safetyTimer = setTimeout(() => done(), 10000);

      const onRoomState = () => {
        clearTimeout(safetyTimer);
        done();
      };
      const cleanup = () => {
        this.socket?.off("room_state", onRoomState);
      };

      this.socket.once("room_state", onRoomState);
      this.socket.emit("join_room", this.currentRoomSession);
    });
  }

  public leaveRoom(roomId: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket || !this.socket.connected) {
        return resolve();
      }
      const safetyTimer = setTimeout(() => resolve(), 10000);
      this.socket.emit("leave_room", { roomId, userId: this.userId, userName: this.userName }, () => {
        clearTimeout(safetyTimer);
        this.currentRoomSession = null;
        resolve();
      });
    });
  }

  public disconnect() {
    if (this.socket) {
      this.socket.disconnect();
    }
  }

  public makeCoHost(roomId: string, targetSocketId?: string, targetUserId?: string) {
    this.socket?.emit("make_cohost", { roomId, targetSocketId, targetUserId });
  }

  public removeCoHost(roomId: string, targetSocketId?: string, targetUserId?: string) {
    this.socket?.emit("remove_cohost", { roomId, targetSocketId, targetUserId });
  }

  public clearEvents() {
    this.hostChangedEvents = [];
    this.roomStateEvents = [];
    this.newHostEvents = [];
    this.newCohostEvents = [];
    this.cohostRemovedEvents = [];
    this.errorsReceived = [];
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("STARTING HOST / CO-HOST STATE SYNCHRONIZATION TESTS");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  // 1. Setup local HTTP and Socket.IO server
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  const GRACE_PERIOD_MS = 2500;
  const roomManager = new RoomManager(io, GRACE_PERIOD_MS);
  setupSocketHandlers(io, roomManager);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as any).port;
  const serverUrl = `http://localhost:${port}`;
  console.log(`Test server running at ${serverUrl}`);

  // Test users
  const userAId = "11111111-1111-4111-b111-111111111111";
  const userBId = "22222222-2222-4222-b222-222222222222";
  const userCId = "33333333-3333-4333-b333-333333333333";
  const userDId = "44444444-4444-4444-b444-444444444444";

  const tokenA = jwt.sign({ userId: userAId, id: userAId, email: "userA_host@test.com" }, JWT_SECRET);
  const tokenB = jwt.sign({ userId: userBId, id: userBId, email: "userB_host@test.com" }, JWT_SECRET);
  const tokenC = jwt.sign({ userId: userCId, id: userCId, email: "userC_host@test.com" }, JWT_SECRET);
  const tokenD = jwt.sign({ userId: userDId, id: userDId, email: "userD_host@test.com" }, JWT_SECRET);

  const roomId1 = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

  // Clean DB before tests
  try {
    await prisma.roomCoHost.deleteMany({ where: { roomId: roomId1 } });
    await prisma.participant.deleteMany({ where: { roomId: roomId1 } });
    await prisma.roomHistoryEntry.deleteMany({ where: { roomId: roomId1 } });
    await prisma.room.deleteMany({ where: { id: roomId1 } });
    await prisma.user.deleteMany({
      where: { id: { in: [userAId, userBId, userCId, userDId] } },
    });

    await prisma.user.createMany({
      data: [
        { id: userAId, email: "userA_host@test.com", name: "User A (Host)", passwordHash: "hash" },
        { id: userBId, email: "userB_host@test.com", name: "User B", passwordHash: "hash" },
        { id: userCId, email: "userC_host@test.com", name: "User C", passwordHash: "hash" },
        { id: userDId, email: "userD_host@test.com", name: "User D", passwordHash: "hash" },
      ],
    });

    await prisma.room.create({
      data: {
        id: roomId1,
        name: "Host Sync Test Room",
        hostId: userAId,
        isActive: true,
      },
    });
  } catch (e) {
    console.error("Setup DB error:", e);
  }

  try {
    // -------------------------------------------------------------
    // Scenario 1: Initial host assignment & Room join snapshot
    // -------------------------------------------------------------
    console.log("\n--- Scenario 1 & 2: Initial host assignment & All participants receive current host ---");
    const clientA = new SimulatedHostClient(userAId, "User A", serverUrl, tokenA);
    const clientB = new SimulatedHostClient(userBId, "User B", serverUrl, tokenB);
    const clientC = new SimulatedHostClient(userCId, "User C", serverUrl, tokenC);

    await clientA.connect();
    await clientA.joinRoom(roomId1);

    assert(clientA.currentHostId === userAId, "Host A client correctly identifies User A as host");
    assert(clientA.isHost === true, "Host A client isHost flag is true");

    await clientB.connect();
    await clientB.joinRoom(roomId1);
    await clientC.connect();
    await clientC.joinRoom(roomId1);

    assert(clientB.currentHostId === userAId, "Participant B client correctly identifies User A as host");
    assert(clientB.isHost === false, "Participant B client isHost flag is false");
    assert(clientC.currentHostId === userAId, "Participant C client correctly identifies User A as host");
    assert(clientC.isHost === false, "Participant C client isHost flag is false");

    // -------------------------------------------------------------
    // Scenario 3, 4, 5: Host leaves intentionally -> Authoritative migration to B
    // -------------------------------------------------------------
    console.log("\n--- Scenario 3, 4, 5: Host A leaves intentionally; replacement host B selected; B & C receive update ---");
    clientB.clearEvents();
    clientC.clearEvents();

    await clientA.leaveRoom(roomId1);
    await new Promise((r) => setTimeout(r, 600));

    // Verify DB updated
    const dbRoomAfterALeft = await prisma.room.findUnique({ where: { id: roomId1 } });
    assert(dbRoomAfterALeft?.hostId === userBId, "DB room.hostId authoritatively updated to User B");

    // Verify User B received host update and became host
    assert(clientB.currentHostId === userBId, "User B client state updated to hostId = User B");
    assert(clientB.isHost === true, "User B client isHost flag transitioned to true");

    // Verify User C received host update and identified B as host
    assert(clientC.currentHostId === userBId, "User C client state updated to hostId = User B");
    assert(clientC.isHost === false, "User C client isHost flag remains false");

    // Verify broadcast event was received by both
    assert(clientB.newHostEvents.length > 0, "User B received new_host socket event");
    assert(clientC.newHostEvents.length > 0, "User C received new_host socket event");

    // -------------------------------------------------------------
    // Scenario 6 & 7: Host disconnects temporarily; grace period respected; host reconnects
    // -------------------------------------------------------------
    console.log("\n--- Scenario 6 & 7: Host B disconnects temporarily; grace period respected; B reconnects ---");
    clientC.clearEvents();
    clientB.disconnect();

    // Wait within grace period (500ms < 2500ms)
    await new Promise((r) => setTimeout(r, 500));

    // Room should NOT have migrated yet during grace period
    const inFlightDbRoom = await prisma.room.findUnique({ where: { id: roomId1 } });
    assert(inFlightDbRoom?.hostId === userBId, "Host does NOT migrate immediately during disconnection grace period");
    assert(clientC.currentHostId === userBId, "Participant C still sees B as host during grace period");

    // Reconnect User B with fresh socket before grace period expires
    const clientB_reconnected = new SimulatedHostClient(userBId, "User B", serverUrl, tokenB);
    await clientB_reconnected.connect();
    await clientB_reconnected.joinRoom(roomId1);

    // Wait for the original grace period duration to elapse
    await new Promise((r) => setTimeout(r, GRACE_PERIOD_MS + 200));

    // Verify User B remained host and no duplicate or demotion occurred
    assert(clientB_reconnected.currentHostId === userBId, "Reconnected User B retained host role");
    assert(clientB_reconnected.isHost === true, "Reconnected User B isHost flag is true");
    assert(clientC.currentHostId === userBId, "Participant C still authoritatively sees B as host");

    // -------------------------------------------------------------
    // Scenario 8: Late join receives current migrated host immediately
    // -------------------------------------------------------------
    console.log("\n--- Scenario 8: Late join participant D receives correct host immediately ---");
    const clientD = new SimulatedHostClient(userDId, "User D", serverUrl, tokenD);
    await clientD.connect();
    await clientD.joinRoom(roomId1);

    assert(clientD.currentHostId === userBId, "Late-joining User D immediately receives hostId = User B");
    assert(clientD.isHost === false, "Late-joining User D isHost flag is false");

    // -------------------------------------------------------------
    // Scenario 9: Co-host assignment synchronization
    // -------------------------------------------------------------
    console.log("\n--- Scenario 9: Host B assigns User C as co-host; B, C, D all receive update ---");
    clientB_reconnected.clearEvents();
    clientC.clearEvents();
    clientD.clearEvents();

    const socketCId = clientC.socket?.id;
    clientB_reconnected.makeCoHost(roomId1, socketCId, userCId);
    await new Promise((r) => setTimeout(r, 900));

    // Verify DB co-host record exists
    const dbCoHost = await prisma.roomCoHost.findUnique({
      where: { roomId_userId: { roomId: roomId1, userId: userCId } },
    });
    assert(!!dbCoHost, "DB RoomCoHost record created for User C");

    // Verify all participants receive co-host state
    assert(clientB_reconnected.coHosts.includes(userCId), "Host B sees User C in coHosts list");
    assert(clientC.coHosts.includes(userCId), "User C sees themselves in coHosts list");
    assert(clientC.isHost === true, "User C isHost flag transitioned to true (as co-host)");
    assert(clientD.coHosts.includes(userCId), "User D sees User C in coHosts list");
    assert(clientD.isHost === false, "User D remains non-host");

    // -------------------------------------------------------------
    // Scenario 10: Co-host removal synchronization
    // -------------------------------------------------------------
    console.log("\n--- Scenario 10: Host B removes User C as co-host; B, C, D all receive removal ---");
    clientB_reconnected.clearEvents();
    clientC.clearEvents();
    clientD.clearEvents();

    clientB_reconnected.removeCoHost(roomId1, socketCId, userCId);
    await new Promise((r) => setTimeout(r, 900));

    // Verify DB co-host record deleted
    const dbCoHostAfterRemove = await prisma.roomCoHost.findUnique({
      where: { roomId_userId: { roomId: roomId1, userId: userCId } },
    });
    assert(!dbCoHostAfterRemove, "DB RoomCoHost record removed for User C");

    // Verify all participants updated
    assert(!clientB_reconnected.coHosts.includes(userCId), "Host B coHosts list no longer contains User C");
    assert(!clientC.coHosts.includes(userCId), "User C coHosts list no longer contains User C");
    assert(clientC.isHost === false, "User C isHost flag transitioned back to false");
    assert(!clientD.coHosts.includes(userCId), "User D coHosts list no longer contains User C");

    // -------------------------------------------------------------
    // Scenario 11: Host leaves when co-host exists -> Co-host prioritized for new host
    // -------------------------------------------------------------
    console.log("\n--- Scenario 11: Co-host prioritized when Host leaves ---");
    // Re-assign User C as co-host
    clientB_reconnected.makeCoHost(roomId1, socketCId, userCId);
    await new Promise((r) => setTimeout(r, 900));

    // Now Host B leaves
    await clientB_reconnected.leaveRoom(roomId1);
    await new Promise((r) => setTimeout(r, 900));

    // User C (co-host) should be selected over User D (normal participant)
    const dbRoomAfterBLeft = await prisma.room.findUnique({ where: { id: roomId1 } });
    assert(dbRoomAfterBLeft?.hostId === userCId, "DB room.hostId migrated to co-host User C (prioritized over D)");
    assert(clientC.currentHostId === userCId, "User C client state updated to hostId = User C");
    assert(clientD.currentHostId === userCId, "User D client state updated to hostId = User C");
    assert(clientC.isHost === true, "User C is now the primary host");

    // -------------------------------------------------------------
    // Scenario 12: Multiple sockets / tabs for host -> closing one does NOT migrate host
    // -------------------------------------------------------------
    console.log("\n--- Scenario 12: Host with multiple tabs; closing one tab does NOT migrate host ---");
    // Host C opens tab 2
    const clientC_tab2 = new SimulatedHostClient(userCId, "User C (Tab 2)", serverUrl, tokenC);
    await clientC_tab2.connect();
    await clientC_tab2.joinRoom(roomId1);

    assert(clientC_tab2.isHost === true, "Tab 2 for User C also recognizes host status");

    // Close tab 1
    clientC.disconnect();
    // Wait past grace period
    await new Promise((r) => setTimeout(r, GRACE_PERIOD_MS + 400));

    // Host must NOT have migrated to D because tab 2 was active
    const dbRoomMultiTab = await prisma.room.findUnique({ where: { id: roomId1 } });
    assert(dbRoomMultiTab?.hostId === userCId, "Host did NOT migrate because Tab 2 was still actively connected");
    assert(clientD.currentHostId === userCId, "User D still authoritatively sees User C as host");

    // -------------------------------------------------------------
    // Scenario 13: Stale disconnect timer race condition safety
    // -------------------------------------------------------------
    console.log("\n--- Scenario 13: Stale disconnect timer race condition safety ---");
    // Tab 2 disconnects, starting a disconnect timer
    clientC_tab2.disconnect();
    await new Promise((r) => setTimeout(r, GRACE_PERIOD_MS / 3));

    // Tab 3 connects before timer expires
    const clientC_tab3 = new SimulatedHostClient(userCId, "User C (Tab 3)", serverUrl, tokenC);
    await clientC_tab3.connect();
    await clientC_tab3.joinRoom(roomId1);

    // Wait past when Tab 2's timer would have fired
    await new Promise((r) => setTimeout(r, GRACE_PERIOD_MS + 400));

    const dbRoomStaleCheck = await prisma.room.findUnique({ where: { id: roomId1 } });
    assert(dbRoomStaleCheck?.hostId === userCId, "Stale disconnect timer safely cancelled; User C remains host");
    assert(clientC_tab3.isHost === true, "Tab 3 user remains host");

    // -------------------------------------------------------------
    // Scenario 14: Invalid / spoofed co-host commands rejected
    // -------------------------------------------------------------
    console.log("\n--- Scenario 14: Unauthorized / spoofed host events rejected ---");
    clientD.clearEvents();
    // User D is NOT host; attempts to make User A a co-host
    clientD.makeCoHost(roomId1, undefined, userAId);
    await new Promise((r) => setTimeout(r, 400));

    assert(clientD.errorsReceived.length > 0, "Server rejected make_cohost from non-host User D");
    const dbSpoofCheck = await prisma.roomCoHost.findUnique({
      where: { roomId_userId: { roomId: roomId1, userId: userAId } },
    });
    assert(!dbSpoofCheck, "DB confirms spoofed co-host assignment was NOT written");

    // -------------------------------------------------------------
    // Scenario 15: Clean cleanup and room state consistency
    // -------------------------------------------------------------
    console.log("\n--- Scenario 15: Clean disconnect & teardown ---");
    clientC_tab3.disconnect();
    clientD.disconnect();

    let isDeactivated = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const r = await prisma.room.findUnique({ where: { id: roomId1 } });
      if (r && r.isActive === false) {
        isDeactivated = true;
        break;
      }
    }
    assert(isDeactivated, "Room cleanly deactivated after all participants left");

  } finally {
    // Cleanup HTTP and DB
    httpServer.close();
    try {
      await prisma.roomCoHost.deleteMany({ where: { roomId: roomId1 } });
      await prisma.participant.deleteMany({ where: { roomId: roomId1 } });
      await prisma.roomHistoryEntry.deleteMany({ where: { roomId: roomId1 } });
      await prisma.room.deleteMany({ where: { id: roomId1 } });
      await prisma.user.deleteMany({
        where: { id: { in: [userAId, userBId, userCId, userDId] } },
      });
      await prisma.$disconnect();
    } catch (_) {}
  }

  console.log("\n==================================================");
  console.log(`HOST / CO-HOST TESTS FINISHED: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
