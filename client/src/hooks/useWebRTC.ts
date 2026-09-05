import { useEffect, useRef, useState } from "react";
import { useSocketStore } from "../store/useSocketStore";
import { useAuthStore } from "../store/useAuthStore";

interface PeerConnection {
  [socketId: string]: RTCPeerConnection;
}

const findVideoSender = (pc: RTCPeerConnection): RTCRtpSender | undefined => {
  if (typeof pc.getTransceivers === "function") {
    const videoTransceiver = pc.getTransceivers().find(
      (t) => t.receiver?.track?.kind === "video" || (t.sender?.track && t.sender.track.kind === "video")
    );
    if (videoTransceiver) return videoTransceiver.sender;
  }
  if (typeof pc.getSenders === "function") {
    const senders = pc.getSenders();
    const senderWithVideoTrack = senders.find((s) => s.track && s.track.kind === "video");
    if (senderWithVideoTrack) return senderWithVideoTrack;
    const senderWithNullTrack = senders.find((s) => s.track === null);
    if (senderWithNullTrack) return senderWithNullTrack;
  }
  return undefined;
};

export function useWebRTC(roomId: string) {
  const { socket } = useSocketStore();
  const { user } = useAuthStore();
  
  const [peers, setPeers] = useState<{ socketId: string, stream: MediaStream }[]>([]);
  const [peerStatuses, setPeerStatuses] = useState<Record<string, { cam: boolean, mic: boolean }>>({});
  const [screenShares, setScreenShares] = useState<Record<string, string>>({}); // socketId -> streamId
  const [localStreamState, setLocalStreamState] = useState<MediaStream | null>(null);
  const [screenStreamState, setScreenStreamState] = useState<MediaStream | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef<PeerConnection>({});
  const mediaPromise = useRef<Promise<MediaStream | null> | null>(null);
  const pendingCandidates = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const toggleVideoPromiseRef = useRef<Promise<void>>(Promise.resolve());

  const getLocalStream = async () => {
    let resolveMedia: (stream: MediaStream | null) => void;
    if (!mediaPromise.current) {
      mediaPromise.current = new Promise((res) => { resolveMedia = res; });
    }

    try {
      const savedVideo = localStorage.getItem('wt_pref_camera') !== 'false';
      const savedAudio = localStorage.getItem('wt_pref_mic') !== 'false';

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: savedVideo, audio: true });
      } catch (err) {
        console.warn("Failed with requested constraints, falling back to audio only", err);
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStorage.setItem('wt_pref_camera', 'false');
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && !savedAudio) {
        audioTrack.enabled = false;
      }

      localStream.current = stream;
      setLocalStreamState(stream);
      if (resolveMedia!) resolveMedia(stream);

      // Broadcast initial status once media is acquired
      const cam = stream.getVideoTracks().some((t) => t.enabled && t.readyState === "live");
      const mic = stream.getAudioTracks().some((t) => t.enabled && t.readyState === "live");
      socket?.emit("participant_status", { roomId, cam, mic });

      return stream;
    } catch (err) {
      console.error("Failed to get any local stream", err);
      if (resolveMedia!) resolveMedia(null);
      socket?.emit("participant_status", { roomId, cam: false, mic: false });
      return null;
    }
  };



  useEffect(() => {
    let isMounted = true;
    if (!socket || !user) return;

    const createPeerConnection = (peerSocketId: string, stream: MediaStream) => {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });

      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit("webrtc_ice_candidate", {
            candidate: event.candidate,
            to: peerSocketId,
            from: socket.id,
          });
        }
      };

      pc.onnegotiationneeded = async () => {
        try {
          if (pc.signalingState !== "stable") return;
          const offer = await pc.createOffer();
          if (pc.signalingState !== "stable") return;
          await pc.setLocalDescription(offer);
          socket?.emit("webrtc_offer", { offer, to: peerSocketId, from: socket.id });
        } catch (err) {
          console.error("Negotiation error", err);
        }
      };

      pc.ontrack = (event) => {
        if (event.track) {
          event.track.onmute = () => {
            if (event.track.kind === "video") {
              setPeerStatuses((prev) => ({
                ...prev,
                [peerSocketId]: { ...(prev[peerSocketId] || { mic: true }), cam: false },
              }));
            }
          };
          event.track.onunmute = () => {
            if (event.track.kind === "video") {
              setPeerStatuses((prev) => ({
                ...prev,
                [peerSocketId]: { ...(prev[peerSocketId] || { mic: true }), cam: true },
              }));
            }
          };
        }

        setPeers((prev) => {
          const stream = event.streams[0];
          if (!stream) return prev;
          const streamId = stream.id;
          const exists = prev.some((p) => p.socketId === peerSocketId || p.stream.id === streamId);
          if (exists) {
            return prev.map((p) => (p.socketId === peerSocketId ? { ...p, stream } : p));
          }
          return [...prev, { socketId: peerSocketId, stream }];
        });
      };

      const hasVideoTrack = stream.getVideoTracks().some((t) => t.readyState === "live");
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Pre-add video transceiver if no video track exists initially, so future camera ON
      // uses replaceTrack without renegotiation
      if (!hasVideoTrack && typeof pc.addTransceiver === "function") {
        try {
          pc.addTransceiver("video", { direction: "sendrecv", streams: [stream] });
        } catch (e) {
          console.warn("Could not pre-add video transceiver", e);
        }
      }

      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, screenStreamRef.current!);
        });
      }

      peerConnections.current[peerSocketId] = pc;
      return pc;
    };

    const waitForMedia = async () => {
      if (localStream.current) return true;
      if (mediaPromise.current) {
        await mediaPromise.current;
        return !!localStream.current;
      }
      return false;
    };

    socket.on("user_joined", async ({ socketId }) => {
      if (!isMounted) return;
      const ready = await waitForMedia();
      if (!isMounted || !ready) return;
      
      // Clean up any pre-existing connection for this socketId if present
      if (peerConnections.current[socketId]) {
        const oldPc = peerConnections.current[socketId];
        oldPc.onicecandidate = null;
        oldPc.onnegotiationneeded = null;
        oldPc.ontrack = null;
        oldPc.close();
        delete peerConnections.current[socketId];
      }

      createPeerConnection(socketId, localStream.current!);
      // broadcast our current status to the new user
      const cam = (localStream.current?.getVideoTracks() || []).some((t) => t.enabled && t.readyState === "live");
      const mic = (localStream.current?.getAudioTracks() || []).some((t) => t.enabled && t.readyState === "live");
      socket.emit("participant_status", { roomId, cam, mic });
    });

    socket.on("participant_status", ({ socketId, cam, mic }) => {
      if (!isMounted) return;
      setPeerStatuses((prev) => ({ ...prev, [socketId]: { cam, mic } }));
    });

    socket.on("room_participant_statuses", (statuses: Record<string, { cam: boolean; mic: boolean }>) => {
      if (!isMounted) return;
      setPeerStatuses((prev) => ({ ...prev, ...statuses }));
    });

    socket.on("webrtc_offer", async ({ offer, from }) => {
      if (!isMounted) return;
      const ready = await waitForMedia();
      if (!isMounted || !ready) return;
      
      let pc = peerConnections.current[from];
      if (!pc) {
        pc = createPeerConnection(from, localStream.current!);
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        if (!isMounted) return;
        
        // Drain any buffered ICE candidates that arrived before the offer
        const candidates = pendingCandidates.current[from] || [];
        pendingCandidates.current[from] = [];
        for (const c of candidates) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (!isMounted) return;
        socket.emit("webrtc_answer", { answer, to: from, from: socket.id });

        // Broadcast our participant status so the offerer has our latest status
        const cam = (localStream.current?.getVideoTracks() || []).some((t) => t.enabled && t.readyState === "live");
        const mic = (localStream.current?.getAudioTracks() || []).some((t) => t.enabled && t.readyState === "live");
        socket.emit("participant_status", { roomId, cam, mic });
      } catch (err) {
        console.error("Failed to handle offer", err);
      }
    });

    socket.on("webrtc_answer", async ({ answer, from }) => {
      if (!isMounted) return;
      const ready = await waitForMedia();
      if (!isMounted || !ready) return;
      
      const pc = peerConnections.current[from];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error("Failed to set answer", err);
        }
      }
    });

    socket.on("webrtc_ice_candidate", async ({ candidate, from }) => {
      if (!isMounted) return;
      const ready = await waitForMedia();
      if (!isMounted || !ready) return;
      
      const pc = peerConnections.current[from];
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("Failed to add ICE candidate", err);
        }
      } else {
        // Buffer ICE candidate if peer connection or remote description isn't ready
        if (!pendingCandidates.current[from]) pendingCandidates.current[from] = [];
        pendingCandidates.current[from].push(candidate);
      }
    });

    socket.on("user_left", ({ socketId }) => {
      if (!isMounted) return;
      if (peerConnections.current[socketId]) {
        const pc = peerConnections.current[socketId];
        pc.onicecandidate = null;
        pc.onnegotiationneeded = null;
        pc.ontrack = null;
        pc.close();
        delete peerConnections.current[socketId];
      }
      delete pendingCandidates.current[socketId];
      setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
      setPeerStatuses((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      setScreenShares((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    });

    socket.on("screen_share_start", ({ socketId, streamId }) => {
      if (!isMounted) return;
      setScreenShares(prev => ({ ...prev, [socketId]: streamId }));
    });

    socket.on("screen_share_stop", ({ socketId }) => {
      if (!isMounted) return;
      setScreenShares(prev => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    });

    const handleSocketDisconnect = () => {
      if (!isMounted) return;
      console.log("Socket disconnected, cleaning up WebRTC connections for reconnect");
      Object.values(peerConnections.current).forEach(pc => {
        pc.onicecandidate = null;
        pc.onnegotiationneeded = null;
        pc.ontrack = null;
        pc.close();
      });
      peerConnections.current = {};
      pendingCandidates.current = {};
      setPeers([]);
      setPeerStatuses({});
      setScreenShares({});
    };

    socket.on("disconnect", handleSocketDisconnect);

    return () => {
      isMounted = false;
      
      // 1. Remove socket listeners
      socket.off("user_joined");
      socket.off("webrtc_offer");
      socket.off("webrtc_answer");
      socket.off("webrtc_ice_candidate");
      socket.off("user_left");
      socket.off("participant_status");
      socket.off("room_participant_statuses");
      socket.off("screen_share_start");
      socket.off("screen_share_stop");
      socket.off("disconnect", handleSocketDisconnect);

      // 2. Close all RTCPeerConnections
      Object.values(peerConnections.current).forEach(pc => {
        pc.onicecandidate = null;
        pc.onnegotiationneeded = null;
        pc.ontrack = null;
        pc.close();
      });
      peerConnections.current = {};

      // 3. Stop local media tracks
      if (localStream.current) {
        localStream.current.getTracks().forEach(t => {
          t.stop();
          t.enabled = false;
        });
        localStream.current = null;
      }

      // 4. Stop screen share tracks
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => {
          t.stop();
          t.enabled = false;
        });
        screenStreamRef.current = null;
      }
    };
  }, [socket, user, roomId]);

  const toggleVideo = async () => {
    toggleVideoPromiseRef.current = toggleVideoPromiseRef.current.then(async () => {
      if (!localStream.current) return;

      const currentVideoTrack = localStream.current.getVideoTracks().find((t) => t.readyState === "live");
      const mic = localStream.current.getAudioTracks().some((t) => t.enabled && t.readyState === "live");

      if (currentVideoTrack) {
        // --- CAMERA OFF ---
        // 1. Disassociate RTP senders from video track on all peer connections
        await Promise.all(
          Object.values(peerConnections.current).map(async (pc) => {
            const sender = findVideoSender(pc);
            if (sender && typeof sender.replaceTrack === "function") {
              await sender.replaceTrack(null).catch((e) => console.warn("replaceTrack(null) error:", e));
            }
          })
        );

        // 2. Stop hardware track & remove from local stream
        currentVideoTrack.stop();
        localStream.current.removeTrack(currentVideoTrack);
        localStorage.setItem("wt_pref_camera", "false");

        // 3. Emit status & update state
        socket?.emit("participant_status", { roomId, cam: false, mic });
        setLocalStreamState(new MediaStream(localStream.current.getTracks()));
      } else {
        // --- CAMERA ON ---
        try {
          const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
          const newVideoTrack = newStream.getVideoTracks()[0];
          if (!newVideoTrack) return;

          localStorage.setItem("wt_pref_camera", "true");
          localStream.current.addTrack(newVideoTrack);

          // Attach new track to all peer connections
          await Promise.all(
            Object.values(peerConnections.current).map(async (pc) => {
              const sender = findVideoSender(pc);
              if (sender && typeof sender.replaceTrack === "function") {
                await sender.replaceTrack(newVideoTrack).catch((e) => console.warn("replaceTrack error:", e));
              } else {
                pc.addTrack(newVideoTrack, localStream.current!);
              }
            })
          );

          socket?.emit("participant_status", { roomId, cam: true, mic });
          setLocalStreamState(new MediaStream(localStream.current.getTracks()));
        } catch (err) {
          console.error("Failed to re-enable camera:", err);
          // On permission denial or hardware failure, record cam: false and do not crash
          localStorage.setItem("wt_pref_camera", "false");
          socket?.emit("participant_status", { roomId, cam: false, mic });
          setLocalStreamState(new MediaStream(localStream.current.getTracks()));
        }
      }
    }).catch((err) => {
      console.error("Error in toggleVideo queue:", err);
    });

    return toggleVideoPromiseRef.current;
  };

  const toggleAudio = async () => {
    if (!localStream.current) return;
    
    const audioTrack = localStream.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      localStorage.setItem('wt_pref_mic', String(audioTrack.enabled));
      const cam = localStream.current.getVideoTracks()[0]?.enabled ?? false;
      socket?.emit("participant_status", { roomId, cam, mic: audioTrack.enabled });
    } else {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const newAudioTrack = audioStream.getAudioTracks()[0];
        localStream.current.addTrack(newAudioTrack);
        localStorage.setItem('wt_pref_mic', 'true');
        
        Object.values(peerConnections.current).forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track === null || (s.track && s.track.kind === 'audio'));
          if (sender) {
            sender.replaceTrack(newAudioTrack);
          } else {
            pc.addTrack(newAudioTrack, localStream.current!);
          }
        });
        
        const cam = localStream.current.getVideoTracks()[0]?.enabled ?? false;
        socket?.emit("participant_status", { roomId, cam, mic: true });
        setLocalStreamState(new MediaStream(localStream.current.getTracks()));
      } catch (e) {
        console.error("Failed to add audio track", e);
      }
    }
  };

  const broadcastMediaStream = (stream: MediaStream) => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    screenStreamRef.current = stream;
    setScreenStreamState(stream);

    Object.values(peerConnections.current).forEach((pc) => {
      pc.addTrack(videoTrack, stream);
    });

    socket?.emit("screen_share_start", { roomId, streamId: stream.id });

    videoTrack.onended = () => {
      Object.values(peerConnections.current).forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track === videoTrack);
        if (sender) {
          pc.removeTrack(sender);
        }
      });
      screenStreamRef.current = null;
      setScreenStreamState(null);
      socket?.emit("screen_share_stop", { roomId });
    };
  };

  const shareScreen = async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      broadcastMediaStream(screenStream);
    } catch (err) {
      console.error("Error sharing screen:", err);
    }
  };

  return { getLocalStream, localStream, localStreamState, screenStreamState, peers, peerStatuses, screenShares, toggleAudio, toggleVideo, shareScreen, broadcastMediaStream };
}
