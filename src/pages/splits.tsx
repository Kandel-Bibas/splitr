import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { expensesQuery, peopleQuery, tagsQuery, useRefreshAll } from "../queries";
import Link from "@/components/Link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { SelectionBar } from "@/components/SelectionBar";
import { PersonChip } from "@/components/PersonChip";
import { formatUSD } from "@/lib/money";
import { settleExpenses } from "@/lib/settle";
import { apiFetch } from "../api";
import {
  filterExpenses,
  expenseDay,
  NO_FILTERS,
  type ExpenseFilters,
} from "@/lib/expense-filter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Person {
  id: string;
  name: string;
  colorHex: string;
  isDefault: boolean;
  archived: boolean;
}

interface ExpenseListItem {
  id: string;
  type: "ITEMIZED" | "SIMPLE";
  description: string | null;
  store: string | null;
  totalCents: number;
  payerId: string;
  payer: Person;
  loggedToSplitwise: boolean;
  purchasedAt: string | null;
  createdAt: string;
  tags: string[];
  itemNames: string[];
  breakdown: {
    perPerson: { personId: string; cents: number }[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** day is YYYY-MM-DD; read as a local date so it never shifts a day */
function localDate(day: string): Date {
  return new Date(`${day}T00:00`);
}

function shortDate(day: string): string {
  return localDate(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function monthLabel(day: string): string {
  return localDate(day).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

const NO_EXPENSES: ExpenseListItem[] = [];
const NO_PEOPLE: Person[] = [];

// Filters, the open panel, and ticks survive opening an expense and coming
// back. sessionStorage lasts as long as the browser tab.
const HOME_STATE_KEY = "splitr.home";

interface SavedHomeState {
  filters: ExpenseFilters;
  filtersOpen: boolean;
  selectedIds: string[];
}

function readHomeState(): SavedHomeState | null {
  try {
    const raw = sessionStorage.getItem(HOME_STATE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedHomeState>;
    return {
      // Spread over the defaults so a state saved by an older version still works
      filters: { ...NO_FILTERS, ...saved.filters },
      filtersOpen: saved.filtersOpen === true,
      selectedIds: Array.isArray(saved.selectedIds) ? saved.selectedIds : [],
    };
  } catch {
    return null;
  }
}

/** A round tick box; a real button so it works with the keyboard */
function Tick({
  checked,
  onToggle,
  label,
}: {
  checked: boolean | "mixed";
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={[
        "tap-area w-6 h-6 shrink-0 rounded-full border border-ink inline-flex items-center justify-center text-xs font-bold transition-colors",
        "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sun",
        checked ? "bg-ink text-white" : "bg-surface text-transparent hover:bg-sun",
      ].join(" ")}
    >
      {checked === "mixed" ? "–" : "✓"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SplitsPage() {
  const expensesResult = useQuery(expensesQuery<ExpenseListItem>());
  // People and tags are extras here: if they fail, the list still shows
  const peopleResult = useQuery(peopleQuery);
  const tagsResult = useQuery(tagsQuery);
  const refreshAll = useRefreshAll();
  const expenses = expensesResult.data ?? NO_EXPENSES;
  const people = peopleResult.data ?? NO_PEOPLE;
  const loadError = expensesResult.error;
  const loadState = loadError ? "error" : expensesResult.data ? "ready" : "loading";

  // Restored when coming back to the page
  const [saved] = useState(readHomeState);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(saved?.selectedIds));
  const [filters, setFilters] = useState<ExpenseFilters>(saved?.filters ?? NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(saved?.filtersOpen ?? false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Every tag on the Tags page (for bulk tagging), not just ones in use
  const tagList = useMemo(() => (tagsResult.data ?? []).map((t) => t.name), [tagsResult.data]);

  const personById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people]
  );

  const allTags = useMemo(
    () => [...new Set(expenses.flatMap((e) => e.tags))].sort(),
    [expenses],
  );
  const visible = useMemo(
    () => filterExpenses(expenses, filters),
    [expenses, filters]
  );
  // Only ticked expenses that are currently shown count toward the bar
  const selectedExpenses = useMemo(
    () => visible.map((m) => m.expense).filter((e) => selectedIds.has(e.id)),
    [visible, selectedIds]
  );
  const debts = useMemo(
    () =>
      settleExpenses(
        selectedExpenses.map((e) => ({
          payerId: e.payerId,
          perPerson: e.breakdown.perPerson,
        }))
      ),
    [selectedExpenses]
  );

  const totalCents = expenses.reduce((sum, e) => sum + e.totalCents, 0);
  const notLogged = expenses.filter((e) => !e.loggedToSplitwise).length;

  // Visible expenses grouped under month headings (already newest first)
  const groups = useMemo(() => {
    const out: { month: string; rows: typeof visible }[] = [];
    for (const m of visible) {
      const month = monthLabel(expenseDay(m.expense));
      if (out.at(-1)?.month !== month) out.push({ month, rows: [] });
      out.at(-1)!.rows.push(m);
    }
    return out;
  }, [visible]);

  const allVisibleSelected =
    visible.length > 0 && selectedExpenses.length === visible.length;

  // Removable pills describing the active filters (search lives in its box)
  const activePills: { key: string; label: string; clear: () => void }[] = [];
  if (filters.from || filters.to) {
    activePills.push({
      key: "dates",
      label: `${filters.from ? shortDate(filters.from) : "Start"} – ${filters.to ? shortDate(filters.to) : "now"}`,
      clear: () => setFilters((f) => ({ ...f, from: "", to: "" })),
    });
  }
  for (const id of filters.personIds) {
    activePills.push({
      key: `person-${id}`,
      label: `With ${personName(id)}`,
      clear: () => toggleIn("personIds", id),
    });
  }
  for (const id of filters.payerIds) {
    activePills.push({
      key: `payer-${id}`,
      label: `Paid by ${personName(id)}`,
      clear: () => toggleIn("payerIds", id),
    });
  }
  if (filters.logged !== "all") {
    activePills.push({
      key: "logged",
      label: filters.logged === "logged" ? "Logged" : "Not logged",
      clear: () => setFilter("logged", "all"),
    });
  }
  for (const tag of filters.tags) {
    activePills.push({ key: `tag-${tag}`, label: `#${tag}`, clear: () => toggleFilterTag(tag) });
  }
  const filterCount = activePills.length;

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(
      allVisibleSelected ? new Set() : new Set(visible.map((m) => m.expense.id))
    );
  }

  function setFilter<K extends keyof ExpenseFilters>(key: K, value: ExpenseFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  /** Adds or removes one value in a list-valued filter */
  function toggleIn(key: "tags" | "personIds" | "payerIds", value: string) {
    setFilters((prev) => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter((v) => v !== value)
        : [...prev[key], value],
    }));
  }

  function toggleFilterTag(tag: string) {
    toggleIn("tags", tag);
  }

  /** Runs a bulk action on the ticked expenses, then reloads the list */
  async function runBulk(action: Record<string, unknown>) {
    const ids = selectedExpenses.map((e) => e.id);
    const res = await apiFetch("/api/expenses/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, ...action }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `Error ${res.status}`);
    }
    if (action.action === "delete") setSelectedIds(new Set());
    await refreshAll();
  }

  function personName(id: string): string {
    return personById.get(id)?.name ?? id.slice(0, 6);
  }

  // "/" jumps to search; Esc closes the filter panel (the selection bar
  // handles Esc itself while anything is ticked)
  const hasSelection = selectedExpenses.length > 0;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing =
        target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && !hasSelection) {
        setFiltersOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasSelection]);

  // Save only once loaded, so the defaults never overwrite what was restored
  useEffect(() => {
    if (loadState !== "ready") return;
    const state: SavedHomeState = { filters, filtersOpen, selectedIds: [...selectedIds] };
    try {
      sessionStorage.setItem(HOME_STATE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or disabled; remembering is a nicety, so ignore
    }
  }, [loadState, filters, filtersOpen, selectedIds]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-8">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header>
        <h1 className="font-display text-6xl sm:text-7xl uppercase">Splits</h1>
        {loadState === "ready" && expenses.length > 0 && (
          <p className="mt-3 text-sm text-ink-muted">
            {expenses.length} expense{expenses.length === 1 ? "" : "s"} ·{" "}
            <span className="text-ink font-semibold tabular-nums">{formatUSD(totalCents)}</span>
            {notLogged > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setFilter("logged", "not-logged")}
                  className="tap-area underline underline-offset-4 hover:text-ink"
                >
                  {notLogged} not in Splitwise yet
                </button>
              </>
            )}
          </p>
        )}
      </header>

      {/* ── Loading / error ─────────────────────────────────────────────── */}
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

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {loadState === "ready" && expenses.length === 0 && (
        <div className="rounded-3xl border border-ink bg-sky px-6 py-12 text-center">
          <p className="font-display text-4xl uppercase">Nothing to split yet</p>
          <Link href="/expenses/new" className="inline-block mt-6">
            <Button variant="primary">+ New split</Button>
          </Link>
        </div>
      )}

      {/* ── Search + filters ────────────────────────────────────────────── */}
      {loadState === "ready" && expenses.length > 0 && (
        <section className="space-y-3" aria-label="Search and filter">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
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
                value={filters.query}
                onChange={(e) => setFilter("query", e.target.value)}
                placeholder="Search expenses or items"
                aria-label="Search expenses and items by name"
                className="pl-10 sm:pr-12"
              />
              {!filters.query && (
                <kbd
                  aria-hidden="true"
                  className="hidden sm:flex absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 items-center justify-center rounded-md border border-rim text-xs font-semibold text-ink-muted pointer-events-none"
                >
                  /
                </kbd>
              )}
            </div>
            <Button
              variant={filtersOpen ? "primary" : "secondary"}
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
            >
              Filter{filterCount > 0 ? ` · ${filterCount}` : ""}
            </Button>
          </div>

          {filtersOpen && (
            <div className="rise rounded-3xl border border-ink bg-mist p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5 text-xs font-semibold">
                  From
                  <Input
                    type="date"
                    value={filters.from}
                    onChange={(e) => setFilter("from", e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs font-semibold">
                  To
                  <Input
                    type="date"
                    value={filters.to}
                    onChange={(e) => setFilter("to", e.target.value)}
                  />
                </label>
              </div>

              {(
                [
                  ["personIds", "Includes", "everyone picked"],
                  ["payerIds", "Paid by", "any of them"],
                ] as const
              ).map(([key, title, rule]) => (
                <div key={key} className="space-y-1.5">
                  <p className="text-xs font-semibold">
                    {title} <span className="font-normal text-ink-muted">· {rule}</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {people.map((p) => (
                      <PersonChip
                        key={p.id}
                        name={p.name}
                        colorHex={p.colorHex}
                        size="sm"
                        selected={filters[key].includes(p.id)}
                        onClick={() => toggleIn(key, p.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}

              <div className="space-y-1.5">
                <p className="text-xs font-semibold">Splitwise</p>
                <div className="flex gap-1.5">
                  {(
                    [
                      ["all", "All"],
                      ["not-logged", "Not logged"],
                      ["logged", "Logged"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setFilter("logged", value)}
                      aria-pressed={filters.logged === value}
                      className={[
                        "h-8 px-3.5 rounded-full border border-ink text-sm font-semibold transition-colors",
                        filters.logged === value ? "bg-ink text-white" : "bg-surface hover:bg-sun",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {allTags.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold">
                    Tags <span className="font-normal text-ink-muted">· any of them</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {allTags.map((tag) => {
                      const on = filters.tags.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => toggleFilterTag(tag)}
                          aria-pressed={on}
                          className={[
                            "h-8 px-3.5 rounded-full border border-ink text-sm font-semibold transition-colors",
                            on ? "bg-ink text-white" : "bg-surface hover:bg-sun",
                          ].join(" ")}
                        >
                          #{tag}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {activePills.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {activePills.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={p.clear}
                  className="h-8 pl-3.5 pr-2.5 rounded-full border border-ink bg-sun text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-surface transition-colors"
                  aria-label={`Remove filter ${p.label}`}
                >
                  {p.label}
                  <span aria-hidden="true" className="text-base leading-none">×</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...NO_FILTERS, query: f.query }))}
                className="tap-area h-8 px-2 text-sm font-semibold text-ink-muted underline underline-offset-4 hover:text-ink"
              >
                Clear all
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── Expense list ────────────────────────────────────────────────── */}
      {loadState === "ready" && expenses.length > 0 && visible.length === 0 && (
        <div className="rounded-3xl border border-dashed border-ink px-6 py-10 text-center">
          <p className="font-display text-3xl uppercase">No matches</p>
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className="mt-3 text-sm font-semibold underline underline-offset-4"
          >
            Clear search and filters
          </button>
        </div>
      )}

      {loadState === "ready" && visible.length > 0 && (
        <section aria-label="Expenses">
          <div className="flex items-center gap-3 px-4 pb-3">
            <Tick
              checked={allVisibleSelected ? true : selectedExpenses.length > 0 ? "mixed" : false}
              onToggle={toggleSelectAll}
              label={allVisibleSelected ? "Deselect all" : "Select all shown"}
            />
            <p className="text-sm text-ink-muted">
              {allVisibleSelected ? "All selected" : "Select all"}
              {filterCount > 0 || filters.query ? ` · ${visible.length} shown` : ""}
            </p>
          </div>

          <div className="space-y-6">
            {groups.map(({ month, rows }) => (
              <div key={month}>
                <h2 className="px-4 pb-2 text-sm font-semibold text-ink-muted">
                  {month}
                </h2>
                <ul className="rounded-3xl border border-ink overflow-hidden divide-y divide-rim">
                  {rows.map(({ expense: exp, matchedItems }, i) => {
                    const label = exp.store || exp.description || "Expense";
                    const payerName = exp.payer?.name ?? personName(exp.payerId);
                    const day = localDate(expenseDay(exp));
                    const selected = selectedIds.has(exp.id);
                    return (
                      <li
                        key={exp.id}
                        className={[
                          "rise flex items-center gap-3 pl-4 pr-2 transition-colors",
                          selected ? "bg-sun/40" : "bg-surface hover:bg-mist",
                        ].join(" ")}
                        style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
                      >
                        <Tick
                          checked={selected}
                          onToggle={() => toggleSelected(exp.id)}
                          label={`Select ${label}`}
                        />
                        <Link
                          href={`/expenses/${exp.id}`}
                          className="flex-1 min-w-0 flex items-center gap-4 py-3.5 pr-3"
                        >
                          {/* Date */}
                          <div className="w-10 shrink-0 text-center leading-none">
                            <p className="font-display text-[26px] tabular-nums">{day.getDate()}</p>
                            <p className="mt-1 text-[11px] font-semibold uppercase text-ink-muted">
                              {day.toLocaleDateString("en-US", { month: "short" })}
                            </p>
                          </div>

                          {/* Label + meta */}
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold truncate">{label}</p>
                            <p className="mt-0.5 text-sm text-ink-muted truncate">
                              {payerName} paid
                              {exp.breakdown.perPerson.length > 1 &&
                                ` · split ${exp.breakdown.perPerson.length} ways`}
                              {exp.tags.length > 0 && ` · ${exp.tags.map((t) => `#${t}`).join(" ")}`}
                            </p>
                            {matchedItems.length > 0 && (
                              <p className="mt-0.5 text-sm truncate">
                                <span className="bg-sun px-1 rounded">{matchedItems.join(", ")}</span>
                              </p>
                            )}
                          </div>

                          {/* Amount + status */}
                          <div className="shrink-0 text-right">
                            <p className="font-semibold tabular-nums">{formatUSD(exp.totalCents)}</p>
                            {exp.loggedToSplitwise && (
                              <p className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted">
                                <span className="w-2 h-2 rounded-full bg-mint" aria-hidden="true" />
                                Logged
                              </p>
                            )}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Selection bar ───────────────────────────────────────────────── */}
      {selectedExpenses.length > 0 && (
        <SelectionBar
          selected={selectedExpenses}
          debts={debts}
          tagList={tagList}
          personName={personName}
          onBulk={runBulk}
          onClear={() => setSelectedIds(new Set())}
        />
      )}
    </div>
  );
}
