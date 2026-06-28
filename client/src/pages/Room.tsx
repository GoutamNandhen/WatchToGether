import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../store/useAuthStore";
import { useSocketStore } from "../store/useSocketStore";
import VideoPlayer from "../components/VideoPlayer";
import VideoGrid from "../components/VideoGrid";
import { useWebRTC } from "../hooks/useWebRTC";
import { useVoiceActivityDetection } from "../hooks/useVoiceActivityDetection";
import { useAudioStore } from "../store/useAudioStore";
import { Settings, Mic2, MessageSquare, Users, ChevronRight, Share2, Clock } from "lucide-react";
import api from "../lib/api";
import AudioSettingsModal from "../components/AudioSettingsModal";
import InviteModal from "../components/InviteModal";
import type { VideoPlayerRef } from "../components/VideoPlayer";

export default function Room() {
  const { id } = useParams();
  const location = useLocation();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const { socket, connect, disconnect, joinRoom, leaveRoom, sendMessage, messages, clearMessages } = useSocketStore();
  const [chatInput, setChatInput] = useState("");
  const chatRef = useRef<HTMLDivElement>(null);
  const { getLocalStream, localStream, localStreamState, screenStreamState, peers, peerStatuses, screenShares, toggleAudio, toggleVideo, shareScreen, broadcastMediaStream } = useWebRTC(id || "");
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [mainScreenSource, setMainScreenSource] = useState<'url' | string>('url');
  const [roomCreatedAt, setRoomCreatedAt] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [hoverZones, setHoverZones] = useState({ top: false, right: false, bottom: false });
  const [isCameraSidebarOpen, setIsCameraSidebarOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [duration, setDuration] = useState("00:00:00");
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const videoPlayerRef = useRef<VideoPlayerRef>(null);

  const insertTimestamp = () => {
    if (!videoPlayerRef.current) return;
    const currentSeconds = Math.floor(videoPlayerRef.current.getCurrentTime());
    const h = Math.floor(currentSeconds / 3600);
    const m = Math.floor((currentSeconds % 3600) / 60);
    const s = currentSeconds % 60;
    
    let timeStr = "";
    if (h > 0) {
      timeStr = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    } else {
      timeStr = `${m}:${s.toString().padStart(2, '0')}`;
    }
    
    setChatInput(prev => `${prev} [Time: ${timeStr}] `);
  };

  const handleSeekToTime = (timeStr: string) => {
    if (!isHost) return;
    const parts = timeStr.split(':').map(Number);
    let seconds = 0;
    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else {
      seconds = parts[0] * 60 + parts[1];
    }
    socket?.emit("seek_video", { roomId: id, time: seconds });
    socket?.emit("play_video", { roomId: id, time: seconds });
    videoPlayerRef.current?.seekTo(seconds);
  };

  const parseMessageContent = (content: string) => {
    const timeRegex = /\[Time:\s*(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
    const parts = content.split(timeRegex);
    
    if (parts.length === 1) return content;
    
    return parts.map((part, i) => {
      if (i % 2 === 1) { // It's the timeMatch
        return (
          <button 
            key={i} 
            onClick={() => handleSeekToTime(part)} 
            className="text-indigo-300 hover:text-indigo-200 font-mono underline mx-1 hover:bg-white/10 px-1 rounded transition-colors"
            title={isHost ? "Jump to time" : "Only the host can seek the video"}
          >
            {part}
          </button>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreen(false);
      } else if (e.key.toLowerCase() === 'f' && (e.target as Node)?.nodeName !== 'INPUT' && (e.target as Node)?.nodeName !== 'TEXTAREA') {
        toggleFullscreen();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (isFullscreen) {
      setIsCameraSidebarOpen(false);
      setIsChatOpen(false);
    }
  }, [isFullscreen]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        setIsFullscreen(true);
        if (videoContainerRef.current) {
          if (videoContainerRef.current.requestFullscreen) {
            await videoContainerRef.current.requestFullscreen();
          } else if ((videoContainerRef.current as any).webkitRequestFullscreen) {
            await ((videoContainerRef.current as any).webkitRequestFullscreen)();
          }
        }
      } else {
        setIsFullscreen(false);
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await ((document as any).webkitExitFullscreen)();
        }
      }
    } catch (err) {
      console.error("Fullscreen error:", err);
    }
  };

  const handleMouseLeaveBottom = () => setHoverZones(p => ({ ...p, bottom: false }));
  const handleMouseEnterBottom = () => setHoverZones(p => ({ ...p, bottom: true }));

  useEffect(() => {
    if (id) {
      api.get(`/rooms/${id}`).then((res) => {
        if (res.data.room) {
          setRoomCreatedAt(res.data.room.createdAt);
          if (user) {
            if (res.data.room.hostId === user.id) {
              setIsHost(true);
            } else if (res.data.room.coHosts?.some((ch: any) => ch.userId === user.id)) {
              setIsHost(true); // Co-hosts get host privileges
            }
          }
        }
      }).catch(err => console.error("Failed to fetch room", err));
    }
  }, [id, user]);

  useEffect(() => {
    if (!socket || !user) return;

    const handleNewCohost = ({ userId }: { userId: string }) => {
      if (userId === user.id) {
        setIsHost(true);
      }
    };

    socket.on("new_cohost", handleNewCohost);
    return () => {
      socket.off("new_cohost", handleNewCohost);
    };
  }, [socket, user]);

  useEffect(() => {
    if (!roomCreatedAt) return;
    
    const interval = setInterval(() => {
      const diff = Math.floor((Date.now() - new Date(roomCreatedAt).getTime()) / 1000);
      const h = Math.floor(diff / 3600).toString().padStart(2, '0');
      const m = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
      const s = (diff % 60).toString().padStart(2, '0');
      setDuration(`${h}:${m}:${s}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [roomCreatedAt]);

  useEffect(() => {
    if (!user) {
      navigate("/login", { state: { from: location.pathname } });
      return;
    }

    if (id) {
      connect();
      joinRoom(id, user.id, user.name);
      getLocalStream();
    }

    return () => {
      if (id && user) {
        leaveRoom(id, user.id, user.name);
      }
      clearMessages();
      disconnect();
    };
  }, [id, user]);

  useVoiceActivityDetection(id, localStreamState);

  const addActiveSpeaker = useAudioStore(state => state.addActiveSpeaker);
  const removeActiveSpeaker = useAudioStore(state => state.removeActiveSpeaker);
  const setHostAnnouncement = useAudioStore(state => state.setHostAnnouncement);

  useEffect(() => {
    if (!socket) return;

    socket.on("user_speaking", ({ socketId }) => {
      addActiveSpeaker(socketId);
    });

    socket.on("user_stopped_speaking", ({ socketId }) => {
      removeActiveSpeaker(socketId);
    });

    socket.on("host_announcement_start", () => {
      setHostAnnouncement(true);
    });

    socket.on("host_announcement_stop", () => {
      setHostAnnouncement(false);
    });

    socket.on("screen_share_start", ({ streamId }) => {
      setMainScreenSource(streamId);
    });

    socket.on("screen_share_stop", () => {
      setMainScreenSource('url');
    });

    socket.on("new_cohost", ({ userId }) => {
      if (user && user.id === userId) {
        setIsHost(true);
      }
    });

    return () => {
      socket.off("user_speaking");
      socket.off("user_stopped_speaking");
      socket.off("host_announcement_start");
      socket.off("host_announcement_stop");
      socket.off("screen_share_start");
      socket.off("screen_share_stop");
      socket.off("new_cohost");
    };
  }, [socket, addActiveSpeaker, removeActiveSpeaker, setHostAnnouncement, user]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !id || !user) return;
    
    sendMessage(id, user.id, user.name, chatInput);
    setChatInput("");
  };

  const toggleHostAnnouncement = () => {
    if (!socket || !id) return;
    const { hostAnnouncementActive } = useAudioStore.getState();
    const newState = !hostAnnouncementActive;
    
    if (newState) {
      socket.emit("host_announcement_start", { roomId: id });
    } else {
      socket.emit("host_announcement_stop", { roomId: id });
    }
    setHostAnnouncement(newState);
  };

  const { hostAnnouncementActive } = useAudioStore();

  return (
    <div className="flex h-screen bg-black overflow-hidden" ref={mainContainerRef}>
      {/* Main Video Area */}
      <div className="flex-1 flex flex-col h-full relative z-0 bg-black">
        <div 
          ref={videoContainerRef} 
          className={isFullscreen ? "fixed inset-0 z-[9999] bg-black flex items-center justify-center" : "flex-1 flex items-center justify-center relative w-full h-full bg-black"}
        >
          {/* Edge Triggers (Always Active) */}
          <div className="absolute top-0 left-0 right-0 h-4 z-[9999]" onMouseEnter={() => setHoverZones(p => ({ ...p, top: true }))} />
          <div className="absolute top-0 bottom-0 right-0 w-4 z-[9999]" onMouseEnter={() => setHoverZones(p => ({ ...p, right: true }))} />
          <div className="absolute bottom-0 left-0 right-0 h-4 z-[9999]" onMouseEnter={handleMouseEnterBottom} />
          {hostAnnouncementActive && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white px-6 py-2 rounded-full font-bold shadow-[0_0_20px_rgba(220,38,38,0.6)] animate-pulse flex items-center gap-2">
              <Mic2 size={18} />
              Host is Speaking
            </div>
          )}

          {/* Top Edge Overlay Area */}
          <div 
            className={`absolute top-0 left-0 right-0 h-32 z-[9000] transition-opacity duration-300 ${hoverZones.top ? 'opacity-100 pointer-events-auto' : 'opacity-0 md:pointer-events-none max-md:opacity-100 max-md:pointer-events-auto max-md:h-16'}`}
            onMouseLeave={() => setHoverZones(p => ({ ...p, top: false }))}
          >
            {/* Main Screen Selection Dropdown */}
            <div className="absolute top-4 left-4 z-50">
              <select 
                value={mainScreenSource}
                onChange={(e) => setMainScreenSource(e.target.value)}
                className="bg-slate-900/80 text-white text-sm backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-700 shadow-lg focus:outline-none focus:border-indigo-500"
              >
                <option value="url">Video Player (YouTube)</option>
                {screenStreamState && <option value={screenStreamState.id}>Your Screen</option>}
                {Object.entries(screenShares).map(([socketId, streamId]) => (
                  <option key={streamId} value={streamId}>Participant {socketId.slice(0,4)}'s Screen</option>
                ))}
              </select>
            </div>

            {/* Room Duration */}
            <div className="absolute top-4 right-4 z-50">
              <div className="bg-slate-900/80 text-white text-sm backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-700 shadow-lg font-mono">
                {duration}
              </div>
            </div>
          </div>

          {/* Main Screen Renderer */}
          {mainScreenSource === 'url' ? (
            id ? <VideoPlayer ref={videoPlayerRef} roomId={id} isFullscreen={isFullscreen} isHost={isHost} broadcastMediaStream={broadcastMediaStream} /> : null
          ) : (
            (() => {
              const streamToRender = [
                ...(screenStreamState ? [screenStreamState] : []),
                ...peers.map(p => p.stream)
              ].find(s => s.id === mainScreenSource);

              if (!streamToRender) {
                // Fallback to URL if stream was closed
                setMainScreenSource('url');
                return id ? <VideoPlayer ref={videoPlayerRef} roomId={id} isFullscreen={isFullscreen} isHost={isHost} broadcastMediaStream={broadcastMediaStream} /> : null;
              }

              return (
                <div className={`w-full h-full flex items-center justify-center bg-black ${isFullscreen ? '' : 'p-4'}`}>
                  <video 
                    ref={el => { 
                      if (el && streamToRender && el.srcObject !== streamToRender) {
                        el.srcObject = streamToRender; 
                      }
                    }}
                    autoPlay 
                    playsInline 
                    className={`max-w-full max-h-full object-contain ${isFullscreen ? '' : 'rounded-xl shadow-2xl border border-slate-800'}`}
                  />
                </div>
              );
            })()
          )}

          {/* Right Edge Overlay Area */}
          <div 
            className={`absolute top-0 right-0 bottom-0 w-32 z-[9000] flex flex-col items-end justify-center pr-4 transition-opacity duration-300 ${hoverZones.right ? 'opacity-100 pointer-events-auto' : 'opacity-0 md:pointer-events-none max-md:opacity-100 max-md:pointer-events-auto max-md:w-16'}`}
            onMouseLeave={() => setHoverZones(p => ({ ...p, right: false }))}
          >
            <div className="flex flex-col gap-2">
              {!isCameraSidebarOpen && (
                <button 
                  onClick={() => setIsCameraSidebarOpen(true)}
                  className="bg-slate-800/90 hover:bg-indigo-600 text-white p-2.5 rounded-xl backdrop-blur shadow-lg transition-all border border-slate-700 flex items-center justify-center group"
                  title="Open Cameras Sidebar"
                >
                  <Users size={20} className="group-hover:-translate-x-1 transition-transform" />
                </button>
              )}
              {!isChatOpen && (
                <button 
                  onClick={() => setIsChatOpen(true)}
                  className="bg-slate-800/90 hover:bg-indigo-600 text-white p-2.5 rounded-xl backdrop-blur shadow-lg transition-all border border-slate-700 flex items-center justify-center group"
                  title="Open Live Chat"
                >
                  <MessageSquare size={20} className="group-hover:-translate-x-1 transition-transform" />
                </button>
              )}
              
              <button 
                onClick={() => navigate('/dashboard')}
                className="bg-red-600/90 hover:bg-red-500 text-white p-2.5 rounded-xl backdrop-blur shadow-[0_0_15px_rgba(220,38,38,0.4)] transition-all border border-red-500 flex items-center justify-center group mt-4"
                title="Exit Room"
              >
                <div className="font-bold text-sm">EXIT</div>
              </button>
            </div>
          </div>
          
          {/* Floating Cameras (rendered here so they overlay the video) */}
          {id && !isCameraSidebarOpen && (
            <VideoGrid 
              localStream={localStreamState || localStream.current} 
              screenStream={screenStreamState} 
              peers={peers}
              peerStatuses={peerStatuses}
              screenShares={screenShares}
              toggleAudio={toggleAudio} 
              toggleVideo={toggleVideo} 
              shareScreen={shareScreen} 
              toggleFullscreen={toggleFullscreen}
              isFullscreen={isFullscreen}
              floating={true}
              isBottomHovered={hoverZones.bottom}
              onMouseLeaveBottom={handleMouseLeaveBottom}
              isHost={isHost}
              roomId={id}
            />
          )}
        </div>
      </div>
      
      {/* Camera Sidebar */}
      {isCameraSidebarOpen && (
        <div className="fixed md:relative right-0 w-full md:w-64 h-full bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl z-[9999] md:z-10 animate-in slide-in-from-right-8 duration-300">
          <div className="p-3 border-b border-slate-800 flex justify-between items-center bg-slate-950">
            <span className="font-semibold text-slate-200 text-sm flex items-center gap-2"><Users size={16}/> Cameras</span>
            <button onClick={() => setIsCameraSidebarOpen(false)} className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition-colors">
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden relative">
            {id && (
              <VideoGrid 
                localStream={localStreamState || localStream.current} 
                screenStream={screenStreamState} 
                peers={peers}
                peerStatuses={peerStatuses}
                screenShares={screenShares}
                toggleAudio={toggleAudio} 
                toggleVideo={toggleVideo} 
                shareScreen={shareScreen}
                toggleFullscreen={toggleFullscreen}
                isFullscreen={isFullscreen}
                floating={false}
                isHost={isHost}
                roomId={id}
              />
            )}
          </div>
        </div>
      )}

      {/* Live Chat Sidebar */}
      {isChatOpen && (
        <div className="fixed md:relative right-0 w-full md:w-80 h-full bg-slate-950 border-l border-slate-900 flex flex-col shadow-2xl z-[9999] md:z-20 animate-in slide-in-from-right-8 duration-300">
          <div className="p-4 border-b border-slate-900 font-semibold flex flex-col gap-2 bg-slate-900/50">
            <div className="flex justify-between items-center">
              <span className="flex items-center gap-2"><MessageSquare size={16}/> Live Chat</span>
              <div className="flex gap-2 items-center">
                <button 
                  onClick={() => setIsInviteModalOpen(true)}
                  className="text-xs flex items-center gap-1 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-full shadow-lg transition-colors"
                >
                  <Share2 size={12} />
                  Invite Friends
                </button>
                <button onClick={() => setIsSettingsOpen(true)} className="text-slate-400 hover:text-white transition-colors">
                  <Settings size={16} />
                </button>
                <button onClick={() => setIsChatOpen(false)} className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition-colors ml-1">
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
            {isHost && (
              <button 
                onClick={toggleHostAnnouncement}
                className={`text-sm py-1.5 px-3 rounded-lg font-medium border transition-colors flex justify-center items-center gap-2 ${hostAnnouncementActive ? 'bg-red-500/20 text-red-500 border-red-500/50' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'}`}
              >
                <Mic2 size={14} />
                {hostAnnouncementActive ? 'Stop Announcement' : 'Host Announcement'}
              </button>
            )}
          </div>
          
          <div ref={chatRef} className="flex-1 p-4 overflow-y-auto space-y-4">
            {messages.map((msg, idx) => {
              const isMe = msg.userId === user?.id;
              return (
                <div key={idx} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                  <span className="text-xs text-slate-500 mb-1">{isMe ? 'You' : msg.userName}</span>
                  <div className={`px-3 py-2 rounded-2xl max-w-[85%] text-sm ${isMe ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-200 rounded-bl-none'}`}>
                    {parseMessageContent(msg.content)}
                  </div>
                </div>
              );
            })}
          </div>
          
          <div className="p-4 border-t border-slate-900 bg-slate-900/50">
            <form onSubmit={handleSendChat} className="flex gap-2">
              <input 
                type="text" 
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Type a message..." 
                className="flex-1 bg-slate-950 border border-slate-800 rounded-full px-4 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all" 
              />
              <button 
                type="button" 
                onClick={insertTimestamp}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-2 rounded-full transition-colors flex items-center justify-center border border-slate-700"
                title="Insert Video Timestamp"
              >
                <Clock size={16} />
              </button>
            </form>
          </div>
        </div>
      )}
      <AudioSettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      {id && <InviteModal isOpen={isInviteModalOpen} onClose={() => setIsInviteModalOpen(false)} roomId={id} />}
    </div>
  );
}
