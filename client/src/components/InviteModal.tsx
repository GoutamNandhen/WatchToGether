import { useState, useEffect } from "react";
import { X, Copy, Check, UserPlus } from "lucide-react";
import api from "../lib/api";

interface Friend {
  id: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
}

interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
}

export default function InviteModal({ isOpen, onClose, roomId }: InviteModalProps) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [isCopied, setIsCopied] = useState(false);
  const [invitedMap, setInvitedMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (isOpen) {
      fetchFriends();
      setInvitedMap({});
    }
  }, [isOpen]);

  const fetchFriends = async () => {
    try {
      const res = await api.get("/friends");
      // Only show accepted friends
      const accepted = res.data.friends.filter((f: any) => f.status === "ACCEPTED");
      setFriends(accepted);
    } catch (error) {
      console.error("Failed to fetch friends:", error);
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleInvite = async (email: string, friendId: string) => {
    try {
      await api.post(`/rooms/${roomId}/invite`, { email });
      setInvitedMap(prev => ({ ...prev, [friendId]: true }));
    } catch (error) {
      console.error("Failed to invite friend:", error);
      alert("Failed to send invitation.");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[99999] flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col">
        <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-800/50">
          <h2 className="text-xl font-bold text-white">Invite Friends</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-6 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-slate-300">Room Link</label>
            <div className="flex bg-slate-950 border border-slate-700 rounded-lg overflow-hidden">
              <input 
                type="text" 
                readOnly 
                value={window.location.href}
                className="flex-1 bg-transparent px-4 py-2 text-sm text-slate-400 outline-none"
              />
              <button 
                onClick={handleCopyLink}
                className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 text-sm font-medium transition-colors flex items-center gap-2"
              >
                {isCopied ? <Check size={16} /> : <Copy size={16} />}
                {isCopied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-slate-300">Invite Friends</label>
            {friends.length === 0 ? (
              <div className="text-slate-500 text-sm italic text-center py-4 bg-slate-950 rounded-lg border border-slate-800">
                You have no friends to invite. Add some from the Dashboard!
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
                {friends.map(friend => (
                  <div key={friend.id} className="flex items-center justify-between bg-slate-950 p-3 rounded-xl border border-slate-800">
                    <div>
                      <h3 className="text-slate-200 font-medium text-sm">{friend.user.name}</h3>
                      <p className="text-xs text-slate-500">{friend.user.email}</p>
                    </div>
                    {invitedMap[friend.id] ? (
                      <span className="text-xs text-green-400 font-medium flex items-center gap-1 bg-green-500/10 px-2 py-1 rounded-md">
                        <Check size={14} /> Invited
                      </span>
                    ) : (
                      <button 
                        onClick={() => handleInvite(friend.user.email, friend.id)}
                        className="text-xs bg-slate-800 hover:bg-indigo-600 text-white px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                      >
                        <UserPlus size={14} /> Invite
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
