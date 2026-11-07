import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Lock, Ticket } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { useAuthStore } from "../store/useAuthStore";
import AuthLayout from "../components/AuthLayout";
import Spinner from "../components/ui/Spinner";

interface InviteInfo {
  valid: boolean;
  reason: string | null;
  expiresAt: string;
  room: { id: string; name: string; displayId: string | null; isPrivate: boolean; hostName: string };
}

export default function InviteAccept() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const [guestName, setGuestName] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/invites/${token}`)
      .then((res) => {
        if (!cancelled) setInfo(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err, "This invite link doesn't work"));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = async () => {
    setJoining(true);
    try {
      const res = await api.post(`/invites/${token}/accept`);
      navigate(`/room/${res.data.roomId}`, { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, "This invite link doesn't work anymore"));
      setJoining(false);
    }
  };

  /** No account? Join with just a name; the guest can save a real account later in Settings. */
  const joinAsGuest = async (event: FormEvent) => {
    event.preventDefault();
    if (!guestName.trim()) return;
    setJoining(true);
    try {
      const guest = await api.post("/auth/guest", { name: guestName.trim(), inviteToken: token });
      setAuth(guest.data.user, guest.data.token);
      const res = await api.post(`/invites/${token}/accept`, null, { headers: { Authorization: `Bearer ${guest.data.token}` } });
      navigate(`/room/${res.data.roomId}`, { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't join right now"));
      setJoining(false);
    }
  };

  const problem = error ?? (info && !info.valid ? info.reason : null);

  return (
    <AuthLayout
      title="You're invited"
      subtitle="Someone shared a watch party with you."
      footer={user ? <Link to="/dashboard" className="font-medium text-indigo-300 hover:text-indigo-200">Go to your dashboard</Link> : <Link to="/" className="font-medium text-indigo-300 hover:text-indigo-200">What is WatchTogether?</Link>}
    >
      {!info && !error ? (
        <div className="grid h-32 place-items-center text-slate-500"><Spinner /></div>
      ) : problem ? (
        <div className="space-y-3 text-center">
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{problem}</p>
          <p className="text-xs text-slate-500">Ask whoever sent it for a new link.</p>
        </div>
      ) : (
        info && (
          <div className="space-y-5">
            <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 shadow-glow">
                <Ticket size={22} />
              </div>
              <div className="min-w-0">
                <p className="truncate font-display text-lg font-semibold text-white">{info.room.name}</p>
                <p className="text-sm text-slate-400">Hosted by {info.room.hostName}</p>
                {info.room.isPrivate && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-emerald-300">
                    <Lock size={11} /> Private room — this link lets you in without the password
                  </p>
                )}
              </div>
            </div>
            {user ? (
              <button onClick={accept} disabled={joining} className="btn-primary w-full py-3">
                {joining ? <Spinner className="h-4 w-4" /> : null} Join watch party
              </button>
            ) : (
              <form onSubmit={joinAsGuest} className="space-y-3">
                <label className="label" htmlFor="guest-name">Your name</label>
                <input id="guest-name" className="input" autoFocus maxLength={40} placeholder="What should friends call you?" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
                <button type="submit" disabled={joining || !guestName.trim()} className="btn-primary w-full py-3">
                  {joining ? <Spinner className="h-4 w-4" /> : null} Join as guest
                </button>
                <p className="text-center text-xs text-slate-500">
                  Have an account? <Link to="/login" state={{ from: `/invite/${token}` }} className="font-medium text-indigo-300 hover:text-indigo-200">Sign in</Link>
                  {" "}or{" "}
                  <Link to="/signup" state={{ from: `/invite/${token}` }} className="font-medium text-indigo-300 hover:text-indigo-200">create one</Link>
                </p>
              </form>
            )}
            <p className="text-center text-xs text-slate-500">
              Link expires {new Date(info.expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </p>
          </div>
        )
      )}
    </AuthLayout>
  );
}
