import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { accountsQuery, useRefreshAll } from "../queries";
import { Button } from "@/components/ui/Button";
import { BankLogo } from "@/components/BankLogo";
import { SyncButton, type SyncResult } from "@/components/SyncButton";
import { PlaidLinkButton } from "@/components/PlaidLinkButton";
import { formatUSD } from "@/lib/money";
import { netBalance } from "@/lib/spending";
import { lastSynced, timeAgo, type BankItem } from "@/lib/bank-types";
import { apiFetch } from "../api";

export default function BanksPage() {
  const { data, error: loadError } = useQuery(accountsQuery);
  const refreshAll = useRefreshAll();
  // Banks whose last sync said to sign in again. Kept until they sync cleanly.
  const [needsLogin, setNeedsLogin] = useState<ReadonlySet<number>>(new Set());

  function onSynced(results: SyncResult[]) {
    setNeedsLogin((prev) => {
      const next = new Set(prev);
      for (const r of results) {
        if (r.error === "login_required") next.add(r.itemId);
        else next.delete(r.itemId);
      }
      return next;
    });
    refreshAll();
  }

  // Pull history right away so Money fills in without another click.
  // One toast that reads "Syncing…" until the sync lands.
  function syncAfterLink(url: string, syncing: string, done: string, retry: string) {
    toast.loading(syncing, { id: "link" });
    apiFetch(url, { method: "POST" })
      .then((r) => r.json() as Promise<{ results?: SyncResult[] }>)
      .then((d) => {
        onSynced(d.results ?? []);
        toast.success(done, { id: "link" });
      })
      .catch(() => toast.error(retry, { id: "link" }));
  }

  const items = data?.items ?? [];
  const allAccounts = items.flatMap((i) => i.accounts);
  const synced = lastSynced(items);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-6xl sm:text-7xl uppercase">Banks</h1>
      </header>

      {loadError && (
        <div
          className="flex items-center gap-3 text-sm text-danger bg-danger-dim border border-danger rounded-3xl px-5 py-4"
          role="alert"
        >
          <span className="flex-1">{loadError.message}</span>
          <Button variant="danger" size="sm" onClick={() => refreshAll()}>
            Retry
          </Button>
        </div>
      )}

      {!data && !loadError && <p className="text-sm text-ink-faint">Loading…</p>}

      {data && (
        <>
          {/* ── Net balance + actions ───────────────────────────────────── */}
          {items.length > 0 && (
            <div className="rounded-3xl border border-ink bg-lavender px-6 pt-4 pb-6">
              <p className="text-sm font-semibold">Net balance</p>
              <p className="mt-1 font-display text-7xl sm:text-8xl tabular-nums leading-none">
                {formatUSD(netBalance(allAccounts))}
              </p>
              {synced && <p className="mt-3 text-sm text-ink-muted">Updated {timeAgo(synced)}</p>}
            </div>
          )}

          <div className="flex items-start gap-2 flex-wrap">
            {data.plaidConfigured ? (
              <PlaidLinkButton
                variant={items.length > 0 ? "secondary" : "primary"}
                onLinked={(name, reconnected) => {
                  if (reconnected) {
                    syncAfterLink(
                      "/api/plaid/sync",
                      "Reconnected. Syncing…",
                      "Reconnected",
                      "Reconnected. Sync again in a minute."
                    );
                    return;
                  }
                  refreshAll();
                  syncAfterLink(
                    "/api/plaid/sync",
                    `Linked ${name ?? "your bank"}. Syncing…`,
                    `Linked ${name ?? "your bank"}`,
                    `Linked ${name ?? "your bank"}. Sync again in a minute to pull its history.`
                  );
                }}
              />
            ) : (
              <p className="text-sm rounded-2xl border border-ink bg-sun/40 px-4 py-2.5">
                Bank linking isn’t set up yet: the app is missing its Plaid keys.
              </p>
            )}
            {items.length > 1 && (
              <SyncButton label="Sync all" size="md" onSynced={onSynced} />
            )}
          </div>

          {items.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-ink px-6 py-10 text-center">
              <p className="font-display text-3xl uppercase">No banks yet</p>
            </div>
          ) : (
            <div className="space-y-6">
              {items.map((item, i) => (
                <BankCard
                  key={item.id}
                  item={item}
                  index={i}
                  needsLogin={needsLogin.has(item.id)}
                  onChange={refreshAll}
                  onSynced={onSynced}
                  onReconnected={() =>
                    syncAfterLink(
                      `/api/plaid/sync/${item.id}`,
                      `Reconnected ${item.institutionName ?? "your bank"}. Syncing…`,
                      `Reconnected ${item.institutionName ?? "your bank"}`,
                      "Reconnected. Sync again in a minute."
                    )
                  }
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BankCard({
  item,
  index,
  needsLogin,
  onChange,
  onSynced,
  onReconnected,
}: {
  item: BankItem;
  index: number;
  needsLogin: boolean;
  onChange: () => void;
  onSynced: (results: SyncResult[]) => void;
  onReconnected: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = item.institutionName ?? "Linked bank";

  async function unlink() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/plaid/items/${item.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Error ${res.status}`);
      }
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unlink failed");
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <section
      className="rise rounded-3xl border border-ink overflow-hidden"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
      aria-label={name}
    >
      <div className="bg-mist border-b border-ink">
        {/* One line at any width: a long name shortens, the buttons never wrap */}
        <div className="flex items-center gap-3 pl-5 pr-3 py-3.5">
          <BankLogo item={item} />
          <h2 className="flex-1 min-w-0 font-semibold truncate">{name}</h2>
          <span className="shrink-0 flex items-center gap-1">
            {/* A bank that needs signing in again can't sync until it does */}
            {needsLogin ? (
              <PlaidLinkButton itemId={item.id} size="sm" onLinked={onReconnected} />
            ) : (
              <SyncButton itemId={item.id} variant="ghost" onSynced={onSynced} />
            )}
            <Button variant="ghost" size="sm" onClick={() => setConfirm(true)} disabled={confirm}>
              Unlink
            </Button>
          </span>
        </div>
        {confirm && (
          <div className="flex items-center gap-2 flex-wrap px-5 pb-3.5">
            <span className="mr-auto text-sm text-ink-muted">Unlink and delete its transactions?</span>
            <span className="flex items-center gap-2">
              <Button variant="danger" size="sm" onClick={unlink} disabled={busy}>
                {busy ? "Unlinking…" : "Unlink"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(false)} disabled={busy}>
                Cancel
              </Button>
            </span>
          </div>
        )}
      </div>
      {item.accounts.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">No accounts yet. Sync to fetch them.</p>
      ) : (
        <ul className="divide-y divide-rim">
          {item.accounts.map((a) => {
            const owed = a.type === "credit" || a.type === "loan";
            return (
              <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{a.name}</p>
                  <p className="text-xs text-ink-muted capitalize">
                    {a.subtype ?? a.type}
                    {a.mask ? ` •• ${a.mask}` : ""}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-display text-2xl tabular-nums">
                    {a.currentBalance == null ? "—" : formatUSD(a.currentBalance)}
                  </p>
                  {owed && a.currentBalance != null && a.currentBalance > 0 && (
                    <p className="text-xs text-ink-muted">owed</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
