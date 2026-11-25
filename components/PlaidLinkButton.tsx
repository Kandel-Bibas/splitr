import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";
import { apiFetch } from "../src/api";

const LINK_TOKEN_KEY = "plaid:link_token";
// Set when the stored token reconnects a bank rather than linking a new one
const LINK_ITEM_KEY = "plaid:link_item";

// Resuming a Plaid OAuth redirect needs the link token stored before the
// redirect plus the exact redirect URL; read both once, outside the render
// cycle. Returns null on the server and on ordinary (non-redirect) loads.
function readOAuthRedirect(): { token: string | null; reconnecting: boolean; redirectUri: string } | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("oauth_state_id")) return null;
  return {
    token: sessionStorage.getItem(LINK_TOKEN_KEY),
    reconnecting: sessionStorage.getItem(LINK_ITEM_KEY) != null,
    redirectUri: window.location.href,
  };
}

/** Links a new bank, or with itemId signs back in to a linked one (Plaid's update mode). */
export function PlaidLinkButton({
  itemId,
  onLinked,
  variant = "primary",
  size = "md",
}: {
  itemId?: number;
  /** reconnected: an existing bank signed back in; there is no new bank */
  onLinked: (institutionName: string | null, reconnected: boolean) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const [oauthRedirect] = useState(readOAuthRedirect);
  const [linkToken, setLinkToken] = useState<string | null>(oauthRedirect?.token ?? null);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(
    oauthRedirect && !oauthRedirect.token ? "The bank sign-in expired. Please try linking again." : null
  );
  const autoOpenedRef = useRef(false);
  const receivedRedirectUri = oauthRedirect?.token ? oauthRedirect.redirectUri : undefined;

  useEffect(() => {
    if (oauthRedirect) {
      if (!oauthRedirect.token) window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    let cancelled = false;
    apiFetch(itemId != null ? `/api/plaid/link-token/${itemId}` : "/api/plaid/link-token", { method: "POST" })
      .then((r) => r.json() as Promise<{ link_token?: string; error?: string }>)
      .then((d) => {
        if (cancelled) return;
        if (d.link_token) {
          setLinkToken(d.link_token);
        } else {
          setError(d.error ?? "Plaid isn’t set up.");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Couldn’t reach Plaid.");
      });
    return () => {
      cancelled = true;
    };
  }, [oauthRedirect, itemId]);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      const reconnected = itemId != null || Boolean(oauthRedirect?.reconnecting);
      if (reconnected) {
        // The bank keeps its access token; nothing to exchange
        sessionStorage.removeItem(LINK_TOKEN_KEY);
        sessionStorage.removeItem(LINK_ITEM_KEY);
        if (receivedRedirectUri) window.history.replaceState({}, "", window.location.pathname);
        onLinked(null, true);
        return;
      }
      setLinking(true);
      setError(null);
      try {
        const res = await apiFetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token: publicToken }),
        });
        const data = (await res.json()) as { institution_name?: string | null; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Linking failed");
        sessionStorage.removeItem(LINK_TOKEN_KEY);
        if (receivedRedirectUri) window.history.replaceState({}, "", window.location.pathname);
        onLinked(data.institution_name ?? null, false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Linking failed");
      } finally {
        setLinking(false);
      }
    },
    [onLinked, receivedRedirectUri, itemId, oauthRedirect]
  );

  // Shown as a toast; the same id, so two buttons on a page show it once
  useEffect(() => {
    if (error) toast.error(error, { id: "plaid-link" });
  }, [error]);

  const { open, ready } = usePlaidLink({ token: linkToken, receivedRedirectUri, onSuccess });

  useEffect(() => {
    if (!receivedRedirectUri || !ready || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    open();
  }, [receivedRedirectUri, ready, open]);

  // Stored on open, not on fetch: with a Reconnect button on the page too, the
  // token an OAuth redirect resumes must be the one that was opened.
  function openLink() {
    if (!linkToken) return;
    sessionStorage.setItem(LINK_TOKEN_KEY, linkToken);
    if (itemId != null) sessionStorage.setItem(LINK_ITEM_KEY, String(itemId));
    else sessionStorage.removeItem(LINK_ITEM_KEY);
    open();
  }

  return (
    <Button variant={variant} size={size} onClick={openLink} disabled={!ready || !linkToken || linking}>
      {linking ? "Linking…" : itemId != null ? "Reconnect" : "+ Link a bank"}
    </Button>
  );
}
