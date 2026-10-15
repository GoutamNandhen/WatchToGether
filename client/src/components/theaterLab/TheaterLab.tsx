import { useCallback, useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from "react";
import { ArrowLeft, Compass, Expand, Glasses, Gauge, Info, Maximize2, Pause, Play, RotateCcw, Upload, Volume2, VolumeX, X } from "lucide-react";
import { Link } from "react-router-dom";
import { CinemaRenderer, type TheaterQuality, type TheaterSeat } from "./CinemaRenderer";
import "./theaterLab.css";

type MotionState = "unavailable" | "available" | "requesting" | "waiting" | "active" | "denied" | "needs-https";
type TextureState = "placeholder" | "waiting" | "ready" | "working" | "failed";

const detectDevice = () => {
  if (typeof window === "undefined") return "Unknown";
  const touch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  return touch && Math.min(window.innerWidth, window.innerHeight) < 760 ? "Phone / touch" : touch ? "Touch computer / tablet" : "Desktop";
};

export default function TheaterLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<CinemaRenderer | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const motionSeenRef = useRef(false);
  const [device] = useState(detectDevice);
  const [webgl, setWebgl] = useState<"checking" | "available" | "unavailable">("checking");
  const [quality, setQuality] = useState<TheaterQuality>("medium");
  const [seat, setSeat] = useState<TheaterSeat>("gallery");
  const [stereo, setStereo] = useState(false);
  const [eyeSep, setEyeSep] = useState(0.065);
  const [fullscreen, setFullscreen] = useState(false);
  const [motionState, setMotionState] = useState<MotionState>(() => typeof window !== "undefined" && "DeviceOrientationEvent" in window ? "available" : "unavailable");
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [textureState, setTextureState] = useState<TextureState>("placeholder");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    try {
      const scene = new CinemaRenderer(canvas, device.startsWith("Phone"), (report) => {
        setFps(report.fps);
        if (report.error) {
          setRenderError(report.error);
          setTextureState((current) => current === "working" ? "failed" : current);
        }
      });
      scene.setQuality("medium");
      sceneRef.current = scene;
      queueMicrotask(() => { if (!cancelled) setWebgl("available"); });
      return () => {
        cancelled = true;
        scene.dispose();
        sceneRef.current = null;
      };
    } catch (error) {
      queueMicrotask(() => {
        if (!cancelled) {
          setWebgl("unavailable");
          setRenderError(error instanceof Error ? error.message : "WebGL is unavailable in this browser.");
        }
      });
      return () => { cancelled = true; };
    }
  }, [device]);

  useEffect(() => {
    return () => { if (videoUrl) URL.revokeObjectURL(videoUrl); };
  }, [videoUrl]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName)) return;
      const selected: TheaterSeat | undefined = event.key === "1" ? "gallery" : event.key === "2" ? "center" : event.key === "3" ? "front" : undefined;
      if (selected) {
        setSeat(selected);
        sceneRef.current?.setSeat(selected);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        sceneRef.current?.look(event.key === "ArrowLeft" ? 16 : -16, 0);
        event.preventDefault();
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        sceneRef.current?.look(0, event.key === "ArrowUp" ? 16 : -16);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!motionEnabled) return;
    motionSeenRef.current = false;
    const onMotion = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null || event.gamma === null) return;
      const angle = screen.orientation?.angle ?? 0;
      sceneRef.current?.useMotion(event.alpha, event.beta, event.gamma, angle);
      if (!motionSeenRef.current) {
        motionSeenRef.current = true;
        setMotionState("active");
      }
    };
    window.addEventListener("deviceorientation", onMotion);
    const timeout = window.setTimeout(() => {
      if (!motionSeenRef.current) {
        setMotionState("unavailable");
        setMotionEnabled(false);
      }
    }, 3500);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("deviceorientation", onMotion);
      sceneRef.current?.disableMotion();
    };
  }, [motionEnabled]);

  const pickSeat = (value: TheaterSeat) => {
    setSeat(value);
    sceneRef.current?.setSeat(value);
  };

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type !== "video/mp4" && !file.name.toLowerCase().endsWith(".mp4")) {
      setNotice("Choose a local MP4 file for this prototype.");
      event.target.value = "";
      return;
    }
    videoRef.current?.pause();
    sceneRef.current?.setVideo(null);
    setPlaying(false);
    setTextureState("waiting");
    setNotice(null);
    setVideoName(file.name);
    setVideoUrl(URL.createObjectURL(file));
    event.target.value = "";
  };

  const playVideo = async () => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;
    if (playing) {
      video.pause();
      return;
    }
    try {
      video.volume = volume;
      await video.play();
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight) {
        sceneRef.current?.setVideo(video);
        setTextureState("ready");
      } else {
        setTextureState("waiting");
      }
      setNotice(null);
    } catch (error) {
      video.pause();
      sceneRef.current?.setVideo(null);
      setTextureState("failed");
      setNotice(error instanceof Error ? `Playback blocked or unsupported: ${error.message}` : "Playback was blocked by this browser.");
    }
  };

  const toggleFullscreen = useCallback(async () => {
    const target = stageRef.current;
    if (!target) return;
    try {
      if (document.fullscreenElement === target) await document.exitFullscreen();
      else if (target.requestFullscreen) await target.requestFullscreen();
      else setNotice("This browser does not support page fullscreen. Stereo remains available in the page.");
    } catch {
      setNotice("Fullscreen was declined by this browser. You can keep watching in the page.");
    }
  }, []);

  const enterStereo = async () => {
    setStereo(true);
    sceneRef.current?.setStereo(true, eyeSep);
    if (stageRef.current?.requestFullscreen && document.fullscreenElement !== stageRef.current) {
      try { await stageRef.current.requestFullscreen(); }
      catch { setNotice("Stereo is active in the page; fullscreen was unavailable."); }
    }
  };

  const exitStereo = async () => {
    setStereo(false);
    sceneRef.current?.setStereo(false);
    if (document.fullscreenElement === stageRef.current) {
      try { await document.exitFullscreen(); } catch { /* Browser may already have exited. */ }
    }
  };

  const enableMotion = async () => {
    if (motionEnabled) {
      setMotionEnabled(false);
      setMotionState("available");
      return;
    }
    if (!window.isSecureContext) {
      setMotionState("needs-https");
      setNotice("Motion sensors need a secure HTTPS page on phones. See the local testing instructions.");
      return;
    }
    if (!("DeviceOrientationEvent" in window)) {
      setMotionState("unavailable");
      return;
    }
    setMotionState("requesting");
    try {
      const sensor = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };
      if (sensor.requestPermission && await sensor.requestPermission() !== "granted") {
        setMotionState("denied");
        return;
      }
      setMotionState("waiting");
      setMotionEnabled(true);
    } catch {
      setMotionState("denied");
      setNotice("Motion permission was not granted. Touch look is still available.");
    }
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (webgl !== "available") return;
    dragRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    sceneRef.current?.look(event.clientX - dragRef.current.x, event.clientY - dragRef.current.y);
    dragRef.current = { x: event.clientX, y: event.clientY };
  };

  return (
    <div className="t3-root">
      <header className="t3-header">
        <div className="t3-brand"><span className="t3-brand-mark">W</span><span>WATCHTOGETHER <strong>THEATER LAB</strong></span></div>
        <div className="t3-header-actions">
          <span className="t3-dev-pill">DEVELOPMENT PROTOTYPE</span>
          <Link to="/" className="t3-quiet-link"><ArrowLeft size={15} /> Classic Mode</Link>
        </div>
      </header>

      <main className="t3-main">
        <div className="t3-stage" ref={stageRef}>
          <div className="t3-viewport" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
            <canvas ref={canvasRef} aria-label="Interactive 3D cinema" />
            {webgl === "unavailable" && <div className="t3-fallback">
              <div className="t3-fallback-screen">{!videoUrl && <><span>PRIVATE SCREENING</span><strong>THE CINEMA IS YOURS</strong><small>WebGL is unavailable. Local MP4 playback remains available below.</small></>}</div>
            </div>}
            <video ref={videoRef} className={webgl === "unavailable" && videoUrl ? "t3-video-fallback" : "t3-video-hidden"}
              src={videoUrl || undefined} playsInline preload="metadata" onPause={() => setPlaying(false)}
              onPlaying={() => setPlaying(true)} onLoadedData={(event) => {
                const video = event.currentTarget;
                if (!video.paused && webgl === "available") {
                  sceneRef.current?.setVideo(video);
                  setTextureState("ready");
                }
              }}
              onTimeUpdate={(event) => { if (event.currentTarget.currentTime > 0 && webgl === "available" && !renderError) setTextureState("working"); }}
              onError={() => { setTextureState("failed"); setNotice("This MP4 or codec is not supported by the browser."); sceneRef.current?.setVideo(null); }}
              onEnded={() => setPlaying(false)} />
          </div>

          {!stereo && <>
            <div className="t3-stage-label"><span className="t3-indicator" /> CINEMA 01 <i /> {seat.toUpperCase()} VIEW</div>
            <div className="t3-stage-hint">DRAG TO LOOK <i /> SEAT KEYS 1–3</div>
            {showDiagnostics && <aside className="t3-diagnostics" aria-label="Theater diagnostics">
              <div className="t3-diagnostics-title"><Gauge size={14} /> LIVE DIAGNOSTICS <button type="button" onClick={() => setShowDiagnostics(false)} aria-label="Hide diagnostics"><X size={13} /></button></div>
              <dl>
                <div><dt>Device</dt><dd>{device}</dd></div>
                <div><dt>WebGL</dt><dd>{webgl}</dd></div>
                <div><dt>Touch</dt><dd>{navigator.maxTouchPoints > 0 || "ontouchstart" in window ? "yes" : "no"}</dd></div>
                <div><dt>Gyroscope</dt><dd>{motionState.replace("-", " ")}</dd></div>
                <div><dt>Stereo</dt><dd>{webgl === "available" ? stereo ? "on" : "available" : "unavailable"}</dd></div>
                <div><dt>Approx. FPS</dt><dd>{fps === null ? document.hidden ? "paused" : "—" : fps}</dd></div>
                <div><dt>Quality</dt><dd>{quality}</dd></div>
                <div><dt>Video texture</dt><dd>{textureState}</dd></div>
                <div className="t3-error-row"><dt>Last error</dt><dd>{renderError || "none"}</dd></div>
              </dl>
            </aside>}
            {!showDiagnostics && <button type="button" className="t3-diagnostics-open" onClick={() => setShowDiagnostics(true)}><Info size={14} /> Diagnostics</button>}
          </>}

          {stereo && <div className="t3-vr-actions">
            <button type="button" onClick={() => sceneRef.current?.recenter()}><RotateCcw size={16} /> Recenter</button>
            <button type="button" onClick={exitStereo}><X size={17} /> Exit VR</button>
          </div>}

          {!stereo && <div className="t3-bottom">
            <div className="t3-status"><span className="t3-status-kicker">YOUR PRIVATE SCREENING</span><strong>{videoName || "A new perspective on movie night"}</strong><small>{videoName ? "Local file · never uploaded" : "A room-independent 3D feasibility study"}</small></div>
            <div className="t3-controls">
              <input ref={fileInputRef} type="file" accept="video/mp4,.mp4" onChange={chooseFile} className="sr-only" aria-label="Choose local MP4" />
              <button type="button" className="t3-primary" onClick={() => fileInputRef.current?.click()}><Upload size={15} /> <span>Local MP4</span></button>
              <button type="button" className="t3-icon" onClick={playVideo} disabled={!videoUrl} aria-label={playing ? "Pause video" : "Play video"}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
              <label className="t3-volume" aria-label="Video volume">{volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}<input type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => { const value = Number(event.target.value); setVolume(value); if (videoRef.current) videoRef.current.volume = value; }} /></label>
              <span className="t3-divider" />
              <div className="t3-seat-picker" aria-label="Seat position"><Compass size={15} />{(["gallery", "center", "front"] as const).map((value) => <button type="button" key={value} className={seat === value ? "selected" : ""} onClick={() => pickSeat(value)}>{value}</button>)}</div>
              <button type="button" className="t3-icon" onClick={toggleFullscreen} title="Fullscreen" aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Expand size={17} /> : <Maximize2 size={17} />}</button>
              <button type="button" className="t3-vr-button" onClick={enterStereo} disabled={webgl !== "available"}><Glasses size={17} /> <span>Phone VR</span></button>
            </div>
          </div>}
        </div>

        {!stereo && <div className="t3-options">
          <div className="t3-options-group"><span>RENDER QUALITY</span><div className="t3-segment">{(["low", "medium", "high"] as const).map((value) => <button type="button" key={value} className={quality === value ? "selected" : ""} onClick={() => { setQuality(value); sceneRef.current?.setQuality(value); }}>{value}</button>)}</div></div>
          <div className="t3-options-group"><span>HEAD TRACKING</span><button type="button" className="t3-subtle-button" onClick={enableMotion} disabled={motionState === "unavailable" || motionState === "requesting"}>{motionEnabled ? "Disable motion" : "Enable motion"}</button><button type="button" className="t3-subtle-button" onClick={() => sceneRef.current?.recenter()}><RotateCcw size={14} /> Recenter</button></div>
          <div className="t3-options-group"><span>STEREO STRENGTH</span><input type="range" min={0.035} max={0.095} step={0.005} value={eyeSep} onChange={(event) => { const value = Number(event.target.value); setEyeSep(value); sceneRef.current?.setEyeSeparation(value); }} aria-label="Stereo eye separation" /><small>{Math.round(eyeSep * 1000)} mm</small></div>
        </div>}
        {notice && !stereo && <div className="t3-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice"><X size={14} /></button></div>}
        {!stereo && <p className="t3-footnote">LOCAL PROTOTYPE <span>·</span> No room connection, movie service, or DRM playback <span>·</span> Motion controls require browser and device support</p>}
      </main>
    </div>
  );
}
