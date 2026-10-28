import { useMemo } from "react";
import { splitItemized } from "@/lib/split";
import { formatUSD, toCents } from "@/lib/money";

export interface BreakdownItem {
  id: string;
  /** Dollar amount as a string (e.g. "5.99") */
  lineTotal: string;
  assigneeIds: string[];
  returned?: boolean;
}

interface Person {
  id: string;
  name: string;
}

interface BreakdownCardProps {
  items: BreakdownItem[];
  /** Tax in dollars as a string (e.g. "4.23") */
  taxDollars: string;
  tipFeesCents?: number;
  discountCents?: number;
  refundCents?: number;
  people: Person[];
  payerId: string;
}

/**
 * Live per-person shares computed via splitItemized. Says which items still
 * need someone (saving is blocked until every item has an assignee).
 */
export function BreakdownCard({
  items,
  taxDollars,
  tipFeesCents,
  discountCents,
  refundCents,
  people,
  payerId,
}: BreakdownCardProps) {
  const personById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people]
  );

  const { result, splitError } = useMemo(() => {
    const taxCents = toCents(parseFloat(taxDollars) || 0);
    const unassigned = items.filter((it) => it.assigneeIds.length === 0);
    if (items.length === 0 || unassigned.length > 0) return { result: null, splitError: null };
    try {
      return {
        result: splitItemized({
          items: items.map((it) => ({
            id: it.id,
            lineTotalCents: toCents(parseFloat(it.lineTotal) || 0),
            assigneeIds: it.assigneeIds,
            returned: it.returned,
          })),
          taxCents,
          tipFeesCents,
          discountCents,
          refundCents,
        }),
        splitError: null,
      };
    } catch (err) {
      return {
        result: null,
        splitError: err instanceof Error ? err.message : "Couldn't split this receipt.",
      };
    }
  }, [items, taxDollars, tipFeesCents, discountCents, refundCents]);

  const unassignedCount = items.filter((it) => it.assigneeIds.length === 0).length;
  const payer = personById.get(payerId);

  if (items.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-ink-muted">
        Each share
      </h2>

      {unassignedCount > 0 && (
        <p className="text-sm font-semibold text-danger" role="alert">
          {unassignedCount === 1 ? "1 item needs" : `${unassignedCount} items need`} at
          least one person before you can save.
        </p>
      )}

      {splitError && (
        <p className="text-sm font-semibold text-danger" role="alert">
          {splitError}
        </p>
      )}

      {result && (
        <ul className="rounded-3xl bg-mist divide-y divide-rim">
          {result.perPerson.map(({ personId, cents }) => {
            const person = personById.get(personId);
            if (!person) return null;
            const isPayer = personId === payerId;
            return (
              <li key={personId} className="flex items-center justify-between px-5 py-3 text-sm">
                <span>
                  <span className="font-semibold">{person.name}</span>
                  <span className="text-ink-muted">
                    {isPayer ? " · paid" : payer ? ` · owes ${payer.name}` : ""}
                  </span>
                </span>
                <span className="font-display text-2xl tabular-nums">{formatUSD(cents)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
