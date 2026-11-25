-- A split can be paid by several card charges (an online order charged per
-- shipment), and each charge belongs to at most one split. The link moves from
-- Expense."transactionId" (one charge per split) to Transaction."expenseId".

alter table splitr."Transaction" add column "expenseId" uuid;

-- Same owner on both ends, like every other reference; deleting the split
-- leaves its charges, unlinked
alter table splitr."Transaction"
  add constraint "Transaction_ownerId_expenseId_fkey"
  foreign key ("ownerId", "expenseId") references splitr."Expense" ("ownerId", "id")
  on delete set null ("expenseId");

create index "Transaction_expenseId_idx" on splitr."Transaction" ("expenseId");

update splitr."Transaction" t
   set "expenseId" = e."id"
  from splitr."Expense" e
 where e."transactionId" = t."id";

-- Takes its unique index and foreign key with it
alter table splitr."Expense" drop column "transactionId";

-- Updates on Transaction are granted per column (never "ownerId"), so the new
-- column needs its own grant
grant update ("expenseId") on splitr."Transaction" to authenticated;
