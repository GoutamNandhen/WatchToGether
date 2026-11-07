import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const API_URL = process.env.WT_API_URL || "https://watchtogether-api.onrender.com";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    bridge: "src/bridge.ts",
    player: "src/player.ts",
    "netflix-main": "src/netflix-main.ts",
    popup: "src/popup.ts",
  },
  bundle: true,
  format: "iife",
  target: "chrome114",
  outdir: "dist",
  minify: true,
  define: { __API_URL__: JSON.stringify(API_URL) },
});

cpSync("manifest.json", "dist/manifest.json");
cpSync("popup.html", "dist/popup.html");
cpSync("icons", "dist/icons", { recursive: true });
console.log(`Built to extension/dist (API ${API_URL})`);
