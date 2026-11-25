import { supabase } from "./supabase";

/**
 * fetch for /api: adds the signed-in user's access token. A 401 means the
 * session is no longer accepted, so it signs out, which returns to the login screen.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) await supabase.auth.signOut({ scope: "local" });
  return res;
}
