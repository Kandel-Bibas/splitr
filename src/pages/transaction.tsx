import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { accountsQuery, expenseQuery, isNotFound, peopleQuery, transactionQuery, useRefreshAll } from "../queries";
import { Chevron } from "@/components/Chevron";
import Link, { useGoTo, useRouteParam } from "@/components/Link";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { BackLink } from "@/components/BackLink";
import { BankLogo } from "@/components/BankLogo";
import { DeleteSection } from "@/components/DeleteSection";
import { PersonChip } from "@/components/PersonChip";
import { CategoryChips } from "@/components/CategoryChips";
import { formatUSD } from "@/lib/money";
import { ALL_CATEGORIES, isMoneyMoving, isSpending, yourShare } from "@/lib/spending";
import { txLabel } from "@/lib/transactions";
import { accountLabel, indexAccounts } from "@/lib/bank-types";
import { apiFetch } from "../api";

interface Person {
  id: string;
  name: string;
  colorHex: string;
}

/** The parts of GET /api/expenses/[id] this page shows */
interface LinkedSplit {
  id: string;
  type: "ITEMIZED" | "SIMPLE";
  totalCents: number;
  payer: Person;
  breakdown: { perPerson: { personId: string; cents: number }[] };
}

function longDate(day: string): string {
  return new Date(`${day}T00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function TransactionPage() {
  const id = useRouteParam("id");
  const goTo = useGoTo();

  const client = useQueryClient();
  const refreshAll = useRefreshAll();
  const txResult = useQuery(transactionQuery(id));
  const tx = txResult.data ?? null;
  // Shown alongside the charge: its bank, and the split made from it if any.
  // These are extras; if one fails to load, the charge still shows.
  const banksResult = useQuery(accountsQuery);
  const splitResult = useQuery({ ...expenseQuery<LinkedSplit>(tx?.split?.expenseId ?? ""), enabled: Boolean(tx?.split) });
  const peopleResult = useQuery({ ...peopleQuery, enabled: Boolean(tx?.split) });
  const account = tx?.accountId != null ? indexAccounts(banksResult.data?.items ?? []).get(tx.accountId) : undefined;
  const split = splitResult.data ?? null;
  const people = new Map((peopleResult.data ?? []).map((p) => [p.id, p]));
  const loadError = txResult.error;
  const loadState = isNotFound(loadError)
    ? "notfound"
    : loadError
      ? "error"
      : tx && !banksResult.isLoading && !splitResult.isLoading && !peopleResult.isLoading
        ? "ready"
        : "loading";

  const [deleting, setDeleting] = useState(false);

  async function handleCategory(next: string) {
    if (!tx || next === tx.categoryPrimary) return;
    const prev = tx;
    const key = transactionQuery(id).queryKey;
    client.setQueryData(key, { ...tx, categoryPrimary: next, categoryDetailed: null }); // optimistic
    try {
      const res = await apiFetch(`/api/transactions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryPrimary: next }),
      });
      if (!res.ok) throw new Error();
      // Money's list and totals use the category too
      refreshAll();
    } catch {
      client.setQueryData(key, prev); // revert
      toast.error("Couldn’t save the category. Try again.");
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/transactions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Error ${res.status}`);
      }
      goTo("/");
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed. Try again.");
      setDeleting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (loadState === "loading") {
    return <p className="py-16 text-center text-sm text-ink-faint">Loading…</p>;
  }

  if (loadState === "notfound" || loadState === "error" || !tx) {
    return (
      <div className="py-16 space-y-4 text-center">
        <p className="font-display text-4xl uppercase">
          {loadState === "notfound" ? "Transaction not found" : "Something went wrong"}
        </p>
        {loadState === "error" && <p className="text-sm text-danger">{loadError?.message}</p>}
        <Link href="/">
          <Button variant="secondary">Back to Money</Button>
        </Link>
      </div>
    );
  }

  const label = txLabel(tx);
  const moneyIn = tx.amount < 0;
  const moving = isMoneyMoving(tx);
  const canSplit = isSpending(tx) && !tx.split;
  const share = tx.split ? yourShare({ amount: tx.amount, owedBackCents: tx.split.owedBackCents }) : null;

  return (
    <div className="space-y-8">
      <BackLink href="/" label="Back to Money" />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header>
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-muted">
          <BankLogo item={account?.item} size="sm" />
          {longDate(tx.date)} · {tx.source === "MANUAL" ? "Added by hand" : accountLabel(account)}
        </p>
        <h1 className="mt-3 font-display text-5xl sm:text-6xl uppercase break-words">{label}</h1>
        {tx.merchantName && tx.merchantName !== tx.name && (
          <p className="mt-2 text-xs text-ink-muted break-all">{tx.name}</p>
        )}
        <div className="mt-5 flex items-end gap-3 flex-wrap">
          <p
            className={`font-display text-7xl sm:text-8xl tabular-nums leading-none ${moneyIn && !moving ? "text-income" : ""}`}
          >
            {moneyIn ? `+${formatUSD(-tx.amount)}` : formatUSD(tx.amount)}
          </p>
          {tx.pending && (
            <span className="mb-2 rounded-full border border-ink bg-sun px-2.5 py-0.5 text-xs font-semibold">
              Pending
            </span>
          )}
        </div>
      </header>

      {/* ── Manual actions ──────────────────────────────────────────────── */}
      {tx.source === "MANUAL" && (
        <div className="flex items-center gap-2 flex-wrap">
          <Link href={`/transactions/new?edit=${tx.id}`}>
            <Button variant="primary" size="sm">Edit</Button>
          </Link>
        </div>
      )}

      {/* ── Split ───────────────────────────────────────────────────────── */}
      {tx.split && (
        <Section title="Split">
          <Link
            href={`/expenses/${tx.split.expenseId}`}
            className="group block rounded-3xl border border-ink bg-mint-dim p-5 sm:p-6 transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sun"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">Coming back to you</p>
                <p className="font-display text-5xl tabular-nums leading-none mt-1">
                  {formatUSD(tx.split.owedBackCents)}
                </p>
                {tx.split.chargeCount > 1 && (
                  <p className="mt-1 text-sm text-ink-muted">
                    One of {tx.split.chargeCount} charges on this split. This is this charge’s part of what comes back.
                  </p>
                )}
                <p className="mt-2 text-sm">
                  Your share <span className="font-semibold tabular-nums">{formatUSD(share ?? 0)}</span>
                  {" · "}
                  {tx.split.logged ? "✓ Logged in Splitwise" : "Not in Splitwise yet"}
                </p>
              </div>
              <span
                aria-hidden="true"
                className="shrink-0 w-11 h-11 rounded-full bg-ink text-white inline-flex items-center justify-center transition-transform group-hover:translate-x-1"
              >
                <Chevron direction="right" />
              </span>
            </div>
            {split && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {split.breakdown.perPerson.map(({ personId, cents }) => {
                  const p = people.get(personId) ?? (split.payer.id === personId ? split.payer : undefined);
                  if (!p) return null;
                  return (
                    <span key={personId} className="inline-flex items-center gap-1.5">
                      <PersonChip name={p.name} colorHex={p.colorHex} size="sm" readOnly />
                      <span className="text-xs font-semibold tabular-nums">{formatUSD(cents)}</span>
                    </span>
                  );
                })}
              </div>
            )}
            {split && tx.split.chargeCount === 1 && split.totalCents !== tx.amount && (
              <p className="mt-3 text-xs text-ink-muted">
                The split totals {formatUSD(split.totalCents)}; the charge was {formatUSD(tx.amount)}.
              </p>
            )}
          </Link>
        </Section>
      )}

      {canSplit && (
        <Section title="Split it">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              {
                href: `/expenses/new/simple?fromTx=${tx.id}`,
                title: "Quick split",
                body: "Evenly or by exact amounts.",
                color: "bg-sky",
              },
              {
                href: `/expenses/new/itemized?fromTx=${tx.id}`,
                title: "Receipt",
                body: "Pick who shares each item.",
                color: "bg-lavender",
              },
            ].map((c) => (
              <Link
                key={c.href}
                href={c.href}
                className={`group rounded-3xl border border-ink p-5 flex items-end justify-between gap-4 transition-transform hover:-translate-y-0.5 hover:shadow-[0_4px_0_0_#0B0B0C] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sun ${c.color}`}
              >
                <div>
                  <p className="font-display text-4xl uppercase">{c.title}</p>
                  <p className="mt-1 text-sm">{c.body}</p>
                </div>
                <span
                  aria-hidden="true"
                  className="shrink-0 w-10 h-10 rounded-full bg-ink text-white inline-flex items-center justify-center transition-transform group-hover:translate-x-1"
                >
                  <Chevron direction="right" />
                </span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {moving && (
        <p className="text-sm text-ink-muted rounded-3xl bg-mist px-5 py-4">
          Transfer · not counted as spending
        </p>
      )}

      {/* ── Category ────────────────────────────────────────────────────── */}
      <Section title="Category">
        <CategoryChips options={ALL_CATEGORIES} value={tx.categoryPrimary} onChange={handleCategory} />
      </Section>

      {/* Bank charges come from the bank, so only hand-added ones can go */}
      {tx.source === "MANUAL" && (
        <DeleteSection
          label="Delete expense"
          question={tx.split ? "Delete? The split stays." : "Delete for good?"}
          deleting={deleting}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
