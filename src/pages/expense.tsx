import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { expenseQuery, isNotFound, peopleQuery, useRefreshAll } from "../queries";
import { Chevron } from "@/components/Chevron";
import { ChargePicker, ChargeTotal, chargeAccountLabel, shortDate, type ExpenseCharge } from "@/components/ChargePicker";
import Link, { useGoTo, useRouteParam } from "@/components/Link";
import { Button } from "@/components/ui/Button";
import { BackLink } from "@/components/BackLink";
import { CopyButton } from "@/components/CopyButton";
import { DeleteSection } from "@/components/DeleteSection";
import { PersonChip } from "@/components/PersonChip";
import { TagPicker } from "@/components/TagPicker";
import { formatUSD } from "@/lib/money";
import { expenseDay } from "@/lib/expense-filter";
import { txLabel } from "@/lib/transactions";
import { apiFetch } from "../api";

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

interface Expense {
  id: string;
  type: "ITEMIZED" | "SIMPLE";
  description: string | null;
  store: string | null;
  purchasedAt: string | null;
  totalCents: number;
  payerId: string;
  payer: Person;
  loggedToSplitwise: boolean;
  createdAt: string;
  splitMethod: "EVEN" | "EXACT" | "ITEMIZED";
  taxCents: number;
  tipFeesCents: number;
  discountCents: number;
  refundCents: number;
  items: {
    id: string;
    name: string;
    quantity: number;
    lineTotalCents: number;
    returned: boolean;
    assignments: { personId: string }[];
  }[];
  tags: string[];
  /** The card charges that paid for this split, oldest first */
  charges: ExpenseCharge[];
  breakdown: {
    payerId: string;
    perPerson: { personId: string; cents: number }[];
    owes: { personId: string; cents: number }[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** day is YYYY-MM-DD; read as a local date so it never shifts a day */
function formatDate(day: string): string {
  return new Date(`${day}T00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const NO_PEOPLE: Person[] = [];
const NO_TAGS: string[] = [];

export default function ExpenseDetailPage() {
  const id = useRouteParam("id");
  const goTo = useGoTo();

  const client = useQueryClient();
  const refreshAll = useRefreshAll();
  const expenseKey = expenseQuery<Expense>(id).queryKey;
  const expenseResult = useQuery(expenseQuery<Expense>(id));
  // People only fill in names; if they fail, the split still shows
  const peopleResult = useQuery(peopleQuery);
  const expense = expenseResult.data ?? null;
  const people = peopleResult.data ?? NO_PEOPLE;
  const loadError = expenseResult.error;
  const loadState = isNotFound(loadError)
    ? "notfound"
    : loadError
      ? "error"
      : expense && !peopleResult.isLoading
        ? "ready"
        : "loading";

  // Logged and tags save as soon as they change, shown before the save lands
  const logged = expense?.loggedToSplitwise ?? false;
  const [logPending, setLogPending] = useState(false);
  const tags = expense?.tags ?? NO_TAGS;

  /** Writes a change into the cached split, for showing it before the save lands. */
  function patchCached(change: Partial<Expense>) {
    client.setQueryData<Expense>(expenseKey, (e) => (e ? { ...e, ...change } : e));
  }

  const [pickingCharges, setPickingCharges] = useState(false);

  // Delete state
  const [deleting, setDeleting] = useState(false);

  const personById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people]
  );

  // ---------------------------------------------------------------------------
  // Mark logged toggle
  // ---------------------------------------------------------------------------

  async function handleToggleLogged() {
    if (!expense || logPending) return;
    const newVal = !logged;
    patchCached({ loggedToSplitwise: newVal }); // optimistic
    setLogPending(true);
    try {
      const res = await apiFetch(`/api/expenses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loggedToSplitwise: newVal }),
      });
      if (!res.ok) throw new Error();
      refreshAll(); // the Splits list and the charge show it too
    } catch {
      patchCached({ loggedToSplitwise: !newVal }); // revert
      toast.error("Couldn’t update Splitwise status. Try again.");
    } finally {
      setLogPending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------

  async function handleTagsChange(next: string[]) {
    const prev = tags;
    patchCached({ tags: next }); // optimistic
    try {
      const res = await apiFetch(`/api/expenses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
      if (!res.ok) throw new Error();
      const saved = (await res.json()) as { tags: string[] };
      patchCached({ tags: saved.tags });
      refreshAll();
    } catch {
      patchCached({ tags: prev }); // revert
      toast.error("Couldn’t save tags. Try again.");
    }
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  async function handleDelete() {
    if (!expense || deleting) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/expenses/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Error ${res.status}`
        );
      }
      goTo(expense.charges.length > 0 ? `/transactions/${expense.charges[0].id}` : "/splits");
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Copy summary
  // ---------------------------------------------------------------------------

  const copySummary = useMemo(() => {
    if (!expense) return "";
    const label = expense.store ?? expense.description ?? "Expense";
    const payerName = expense.payer?.name ?? "Unknown";
    const header = `${label} — ${formatUSD(expense.totalCents)} (paid by ${payerName})`;
    const lines = expense.breakdown.owes.map(({ personId, cents }) => {
      const person =
        personById.get(personId) ??
        (expense.payer?.id === personId ? expense.payer : undefined);
      const name = person?.name ?? personId.slice(0, 8);
      return `${name} owes ${payerName} ${formatUSD(cents)}`;
    });
    return [header, ...lines].join("\n");
  }, [expense, personById]);

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (loadState === "loading") {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-ink-faint">Loading…</p>
      </div>
    );
  }

  if (loadState === "notfound") {
    return (
      <div className="py-16 space-y-4 text-center">
        <p className="font-display text-4xl uppercase">Expense not found</p>
        <Link href="/splits">
          <Button variant="secondary">Back to splits</Button>
        </Link>
      </div>
    );
  }

  if (loadState === "error" || !expense) {
    return (
      <div className="py-8 space-y-4">
        <p
          className="text-sm text-danger bg-danger-dim border border-danger rounded-3xl px-5 py-4"
          role="alert"
        >
          {loadError?.message ?? "Something went wrong."}
        </p>
        <Link href="/splits">
          <Button variant="secondary">Back to splits</Button>
        </Link>
      </div>
    );
  }

  const label = expense.store ?? expense.description ?? "Expense";
  const payerName = expense.payer?.name ?? "Unknown";

  // Resolve a person by ID — graceful for archived/missing
  function resolvePerson(personId: string): Person | undefined {
    if (expense!.payer?.id === personId) return expense!.payer;
    return personById.get(personId);
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  const editHref = `/expenses/new/${expense.type === "ITEMIZED" ? "itemized" : "simple"}?edit=${expense.id}`;

  return (
    <div className="space-y-8">
      <BackLink href="/splits" label="Back to Splits" />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header>
        <p className="text-sm font-semibold text-ink-muted">
          {formatDate(expenseDay(expense))} · {expense.type === "ITEMIZED" ? "Receipt" : "Quick split"}
        </p>
        <h1 className="mt-2 font-display text-5xl sm:text-6xl uppercase break-words">{label}</h1>
        <div className="mt-5 flex items-end gap-4 flex-wrap">
          <p className="font-display text-7xl sm:text-8xl tabular-nums leading-none">
            {formatUSD(expense.totalCents)}
          </p>
          <div className="pb-1.5 flex items-center gap-2 text-sm text-ink-muted">
            paid by
            {expense.payer ? (
              <PersonChip name={expense.payer.name} colorHex={expense.payer.colorHex} size="sm" readOnly />
            ) : (
              <span className="text-ink font-semibold">{payerName}</span>
            )}
          </div>
        </div>
      </header>

      {/* ── Charges ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="charges-heading" className="space-y-2">
        <h2 id="charges-heading" className="px-1 text-sm font-semibold text-ink-muted">
          Charges
        </h2>
        {pickingCharges ? (
          <ChargePicker
            expenseId={expense.id}
            store={expense.store}
            day={expenseDay(expense)}
            totalCents={expense.totalCents}
            linked={expense.charges}
            onClose={() => setPickingCharges(false)}
          />
        ) : (
          <div className="space-y-3">
            {expense.charges.length === 0 ? (
              <p className="px-1 text-sm text-ink-muted">Not linked to a card charge</p>
            ) : (
              <>
                <ul className="rounded-3xl border border-ink bg-mist divide-y divide-rim overflow-hidden">
                  {expense.charges.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/transactions/${c.id}`}
                        className="flex items-center gap-3 px-5 py-3 hover:bg-sun/40 transition-colors"
                      >
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-sm font-semibold">{txLabel(c)}</span>
                          <span className="block truncate text-xs text-ink-muted">
                            {chargeAccountLabel(c.account)} · {shortDate(c.date)}
                          </span>
                        </span>
                        <span className="text-sm tabular-nums">{formatUSD(c.amount)}</span>
                        <Chevron direction="right" className="w-4 h-4 shrink-0" />
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="px-1">
                  <ChargeTotal amounts={expense.charges.map((c) => c.amount)} totalCents={expense.totalCents} />
                </div>
              </>
            )}
            <Button variant="secondary" size="sm" onClick={() => setPickingCharges(true)}>
              {expense.charges.length > 0 ? "Edit charges" : "Link charges"}
            </Button>
          </div>
        )}
      </section>

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link href={editHref}>
          <Button variant="primary" size="sm">Edit</Button>
        </Link>
        <button
          type="button"
          onClick={handleToggleLogged}
          disabled={logPending}
          aria-pressed={logged}
          className={[
            "h-8 px-3.5 rounded-full border border-ink text-sm font-semibold transition-colors",
            "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sun disabled:opacity-50",
            logged ? "bg-mint hover:bg-mint-dim" : "bg-surface hover:bg-sun",
          ].join(" ")}
        >
          {logged ? "✓ Logged in Splitwise" : "Mark as logged"}
        </button>
        <CopyButton summary={copySummary} />
      </div>

      {/* ── Who owes what ───────────────────────────────────────────────── */}
      <section aria-labelledby="owes-heading">
        <h2 id="owes-heading" className="px-1 pb-2 text-sm font-semibold text-ink-muted">
          Who owes what
        </h2>
        <ul className="rounded-3xl border border-ink divide-y divide-rim overflow-hidden">
          {expense.breakdown.perPerson
            .slice()
            .sort((a, b) => Number(a.personId === expense.payerId) - Number(b.personId === expense.payerId))
            .map(({ personId, cents }) => {
              const person = resolvePerson(personId);
              const name = person?.name ?? personId.slice(0, 8);
              const isPayer = personId === expense.payerId;
              return (
                <li key={personId} className="flex items-center gap-3 px-5 py-3.5">
                  {person ? (
                    <PersonChip name={name} colorHex={person.colorHex} size="sm" readOnly />
                  ) : (
                    <span className="text-sm font-semibold">{name}</span>
                  )}
                  <span className="flex-1 text-sm text-ink-muted">
                    {isPayer ? "paid · their own share" : `owes ${payerName}`}
                  </span>
                  <span
                    className={[
                      "tabular-nums",
                      isPayer ? "text-sm text-ink-muted" : "font-display text-3xl",
                    ].join(" ")}
                  >
                    {formatUSD(cents)}
                  </span>
                </li>
              );
            })}
        </ul>
      </section>

      {/* ── Items (receipts only) ───────────────────────────────────────── */}
      {expense.type === "ITEMIZED" && expense.items.length > 0 && (
        <section aria-labelledby="items-heading">
          <h2 id="items-heading" className="px-1 pb-2 text-sm font-semibold text-ink-muted">
            Items · {expense.items.length}
          </h2>
          <ul className="rounded-3xl border border-ink divide-y divide-rim overflow-hidden">
            {expense.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {item.name}
                    {item.returned && <span className="font-normal text-ink-muted"> · Returned</span>}
                    {item.quantity !== 1 && (
                      <span className="font-normal text-ink-muted"> × {item.quantity}</span>
                    )}
                  </p>
                  <p className="text-xs text-ink-muted truncate">
                    {item.assignments.length === expense.breakdown.perPerson.length &&
                    expense.breakdown.perPerson.length > 1
                      ? "Everyone"
                      : item.assignments
                          .map((a) => resolvePerson(a.personId)?.name ?? "?")
                          .join(", ")}
                  </p>
                </div>
                <span className="text-sm tabular-nums">{formatUSD(item.lineTotalCents)}</span>
              </li>
            ))}
            {expense.taxCents > 0 && (
              <li className="flex items-center gap-3 px-5 py-3 bg-mist">
                <p className="flex-1 text-sm text-ink-muted">Tax, split by each person&apos;s items</p>
                <span className="text-sm tabular-nums">{formatUSD(expense.taxCents)}</span>
              </li>
            )}
            {[
              { label: "Tip & fees", cents: expense.tipFeesCents },
              { label: "Discounts", cents: expense.discountCents },
              { label: "Refunds", cents: expense.refundCents },
            ]
              .filter((c) => c.cents !== 0)
              .map((c) => (
                <li key={c.label} className="flex items-center gap-3 px-5 py-3 bg-mist">
                  <p className="flex-1 text-sm text-ink-muted">{c.label}</p>
                  <span className="text-sm tabular-nums">{formatUSD(c.cents)}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* ── Tags ────────────────────────────────────────────────────────── */}
      <section aria-labelledby="tags-heading" className="space-y-2">
        <h2 id="tags-heading" className="px-1 text-sm font-semibold text-ink-muted">
          Tags
        </h2>
        <TagPicker value={tags} onChange={handleTagsChange} />
      </section>

      <DeleteSection
        label="Delete split"
        question="Delete for good?"
        deleting={deleting}
        onDelete={handleDelete}
      />
    </div>
  );
}
