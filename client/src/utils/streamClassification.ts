/**
 * WebRTC Remote Stream Classification & State Management
 *
 * Ensures deterministic isolation between:
 * 1. Camera + Microphone MediaStream (routes to VideoGrid and RemoteAudioManager)
 * 2. Screen-share MediaStream (routes to Movie / presentation stage)
 *
 * Invariant: A screen-share MediaStream must NEVER replace a participant's camera/mic stream in `peers`.
 */

export interface PeerStreamItem<T = MediaStream> {
  socketId: string;
  stream: T;
}

export type StreamKind = "camera" | "screen_share";

export interface StreamStateContext {
  cameraStreamIds: Record<string, string>; // socketId -> streamId
  screenShareStreamIds: Record<string, string>; // socketId -> streamId
}

/**
 * Deterministically classify whether an incoming stream is camera/mic or screen-share.
 */
export function classifyRemoteStream(
  peerSocketId: string,
  streamId: string,
  context: StreamStateContext
): StreamKind {
  // 1. If signaling already recorded this streamId as screen-share for this peer
  if (context.screenShareStreamIds[peerSocketId] === streamId) {
    return "screen_share";
  }

  // 2. If this peer already has a known camera stream with a different ID, this new stream is screen-share
  const existingCameraStreamId = context.cameraStreamIds[peerSocketId];
  if (existingCameraStreamId && existingCameraStreamId !== streamId) {
    return "screen_share";
  }

  // 3. Otherwise, it is the peer's primary camera/microphone stream
  return "camera";
}

/**
 * Update peers and screenShares upon receiving an ontrack stream.
 */
export function handleOnTrackStream<T extends { id: string }>(
  peerSocketId: string,
  stream: T,
  currentPeers: PeerStreamItem<T>[],
  currentScreenShares: Record<string, T>,
  context: StreamStateContext
): {
  peers: PeerStreamItem<T>[];
  screenShares: Record<string, T>;
  streamKind: StreamKind;
} {
  const streamKind = classifyRemoteStream(peerSocketId, stream.id, context);

  if (streamKind === "screen_share") {
    context.screenShareStreamIds[peerSocketId] = stream.id;
    return {
      // Screen-share NEVER replaces camera/mic in peers. Also ensure it isn't accidentally in peers.
      peers: currentPeers.filter((p) => !(p.socketId === peerSocketId && p.stream.id === stream.id)),
      screenShares: {
        ...currentScreenShares,
        [peerSocketId]: stream,
      },
      streamKind,
    };
  } else {
    // Primary camera + mic stream
    context.cameraStreamIds[peerSocketId] = stream.id;
    const exists = currentPeers.some((p) => p.socketId === peerSocketId);
    const updatedPeers = exists
      ? currentPeers.map((p) => (p.socketId === peerSocketId ? { ...p, stream } : p))
      : [...currentPeers, { socketId: peerSocketId, stream }];

    return {
      peers: updatedPeers,
      screenShares: currentScreenShares,
      streamKind,
    };
  }
}

/**
 * Handle screen_share_start socket event.
 */
export function handleScreenShareStartSignal<T extends { id: string }>(
  socketId: string,
  streamId: string,
  currentPeers: PeerStreamItem<T>[],
  currentScreenShares: Record<string, T>,
  context: StreamStateContext,
  findStreamById?: (id: string) => T | undefined
): {
  peers: PeerStreamItem<T>[];
  screenShares: Record<string, T>;
} {
  context.screenShareStreamIds[socketId] = streamId;

  // Check if this stream was already attached to peers (e.g. ontrack arrived before signal)
  const misplacedPeer = currentPeers.find((p) => p.socketId === socketId && p.stream.id === streamId);
  const streamToPromote = misplacedPeer?.stream || (findStreamById ? findStreamById(streamId) : undefined);

  const cleanPeers = currentPeers.filter((p) => p.stream.id !== streamId);
  const updatedScreenShares = streamToPromote
    ? { ...currentScreenShares, [socketId]: streamToPromote }
    : currentScreenShares;

  return {
    peers: cleanPeers,
    screenShares: updatedScreenShares,
  };
}

/**
 * Handle screen_share_stop socket event.
 */
export function handleScreenShareStopSignal<T>(
  socketId: string,
  currentScreenShares: Record<string, T>,
  context: StreamStateContext
): Record<string, T> {
  delete context.screenShareStreamIds[socketId];
  const next = { ...currentScreenShares };
  delete next[socketId];
  return next;
}

/**
 * Handle participant leaving (user_left).
 */
export function handleUserLeftCleanup<T>(
  socketId: string,
  currentPeers: PeerStreamItem<T>[],
  currentScreenShares: Record<string, T>,
  context: StreamStateContext
): {
  peers: PeerStreamItem<T>[];
  screenShares: Record<string, T>;
} {
  delete context.cameraStreamIds[socketId];
  delete context.screenShareStreamIds[socketId];

  const nextScreenShares = { ...currentScreenShares };
  delete nextScreenShares[socketId];

  return {
    peers: currentPeers.filter((p) => p.socketId !== socketId),
    screenShares: nextScreenShares,
  };
}
