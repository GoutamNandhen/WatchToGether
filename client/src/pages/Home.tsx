import { Link } from "react-router-dom";
import { Play, Users, Video } from "lucide-react";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-center px-4">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950 to-slate-950"></div>
      
      <div className="mb-8 p-4 bg-indigo-500/10 rounded-full text-indigo-400">
        <Video size={48} strokeWidth={1.5} />
      </div>

      <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6">
        Watch Together, <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">Anywhere.</span>
      </h1>
      
      <p className="text-lg md:text-xl text-slate-400 max-w-2xl mb-10">
        CineSync synchronizes your videos in real-time, letting you enjoy movies, shows, and streams with friends over voice and video chat.
      </p>

      <div className="flex gap-4">
        <Link to="/signup" className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-all shadow-lg shadow-indigo-500/25 flex items-center gap-2">
          <Play size={20} />
          Start Watching
        </Link>
        <Link to="/login" className="px-8 py-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-all flex items-center gap-2">
          <Users size={20} />
          Join Room
        </Link>
      </div>
    </div>
  );
}
