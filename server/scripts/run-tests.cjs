const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Every integration suite writes to Prisma. Require an explicit, local test database
// before loading any test or server code that writes participant rows.
const databaseUrl = process.env.TEST_DATABASE_URL;
let parsed;
try {
  parsed = new URL(databaseUrl);
} catch {
  // Keep credentials out of diagnostics.
}

const databaseName = parsed && decodeURIComponent(parsed.pathname.slice(1));
if (
  !parsed ||
  !["postgres:", "postgresql:"].includes(parsed.protocol) ||
  !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname) ||
  !/(^|[_-])test([_-]|$)/i.test(databaseName || "") ||
  databaseUrl === process.env.DATABASE_URL ||
  databaseUrl === process.env.DIRECT_URL
) {
  console.error("Integration tests require TEST_DATABASE_URL for a separate local PostgreSQL database with 'test' in its name.");
  process.exit(1);
}

const environment = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DIRECT_URL: databaseUrl,
  JWT_SECRET: "watchtogether-isolated-test-secret",
  REDIS_URL: "",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
};

const regularTests = [
  "moments_spoilers",
  "break_focus",
  "phase1_security_lifecycle",
  "room_features",
  "http_features",
  "youtube",
  "room_lifecycle",
  "reconnection",
  "camera_lifecycle",
  "remote_audio_pipeline",
  "local_video_presentation",
  "host_cohost_sync",
  "playback_sync",
];

const multi = process.argv.includes("--multi");
const redisUrl = process.env.TEST_REDIS_URL;
if (multi || redisUrl) {
  let redis;
  try {
    redis = new URL(redisUrl);
  } catch {
    // Report the missing test service without printing its URL.
  }
  if (!redis || !["redis:", "rediss:"].includes(redis.protocol) || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(redis.hostname)) {
    console.error("Multi-instance tests require TEST_REDIS_URL for a local Redis service.");
    process.exit(1);
  }
  environment.REDIS_URL = redisUrl;
}

const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const availableTests = multi ? ["multi_instance"] : [...regularTests, ...(redisUrl ? ["multi_instance"] : [])];
if (only && !availableTests.includes(only)) {
  console.error("Unknown or unavailable test suite.");
  process.exit(1);
}
const testNames = only ? [only] : availableTests;
for (const name of testNames) {
  console.log(`\nRunning ${name}.test.ts`);
  const result = spawnSync(process.execPath, [require.resolve("ts-node/dist/bin"), path.join(__dirname, "..", "src", "tests", `${name}.test.ts`)], {
    cwd: path.join(__dirname, ".."),
    env: environment,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Could not start ${name}.test.ts: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

if (!multi && !redisUrl) console.log("Multi-instance suite blocked: set TEST_REDIS_URL to a local Redis service to include it.");
