import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BackLink } from "@/components/BackLink";
import Link, { useGoTo, useQueryString } from "@/components/Link";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Section } from "@/components/ui/Section";
import { SaveBar } from "@/components/SaveBar";
import { CategoryChips } from "@/components/CategoryChips";
import { toCents, formatUSD } from "@/lib/money";
import { MANUAL_CATEGORIES, todayLocal } from "@/lib/spending";
import type { TxView } from "@/lib/transactions";
import { loadManualTxToEdit, useRefreshAll } from "../queries";
import { apiFetch } from "../api";

export default function AddExpensePage() {
  // ?edit=<id> opens this form pre-filled to edit a hand-added expense
  const { edit: editId } = useQueryString<{ edit?: string }>();
  const goTo = useGoTo();
  const refreshAll = useRefreshAll();

  const [amountDollars, setAmountDollars] = useState("");
  const [name, setName] = useState("");
  const [date, setDate] = useState(() => todayLocal());
  const [category, setCategory] = useState<string | null>(null);

  const [loading, setLoading] = useState(Boolean(editId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<false | "save" | "split">(false);

  useEffect(() => {
    if (!editId) return;
    loadManualTxToEdit(editId)
      .then((tx) => {
        setAmountDollars((tx.amount / 100).toFixed(2));
        setName(tx.name);
        setDate(tx.date);
        setCategory(tx.categoryPrimary);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Couldn’t load the expense."))
      .finally(() => setLoading(false));
  }, [editId]);

  const parsed = parseFloat(amountDollars);
  const amountCents = isNaN(parsed) ? 0 : toCents(parsed);
  const canSave = !saving && !loading && amountCents > 0 && name.trim() !== "" && date !== "";

  async function save(then: "save" | "split") {
    if (!canSave) return;
    setSaving(then);
    try {
      const res = await apiFetch(editId ? `/api/transactions/${editId}` : "/api/transactions", {
        method: editId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          amountCents,
          date,
          // Picking a category is optional; it keeps adding an expense quick
          categoryPrimary: category ?? "OTHER",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<TxView> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`);
      refreshAll();
      goTo(then === "split" ? `/expenses/new?fromTx=${body.id}` : editId ? `/transactions/${editId}` : "/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed. Try again.");
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="py-8 space-y-4">
        <p className="text-sm text-danger bg-danger-dim border border-danger rounded-3xl px-5 py-4" role="alert">
          {loadError}
        </p>
        <Link href="/">
          <Button variant="secondary">Back to Money</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-9">
      <header>
        <BackLink href={editId ? `/transactions/${editId}` : "/"} label={editId ? "Back to expense" : "Back to Money"} />
        <h1 className="mt-4 font-display text-6xl sm:text-7xl uppercase">
          {editId ? "Edit expense" : "Add expense"}
        </h1>
      </header>

      {/* ── Amount ──────────────────────────────────────────────────────── */}
      <label
        htmlFor="amount-input"
        className="block rounded-3xl border border-ink bg-sky px-6 pt-4 pb-5 focus-within:ring-4 focus-within:ring-sun"
      >
        <span className="text-sm font-semibold">Amount</span>
        <span className="mt-1 flex items-baseline gap-1 font-display text-6xl sm:text-7xl">
          <span aria-hidden="true">$</span>
          <input
            id="amount-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            autoFocus={!editId}
            value={amountDollars}
            onChange={(e) => setAmountDollars(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save("save");
            }}
            placeholder="0.00"
            disabled={loading}
            className="w-full min-w-0 bg-transparent outline-none placeholder:text-ink/25 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
        </span>
      </label>

      {/* ── What + when ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_12rem] gap-4">
        <Field label="What was it?" htmlFor="name-input">
          <Input
            id="name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save("save");
            }}
            placeholder="Coffee, farmers market, haircut…"
            disabled={loading}
          />
        </Field>
        <Field label="Date" htmlFor="date-input">
          <Input id="date-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={loading} />
        </Field>
      </div>

      <Section title="Category" hint="Optional.">
        <CategoryChips options={MANUAL_CATEGORIES} value={category} onChange={setCategory} disabled={loading} />
      </Section>

      <SaveBar
        summary={
          amountCents > 0 ? (
            <span className="font-semibold tabular-nums">{formatUSD(amountCents)}</span>
          ) : (
            <span className="text-ink-muted">Enter an amount to save</span>
          )
        }
        saveLabel={editId ? "Save changes" : "Save"}
        canSave={canSave}
        saving={saving === "save"}
        onSave={() => save("save")}
        cancelHref={editId ? `/transactions/${editId}` : "/"}
      >
        {!editId && (
          <Button variant="secondary" onClick={() => save("split")} disabled={!canSave}>
            {saving === "split" ? "Saving…" : "Save & split"}
          </Button>
        )}
      </SaveBar>
    </div>
  );
}
