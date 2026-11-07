import { useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";
import api, { getErrorMessage } from "../lib/api";
import { useAuthStore } from "../store/useAuthStore";
import { toast } from "../store/useToastStore";
import { EMAIL_REGEX } from "../lib/validation";
import PasswordInput from "./PasswordInput";
import Spinner from "./ui/Spinner";

/** Lets a guest (joined from an invite link) keep their account by adding an email and password. */
export default function SaveGuestAccount() {
  const { user, setAuth } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user?.isGuest) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!EMAIL_REGEX.test(email.trim())) return setError("Enter a valid email address");
    if (password.length < 6) return setError("Password must be at least 6 characters");
    setSaving(true);
    setError(null);
    try {
      const res = await api.post("/auth/me/claim", { email: email.trim(), password });
      setAuth(res.data.user, res.data.token);
      toast.success("Account saved. You can now host parties and add friends.");
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't save your account"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card border-indigo-400/30 p-6">
      <h2 className="mb-1 flex items-center gap-2 font-display font-semibold"><UserPlus size={18} className="text-indigo-300" /> Keep your account</h2>
      <p className="mb-5 text-sm text-slate-400">You joined as a guest. Add an email and password to host your own parties, add friends, and sign in on other devices. Your history stays.</p>
      <form onSubmit={submit} className="grid gap-4 sm:max-w-sm">
        <div>
          <label className="label" htmlFor="claim-email">Email</label>
          <input id="claim-email" type="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="claim-password">Password</label>
          <PasswordInput id="claim-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <button type="submit" disabled={saving} className="btn-primary w-fit">{saving && <Spinner className="h-4 w-4" />} Save account</button>
      </form>
    </section>
  );
}
