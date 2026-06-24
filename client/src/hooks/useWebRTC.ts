import { useEffect, useRef, useState } from "react";
import { useSocketStore } from "../store/useSocketStore";
import { useAuthStore } from "../store/useAuthStore";

interface PeerConnection {
  [socketId: string]: RTCPeerConnection;
}

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

  const getLocalStream = async (video = true, audio = true) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio });
      localStream.current = stream;
      setLocalStreamState(stream);
      return stream;
    } catch (err) {
      console.error("Failed to get local stream", err);
      return null;
    }
  };

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
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket?.emit("webrtc_offer", { offer, to: peerSocketId, from: socket.id });
      } catch (err) {
        console.error("Negotiation error", err);
      }
    };

    pc.ontrack = (event) => {
      setPeers((prev) => {
        const streamId = event.streams[0].id;
        const exists = prev.find((p) => p.stream.id === streamId);
        if (exists) return prev;
        return [...prev, { socketId: peerSocketId, stream: event.streams[0] }];
      });
    };

    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, screenStreamRef.current!);
      });
    }

    peerConnections.current[peerSocketId] = pc;
    return pc;
  };

  useEffect(() => {
    if (!socket || !user) return;

    socket.on("user_joined", async ({ socketId }) => {
      if (!localStream.current) return;
      createPeerConnection(socketId, localStream.current);
      // broadcast our current status to the new user
      const cam = localStream.current.getVideoTracks()[0]?.enabled ?? false;
      const mic = localStream.current.getAudioTracks()[0]?.enabled ?? false;
      socket.emit("participant_status", { roomId, cam, mic });
    });

    socket.on("participant_status", ({ socketId, cam, mic }) => {
      setPeerStatuses(prev => ({ ...prev, [socketId]: { cam, mic } }));
    });

    socket.on("webrtc_offer", async ({ offer, from }) => {
      if (!localStream.current) return;
      let pc = peerConnections.current[from];
      if (!pc) {
        pc = createPeerConnection(from, localStream.current);
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("webrtc_answer", { answer, to: from, from: socket.id });
      } catch (err) {
        console.error("Failed to handle offer", err);
      }
    });

    socket.on("webrtc_answer", async ({ answer, from }) => {
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
      const pc = peerConnections.current[from];
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on("user_left", ({ socketId }) => {
      if (peerConnections.current[socketId]) {
        peerConnections.current[socketId].close();
        delete peerConnections.current[socketId];
        setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
      }
    });

    socket.on("screen_share_start", ({ socketId, streamId }) => {
      setScreenShares(prev => ({ ...prev, [socketId]: streamId }));
    });

    socket.on("screen_share_stop", ({ socketId }) => {
      setScreenShares(prev => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    });

    return () => {
      socket.off("user_joined");
      socket.off("webrtc_offer");
      socket.off("webrtc_answer");
      socket.off("webrtc_ice_candidate");
      socket.off("user_left");
      socket.off("participant_status");
      socket.off("screen_share_start");
      socket.off("screen_share_stop");
    };
  }, [socket, user, roomId]);

  const toggleVideo = async () => {
    if (!localStream.current) return;

    const videoTrack = localStream.current.getVideoTracks()[0];
    const mic = localStream.current.getAudioTracks()[0]?.enabled ?? false;

    // If we have an active video track, turn it OFF completely
    if (videoTrack && videoTrack.readyState === 'live') {
      videoTrack.stop();
      localStream.current.removeTrack(videoTrack);
      
      socket?.emit("participant_status", { roomId, cam: false, mic });
      // Force a state update with the new tracks
      setLocalStreamState(new MediaStream(localStream.current.getTracks()));
    } else {
      // It's off, we need to request hardware access again to turn it ON
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const newVideoTrack = newStream.getVideoTracks()[0];
        
        localStream.current.addTrack(newVideoTrack);

        // Replace the dead track in all existing peer connections
        Object.values(peerConnections.current).forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track === null || (s.track && s.track.kind === 'video'));
          if (sender) {
            sender.replaceTrack(newVideoTrack);
          } else {
            pc.addTrack(newVideoTrack, localStream.current!);
          }
        });

        socket?.emit("participant_status", { roomId, cam: true, mic });
        // Force a state update with the new tracks
        setLocalStreamState(new MediaStream(localStream.current.getTracks()));
      } catch (err) {
        console.error("Failed to re-enable camera:", err);
      }
    }
  };

  const toggleAudio = () => {
    if (localStream.current) {
      const audioTrack = localStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        const cam = localStream.current.getVideoTracks()[0]?.enabled ?? false;
        socket?.emit("participant_status", { roomId, cam, mic: audioTrack.enabled });
      }
    }
  };

  const shareScreen = async () => {
    if (screenStreamRef.current) {
      // Stop sharing
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      // The onended handler will clean up
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenVideoTrack = screenStream.getVideoTracks()[0];

      screenStreamRef.current = screenStream;
      setScreenStreamState(screenStream);

      Object.values(peerConnections.current).forEach((pc) => {
        pc.addTrack(screenVideoTrack, screenStream);
      });

      socket?.emit("screen_share_start", { roomId, streamId: screenStream.id });

      // When screen share stops, remove the track
      screenVideoTrack.onended = () => {
        Object.values(peerConnections.current).forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track === screenVideoTrack);
          if (sender) {
            pc.removeTrack(sender);
          }
        });
        screenStreamRef.current = null;
        setScreenStreamState(null);
        socket?.emit("screen_share_stop", { roomId });
      };
    } catch (err) {
      console.error("Error sharing screen:", err);
    }
  };

  return { getLocalStream, localStream, localStreamState, screenStreamState, peers, peerStatuses, screenShares, toggleVideo, toggleAudio, shareScreen };
}
