import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chevron } from "@/components/Chevron";
import Link from "@/components/Link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { BankLogo } from "@/components/BankLogo";
import { SyncButton } from "@/components/SyncButton";
import { formatUSD } from "@/lib/money";
import {
  categoryColor,
  categoryLabel,
  isMoneyMoving,
  isSpending,
  netBalance,
  shiftMonth,
  summarizeMonth,
  todayLocal,
} from "@/lib/spending";
import { txLabel, type TxView } from "@/lib/transactions";
import { accountsQuery, transactionsQuery, useRefreshAll } from "../queries";
import {
  accountLabel,
  indexAccounts,
  type AccountRef,
  type AccountsResponse,
} from "@/lib/bank-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** day is YYYY-MM-DD; read as a local date so it never shifts a day */
function localDate(day: string): Date {
  return new Date(`${day}T00:00`);
}

function monthName(month: string, withYear = true): string {
  return localDate(`${month}-01`).toLocaleDateString("en-US", {
    month: "long",
    ...(withYear && { year: "numeric" }),
  });
}

type Show = "all" | "spending" | "unsplit" | "in";

const SHOW_OPTIONS: [Show, string][] = [
  ["all", "All"],
  ["spending", "Spending"],
  ["unsplit", "Not split"],
  ["in", "Money in"],
];

// The month and filters survive opening a transaction and coming back.
// sessionStorage lasts as long as the browser tab.
const MONEY_STATE_KEY = "splitr.money";

interface SavedMoneyState {
  month: string;
  query: string;
  category: string | null;
  show: Show;
}

function readMoneyState(): Partial<SavedMoneyState> | null {
  try {
    const raw = sessionStorage.getItem(MONEY_STATE_KEY);
    return raw ? (JSON.parse(raw) as Partial<SavedMoneyState>) : null;
  } catch {
    return null;
  }
}

const NO_TXS: TxView[] = [];
const NO_BANKS: AccountsResponse = { plaidConfigured: false, items: [] };

/** The month to open on: this one, or the newest with activity if this one is empty. */
function defaultMonth(txs: TxView[]): string {
  const current = todayLocal().slice(0, 7);
  if (txs.length === 0 || txs.some((t) => t.date.startsWith(current))) return current;
  return txs[0].date.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MoneyPage() {
  const txQuery = useQuery(transactionsQuery);
  const bankQuery = useQuery(accountsQuery);
  const refreshAll = useRefreshAll();
  const txs = txQuery.data ?? NO_TXS;
  const banks = bankQuery.data ?? NO_BANKS;
  const loadError = txQuery.error ?? bankQuery.error;
  const loadState = loadError ? "error" : txQuery.data && bankQuery.data ? "ready" : "loading";

  // Restored when coming back to the page; only a saved month brings filters
  const [saved] = useState(readMoneyState);
  const [pickedMonth, setPickedMonth] = useState<string | null>(saved?.month ?? null);
  const [query, setQuery] = useState(saved?.month ? (saved.query ?? "") : "");
  const [category, setCategory] = useState<string | null>(saved?.month ? (saved.category ?? null) : null);
  const [show, setShow] = useState<Show>(saved?.month ? (saved.show ?? "all") : "all");
  const [showAllCategories, setShowAllCategories] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const month = pickedMonth ?? defaultMonth(txs);

  // Save only once loaded, so the defaults never overwrite what was restored
  useEffect(() => {
    if (loadState !== "ready") return;
    const state: SavedMoneyState = { month, query, category, show };
    try {
      sessionStorage.setItem(MONEY_STATE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or disabled; remembering is a nicety, so ignore
    }
  }, [loadState, month, query, category, show]);

  // "/" jumps to search, like on Splits
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const accounts = useMemo(() => indexAccounts(banks.items), [banks.items]);
  const summary = useMemo(
    () =>
      summarizeMonth(
        txs.map((t) => ({ ...t, owedBackCents: t.split?.owedBackCents ?? 0 })),
        month
      ),
    [txs, month]
  );
  const net = useMemo(() => netBalance(banks.items.flatMap((i) => i.accounts)), [banks.items]);
  const thisMonth = todayLocal().slice(0, 7);
  const oldestMonth = txs.at(-1)?.date.slice(0, 7) ?? thisMonth;

  // Searching looks across every month; otherwise the list follows the month
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      txs.filter((t) => {
        if (q) {
          const hay = `${t.merchantName ?? ""} ${t.name}`.toLowerCase();
          if (!hay.includes(q)) return false;
        } else if (!t.date.startsWith(month)) return false;
        if (category && t.categoryPrimary !== category) return false;
        if (show === "spending" && !isSpending(t)) return false;
        if (show === "unsplit" && (!isSpending(t) || t.split)) return false;
        if (show === "in" && (t.amount >= 0 || isMoneyMoving(t))) return false;
        return true;
      }),
    [txs, q, month, category, show]
  );

  const maxCategory = summary.byCategory[0]?.cents ?? 0;
  const categories = showAllCategories ? summary.byCategory : summary.byCategory.slice(0, 6);
  const hasBanks = banks.items.length > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-9">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="space-y-4">
        <h1 className="font-display text-6xl sm:text-7xl uppercase">Money</h1>
        {loadState === "ready" && (
          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/transactions/new">
              <Button variant="primary">+ Add expense</Button>
            </Link>
            {hasBanks && (
              <SyncButton onSynced={refreshAll} />
            )}
          </div>
        )}
      </header>

      {loadState === "loading" && <p className="text-sm text-ink-faint">Loading…</p>}

      {loadState === "error" && (
        <div
          className="flex items-center gap-3 text-sm text-danger bg-danger-dim border border-danger rounded-3xl px-5 py-4"
          role="alert"
        >
          <span className="flex-1">{loadError?.message}</span>
          <Button variant="danger" size="sm" onClick={() => refreshAll()}>
            Retry
          </Button>
        </div>
      )}

      {/* ── First run ───────────────────────────────────────────────────── */}
      {loadState === "ready" && txs.length === 0 && (
        <div className="rounded-3xl border border-ink bg-sky px-6 py-12 text-center">
          <p className="font-display text-4xl uppercase">Track your money</p>
          <div className="mt-6 flex justify-center gap-2 flex-wrap">
            <Link href="/accounts">
              <Button variant="primary">Link a bank</Button>
            </Link>
            <Link href="/transactions/new">
              <Button variant="secondary">Add expense</Button>
            </Link>
          </div>
        </div>
      )}

      {loadState === "ready" && txs.length > 0 && (
        <>
          {/* ── Month summary ─────────────────────────────────────────────── */}
          <section aria-label={`Summary for ${monthName(month)}`} className="space-y-3">
            <div className="rounded-3xl border border-ink bg-sky px-6 pt-4 pb-6">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setPickedMonth(shiftMonth(month, -1))}
                  disabled={month <= oldestMonth}
                  aria-label="Previous month"
                  className="w-9 h-9 inline-flex items-center justify-center rounded-full border border-ink bg-surface hover:bg-sun disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <Chevron direction="left" className="w-4 h-4" />
                </button>
                <p className="text-sm font-semibold">{monthName(month)}</p>
                <button
                  type="button"
                  onClick={() => setPickedMonth(shiftMonth(month, 1))}
                  disabled={month >= thisMonth}
                  aria-label="Next month"
                  className="w-9 h-9 inline-flex items-center justify-center rounded-full border border-ink bg-surface hover:bg-sun disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <Chevron direction="right" className="w-4 h-4" />
                </button>
              </div>

              <p className="mt-4 text-sm font-semibold">Spent</p>
              <p className="font-display text-7xl sm:text-8xl tabular-nums leading-none">
                {formatUSD(summary.spentCents)}
              </p>
              {summary.owedBackCents > 0 && (
                <dl className="mt-4 flex gap-8">
                  <div>
                    <dt className="text-sm font-semibold">Owed to you</dt>
                    <dd className="mt-1 font-display text-3xl tabular-nums">{formatUSD(summary.owedBackCents)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-semibold">Your share</dt>
                    <dd className="mt-1 font-display text-3xl tabular-nums">{formatUSD(summary.yourShareCents)}</dd>
                  </div>
                </dl>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-3xl border border-ink bg-mint-dim px-5 py-4">
                <p className="text-sm font-semibold">Money in</p>
                <p className="mt-1 font-display text-3xl sm:text-4xl tabular-nums">
                  {formatUSD(summary.incomeCents)}
                </p>
              </div>
              <Link
                href="/accounts"
                className="group rounded-3xl border border-ink bg-lavender px-5 py-4 transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sun"
              >
                <p className="text-sm font-semibold flex justify-between">
                  Net balance
                  <span className="transition-transform group-hover:translate-x-0.5">
                    <Chevron direction="right" className="w-4 h-4" />
                  </span>
                </p>
                <p className="mt-1 font-display text-3xl sm:text-4xl tabular-nums">
                  {hasBanks ? formatUSD(net) : "—"}
                </p>
              </Link>
            </div>
          </section>

          {/* ── Where it went ─────────────────────────────────────────────── */}
          {summary.byCategory.length > 0 && (
            <section aria-labelledby="where-heading" className="space-y-3">
              <h2 id="where-heading" className="px-1 text-sm font-semibold text-ink-muted">
                Where it went
              </h2>
              <ul className="rounded-3xl border border-ink divide-y divide-rim overflow-hidden">
                {categories.map(({ category: c, cents }) => {
                  const on = category === c;
                  return (
                    <li key={c ?? "none"}>
                      <button
                        type="button"
                        onClick={() => setCategory(on ? null : c)}
                        aria-pressed={on}
                        className={[
                          "w-full grid grid-cols-[7.5rem_1fr_auto] sm:grid-cols-[10rem_1fr_6.5rem] items-center gap-3 px-5 py-3 text-left transition-colors",
                          on ? "bg-sun/40" : "bg-surface hover:bg-mist",
                        ].join(" ")}
                      >
                        <span className="text-sm font-semibold truncate">{categoryLabel(c)}</span>
                        <span className="h-3.5 rounded-full bg-mist overflow-hidden">
                          <span
                            className="block h-full rounded-full border border-ink"
                            style={{
                              width: `${Math.max(4, (cents / maxCategory) * 100)}%`,
                              backgroundColor: categoryColor(c),
                            }}
                          />
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-right">{formatUSD(cents)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {summary.byCategory.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAllCategories((v) => !v)}
                  className="tap-area px-1 text-sm font-semibold text-ink-muted underline underline-offset-4 hover:text-ink"
                >
                  {showAllCategories ? "Show fewer" : `Show all ${summary.byCategory.length}`}
                </button>
              )}
            </section>
          )}

          {/* ── Transactions ──────────────────────────────────────────────── */}
          <section aria-label="Transactions" className="space-y-3">
            <div className="relative">
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="M13 13l4 4" strokeLinecap="round" />
              </svg>
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search all transactions"
                aria-label="Search transactions by name"
                className="pl-10 sm:pr-12"
              />
              {!query && (
                <kbd
                  aria-hidden="true"
                  className="hidden sm:flex absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 items-center justify-center rounded-md border border-rim text-xs font-semibold text-ink-muted pointer-events-none"
                >
                  /
                </kbd>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Show">
              {SHOW_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={show === value}
                  onClick={() => setShow(value)}
                  className={[
                    "h-8 px-3.5 rounded-full border border-ink text-sm font-semibold transition-colors",
                    show === value ? "bg-ink text-white" : "bg-surface hover:bg-sun",
                  ].join(" ")}
                >
                  {label}
                </button>
              ))}
              {category !== null && (
                <button
                  type="button"
                  onClick={() => setCategory(null)}
                  className="h-8 pl-3.5 pr-2.5 rounded-full border border-ink bg-sun text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-surface transition-colors"
                  aria-label={`Remove filter ${categoryLabel(category)}`}
                >
                  {categoryLabel(category)}
                  <span aria-hidden="true" className="text-base leading-none">×</span>
                </button>
              )}
            </div>

            <p className="px-1 pt-2 text-sm font-semibold text-ink-muted">
              {q
                ? `${visible.length} match${visible.length === 1 ? "" : "es"} across all months`
                : `${monthName(month, false)} · ${visible.length} transaction${visible.length === 1 ? "" : "s"}`}
            </p>

            {visible.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-ink px-6 py-10 text-center">
                <p className="font-display text-3xl uppercase">
                  {q || category || show !== "all" ? "No matches" : `Nothing in ${monthName(month, false)}`}
                </p>
                {(q || category || show !== "all") && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setCategory(null);
                      setShow("all");
                    }}
                    className="mt-3 text-sm font-semibold underline underline-offset-4"
                  >
                    Clear search and filters
                  </button>
                )}
              </div>
            ) : (
              <ul className="rounded-3xl border border-ink overflow-hidden divide-y divide-rim">
                {visible.map((t, i) => (
                  <TxRow
                    key={t.id}
                    tx={t}
                    index={i}
                    account={t.accountId != null ? accounts.get(t.accountId) : undefined}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function TxRow({
  tx,
  index,
  account,
}: {
  tx: TxView;
  index: number;
  account: AccountRef | undefined;
}) {
  const day = localDate(tx.date);
  const label = txLabel(tx);
  const moving = isMoneyMoving(tx);
  const moneyIn = tx.amount < 0;
  const canSplit = isSpending(tx) && !tx.split;

  return (
    <li
      className="rise flex items-center gap-3 pl-4 pr-3 bg-surface hover:bg-mist transition-colors"
      style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
    >
      <Link href={`/transactions/${tx.id}`} className="flex-1 min-w-0 flex items-center gap-3.5 py-3.5">
        {/* Date */}
        <div className="w-9 shrink-0 text-center leading-none">
          <p className="font-display text-[26px] tabular-nums">{day.getDate()}</p>
          <p className="mt-1 text-[11px] font-semibold uppercase text-ink-muted">
            {day.toLocaleDateString("en-US", { month: "short" })}
          </p>
        </div>

        {/* The bank is also named in the meta line, so phones skip the logo */}
        <span className="hidden sm:inline-flex">
          <BankLogo item={account?.item} />
        </span>

        {/* Label + meta */}
        <div className="flex-1 min-w-0">
          <p className={`font-semibold truncate ${moving ? "text-ink-muted" : ""}`}>{label}</p>
          <p className="mt-0.5 text-sm text-ink-muted truncate">
            {categoryLabel(tx.categoryPrimary)} · {accountLabel(account)}
            {tx.pending && " · Pending"}
          </p>
        </div>

        {/* Amount + split state */}
        <div className="shrink-0 text-right">
          <p
            className={[
              "font-semibold tabular-nums",
              moneyIn && !moving ? "text-income" : moving ? "text-ink-muted" : "",
            ].join(" ")}
          >
            {moneyIn ? `+${formatUSD(-tx.amount)}` : formatUSD(tx.amount)}
          </p>
          {tx.split && (
            <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-mint-dim border border-mint px-2 py-0.5 text-xs font-semibold">
              Split {tx.split.ways} ways · {formatUSD(tx.split.owedBackCents)} back
            </p>
          )}
        </div>
      </Link>

      {canSplit && (
        <Link
          href={`/expenses/new?fromTx=${tx.id}`}
          aria-label={`Split ${label}`}
          className="shrink-0 h-8 px-3 rounded-full border border-ink text-sm font-semibold inline-flex items-center hover:bg-sun transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sun"
        >
          Split
        </Link>
      )}
    </li>
  );
}
