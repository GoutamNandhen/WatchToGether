import dotenv from "dotenv";
import { startReminderScheduler } from "./managers/ReminderScheduler";
import { initRedis } from "./infra/redis";

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error("FATAL ERROR: JWT_SECRET environment variable is not defined.");
  process.exit(1);
}

// Imported after dotenv so modules see the configured environment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require("./app") as typeof import("./app");


const start = async () => {
  const redis = await initRedis();
  const { httpServer, io } = createApp({ redis });
  startReminderScheduler(io);
  const PORT = process.env.PORT || 5000;

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

start();
