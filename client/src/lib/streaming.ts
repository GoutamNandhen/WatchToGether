/** Subscription streaming services the WatchTogether Sync extension supports. Their video is
 * DRM-protected, so it can't play inside the room: each viewer opens it on their own account. */
const SERVICES: Array<{ name: string; pattern: RegExp }> = [
  { name: "Netflix", pattern: /(^|\.)netflix\.com$/ },
  { name: "Disney+ Hotstar", pattern: /(^|\.)hotstar\.com$/ },
  { name: "Prime Video", pattern: /(^|\.)primevideo\.com$/ },
  { name: "SonyLIV", pattern: /(^|\.)sonyliv\.com$/ },
  { name: "ZEE5", pattern: /(^|\.)zee5\.com$/ },
  { name: "JioCinema", pattern: /(^|\.)jiocinema\.com$/ },
];

export const streamingService = (url: string): string | null => {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)amazon\.[a-z.]+$/.test(host) && /\/(gp\/video|dp)\//.test(url)) return "Prime Video";
    return SERVICES.find((s) => s.pattern.test(host))?.name ?? null;
  } catch {
    return null;
  }
};

export const EXTENSION_HELP_URL = "https://github.com/GoutamNandhen/WatchToGether/tree/main/extension#readme";
