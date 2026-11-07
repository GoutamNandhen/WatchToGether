# WatchTogether Sync (browser extension)

Watch Netflix, Disney+ Hotstar, Prime Video, SonyLIV, ZEE5 and JioCinema together. Everyone streams the title from **their own account**; the extension keeps every player on the same second, and your WatchTogether room handles chat, voice, video and reactions.

It never captures, records or re-streams the video, and it doesn't touch DRM. That's why screen sharing these sites goes black, and why this extension works instead.

## Install (developer mode, for now)

1. `cd extension && npm install && npm run build`
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**.
3. **Load unpacked** and choose `extension/dist`.

## Use it

1. Host: in your room, paste the title's link (for example `https://www.netflix.com/watch/81234567`) as the video. Everyone sees an **Open on Netflix** card.
2. Everyone: open the title in a new tab, pause at the start.
3. Click the extension icon on that tab and press **Link this tab to my room**. Keep the room tab open for chat and voice.
4. The host plays, pauses and seeks; everyone else follows. Viewers who drift more than 1.5 s are nudged back.

## How it works

- `bridge.js` runs on the WatchTogether site and, only when the extension asks, hands over your session and current room.
- `background.js` opens its own Socket.io connection to the API and joins the room, using the same `play_video` / `pause_video` / `seek_video` / `sync_time` events as the web player.
- `player.js` finds the main `<video>` on the streaming site, reports the host's actions and applies the room's position.
- `netflix-main.js` seeks through Netflix's own player API, because setting `currentTime` directly makes Netflix error out.

## Limits

- Desktop Chrome, Edge, Brave and other Chromium browsers. Phones and TV apps don't support extensions.
- Everyone needs their own subscription, in a region where the title is available.
- Ads and intros differ per account, so the host may need to pause until everyone is past them.
- Sites change their players; adapters may need updating. Prime Video seeking is the least reliable so far.
- The extension's connection shows as a second presence for you in the room.

Build for another API: `WT_API_URL=https://your-api.example.com npm run build` (also add that host to `host_permissions` in `manifest.json`).
