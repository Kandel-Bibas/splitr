import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { supabase } from "../supabase";

/** A link that failed (expired, already used) comes back with the reason in the URL hash. */
function linkError(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("error_description");
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(linkError);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setPending(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    setPending(false);
    if (error) setError(error.message);
    else setSentTo(address);
  }

  return (
    <main className="flex-1 w-full max-w-sm mx-auto px-4 py-16 space-y-8">
      <p className="font-display text-5xl uppercase text-center">Splitr</p>
      {sentTo ? (
        <div className="space-y-4 text-center">
          <p className="text-lg font-semibold">Check your email</p>
          <p className="text-sm text-ink-muted">
            We sent a sign-in link to {sentTo}. Open it on this device to continue.
          </p>
          <Button variant="ghost" onClick={() => setSentTo(null)}>
            Use a different email
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Email" htmlFor="login-email" error={error ?? undefined}>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              hasError={!!error}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" className="w-full" disabled={pending}>
            {pending ? "Sending…" : "Email me a sign-in link"}
          </Button>
        </form>
      )}
    </main>
  );
}
