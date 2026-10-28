import { QueryClient, queryOptions, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import type { AccountsResponse } from "@/lib/bank-types";
import type { TxView } from "@/lib/transactions";

// Every API read the pages make, with one cache shared across pages. Going
// back to a page shows what it last loaded at once, then refreshes it.

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A failed load shows its error (and Retry) straight away, as before,
      // and a 404 isn't retried: "not found" is an answer, not a hiccup.
      retry: false,
    },
  },
});

/** A failed API read; `status` is the HTTP status, e.g. 404. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GETs JSON, throwing "Failed to load <what> (HTTP <status>)" on an error status. */
async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status, `Failed to load ${what} (HTTP ${res.status})`);
  return res.json() as Promise<T>;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

// ---------------------------------------------------------------------------
// Shapes the pages read. Each page declares only the fields it uses.
// ---------------------------------------------------------------------------

export interface Person {
  id: string;
  name: string;
  colorHex: string;
  isDefault: boolean;
  isMe: boolean;
  archived: boolean;
}

export interface TagWithCount {
  id: string;
  name: string;
  expenseCount: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const peopleQuery = queryOptions({
  queryKey: ["people"],
  queryFn: () => getJson<Person[]>("/api/people", "people"),
});

export const tagsQuery = queryOptions({
  queryKey: ["tags"],
  queryFn: () => getJson<TagWithCount[]>("/api/tags", "tags"),
});

export const accountsQuery = queryOptions({
  queryKey: ["accounts"],
  queryFn: () => getJson<AccountsResponse>("/api/accounts", "banks"),
});

export const transactionsQuery = queryOptions({
  queryKey: ["transactions"],
  queryFn: () => getJson<TxView[]>("/api/transactions", "transactions"),
});

export const transactionQuery = (id: string) =>
  queryOptions({
    queryKey: ["transactions", id],
    queryFn: () => getJson<TxView>(`/api/transactions/${id}`, "transaction"),
  });

/** The split list; the Splits page declares its row shape. */
export const expensesQuery = <T>() =>
  queryOptions({
    queryKey: ["expenses"],
    queryFn: () => getJson<T[]>("/api/expenses", "expenses"),
  });

/** One split; each page declares the fields it reads. */
export const expenseQuery = <T>(id: string) =>
  queryOptions({
    queryKey: ["expenses", id],
    queryFn: () => getJson<T>(`/api/expenses/${id}`, "expense"),
  });

/**
 * After any save. Splits, charges, and totals depend on each other, so every
 * read is refreshed. The page on screen reloads in place; pages not on screen
 * drop what they had, so the next one opened loads fresh rather than briefly
 * showing what was just changed or deleted.
 */
export function useRefreshAll(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    client.removeQueries({ type: "inactive" });
    await client.invalidateQueries({ type: "active" });
  };
}

// ---------------------------------------------------------------------------
// Loads for forms. A form reads its data once to fill itself in, so it fetches
// through the cache rather than subscribing, and words "not found" its own way.
// ---------------------------------------------------------------------------

/** A saved split, for its edit form. */
export async function loadExpenseToEdit<T>(id: string): Promise<T> {
  try {
    return await queryClient.fetchQuery(expenseQuery<T>(id));
  } catch (e) {
    if (isNotFound(e)) throw new Error("Expense not found.");
    throw e;
  }
}

/** A hand-added expense, for its edit form. */
export async function loadManualTxToEdit(id: string): Promise<TxView> {
  let tx: TxView;
  try {
    tx = await queryClient.fetchQuery(transactionQuery(id));
  } catch (e) {
    if (isNotFound(e)) throw new Error("Expense not found.");
    if (e instanceof ApiError) throw new Error(`Failed to load expense (HTTP ${e.status})`);
    throw e;
  }
  if (tx.source !== "MANUAL") throw new Error("Bank transactions can’t be edited here.");
  return tx;
}

/** The Money charge a new split starts from (?fromTx=<id>). */
export async function loadSourceTx(id: string): Promise<TxView> {
  let tx: TxView;
  try {
    tx = await queryClient.fetchQuery(transactionQuery(id));
  } catch (e) {
    if (isNotFound(e)) throw new Error("That charge no longer exists.");
    if (e instanceof ApiError) throw new Error(`Failed to load the charge (HTTP ${e.status})`);
    throw e;
  }
  if (tx.split) throw new Error("This charge is already split.");
  return tx;
}
