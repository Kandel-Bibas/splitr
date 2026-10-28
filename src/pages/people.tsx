import { useState, useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { peopleQuery, useRefreshAll } from "../queries";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { PersonAvatar } from "@/components/PersonChip";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRESET_COLORS = [
  "#6366F1",
  "#0EA5E9",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#14B8A6",
  "#F97316",
  "#84CC16",
] as const;

function pickRandomColor(): string {
  return PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
}

// ---------------------------------------------------------------------------
// ColorPicker sub-component
// ---------------------------------------------------------------------------

interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  id?: string;
}

function ColorPicker({ value, onChange, id }: ColorPickerProps) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          className={[
            "w-7 h-7 pointer-coarse:w-9 pointer-coarse:h-9 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sun",
            value === c
              ? "border-ink scale-110"
              : "border-transparent hover:scale-105",
          ].join(" ")}
          style={{ backgroundColor: c }}
          aria-label={`Color ${c}${value === c ? " (selected)" : ""}`}
          aria-pressed={value === c}
        />
      ))}
      {/* Custom colour via native picker */}
      <div className="relative w-7 h-7 pointer-coarse:w-9 pointer-coarse:h-9" title="Custom color">
        <div
          className="w-full h-full rounded-full border border-dashed border-ink"
          style={{ backgroundColor: PRESET_COLORS.includes(value as (typeof PRESET_COLORS)[number]) ? "#FFFFFF" : value }}
        />
        <input
          type="color"
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label="Custom color"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const NO_PEOPLE: Person[] = [];

export default function PeoplePage() {
  const addNameId = useId();
  const addColorId = useId();

  const peopleResult = useQuery(peopleQuery);
  const refreshAll = useRefreshAll();
  const people = peopleResult.data ?? NO_PEOPLE;
  const loadError = peopleResult.error;
  const loadState = loadError ? "error" : peopleResult.data ? "ready" : "loading";

  // ---- Add form ----
  const [addName, setAddName] = useState("");
  const [addColor, setAddColor] = useState(() => pickRandomColor());
  const [addDefault, setAddDefault] = useState(false);
  const [addPending, setAddPending] = useState(false);
  const [addNameTouched, setAddNameTouched] = useState(false);

  // ---- Inline edit ----
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editDefault, setEditDefault] = useState(false);
  const [editMe, setEditMe] = useState(false);
  const [editPending, setEditPending] = useState(false);
  const [editNameTouched, setEditNameTouched] = useState(false);

  // ---- Archive confirmation ----
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [archivePending, setArchivePending] = useState(false);

  // ---------------------------------------------------------------------------
  // Add
  // ---------------------------------------------------------------------------

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!addName.trim()) {
      setAddNameTouched(true);
      return;
    }
    setAddPending(true);
    try {
      const res = await apiFetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addName.trim(),
          colorHex: addColor,
          isDefault: addDefault,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Error ${res.status}`
        );
      }
      setAddName("");
      setAddColor(pickRandomColor());
      setAddDefault(false);
      setAddNameTouched(false);
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t add the person.");
    } finally {
      setAddPending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Edit
  // ---------------------------------------------------------------------------

  function startEdit(person: Person) {
    setEditId(person.id);
    setEditName(person.name);
    setEditColor(person.colorHex);
    setEditDefault(person.isDefault);
    setEditMe(person.isMe);
    setEditNameTouched(false);
    setArchiveId(null);
  }

  function cancelEdit() {
    setEditId(null);
    setEditNameTouched(false);
  }

  async function handleEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editId || !editName.trim()) {
      setEditNameTouched(true);
      return;
    }
    setEditPending(true);
    try {
      const res = await apiFetch(`/api/people/${editId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          colorHex: editColor,
          isDefault: editDefault,
          isMe: editMe,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Error ${res.status}`
        );
      }
      setEditId(null);
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t save the changes.");
    } finally {
      setEditPending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Archive
  // ---------------------------------------------------------------------------

  async function handleArchive(id: string) {
    setArchivePending(true);
    try {
      const res = await apiFetch(`/api/people/${id}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error(`Error ${res.status}`);
      }
      setArchiveId(null);
      await refreshAll();
    } catch {
      // Keep archiveId open so the user can retry
      toast.error("Couldn’t archive. Try again.");
    } finally {
      setArchivePending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-8">
      {/* Page heading */}
      <div>
        <h1 className="font-display text-6xl sm:text-7xl uppercase">People</h1>
      </div>

      {/* ---- People list ---- */}
      {loadState === "loading" && (
        <p className="text-sm text-ink-faint">Loading…</p>
      )}

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

      {loadState === "ready" && people.length === 0 && (
        <p className="text-sm text-ink-faint">
          No people yet — add someone below.
        </p>
      )}

      {loadState === "ready" && people.length > 0 && (
        <section aria-label="Active people">
          <div className="rounded-3xl border border-ink divide-y divide-rim overflow-hidden">
            {people.map((person) =>
              editId === person.id ? (
                /* ---- Inline edit form ---- */
                <div key={person.id} className="bg-mist p-5">
                  <form onSubmit={handleEdit} noValidate>
                    <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                      {/* Name */}
                      <div className="flex-1 min-w-0">
                        <Field label="Name" htmlFor={`edit-name-${person.id}`}>
                          <Input
                            id={`edit-name-${person.id}`}
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={() => setEditNameTouched(true)}
                            required
                            autoFocus
                            placeholder="Full name"
                          />
                        </Field>
                        {editNameTouched && !editName.trim() && (
                          <p className="mt-1 text-xs text-danger" role="alert">
                            Name is required.
                          </p>
                        )}
                      </div>

                      {/* Color */}
                      <div>
                        <Field label="Color" htmlFor={`edit-color-${person.id}`}>
                          <ColorPicker
                            id={`edit-color-${person.id}`}
                            value={editColor}
                            onChange={setEditColor}
                          />
                        </Field>
                      </div>
                    </div>

                    {/* Default checkbox */}
                    <label className="mt-3 flex items-center gap-2 text-sm text-ink cursor-pointer select-none w-fit">
                      <input
                        type="checkbox"
                        checked={editDefault}
                        onChange={(e) => setEditDefault(e.target.checked)}
                        className="w-5 h-5 accent-[#0B0B0C]"
                      />
                      Roommate (ticked by default)
                    </label>
                    <label className="mt-2 flex items-center gap-2 text-sm text-ink cursor-pointer select-none w-fit">
                      <input
                        type="checkbox"
                        checked={editMe}
                        onChange={(e) => setEditMe(e.target.checked)}
                        className="w-5 h-5 accent-[#0B0B0C]"
                      />
                      This is me (picked as the payer when you split a bank charge)
                    </label>

                    {/* Actions */}
                    <div className="mt-4 flex items-center gap-2">
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={editPending || !editName.trim()}
                      >
                        {editPending ? "Saving…" : "Save"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={cancelEdit}
                        disabled={editPending}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                </div>
              ) : (
                /* ---- Person row ---- */
                <div key={person.id} className="px-5 py-3.5 bg-surface">
                  {/* One line at any width: a long name shortens, the buttons never wrap */}
                  <div className="flex items-center gap-3">
                    <PersonAvatar name={person.name} colorHex={person.colorHex} />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">{person.name}</p>
                      {(person.isMe || person.isDefault) && (
                        <p className="text-xs text-ink-muted">
                          {[person.isMe && "You", person.isDefault && "Roommate"].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0 flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(person)}
                        disabled={archiveId === person.id}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setArchiveId(person.id);
                          setEditId(null);
                        }}
                        disabled={archiveId === person.id}
                        className="hover:!text-danger hover:!bg-danger-dim"
                      >
                        Archive
                      </Button>
                    </div>
                  </div>

                  {archiveId === person.id && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className="mr-auto text-sm text-ink-muted">Archive this person?</span>
                      <span className="flex items-center gap-2">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleArchive(person.id)}
                          disabled={archivePending}
                        >
                          {archivePending ? "Archiving…" : "Archive"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setArchiveId(null)}
                          disabled={archivePending}
                        >
                          Cancel
                        </Button>
                      </span>
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        </section>
      )}

      {/* ---- Add person form ---- */}
      <div className="rounded-3xl border border-ink bg-sky p-6">
        <h2 className="font-display text-3xl uppercase mb-5">Add someone</h2>

        <form onSubmit={handleAdd} noValidate>
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            {/* Name */}
            <div className="flex-1 min-w-0">
              <Field label="Name" htmlFor={addNameId}>
                <Input
                  id={addNameId}
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  onBlur={() => setAddNameTouched(true)}
                  placeholder="e.g. Alex"
                  required
                />
              </Field>
              {addNameTouched && !addName.trim() && (
                <p className="mt-1 text-xs text-danger" role="alert">
                  Name is required.
                </p>
              )}
            </div>

            {/* Color */}
            <div>
              <Field label="Color" htmlFor={addColorId}>
                <ColorPicker
                  id={addColorId}
                  value={addColor}
                  onChange={setAddColor}
                />
              </Field>
            </div>
          </div>

          {/* Default checkbox */}
          <label className="mt-3 flex items-center gap-2 text-sm text-ink cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              checked={addDefault}
              onChange={(e) => setAddDefault(e.target.checked)}
              className="w-5 h-5 accent-[#0B0B0C]"
            />
            Roommate (ticked by default on new expenses)
          </label>

          <div className="mt-4">
            <Button
              type="submit"
              variant="primary"
              disabled={addPending || !addName.trim()}
            >
              {addPending ? "Adding…" : "Add person"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
