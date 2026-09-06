import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from './useAuthStore';

export interface Message {
  id: string;
  userId: string;
  userName: string;
  content: string;
  createdAt: string;
}

export interface RoomSession {
  roomId: string;
  userId: string;
  userName: string;
  password?: string;
}

interface SocketState {
  socket: Socket | null;
  messages: Message[];
  participants: { userId: string; userName: string }[];
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
  reconnectError: string | null;
  currentRoomSession: RoomSession | null;
  connect: () => void;
  disconnect: () => void;
  joinRoom: (roomId: string, userId: string, userName: string, password?: string) => void;
  leaveRoom: (roomId: string, userId: string, userName: string) => void;
  sendMessage: (roomId: string, userId: string, userName: string, content: string) => void;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  messages: [],
  participants: [],
  connectionStatus: 'disconnected',
  reconnectError: null,
  currentRoomSession: null,
  
  connect: () => {
    if (!get().socket) {
      const url = import.meta.env.VITE_API_URL || 'http://localhost:5000';
      
      const socket = io(url, {
        auth: (cb) => {
          cb({ token: useAuthStore.getState().token });
        },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });

      socket.on('connect', () => {
        set({ connectionStatus: 'connected', reconnectError: null });
        const { currentRoomSession } = get();
        // If we were inside an active room session, automatically rejoin
        if (currentRoomSession) {
          socket.emit('join_room', currentRoomSession);
        }
      });

      socket.on('disconnect', (reason) => {
        console.warn("Socket disconnected:", reason);
        set({ connectionStatus: 'reconnecting' });
      });

      socket.on('connect_error', (err) => {
        console.error("Socket Connect Error:", err);
        set({ connectionStatus: 'reconnecting', reconnectError: err.message || "Failed to connect to server" });
      });
      
      socket.on('receive_message', (message: Message) => {
        set((state) => ({ messages: [...state.messages, message] }));
      });
      
      socket.on('error', (err: unknown) => {
        console.error("Socket Error:", err);
        const errorMsg = typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: string }).message)
          : String(err);
        if (errorMsg.includes("Password") || errorMsg.includes("Unauthorized") || errorMsg.includes("Room not found")) {
          set({ reconnectError: errorMsg });
        }
      });

      set({ socket, connectionStatus: socket.connected ? 'connected' : 'reconnecting' });
    }
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
      socket.disconnect();
      set({ socket: null, currentRoomSession: null, connectionStatus: 'disconnected', reconnectError: null });
    }
  },

  joinRoom: (roomId, userId, userName, password) => {
    const session: RoomSession = { roomId, userId, userName, password };
    set({ currentRoomSession: session, reconnectError: null });
    const { socket } = get();
    if (socket && socket.connected) {
      socket.emit('join_room', session);
    }
  },

  leaveRoom: (roomId, userId, userName) => {
    set({ currentRoomSession: null, reconnectError: null });
    const { socket } = get();
    if (socket) {
      socket.emit('leave_room', { roomId, userId, userName });
    }
  },

  sendMessage: (roomId, userId, userName, content) => {
    const { socket } = get();
    if (socket) {
      socket.emit('send_message', { roomId, userId, userName, content });
    }
  },

  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  
  clearMessages: () => set({ messages: [] }),
}));

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__useSocketStore = useSocketStore;
}
