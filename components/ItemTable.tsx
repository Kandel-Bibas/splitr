import { PersonChip } from "@/components/PersonChip";
import { Button } from "@/components/ui/Button";
import { formatUSD, toCents } from "@/lib/money";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ItemRow {
  id: string;
  rawName: string | null;
  name: string;
  /** String so the <input> is always controlled */
  quantity: string;
  /** Dollars as string (e.g. "2.99") */
  unitPrice: string;
  /** Dollars as string (e.g. "5.98") */
  lineTotal: string;
  assigneeIds: string[];
  /** Returned after purchase (set by an order import) */
  returned?: boolean;
}

interface Person {
  id: string;
  name: string;
  colorHex: string;
  isDefault: boolean;
}

interface ItemTableProps {
  rows: ItemRow[];
  people: Person[];
  selectedRowIds: Set<string>;
  /** Tax in dollars as a string */
  taxDollars: string;
  onTaxChange: (v: string) => void;
  /** Read-only order charges shown under tax; zero amounts are left out */
  charges?: { label: string; cents: number }[];
  onRowChange: (id: string, field: string, value: string) => void;
  onDeleteRow: (id: string) => void;
  onAddRow: () => void;
  onToggleAssignee: (rowId: string, personId: string) => void;
  onToggleRowSelect: (rowId: string) => void;
  onToggleSelectAll: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Editable item table with per-row person-chip assignment.
 * Inputs are in dollars; callers convert to cents before saving.
 * Auto-computes lineTotal when qty or unitPrice changes (handled by parent
 * via onRowChange calling back with the updated lineTotal).
 */
export function ItemTable({
  rows,
  people,
  selectedRowIds,
  taxDollars,
  onTaxChange,
  charges = [],
  onRowChange,
  onDeleteRow,
  onAddRow,
  onToggleAssignee,
  onToggleRowSelect,
  onToggleSelectAll,
}: ItemTableProps) {
  const subtotal = rows.reduce(
    (sum, r) => sum + (parseFloat(r.lineTotal) || 0),
    0
  );
  const tax = parseFloat(taxDollars) || 0;
  const computedTotal =
    subtotal + tax + charges.reduce((sum, c) => sum + c.cents, 0) / 100;

  const allSelected =
    rows.length > 0 && rows.every((r) => selectedRowIds.has(r.id));

  // Shared input classes for inline compact inputs
  const cellInput =
    "h-8 bg-mist border border-transparent rounded-full text-ink text-sm tabular-nums hover:border-rim focus:outline-none focus:border-ink focus:bg-surface focus:ring-4 focus:ring-sun/60 transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
  const tick = "w-5 h-5 shrink-0 accent-[#0B0B0C] cursor-pointer";

  return (
    <div className="space-y-3">
      {/* Select-all toggle */}
      {rows.length > 0 && (
        <label className="flex items-center gap-2.5 px-4 text-sm text-ink-muted cursor-pointer select-none w-fit">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={onToggleSelectAll}
            className={tick}
            aria-label="Select all items to assign people in bulk"
          />
          Select all to assign in bulk
        </label>
      )}

      {/* Item rows */}
      <div className="rounded-3xl border border-ink divide-y divide-rim overflow-hidden">
        {rows.map((row, idx) => (
          <div
            key={row.id}
            className={[
              "px-4 py-3.5 space-y-2.5 transition-colors",
              selectedRowIds.has(row.id) ? "bg-sun/40" : "bg-surface",
            ].join(" ")}
          >
            {/* Row header: checkbox + name + delete */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selectedRowIds.has(row.id)}
                onChange={() => onToggleRowSelect(row.id)}
                className={tick}
                aria-label={`Select item ${idx + 1} for bulk assignment`}
              />
              <input
                type="text"
                value={row.name}
                onChange={(e) => onRowChange(row.id, "name", e.target.value)}
                placeholder="Item name"
                aria-label={`Row ${idx + 1} item name`}
                className={`flex-1 min-w-0 px-3 font-semibold ${cellInput}`}
              />
              {row.returned && (
                <span className="shrink-0 text-sm text-ink-muted">Returned</span>
              )}
              <button
                type="button"
                onClick={() => onDeleteRow(row.id)}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-xl leading-none text-ink-faint hover:text-white hover:bg-danger transition-colors"
                aria-label={`Delete row ${idx + 1}`}
              >
                ×
              </button>
            </div>

            {/* Qty × Unit = Line total; indented under the name from tablet up,
                full width on phones so it fits on one line */}
            <div className="flex flex-wrap items-center gap-1.5 sm:ml-7 text-sm text-ink-faint">
              <input
                type="number"
                value={row.quantity}
                onChange={(e) =>
                  onRowChange(row.id, "quantity", e.target.value)
                }
                min="0"
                step="1"
                aria-label={`Row ${idx + 1} quantity`}
                className={`w-12 sm:w-14 px-2 text-center ${cellInput}`}
              />
              <span aria-hidden="true">×</span>
              <div className="relative">
                <span
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none"
                  aria-hidden="true"
                >
                  $
                </span>
                <input
                  type="number"
                  value={row.unitPrice}
                  onChange={(e) =>
                    onRowChange(row.id, "unitPrice", e.target.value)
                  }
                  min="0"
                  step="0.01"
                  aria-label={`Row ${idx + 1} unit price in dollars`}
                  className={`w-24 pl-6 pr-3 ${cellInput}`}
                />
              </div>
              <span aria-hidden="true">=</span>
              <div className="relative">
                <span
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none"
                  aria-hidden="true"
                >
                  $
                </span>
                <input
                  type="number"
                  value={row.lineTotal}
                  onChange={(e) =>
                    onRowChange(row.id, "lineTotal", e.target.value)
                  }
                  min="0"
                  step="0.01"
                  aria-label={`Row ${idx + 1} line total in dollars`}
                  className={`w-24 pl-6 pr-3 ${cellInput}`}
                />
              </div>
            </div>

            {/* Per-row assignee toggles */}
            {people.length > 0 && (
              <div
                className="flex flex-wrap gap-1.5 sm:ml-7"
                role="group"
                aria-label={`Row ${idx + 1} assigned to`}
              >
                {people.map((person) => (
                  <PersonChip
                    key={person.id}
                    name={person.name}
                    colorHex={person.colorHex}
                    selected={row.assigneeIds.includes(person.id)}
                    onClick={() => onToggleAssignee(row.id, person.id)}
                    size="sm"
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add row */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onAddRow}
        className="w-full justify-center border-dashed !border-ink text-ink"
      >
        + Add item
      </Button>

      {/* Subtotal / Tax / Total footer */}
      <div className="space-y-2.5 rounded-3xl bg-mist px-5 py-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-muted">Items subtotal</span>
          <span className="font-medium text-ink tabular-nums">
            {formatUSD(toCents(subtotal))}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 text-sm">
          <label htmlFor="tax-input" className="text-ink-muted shrink-0">
            Tax
          </label>
          <div className="relative">
            <span
              className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-sm pointer-events-none"
              aria-hidden="true"
            >
              $
            </span>
            <input
              id="tax-input"
              type="number"
              value={taxDollars}
              onChange={(e) => onTaxChange(e.target.value)}
              min="0"
              step="0.01"
              className={`w-28 pl-6 pr-3 text-right !bg-surface !border-ink ${cellInput}`}
            />
          </div>
        </div>

        {charges
          .filter((c) => c.cents !== 0)
          .map((c) => (
            <div key={c.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-ink-muted shrink-0">{c.label}</span>
              <span className="font-medium text-ink tabular-nums">{formatUSD(c.cents)}</span>
            </div>
          ))}

        <div className="flex items-baseline justify-between pt-2 border-t border-rim">
          <span className="text-sm font-semibold">Total</span>
          <span className="font-display text-4xl tabular-nums">
            {formatUSD(toCents(computedTotal))}
          </span>
        </div>

      </div>
    </div>
  );
}
