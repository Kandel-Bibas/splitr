import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { tagsQuery, useRefreshAll } from "../queries";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { apiFetch } from "../api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tag {
  id: string;
  name: string;
  expenseCount: number;
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? `Error ${res.status}`;
}

function expensesLabel(n: number): string {
  return `${n} expense${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const NO_TAGS: Tag[] = [];

export default function TagsPage() {
  const tagsResult = useQuery(tagsQuery);
  const refreshAll = useRefreshAll();
  const tags: Tag[] = tagsResult.data ?? NO_TAGS;
  const loadError = tagsResult.error;
  const loadState = loadError ? "error" : tagsResult.data ? "ready" : "loading";

  // ---- Add form ----
  const [addName, setAddName] = useState("");
  const [addPending, setAddPending] = useState(false);

  // ---- Inline rename ----
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPending, setEditPending] = useState(false);

  // ---- Delete confirmation ----
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  // ---------------------------------------------------------------------------
  // Add
  // ---------------------------------------------------------------------------

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!addName.trim()) return;
    setAddPending(true);
    try {
      const res = await apiFetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: addName }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setAddName("");
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t add the tag.");
    } finally {
      setAddPending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Rename
  // ---------------------------------------------------------------------------

  function startEdit(tag: Tag) {
    setEditId(tag.id);
    setEditName(tag.name);
    setDeleteId(null);
  }

  async function handleRename(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editId || !editName.trim()) return;
    setEditPending(true);
    try {
      const res = await apiFetch(`/api/tags/${editId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setEditId(null);
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t rename the tag.");
    } finally {
      setEditPending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  async function handleDelete(id: string) {
    setDeletePending(true);
    try {
      const res = await apiFetch(`/api/tags/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorMessage(res));
      setDeleteId(null);
      await refreshAll();
    } catch {
      // Keep the confirmation open so the user can retry
      toast.error("Couldn’t delete the tag. Try again.");
    } finally {
      setDeletePending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-8">
      {/* Page heading */}
      <h1 className="font-display text-6xl sm:text-7xl uppercase">Tags</h1>

      {/* ---- Tag list ---- */}
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

      {loadState === "ready" && tags.length === 0 && (
        <p className="text-sm text-ink-faint">No tags yet — add one below.</p>
      )}

      {loadState === "ready" && tags.length > 0 && (
        <section
          aria-label="Tags"
          className="rounded-3xl border border-ink divide-y divide-rim overflow-hidden"
        >
          {tags.map((tag) => (
            <div key={tag.id} className="px-5 py-3.5 bg-surface">
              {editId === tag.id ? (
                /* ---- Inline rename form ---- */
                <form onSubmit={handleRename}>
                  <div className="flex items-center gap-2">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      aria-label={`New name for ${tag.name}`}
                      autoFocus
                    />
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
                      onClick={() => setEditId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  {/* One line at any width: a long name shortens, the buttons never wrap */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">#{tag.name}</p>
                      <p className="text-xs text-ink-muted">
                        {expensesLabel(tag.expenseCount)}
                      </p>
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(tag)}
                        disabled={deleteId === tag.id}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setDeleteId(tag.id);
                          setEditId(null);
                        }}
                        disabled={deleteId === tag.id}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {deleteId === tag.id && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className="mr-auto text-sm text-ink-muted">
                        {tag.expenseCount > 0
                          ? `Remove from ${expensesLabel(tag.expenseCount)} and delete?`
                          : "Delete this tag?"}
                      </span>
                      <span className="flex items-center gap-2">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleDelete(tag.id)}
                          disabled={deletePending}
                        >
                          {deletePending ? "Deleting…" : "Delete"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteId(null)}
                          disabled={deletePending}
                        >
                          Cancel
                        </Button>
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {/* ---- Add form ---- */}
      <div className="rounded-3xl border border-ink bg-lavender p-6">
        <form onSubmit={handleAdd} className="space-y-3">
          <h2 className="font-display text-3xl uppercase">Add a tag</h2>
          <div className="flex items-center gap-2">
            <Input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="walmart, goa trip…"
              aria-label="Tag name"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={addPending || !addName.trim()}
            >
              {addPending ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
