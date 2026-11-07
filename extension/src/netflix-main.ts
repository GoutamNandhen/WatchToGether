// Runs in Netflix's own page context so it can use the site's player API for seeking.
interface NetflixPlayer { seek(ms: number): void }
interface NetflixWindow extends Window {
  netflix?: { appContext?: { state?: { playerApp?: { getAPI?: () => { videoPlayer: { getAllPlayerSessionIds(): string[]; getVideoPlayerBySessionId(id: string): NetflixPlayer } } } } } };
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "watchtogether" || event.data.type !== "seek") return;
  const ms = Number(event.data.ms);
  if (!Number.isFinite(ms) || ms < 0) return;
  try {
    const api = (window as NetflixWindow).netflix?.appContext?.state?.playerApp?.getAPI?.();
    const ids = api?.videoPlayer.getAllPlayerSessionIds() ?? [];
    const id = ids.find((s) => s.startsWith("watch")) ?? ids[0];
    if (id) api!.videoPlayer.getVideoPlayerBySessionId(id).seek(ms);
  } catch (err) {
    console.warn("[WatchTogether] Netflix seek failed", err);
  }
});
