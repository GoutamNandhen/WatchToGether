import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../lib/api";
import { useAuthStore } from "../store/useAuthStore";
import { LogOut, Trash2, Users, MonitorPlay, UserPlus, Check } from "lucide-react";

interface Room {
  id: string;
  name: string;
  description: string;
  _count: { participants: number };
  host: { name: string };
  hostId: string;
}

interface Friend {
  id: string;
  status: 'PENDING' | 'ACCEPTED';
  isSender: boolean;
  user: {
    id: string;
    name: string;
    email: string;
  };
}

export default function Dashboard() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [roomName, setRoomName] = useState("");
  const [friendEmail, setFriendEmail] = useState("");
  const [activeTab, setActiveTab] = useState<'rooms' | 'friends'>('rooms');
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) {
      navigate("/login");
      return;
    }
    fetchRooms();
    fetchFriends();
  }, [user]);

  const fetchFriends = async () => {
    try {
      const res = await api.get("/friends");
      setFriends(res.data.friends);
    } catch (error) {
      console.error("Failed to fetch friends:", error);
    }
  };

  const fetchRooms = async () => {
    try {
      const res = await api.get("/rooms");
      setRooms(res.data.rooms);
    } catch (error) {
      console.error("Failed to fetch rooms:", error);
    }
  };

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomName.trim()) return;
    try {
      const res = await api.post("/rooms", { name: roomName, isPrivate: false });
      navigate(`/room/${res.data.room.id}`);
    } catch (error) {
      console.error("Failed to create room:", error);
    }
  };

  const handleDeleteRoom = async (roomId: string) => {
    if (!confirm("Are you sure you want to delete this room?")) return;
    try {
      await api.delete(`/rooms/${roomId}`);
      setRooms(rooms.filter(r => r.id !== roomId));
    } catch (error) {
      console.error("Failed to delete room:", error);
    }
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const handleSendFriendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendEmail.trim()) return;
    try {
      await api.post("/friends/request", { email: friendEmail });
      setFriendEmail("");
      fetchFriends();
      alert("Friend request sent!");
    } catch (error: any) {
      alert(error.response?.data?.error || "Failed to send request");
    }
  };

  const handleAcceptFriendRequest = async (friendId: string) => {
    try {
      await api.post(`/friends/accept/${friendId}`);
      fetchFriends();
    } catch (error) {
      console.error("Failed to accept friend request:", error);
    }
  };

  if (!user) return null;

  return (
    <div className="min-h-screen p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-slate-400">Welcome back, {user.name}</p>
        </div>
        <button onClick={handleLogout} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <LogOut size={18} /> Logout
        </button>
      </div>

      <div className="flex gap-4 mb-6 border-b border-slate-800">
        <button 
          onClick={() => setActiveTab('rooms')}
          className={`flex items-center gap-2 px-4 py-3 font-medium transition-all ${activeTab === 'rooms' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-400 hover:text-slate-200'}`}
        >
          <MonitorPlay size={18} /> Rooms
        </button>
        <button 
          onClick={() => setActiveTab('friends')}
          className={`flex items-center gap-2 px-4 py-3 font-medium transition-all ${activeTab === 'friends' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-400 hover:text-slate-200'}`}
        >
          <Users size={18} /> Friends
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Sidebar Creation Panel */}
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl h-fit">
          {activeTab === 'rooms' ? (
            <>
              <h2 className="text-xl font-semibold mb-2">Create Room</h2>
              <p className="text-slate-400 mb-4 text-sm">Start a new watch party and invite friends.</p>
              <form onSubmit={handleCreateRoom}>
                <input 
                  type="text" 
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="Room Name" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-4" 
                />
                <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-500 py-2 rounded-lg font-medium transition-colors">
                  Create New Room
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold mb-2">Add Friend</h2>
              <p className="text-slate-400 mb-4 text-sm">Send a request by email address.</p>
              <form onSubmit={handleSendFriendRequest}>
                <input 
                  type="email" 
                  value={friendEmail}
                  onChange={(e) => setFriendEmail(e.target.value)}
                  placeholder="friend@example.com" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-4" 
                />
                <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-500 py-2 rounded-lg font-medium transition-colors flex justify-center items-center gap-2">
                  <UserPlus size={18} /> Send Request
                </button>
              </form>
            </>
          )}
        </div>
        
        {/* Main Content Area */}
        <div className="md:col-span-2 bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          {activeTab === 'rooms' ? (
            <>
              <h2 className="text-xl font-semibold mb-4">Active Public Rooms</h2>
              {rooms.length === 0 ? (
                <div className="text-slate-400 text-sm flex items-center justify-center h-32 border border-dashed border-slate-800 rounded-lg">
                  No active rooms right now. Create one!
                </div>
              ) : (
                <div className="space-y-4">
                  {rooms.map((room) => (
                    <div key={room.id} className="flex items-center justify-between bg-slate-950 p-4 rounded-xl border border-slate-800 hover:border-slate-700 transition-colors">
                      <div>
                        <h3 className="font-semibold text-lg">{room.name}</h3>
                        <p className="text-sm text-slate-400">Hosted by {room.host.name} • {room._count.participants} watching</p>
                      </div>
                      <div className="flex gap-2">
                        {user.id === room.hostId && (
                          <button 
                            onClick={() => handleDeleteRoom(room.id)}
                            className="p-2 text-slate-500 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                            title="Delete Room"
                          >
                            <Trash2 size={18} />
                          </button>
                        )}
                        <button 
                          onClick={() => navigate(`/room/${room.id}`)}
                          className="px-6 py-2 bg-slate-800 hover:bg-indigo-600 rounded-lg font-medium transition-colors"
                        >
                          Join
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold mb-4">Your Friends</h2>
              {friends.length === 0 ? (
                <div className="text-slate-400 text-sm flex items-center justify-center h-32 border border-dashed border-slate-800 rounded-lg">
                  You haven't added any friends yet.
                </div>
              ) : (
                <div className="space-y-4">
                  {friends.map((friend) => (
                    <div key={friend.id} className="flex items-center justify-between bg-slate-950 p-4 rounded-xl border border-slate-800">
                      <div>
                        <h3 className="font-semibold text-lg">{friend.user.name}</h3>
                        <p className="text-sm text-slate-400">{friend.user.email}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        {friend.status === 'ACCEPTED' ? (
                          <span className="text-sm bg-green-500/10 text-green-400 px-3 py-1 rounded-full border border-green-500/20 flex items-center gap-1">
                            <Check size={14} /> Friends
                          </span>
                        ) : friend.isSender ? (
                          <span className="text-sm bg-slate-800 text-slate-400 px-3 py-1 rounded-full border border-slate-700">
                            Request Sent
                          </span>
                        ) : (
                          <button 
                            onClick={() => handleAcceptFriendRequest(friend.id)}
                            className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                          >
                            Accept Request
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
