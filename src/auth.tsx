import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import LoginPage from "./pages/login";
import { queryClient } from "./queries";
import { supabase } from "./supabase";

const SessionContext = createContext<Session | null>(null);

/** The signed-in session; only valid below AuthGate. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside AuthGate with a session");
  return session;
}

export function signOut() {
  return supabase.auth.signOut();
}

/**
 * Shows the login screen until there is a session, then the app. The first
 * auth event also covers a sign-in or invite link, which supabase-js reads
 * from the URL on load.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  // undefined while the stored session (or a link in the URL) is being read
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const userId = useRef<string | null>(null);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      // Signing out, or a different user signing in, must not leave the last user's data cached
      const nextId = next?.user.id ?? null;
      if (nextId !== userId.current) queryClient.clear();
      userId.current = nextId;
      setSession(next);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return null;
  if (!session) return <LoginPage />;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
