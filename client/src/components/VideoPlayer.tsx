import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import ReactPlayer from "react-player";
import { useSocketStore } from "../store/useSocketStore";
import { useAudioStore } from "../store/useAudioStore";

export interface VideoPlayerRef {
  seekTo: (time: number) => void;
  getCurrentTime: () => number;
}

interface VideoPlayerProps {
  roomId: string;
  isFullscreen?: boolean;
  isHost: boolean;
  broadcastMediaStream?: (stream: MediaStream) => void;
}

const VideoPlayer = forwardRef<VideoPlayerRef, VideoPlayerProps>(({ roomId, isFullscreen = false, isHost, broadcastMediaStream }, ref) => {
  const { socket } = useSocketStore();
  const [url, setUrl] = useState("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  const [inputUrl, setInputUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  
  const playerRef = useRef<ReactPlayer>(null);
  const isHandlingRemote = useRef(false);

  useImperativeHandle(ref, () => ({
    seekTo: (time: number) => {
      if (playerRef.current && typeof playerRef.current.seekTo === 'function') {
        playerRef.current.seekTo(time, "seconds");
      }
    },
    getCurrentTime: () => {
      if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
        return playerRef.current.getCurrentTime();
      }
      return 0;
    }
  }));

  const { settings, activeSpeakers, hostAnnouncementActive, hostSocketId } = useAudioStore();
  const baseVolumeRef = useRef(0.8);
  const targetVolumeRef = useRef(0.8);

  useEffect(() => {
    if (!settings.isEnabled) {
      targetVolumeRef.current = baseVolumeRef.current;
    } else {
      let isHostSpeaking = false;
      if (hostAnnouncementActive) {
        isHostSpeaking = true;
      } else if (hostSocketId && activeSpeakers.includes(hostSocketId)) {
        isHostSpeaking = true;
      }

      const hasActiveSpeakers = activeSpeakers.length > 0;
      
      let duckAmount = settings.duckingLevel;
      if (settings.audioMode === 'cinema') duckAmount = Math.max(0.2, settings.duckingLevel - 0.3);
      if (settings.audioMode === 'conversation') duckAmount = Math.min(1.0, settings.duckingLevel + 0.3);
      if (isHostSpeaking) duckAmount = 0.9; // Host ducks deeply
      if (settings.audioMode === 'custom') {
         // simple interpretation of custom movie volume acting as max
         baseVolumeRef.current = settings.customMovieVolume;
      } else {
         baseVolumeRef.current = 0.8;
      }

      if (hasActiveSpeakers) {
        targetVolumeRef.current = baseVolumeRef.current * (1 - duckAmount);
      } else {
        targetVolumeRef.current = baseVolumeRef.current;
      }
    }
  }, [settings, activeSpeakers, hostAnnouncementActive, hostSocketId]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setVolume((prev) => {
        const diff = targetVolumeRef.current - prev;
        if (Math.abs(diff) < 0.01) {
          return targetVolumeRef.current;
        }
        
        let speedMult = 0.1;
        if (diff < 0) {
          // fading down
          if (settings.duckingSpeed === 'slow') speedMult = 0.05;
          if (settings.duckingSpeed === 'fast') speedMult = 0.2;
        } else {
          // fading up
          if (settings.recoverySpeed === 'slow') speedMult = 0.02;
          if (settings.recoverySpeed === 'fast') speedMult = 0.15;
        }

        return prev + diff * speedMult;
      });
    }, 50);

    return () => clearInterval(intervalId);
  }, [settings.duckingSpeed, settings.recoverySpeed]);

  useEffect(() => {
    if (!socket) return;

    socket.on("play_video", ({ time }) => {
      isHandlingRemote.current = true;
      if (playerRef.current) {
        const currentTime = typeof playerRef.current.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
        if (Math.abs(currentTime - time) > 2) {
          if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(time, "seconds");
        }
      }
      setPlaying(true);
      setTimeout(() => { isHandlingRemote.current = false; }, 500);
    });

    socket.on("pause_video", ({ time }) => {
      isHandlingRemote.current = true;
      if (playerRef.current) {
        if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(time, "seconds");
      }
      setPlaying(false);
      setTimeout(() => { isHandlingRemote.current = false; }, 500);
    });

    socket.on("video_state", ({ playing, time, url: newUrl }) => {
        isHandlingRemote.current = true;
        setPlaying(playing);
        if (newUrl !== url) setUrl(newUrl);
        if (playerRef.current) {
          if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(time, "seconds");
        }
        setTimeout(() => { isHandlingRemote.current = false; }, 500);
      });

    socket.on("seek_video", ({ time }) => {
      isHandlingRemote.current = true;
      if (playerRef.current) {
        if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(time, "seconds");
      }
      setTimeout(() => { isHandlingRemote.current = false; }, 500);
    });

    socket.on("change_video", ({ url: newUrl }) => {
      setUrl(newUrl);
      setPlaying(true);
      if (playerRef.current) {
        if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(0);
      }
    });

    socket.on("request_sync", ({ socketId }) => {
      if (isHost && playerRef.current) {
        const time = typeof playerRef.current.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
        socket.emit("sync_response", { targetSocketId: socketId, time, playing: playing, url });
      }
    });

    socket.on("sync_response", ({ time, playing: hostPlaying, url: hostUrl }) => {
      isHandlingRemote.current = true;
      if (hostUrl !== url) setUrl(hostUrl);
      setPlaying(hostPlaying);
      if (playerRef.current) {
        const myTime = typeof playerRef.current.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
        const drift = time - myTime;
        
        if (Math.abs(drift) > 3) {
          if (typeof playerRef.current.seekTo === 'function') playerRef.current.seekTo(time, "seconds");
          setPlaybackRate(1.0);
        } else if (drift > 0.5) {
          setPlaybackRate(1.05); // Host is ahead, speed up
        } else if (drift < -0.5) {
          setPlaybackRate(0.95); // Host is behind, slow down
        } else {
          setPlaybackRate(1.0); // Synced!
        }
      }
      setTimeout(() => { isHandlingRemote.current = false; }, 500);
    });

    return () => {
      socket.off("play_video");
      socket.off("pause_video");
      socket.off("seek_video");
      socket.off("change_video");
      socket.off("request_sync");
      socket.off("sync_response");
    };
  }, [socket, isHost, playing, url]);

  useEffect(() => {
    if (isHost || !socket) return;
    const intervalId = setInterval(() => {
      socket.emit("request_sync", { roomId });
    }, 10000); // Ping every 10 seconds for seamless sync
    return () => clearInterval(intervalId);
  }, [isHost, socket, roomId]);

  const handlePlay = () => {
    if (isHandlingRemote.current) return;
    if (!isHost) {
      setPlaying(false); // Instantly revert if not host
      setTimeout(() => setPlaying(true), 10); // Force re-render just in case
      return;
    }
    setPlaying(true);
    const time = typeof playerRef.current?.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
    socket?.emit("play_video", { roomId, time });
  };

  const handlePause = () => {
    if (isHandlingRemote.current) return;
    if (!isHost) {
      setPlaying(true); // Instantly revert if not host
      setTimeout(() => setPlaying(false), 10);
      return;
    }
    setPlaying(false);
    const time = typeof playerRef.current?.getCurrentTime === 'function' ? playerRef.current.getCurrentTime() : 0;
    socket?.emit("pause_video", { roomId, time });
  };

  const handleProgress = () => {
    // Implement drift correction here if needed
  };

  const [videoError, setVideoError] = useState(false);

  const changeVideo = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUrl) {
      let finalUrl = inputUrl.trim();
      if (!/^https?:\/\//i.test(finalUrl)) {
        finalUrl = 'https://' + finalUrl;
      }
      setUrl(finalUrl);
      setPlaying(true);
      setVideoError(false);
      socket?.emit("change_video", { roomId, url: finalUrl });
      socket?.emit("play_video", { roomId, time: 0 });
      setInputUrl("");
    }
  };

  // Unwrap default export for Vite ESM compatibility with react-player v2
  const Player: any = (ReactPlayer as any).default || ReactPlayer;

  const handleLocalFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const fileUrl = URL.createObjectURL(file);
    setUrl(fileUrl);
    setPlaying(true);
    setVideoError(false);
    
    // We do not broadcast the blob URL because peers cannot access it.
    // Instead, we will capture the stream once it starts playing and broadcast it.
    socket?.emit("play_video", { roomId, time: 0 });
    
    // Attempt to capture stream after a short delay to ensure video element is mounted and playing
    setTimeout(() => {
      if (playerRef.current && broadcastMediaStream) {
        const videoEl = playerRef.current.getInternalPlayer() as HTMLVideoElement;
        if (videoEl && typeof (videoEl as any).captureStream === 'function') {
          const stream = (videoEl as any).captureStream();
          broadcastMediaStream(stream);
        } else if (videoEl && typeof (videoEl as any).mozCaptureStream === 'function') {
          const stream = (videoEl as any).mozCaptureStream();
          broadcastMediaStream(stream);
        }
      }
    }, 1000);
  };

  return (
    <div className={`flex flex-col w-full h-full relative group transition-all duration-300 ${isFullscreen ? '' : 'p-4'}`}>
      <div className={`absolute z-10 p-2 rounded-lg backdrop-blur-sm border border-slate-700 flex flex-col items-end transition-opacity duration-300 ${isFullscreen ? 'top-4 right-4' : 'top-6 right-6'} ${videoError ? 'opacity-100 bg-red-900/80 border-red-500/50' : 'opacity-0 group-hover:opacity-100 bg-slate-900/80'}`}>
        {isHost ? (
          <div className="flex flex-col gap-2 mb-2 w-80">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder="Paste video URL (youtube.com...)"
                className={`flex-1 bg-black/50 text-white px-3 py-1.5 rounded text-sm focus:outline-none focus:ring-1 transition-colors ${videoError ? 'border border-red-500 focus:ring-red-500 placeholder-red-300/50' : 'focus:ring-indigo-500'}`}
              />
              <button
                onClick={changeVideo}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded text-sm transition-colors"
              >
                Change
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 font-medium">OR PLAY LOCAL FILE:</span>
              <input 
                type="file" 
                accept="video/*" 
                onChange={handleLocalFile}
                className="text-xs text-slate-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-indigo-600 file:text-white hover:file:bg-indigo-500 transition-colors w-full cursor-pointer"
              />
            </div>
          </div>
        ) : (
          <div className="flex justify-end w-full mb-2">
            <button
              onClick={() => socket?.emit("request_sync", { roomId })}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21v-5h5"/></svg>
              Sync with Host
            </button>
          </div>
        )}
        {videoError && (
          <div className="text-red-300 text-xs text-right mt-1 font-medium bg-red-950/80 p-2 rounded w-full border border-red-900/50">
            Cannot play this URL. Make sure it's a direct video link.
          </div>
        )}
      </div>

      <div className={`flex-1 overflow-hidden relative bg-black flex items-center justify-center transition-all duration-300 ${isFullscreen ? '' : 'rounded-2xl shadow-2xl border border-slate-800'}`}>
        <Player
          key={url}
          ref={playerRef}
          url={url}
          width="100%"
          height="100%"
          playing={playing}
          volume={volume}
          playbackRate={playbackRate}
          onPlay={handlePlay}
          onPause={handlePause}
          onProgress={handleProgress}
          onError={() => setVideoError(true)}
          controls={true}
          config={{ youtube: { playerVars: { fs: 0 } } }}
          style={{ position: "absolute", top: 0, left: 0 }}
        />
      </div>
    </div>
  );
});

export default VideoPlayer;
