import { useState } from "react";
import { toast } from "sonner";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";
import { apiFetch } from "../src/api";

export interface SyncResult {
  itemId: number;
  institutionName: string | null;
  added: number;
  modified: number;
  removed: number;
  /** This bank failed; the others still synced. login_required: reconnect it on Banks. */
  error?: "login_required" | "failed";
}

/** "Chase", "Chase and Amex" */
function bankNames(results: SyncResult[]): string {
  return results.map((r) => r.institutionName ?? "a bank").join(" and ");
}

function syncStatus(results: SyncResult[]): { ok: boolean; text: string } {
  const login = results.filter((r) => r.error === "login_required");
  const failed = results.filter((r) => r.error === "failed");
  if (login.length > 0) return { ok: false, text: `${bankNames(login)} need${login.length === 1 ? "s" : ""} you to reconnect` };
  if (failed.length > 0) return { ok: false, text: `Couldn’t sync ${bankNames(failed)}` };
  const added = results.reduce((s, r) => s + r.added, 0);
  return { ok: true, text: added === 0 ? "Up to date" : `${added} new` };
}

/** Pulls new transactions from Plaid (one bank, or all of them). */
export function SyncButton({
  itemId,
  label = "Sync",
  variant = "secondary",
  size = "sm",
  onSynced,
}: {
  itemId?: number;
  label?: string;
  variant?: ButtonVariant;
  /** Match the button beside it */
  size?: ButtonSize;
  /** Also called when some banks failed; their results carry the error */
  onSynced: (results: SyncResult[]) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function sync() {
    setBusy(true);
    try {
      const res = await apiFetch(itemId != null ? `/api/plaid/sync/${itemId}` : "/api/plaid/sync", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { results?: SyncResult[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Sync failed (HTTP ${res.status})`);
      const results = data.results ?? [];
      const status = syncStatus(results);
      // One id for every sync, so pressing it again replaces the last result
      if (status.ok) toast.success(status.text, { id: "sync" });
      else toast.error(status.text, { id: "sync" });
      onSynced(results);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed", { id: "sync" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant={variant} size={size} onClick={sync} disabled={busy}>
      <span aria-hidden="true" className={busy ? "inline-block animate-spin" : ""}>↻</span>
      {busy ? "Syncing…" : label}
    </Button>
  );
}
