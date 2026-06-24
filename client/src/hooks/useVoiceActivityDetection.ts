import { useEffect, useRef } from 'react';
import { useSocketStore } from '../store/useSocketStore';

export function useVoiceActivityDetection(roomId: string | undefined, localStream: MediaStream | null) {
  const { socket } = useSocketStore();
  const isSpeakingRef = useRef(false);

  useEffect(() => {
    if (!roomId || !localStream || !socket) return;

    // Check if the stream actually has an audio track
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    let audioContext: AudioContext;
    try {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch (e) {
      console.error("AudioContext not supported", e);
      return;
    }

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;
    
    const source = audioContext.createMediaStreamSource(localStream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let animationFrameId: number;

    const threshold = 15; // Noise gate threshold (out of 255)
    let silenceStart = performance.now();
    const SILENCE_TIMEOUT = 500; // ms to wait before marking as stopped

    const checkVolume = () => {
      analyser.getByteFrequencyData(dataArray);
      
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;

      const now = performance.now();

      if (average > threshold && audioTrack.enabled) {
        if (!isSpeakingRef.current) {
          isSpeakingRef.current = true;
          socket.emit('started_speaking', { roomId });
        }
        silenceStart = now;
      } else {
        if (isSpeakingRef.current && (now - silenceStart > SILENCE_TIMEOUT)) {
          isSpeakingRef.current = false;
          socket.emit('stopped_speaking', { roomId });
        }
      }

      animationFrameId = requestAnimationFrame(checkVolume);
    };

    checkVolume();

    return () => {
      cancelAnimationFrame(animationFrameId);
      if (isSpeakingRef.current) {
        socket.emit('stopped_speaking', { roomId });
      }
      audioContext.close();
    };
  }, [roomId, localStream, socket]);
}
