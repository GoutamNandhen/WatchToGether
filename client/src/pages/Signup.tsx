import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import api from "../lib/api";
import { useAuthStore } from "../store/useAuthStore";

export default function Signup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const setAuth = useAuthStore((state) => state.setAuth);
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccessMsg("");

    if (!name.trim()) return setError("Name is required");
    if (!email.trim()) return setError("Email is required");
    if (!/^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/.test(email)) return setError("Invalid email format");
    if (!password) return setError("Password is required");
    if (password.length < 6) return setError("Password must be at least 6 characters");

    setIsLoading(true);
    try {
      const res = await api.post("/auth/register", { name, email, password });
      setAuth(res.data.user, res.data.token);
      setSuccessMsg("Account created successfully");
      
      setTimeout(() => {
        const from = location.state?.from || "/dashboard";
        navigate(from);
      }, 500);
    } catch (err: any) {
      if (!err.response) {
        setError("Unable to connect to the server. Please check your connection and try again.");
      } else {
        setError(err.response?.data?.error || "Unable to create account. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-xl">
        <h2 className="text-3xl font-bold text-center mb-6">Create Account</h2>
        {error && <div className="bg-red-500/10 border border-red-500/50 text-red-500 px-4 py-2 rounded-lg mb-4 text-sm" role="alert">{error}</div>}
        {successMsg && <div className="bg-green-500/10 border border-green-500/50 text-green-500 px-4 py-2 rounded-lg mb-4 text-sm" role="status">{successMsg}</div>}
        <form className="space-y-4" onSubmit={handleSignup}>
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1">Name</label>
            <input 
              type="text" 
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500" 
              placeholder="John Doe" 
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1">Email</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500" 
              placeholder="you@example.com" 
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1">Password</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500" 
              placeholder="••••••••" 
              required
            />
          </div>
          <button 
            type="submit" 
            disabled={isLoading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 rounded-lg transition-colors mt-2 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Creating account...
              </>
            ) : "Sign Up"}
          </button>
        </form>
        <p className="text-center text-slate-400 mt-6 text-sm">
          Already have an account? <Link to="/login" state={{ from: location.state?.from }} className="text-indigo-400 hover:text-indigo-300">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
