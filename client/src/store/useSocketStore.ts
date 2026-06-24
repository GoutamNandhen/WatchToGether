import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

interface Message {
  id: string;
  userId: string;
  userName: string;
  content: string;
  createdAt: string;
}

interface SocketState {
  socket: Socket | null;
  messages: Message[];
  participants: any[];
  connect: () => void;
  disconnect: () => void;
  joinRoom: (roomId: string, userId: string, userName: string) => void;
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
      const socket = io('http://localhost:5000');
      
      socket.on('receive_message', (message: Message) => {
        set((state) => ({ messages: [...state.messages, message] }));
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

  joinRoom: (roomId, userId, userName) => {
    const { socket } = get();
    if (socket) {
      socket.emit('join_room', { roomId, userId, userName });
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
