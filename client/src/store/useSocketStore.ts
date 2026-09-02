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

interface SocketState {
  socket: Socket | null;
  messages: Message[];
  participants: { userId: string; userName: string }[];
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
  
  connect: () => {
    if (!get().socket) {
      const url = import.meta.env.VITE_API_URL || 'http://localhost:5000';
      const token = useAuthStore.getState().token;
      
      const socket = io(url, {
        auth: { token },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });
      
      socket.on('receive_message', (message: Message) => {
        set((state) => ({ messages: [...state.messages, message] }));
      });
      
      socket.on('error', (err: unknown) => {
        console.error("Socket Error:", err);
      });

      socket.on('connect_error', (err: unknown) => {
        console.error("Socket Connect Error:", err);
      });

      set({ socket });
    }
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
      socket.disconnect();
      set({ socket: null });
    }
  },

  joinRoom: (roomId, userId, userName, password) => {
    const { socket } = get();
    if (socket) {
      socket.emit('join_room', { roomId, userId, userName, password });
    }
  },

  leaveRoom: (roomId, userId, userName) => {
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
