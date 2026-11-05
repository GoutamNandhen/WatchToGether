import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { rememberAvatars } from "./store/useAvatarStore";
import Toaster from "./components/ui/Toaster";
import { useAuthStore } from "./store/useAuthStore";
import { useSocketStore } from "./store/useSocketStore";
import api from "./lib/api";
import Spinner from "./components/ui/Spinner";

// Each page is its own chunk, so the landing page doesn't download the room, WebRTC and player code.
const Home = lazy(() => import("./pages/Home"));
const Login = lazy(() => import("./pages/Login"));
const Signup = lazy(() => import("./pages/Signup"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Room = lazy(() => import("./pages/Room"));
const NotFound = lazy(() => import("./pages/NotFound"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Settings = lazy(() => import("./pages/Settings"));
const InviteAccept = lazy(() => import("./pages/InviteAccept"));
const Replay = lazy(() => import("./pages/Replay"));
const Legal = lazy(() => import("./pages/Legal"));

function RequireAuth({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from || "/dashboard"} replace />;
  }
  return <>{children}</>;
}

function SessionSync() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (user) rememberAvatars({ [user.id]: user.avatarVersion ?? null });
  }, [user]);

  // Validate the stored token once and pick up profile changes.
  useEffect(() => {
    if (!token) return;
    api
      .get("/auth/me")
      .then((res) => useAuthStore.getState().setUser(res.data.user))
      .catch(() => {
        /* 401s are handled by the api interceptor */
      });
  }, [token]);

  // Stay connected on every signed-in page so friends see accurate presence;
  // drop the realtime connection when the user signs out.
  useEffect(() => {
    if (token) {
      useSocketStore.getState().connect();
    } else {
      useSocketStore.getState().disconnect();
    }
  }, [token]);

  return null;
}

function App() {
  return (
    <BrowserRouter>
      <SessionSync />
      <div className="min-h-screen bg-ink-950 font-sans text-slate-50 selection:bg-indigo-500/30 selection:text-white">
        <Suspense fallback={<div className="grid min-h-screen place-items-center"><Spinner /></div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
          <Route path="/signup" element={<GuestOnly><Signup /></GuestOnly>} />
          <Route path="/forgot-password" element={<GuestOnly><ForgotPassword /></GuestOnly>} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/room/:id" element={<RequireAuth><Room /></RequireAuth>} />
          <Route path="/room/:id/replay" element={<RequireAuth><Replay /></RequireAuth>} />
          <Route path="/invite/:token" element={<RequireAuth><InviteAccept /></RequireAuth>} />
          <Route path="/privacy" element={<Legal kind="privacy" />} />
          <Route path="/terms" element={<Legal kind="terms" />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </div>
      <Toaster />
    </BrowserRouter>
  );
}

export default App;
