import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import authRoutes from "./routes/auth";
import roomRoutes from "./routes/room";
import friendRoutes from "./routes/friend";
import { setupSocketHandlers } from "./socket";

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error("FATAL ERROR: JWT_SECRET environment variable is not defined.");
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

app.set("io", io);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/friends", friendRoutes);

app.get("/", (req, res) => {
  res.send("CineSync API");
});

// Socket.io Setup
const roomManager = setupSocketHandlers(io);
app.set("roomManager", roomManager);

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
