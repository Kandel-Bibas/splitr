import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { BackLink } from "@/components/BackLink";
import Link, { useGoTo, useQueryString } from "@/components/Link";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { PersonChip } from "@/components/PersonChip";
import { TagPicker } from "@/components/TagPicker";
import { SaveBar } from "@/components/SaveBar";
import { Section } from "@/components/ui/Section";
import { toCents, formatUSD } from "@/lib/money";
import { splitSimpleEven, splitSimpleExact } from "@/lib/split";
import { expenseDay } from "@/lib/expense-filter";
import { txLabel, type TxView } from "@/lib/transactions";
import { loadExpenseToEdit, loadSourceTx, peopleQuery, queryClient, useRefreshAll } from "../queries";
import { apiFetch } from "../api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Person {
  id: string;
  name: string;
  colorHex: string;
  isDefault: boolean;
  isMe: boolean;
  archived: boolean;
}

type SplitMethod = "EVEN" | "EXACT";

/** The parts of GET /api/expenses/[id] this form needs when editing */
interface SavedExpense {
  type: "ITEMIZED" | "SIMPLE";
  description: string;
  purchasedAt: string | null;
  createdAt: string;
  totalCents: number;
  payerId: string;
  splitMethod: SplitMethod | "ITEMIZED";
  tags: string[];
  participants: { personId: string; exactAmountCents: number | null }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NewSimplePage() {
  // ?edit=<id> opens this form pre-filled to edit a saved expense;
  // ?fromTx=<id> pre-fills it from a charge in Money and links the two
  const { edit: editId, fromTx } = useQueryString<{ edit?: string; fromTx?: string }>();
  const goTo = useGoTo();
  const refreshAll = useRefreshAll();
  const [editLoadError, setEditLoadError] = useState<string | null>(null);
  const [sourceTx, setSourceTx] = useState<TxView | null>(null);

  // People
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(true);

  // Form state
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  // YYYY-MM-DD; defaults to today
  const [purchasedAt, setPurchasedAt] = useState(() =>
    expenseDay({ purchasedAt: null, createdAt: new Date().toISOString() })
  );
  const [amountDollars, setAmountDollars] = useState("");
  const [payerId, setPayerId] = useState("");
  const [participantIds, setParticipantIds] = useState<Set<string>>(new Set());
  const [splitMethod, setSplitMethod] = useState<SplitMethod>("EVEN");

  // Exact-split per-person inputs: personId → dollar string
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});

  // Save state
  const [saving, setSaving] = useState(false);

  // ---------------------------------------------------------------------------
  // Load people
  // ---------------------------------------------------------------------------

  // peopleLoading starts true, so the effect only has to settle it
  useEffect(() => {
    Promise.all([
      queryClient.fetchQuery(peopleQuery),
      editId ? loadExpenseToEdit<SavedExpense>(editId) : null,
      fromTx && !editId ? loadSourceTx(fromTx) : null,
    ])
      .then(([data, saved, tx]) => {
        setPeople(data);
        if (saved) {
          const active = new Set(data.map((p) => p.id));
          const involved = [saved.payerId, ...saved.participants.map((p) => p.personId)];
          if (saved.type !== "SIMPLE") throw new Error("This is not a simple expense.");
          if (!involved.every((id) => active.has(id))) {
            throw new Error("This expense includes an archived person, so it can't be edited.");
          }
          setDescription(saved.description);
          setTags(saved.tags);
          setPurchasedAt(expenseDay(saved));
          setAmountDollars((saved.totalCents / 100).toFixed(2));
          setPayerId(saved.payerId);
          setParticipantIds(new Set(saved.participants.map((p) => p.personId)));
          setSplitMethod(saved.splitMethod === "EXACT" ? "EXACT" : "EVEN");
          setExactAmounts(
            Object.fromEntries(
              saved.participants
                .filter((p) => p.exactAmountCents !== null)
                .map((p) => [p.personId, (p.exactAmountCents! / 100).toFixed(2)])
            )
          );
          return;
        }
        // Pre-check default (roommate) people
        const defaultIds = new Set(
          data.filter((p) => p.isDefault).map((p) => p.id)
        );
        if (tx) {
          setSourceTx(tx);
          setAmountDollars((tx.amount / 100).toFixed(2));
          setDescription(txLabel(tx));
          setPurchasedAt(tx.date);
          // It's your charge, so you paid and you're in on it
          const me = data.find((p) => p.isMe);
          if (me) {
            setPayerId(me.id);
            defaultIds.add(me.id);
          }
          setParticipantIds(defaultIds);
          return;
        }
        const def = data.find((p) => p.isDefault) ?? data[0];
        if (def) setPayerId(def.id);
        setParticipantIds(defaultIds.size > 0 ? defaultIds : new Set());
      })
      .catch((err) => {
        if (editId || fromTx) {
          setEditLoadError(err instanceof Error ? err.message : "Couldn't load the expense.");
        }
      })
      .finally(() => setPeopleLoading(false));
  }, [editId, fromTx]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const totalCents = useMemo(() => {
    const v = parseFloat(amountDollars);
    return isNaN(v) ? 0 : toCents(v);
  }, [amountDollars]);

  const participantList = useMemo(
    () => people.filter((p) => participantIds.has(p.id)),
    [people, participantIds]
  );

  // For EXACT: sum of entered amounts in cents
  const exactSumCents = useMemo(() => {
    if (splitMethod !== "EXACT") return 0;
    return participantList.reduce((sum, p) => {
      const v = parseFloat(exactAmounts[p.id] ?? "");
      return sum + (isNaN(v) ? 0 : toCents(v));
    }, 0);
  }, [splitMethod, participantList, exactAmounts]);

  const exactSumMatchesTotal =
    totalCents > 0 && exactSumCents === totalCents;

  const exactHasAllAmounts = participantList.every(
    (p) => !isNaN(parseFloat(exactAmounts[p.id] ?? ""))
  );

  // Live breakdown preview
  const liveBreakdown = useMemo(() => {
    if (participantList.length === 0 || totalCents === 0) return null;
    try {
      if (splitMethod === "EVEN") {
        return splitSimpleEven(
          totalCents,
          participantList.map((p) => p.id)
        );
      } else {
        if (!exactHasAllAmounts || !exactSumMatchesTotal) return null;
        return splitSimpleExact(
          totalCents,
          participantList.map((p) => ({
            personId: p.id,
            cents: toCents(parseFloat(exactAmounts[p.id])),
          }))
        );
      }
    } catch {
      return null;
    }
  }, [
    splitMethod,
    totalCents,
    participantList,
    exactAmounts,
    exactHasAllAmounts,
    exactSumMatchesTotal,
  ]);

  // Person lookup map
  const personById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people]
  );

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const canSave = useMemo(() => {
    if (saving) return false;
    if (!description.trim()) return false;
    if (totalCents <= 0) return false;
    if (!payerId) return false;
    if (participantList.length === 0) return false;
    if (splitMethod === "EXACT") {
      if (!exactHasAllAmounts) return false;
      if (!exactSumMatchesTotal) return false;
    }
    return true;
  }, [
    saving,
    description,
    totalCents,
    payerId,
    participantList,
    splitMethod,
    exactHasAllAmounts,
    exactSumMatchesTotal,
  ]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function toggleParticipant(id: string) {
    setParticipantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setExactAmount(personId: string, value: string) {
    setExactAmounts((prev) => ({ ...prev, [personId]: value }));
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);

    const payload = {
      type: "SIMPLE" as const,
      description: description.trim(),
      purchasedAt,
      tags,
      payerId,
      totalCents,
      splitMethod,
      ...(sourceTx && { transactionId: sourceTx.id }),
      participants: participantList.map((p) => ({
        personId: p.id,
        ...(splitMethod === "EXACT"
          ? { exactAmountCents: toCents(parseFloat(exactAmounts[p.id])) }
          : {}),
      })),
    };

    try {
      const res = await apiFetch(editId ? `/api/expenses/${editId}` : "/api/expenses", {
        method: editId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const { id } = (await res.json()) as { id: string };
        refreshAll();
        goTo(`/expenses/${id}`);
        return;
      }

      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? `Server error ${res.status}`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed. Try again.");
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render — edit load failure
  // ---------------------------------------------------------------------------

  if (editLoadError) {
    return (
      <div className="py-8 space-y-4">
        <p
          className="text-sm text-danger bg-danger-dim border border-danger rounded-3xl px-5 py-4"
          role="alert"
        >
          {editLoadError}
        </p>
        <Link href={editId ? `/expenses/${editId}` : fromTx ? `/transactions/${fromTx}` : "/splits"}>
          <Button variant="secondary">{editId ? "Back to expense" : "Back"}</Button>
        </Link>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — no-people guard
  // ---------------------------------------------------------------------------

  if (!peopleLoading && people.length === 0) {
    return (
      <div className="rounded-3xl border border-ink bg-sky px-6 py-12 text-center">
        <p className="font-display text-4xl uppercase">Add people first</p>
        <Link href="/people" className="inline-block mt-6">
          <Button variant="primary">Add people</Button>
        </Link>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-9">
      <header>
        <BackLink href={editId ? `/expenses/${editId}` : fromTx ? `/expenses/new?fromTx=${fromTx}` : "/expenses/new"} label={editId ? "Back to expense" : fromTx ? "Back to split options" : "Back to New"} />
        <h1 className="mt-4 font-display text-6xl sm:text-7xl uppercase">
          {editId ? "Edit split" : "Quick split"}
        </h1>
        {editId && (
          <p className="mt-3 text-sm text-ink-muted">
            Saving clears &ldquo;logged to Splitwise&rdquo; so you remember to update it there.
          </p>
        )}
        {sourceTx && (
          <p className="mt-3 text-sm text-ink-muted">
            From your <span className="font-semibold text-ink tabular-nums">{formatUSD(sourceTx.amount)}</span>{" "}
            charge
          </p>
        )}
      </header>

      {/* ── Amount ──────────────────────────────────────────────────────── */}
      <label
        htmlFor="amount-input"
        className="block rounded-3xl border border-ink bg-sky px-6 pt-4 pb-5 focus-within:ring-4 focus-within:ring-sun"
      >
        <span className="text-xs font-semibold uppercase tracking-[0.08em]">Total</span>
        <span className="mt-1 flex items-baseline gap-1 font-display text-6xl sm:text-7xl">
          <span aria-hidden="true">$</span>
          <input
            id="amount-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={amountDollars}
            onChange={(e) => setAmountDollars(e.target.value)}
            placeholder="0.00"
            className="w-full min-w-0 bg-transparent outline-none placeholder:text-ink/25 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
        </span>
      </label>

      {/* ── What + when ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_12rem] gap-4">
        <Field label="What was it?" htmlFor="description-input">
          <Input
            id="description-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Dinner, gas, tickets…"
          />
        </Field>
        <Field label="Date" htmlFor="date-input">
          <Input
            id="date-input"
            type="date"
            value={purchasedAt}
            onChange={(e) => setPurchasedAt(e.target.value)}
          />
        </Field>
      </div>

      {/* ── Who paid ────────────────────────────────────────────────────── */}
      <Section title="Who paid">
        {peopleLoading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : (
          <>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Who paid">
            {people.map((p) => (
              <PersonChip
                key={p.id}
                name={p.name}
                colorHex={p.colorHex}
                selected={payerId === p.id}
                onClick={() => setPayerId(p.id)}
              />
            ))}
          </div>
          {sourceTx && !people.some((p) => p.isMe) && (
            <p className="text-sm text-ink-muted">
              Pick yourself. To skip this next time, mark yourself as{" "}
              <Link href="/people" className="tap-area font-semibold underline underline-offset-4">This is me</Link>.
            </p>
          )}
          </>
        )}
      </Section>

      {/* ── Who's in ────────────────────────────────────────────────────── */}
      <Section title="Split between">
        {peopleLoading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {people.map((p) => (
              <PersonChip
                key={p.id}
                name={p.name}
                colorHex={p.colorHex}
                selected={participantIds.has(p.id)}
                onClick={() => toggleParticipant(p.id)}
              />
            ))}
          </div>
        )}

        <div className="flex gap-1.5 pt-1" role="radiogroup" aria-label="Split method">
          {(
            [
              ["EVEN", "Evenly"],
              ["EXACT", "Exact amounts"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={splitMethod === value}
              onClick={() => setSplitMethod(value)}
              className={[
                "h-8 px-3.5 rounded-full border border-ink text-sm font-semibold transition-colors",
                splitMethod === value ? "bg-ink text-white" : "bg-surface hover:bg-sun",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Exact-amount inputs */}
        {splitMethod === "EXACT" && participantList.length > 0 && (
          <div className="rounded-3xl border border-ink p-4 space-y-2.5">
            {participantList.map((p) => (
              <div key={p.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <PersonChip name={p.name} colorHex={p.colorHex} size="sm" readOnly />
                </div>
                <div className="w-36">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={exactAmounts[p.id] ?? ""}
                    onChange={(e) => setExactAmount(p.id, e.target.value)}
                    aria-label={`${p.name}'s share`}
                    className="text-right tabular-nums"
                  />
                </div>
              </div>
            ))}

            {totalCents > 0 && (
              <p
                className={[
                  "pt-2 border-t border-rim text-sm flex justify-between",
                  exactHasAllAmounts && !exactSumMatchesTotal ? "text-danger font-semibold" : "text-ink-muted",
                ].join(" ")}
                role="status"
              >
                <span>
                  {!exactHasAllAmounts
                    ? "Enter an amount for everyone"
                    : exactSumMatchesTotal
                      ? "✓ Adds up"
                      : exactSumCents < totalCents
                        ? `${formatUSD(totalCents - exactSumCents)} short`
                        : `${formatUSD(exactSumCents - totalCents)} over`}
                </span>
                <span className="tabular-nums">
                  {formatUSD(exactSumCents)} / {formatUSD(totalCents)}
                </span>
              </p>
            )}
          </div>
        )}
      </Section>

      {/* ── Live breakdown ──────────────────────────────────────────────── */}
      {liveBreakdown && liveBreakdown.length > 0 && (
        <Section title="Each share">
          <ul className="rounded-3xl bg-mist divide-y divide-rim">
            {liveBreakdown.map(({ personId, cents }) => {
              const person = personById.get(personId);
              if (!person) return null;
              return (
                <li key={personId} className="flex items-center justify-between px-5 py-3 text-sm">
                  <span>
                    <span className="font-semibold">{person.name}</span>
                    {personId === payerId && <span className="text-ink-muted"> · paid</span>}
                  </span>
                  <span className="font-display text-2xl tabular-nums">{formatUSD(cents)}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {/* ── Tags ────────────────────────────────────────────────────────── */}
      <Section title="Tags">
        <TagPicker value={tags} onChange={setTags} />
      </Section>

      <SaveBar
        summary={
          totalCents > 0 ? (
            <>
              <span className="font-semibold tabular-nums">{formatUSD(totalCents)}</span>
              <span className="text-ink-muted">
                {" "}· {participantList.length} {participantList.length === 1 ? "person" : "people"}
              </span>
            </>
          ) : (
            <span className="text-ink-muted">Enter a total to save</span>
          )
        }
        saveLabel={editId ? "Save changes" : "Save"}
        canSave={canSave}
        saving={saving}
        onSave={handleSave}
        cancelHref={editId ? `/expenses/${editId}` : fromTx ? `/transactions/${fromTx}` : "/splits"}
      />
    </div>
  );
}
