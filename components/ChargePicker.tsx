import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accountsQuery, transactionsQuery, useRefreshAll } from "../src/queries";
import { apiFetch } from "../src/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { formatUSD } from "@/lib/money";
import { txLabel, type TxView } from "@/lib/transactions";
import { accountLabel, indexAccounts } from "@/lib/bank-types";

/** A charge linked to a split, as GET /api/expenses/:id returns it */
export interface ExpenseCharge {
  id: number;
  date: string;
  amount: number;
  source: "PLAID" | "MANUAL";
  name: string;
  merchantName: string | null;
  account: { name: string; mask: string | null; item: { institutionName: string | null } } | null;
}

/** "Chase •• 1234", or "Cash" for a charge added by hand */
export function chargeAccountLabel(account: ExpenseCharge["account"]): string {
  if (!account) return "Cash";
  const bank = account.item.institutionName ?? account.name;
  return account.mask ? `${bank} •• ${account.mask}` : bank;
}

/**
 * The charges' amounts against what the split totals: "$60.12 + $39.88 =
 * $100.00 of $100.00". A gap is shown in the danger style.
 */
export function ChargeTotal({ amounts, totalCents }: { amounts: number[]; totalCents: number }) {
  const sum = amounts.reduce((a, b) => a + b, 0);
  const gap = sum - totalCents;
  const sumText =
    amounts.length > 1
      ? `${amounts.map(formatUSD).join(" + ")} = ${formatUSD(sum)} of ${formatUSD(totalCents)}`
      : `${formatUSD(sum)} of ${formatUSD(totalCents)}`;
  return (
    <p className="text-sm tabular-nums text-ink-muted">
      {sumText}
      {gap !== 0 && (
        <span className="text-danger font-semibold">
          {" · "}
          {formatUSD(Math.abs(gap))} {gap < 0 ? "short" : "over"}
        </span>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Which charges to offer
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  date: string;
  amount: number;
  /** Merchant or bank description */
  label: string;
  /** Bank description, searched along with the label */
  name: string;
  account: string;
}

const DAYS_BEFORE = 3;
const DAYS_AFTER = 21;
const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

/** Lowercase letters and digits only, so "SAM'S CLUB #6279" and "Sams Club" compare alike. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isStoreMatch(store: string, row: Row): boolean {
  const wanted = squash(store);
  return wanted !== "" && (squash(row.label).includes(wanted) || squash(row.name).includes(wanted));
}

/** Search text against name, merchant and amount ("39.88" or "$39.88"). */
function isSearchMatch(query: string, row: Row): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (`${row.label} ${row.name}`.toLowerCase().includes(q)) return true;
  const squashed = squash(q);
  if (squashed !== "" && (squash(row.label).includes(squashed) || squash(row.name).includes(squashed))) return true;
  const amount = q.replace(/[$,\s]/g, "");
  return /^\d*\.?\d+$/.test(amount) && (row.amount / 100).toFixed(2).includes(amount);
}

function newestFirst(a: Row, b: Row): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id;
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

/**
 * Chooses which card charges paid for a split. Starts with the charges near
 * the purchase date from the same store, and a search reaches every other
 * charge that is still free to link.
 */
export function ChargePicker({
  expenseId,
  store,
  day,
  totalCents,
  linked,
  onClose,
}: {
  expenseId: string;
  store: string | null;
  /** The purchase date, YYYY-MM-DD */
  day: string;
  totalCents: number;
  linked: ExpenseCharge[];
  onClose: () => void;
}) {
  const refreshAll = useRefreshAll();
  const txResult = useQuery(transactionsQuery);
  const banksResult = useQuery(accountsQuery);

  const [selected, setSelected] = useState<Set<number>>(() => new Set(linked.map((c) => c.id)));
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useMemo(() => indexAccounts(banksResult.data?.items ?? []), [banksResult.data]);

  // Everything that can be linked here: money out, and free or already on this split
  const rows = useMemo(() => {
    const byId = new Map<number, Row>();
    function fromTx(tx: TxView): Row {
      return {
        id: tx.id,
        date: tx.date,
        amount: tx.amount,
        label: txLabel(tx),
        name: tx.name,
        account: tx.accountId == null ? "Cash" : accountLabel(accounts.get(tx.accountId)),
      };
    }
    for (const tx of txResult.data ?? []) {
      if (tx.amount > 0 && (!tx.split || tx.split.expenseId === expenseId)) byId.set(tx.id, fromTx(tx));
    }
    // A linked charge stays listed (so it can be unticked) even if the list lacks it
    for (const c of linked) {
      if (!byId.has(c.id)) {
        byId.set(c.id, {
          id: c.id,
          date: c.date,
          amount: c.amount,
          label: c.merchantName || c.name,
          name: c.name,
          account: chargeAccountLabel(c.account),
        });
      }
    }
    return [...byId.values()];
  }, [txResult.data, accounts, expenseId, linked]);

  const linkedIds = useMemo(() => new Set(linked.map((c) => c.id)), [linked]);
  const searching = query.trim() !== "";

  const shown = useMemo(() => {
    const from = dayNumber(day) - DAYS_BEFORE;
    const to = dayNumber(day) + DAYS_AFTER;
    const list = searching
      ? rows.filter((r) => isSearchMatch(query, r))
      : rows.filter((r) => {
          if (linkedIds.has(r.id)) return true;
          const d = dayNumber(r.date);
          return d >= from && d <= to && (store == null || store.trim() === "" || isStoreMatch(store, r));
        });
    return list.sort(newestFirst);
  }, [rows, query, searching, day, store, linkedIds]);

  const amounts = rows.filter((r) => selected.has(r.id)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)).map((r) => r.amount);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/expenses/${expenseId}/charges`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionIds: [...selected] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Couldn’t save the charges (HTTP ${res.status})`);
      }
      // The split, the Money list and each charge's page all show the link
      await refreshAll();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t save the charges. Try again.");
      setSaving(false);
    }
  }

  const loading = txResult.isLoading;

  return (
    <div className="space-y-4 rounded-3xl border border-ink bg-surface p-5">
      <div className="space-y-1.5">
        <label htmlFor="charge-search" className="text-sm font-semibold leading-none">
          Search charges
        </label>
        <Input
          id="charge-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name, merchant or amount, like 39.88"
          disabled={saving}
        />
        <p className="text-xs text-ink-faint">
          {searching
            ? "Searching every charge that isn’t on another split."
            : store
              ? `Showing ${store} charges from ${DAYS_BEFORE} days before to ${DAYS_AFTER} days after the purchase.`
              : `Showing charges from ${DAYS_BEFORE} days before to ${DAYS_AFTER} days after the purchase.`}
        </p>
      </div>

      {txResult.error ? (
        <p className="text-sm text-danger" role="alert">
          {txResult.error.message}
        </p>
      ) : loading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="rounded-2xl bg-mist px-4 py-3 text-sm text-ink-muted">
          No matching charges{searching ? "" : ". Search to look through all of them."}
        </p>
      ) : (
        <ul className="max-h-96 overflow-y-auto rounded-2xl border border-ink divide-y divide-rim">
          {shown.map((r) => (
            <li key={r.id}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-3 select-none hover:bg-mist">
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                  disabled={saving}
                  className="w-5 h-5 shrink-0 accent-[#0B0B0C] cursor-pointer"
                />
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-sm font-semibold">{r.label}</span>
                  <span className="block truncate text-xs text-ink-muted">
                    {r.account} · {shortDate(r.date)}
                  </span>
                </span>
                <span className="text-sm tabular-nums">{formatUSD(r.amount)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1">
        <p className="text-sm font-semibold">
          {selected.size === 0 ? "No charges ticked" : `${selected.size} ticked`}
        </p>
        {selected.size > 0 && <ChargeTotal amounts={amounts} totalCents={totalCents} />}
      </div>

      {error && (
        <p className="text-sm text-danger bg-danger-dim border border-danger rounded-2xl px-4 py-3" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || loading}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** day is YYYY-MM-DD; read as a local date so it never shifts a day */
export function shortDate(day: string): string {
  return new Date(`${day}T00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
