-- Splitr on Supabase Postgres: tables, ownership and row security.
--
-- Every row belongs to one Supabase user ("ownerId", filled from the login).
-- The Worker runs each request as that user (role authenticated, JWT claims
-- set for the transaction), so the policies below decide what it can touch.
--
-- Who sees what:
--   banks, transactions, Plaid tokens, tags  -> owner only
--   people (contacts)                         -> owner, the friend a contact is
--                                               linked to, and anyone a shared
--                                               split is visible to
--   splits, items, shares                     -> owner, plus friends linked to
--                                               a person who paid or shares in it
-- Friends can only read. Every write is owner only.
--
-- Cross-table references are composite ("ownerId", id) foreign keys, so a row
-- can never point at a row belonging to someone else.

create schema splitr;

-- Kept off the Data API (it only exposes public): every read and write goes
-- through the Worker, which validates input before it reaches here.
revoke all on schema splitr from public;
grant usage on schema splitr to authenticated;

-- ---------------------------------------------------------------------------
-- Splits
-- ---------------------------------------------------------------------------

create table splitr."Person" (
  "id" uuid primary key default gen_random_uuid(),
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "name" text not null,
  "colorHex" text not null default '#64748b',
  "isDefault" boolean not null default false,
  "isMe" boolean not null default false,
  "archived" boolean not null default false,
  -- The Splitr user this contact is, once they accept an invite. Set only by
  -- the Worker's admin path (see grants below), never by the owner.
  "linkedUserId" uuid references auth.users (id) on delete set null,
  "createdAt" timestamptz not null default now(),
  unique ("ownerId", "id"),
  -- A friend appears at most once in each owner's contacts
  unique ("ownerId", "linkedUserId")
);
create index "Person_linkedUserId_idx" on splitr."Person" ("linkedUserId");

create table splitr."PlaidItem" (
  "id" integer primary key generated always as identity,
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "itemId" text not null unique,
  -- AES-GCM ciphertext; the key is a Worker secret and never reaches Postgres
  "accessToken" text not null,
  "institutionId" text,
  "institutionName" text,
  "institutionLogo" text,
  "institutionColor" text,
  "cursor" text,
  "createdAt" timestamptz not null default now(),
  unique ("ownerId", "id")
);

create table splitr."Account" (
  "id" integer primary key generated always as identity,
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "plaidAccountId" text not null unique,
  "itemId" integer not null,
  "name" text not null,
  "officialName" text,
  "mask" text,
  "type" text not null,
  "subtype" text,
  -- Integer cents
  "currentBalance" integer,
  "availableBalance" integer,
  "isoCurrencyCode" text not null default 'USD',
  "updatedAt" timestamptz not null default now(),
  unique ("ownerId", "id"),
  foreign key ("ownerId", "itemId") references splitr."PlaidItem" ("ownerId", "id") on delete cascade
);
create index "Account_itemId_idx" on splitr."Account" ("itemId");

create table splitr."Transaction" (
  "id" integer primary key generated always as identity,
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "source" text not null default 'PLAID' check ("source" in ('PLAID', 'MANUAL')),
  "plaidTransactionId" text unique,
  -- Null for hand-added (cash) transactions
  "accountId" integer,
  -- YYYY-MM-DD, the local calendar day
  "date" text not null check ("date" ~ '^\d{4}-\d{2}-\d{2}$'),
  -- Integer cents, Plaid's sign: positive = money out, negative = money in
  "amount" integer not null,
  "name" text not null,
  "merchantName" text,
  "categoryPrimary" text,
  "categoryDetailed" text,
  "userCategory" text,
  "pending" boolean not null default false,
  "isoCurrencyCode" text not null default 'USD',
  "createdAt" timestamptz not null default now(),
  unique ("ownerId", "id"),
  foreign key ("ownerId", "accountId") references splitr."Account" ("ownerId", "id") on delete cascade
);
create index "Transaction_ownerId_date_idx" on splitr."Transaction" ("ownerId", "date");
create index "Transaction_accountId_idx" on splitr."Transaction" ("accountId");

create table splitr."BalanceSnapshot" (
  "id" integer primary key generated always as identity,
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "accountId" integer not null,
  "date" text not null check ("date" ~ '^\d{4}-\d{2}-\d{2}$'),
  "currentBalance" integer,
  "availableBalance" integer,
  unique ("accountId", "date"),
  foreign key ("ownerId", "accountId") references splitr."Account" ("ownerId", "id") on delete cascade
);
create index "BalanceSnapshot_ownerId_date_idx" on splitr."BalanceSnapshot" ("ownerId", "date");

create table splitr."Expense" (
  "id" uuid primary key default gen_random_uuid(),
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "type" text not null check ("type" in ('ITEMIZED', 'SIMPLE')),
  "description" text not null default '',
  "store" text,
  "purchasedAt" timestamptz,
  "payerId" uuid not null,
  "subtotalCents" integer not null default 0,
  "taxCents" integer not null default 0,
  -- Itemized only: driver tip + fees (>= 0), discounts (<= 0), refunds (<= 0)
  "tipFeesCents" integer not null default 0,
  "discountCents" integer not null default 0,
  "refundCents" integer not null default 0,
  "totalCents" integer not null,
  "splitMethod" text not null check ("splitMethod" in ('EVEN', 'EXACT', 'ITEMIZED')),
  "loggedToSplitwise" boolean not null default false,
  "imagePath" text,
  "createdAt" timestamptz not null default now(),
  -- The bank or hand-added transaction this split was made from, if any
  "transactionId" integer unique,
  -- The online order it was imported from ("walmart-<id>")
  "orderRef" text,
  unique ("ownerId", "id"),
  unique ("ownerId", "orderRef"),
  foreign key ("ownerId", "payerId") references splitr."Person" ("ownerId", "id") on delete restrict,
  -- Clearing only "transactionId" on delete needs a column list (Postgres 15+)
  foreign key ("ownerId", "transactionId") references splitr."Transaction" ("ownerId", "id")
    on delete set null ("transactionId")
);
create index "Expense_payerId_idx" on splitr."Expense" ("payerId");

create table splitr."Item" (
  "id" uuid primary key default gen_random_uuid(),
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "expenseId" uuid not null,
  "rawName" text,
  "name" text not null,
  "quantity" double precision not null default 1,
  "unitPriceCents" integer not null,
  "lineTotalCents" integer not null,
  "sortOrder" integer not null,
  -- A returned item stays on the receipt at full price; its money back is the refund
  "returned" boolean not null default false,
  unique ("ownerId", "id"),
  foreign key ("ownerId", "expenseId") references splitr."Expense" ("ownerId", "id") on delete cascade
);
create index "Item_expenseId_idx" on splitr."Item" ("expenseId");

create table splitr."ItemAssignment" (
  "itemId" uuid not null,
  "personId" uuid not null,
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  primary key ("itemId", "personId"),
  foreign key ("ownerId", "itemId") references splitr."Item" ("ownerId", "id") on delete cascade,
  foreign key ("ownerId", "personId") references splitr."Person" ("ownerId", "id") on delete restrict
);
create index "ItemAssignment_personId_idx" on splitr."ItemAssignment" ("personId");

create table splitr."ExpenseParticipant" (
  "expenseId" uuid not null,
  "personId" uuid not null,
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "exactAmountCents" integer,
  primary key ("expenseId", "personId"),
  foreign key ("ownerId", "expenseId") references splitr."Expense" ("ownerId", "id") on delete cascade,
  foreign key ("ownerId", "personId") references splitr."Person" ("ownerId", "id") on delete restrict
);
create index "ExpenseParticipant_personId_idx" on splitr."ExpenseParticipant" ("personId");

create table splitr."Tag" (
  "id" uuid primary key default gen_random_uuid(),
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "name" text not null,
  unique ("ownerId", "id"),
  unique ("ownerId", "name")
);

-- A = Expense.id, B = Tag.id (the names the Prisma-era code uses)
create table splitr."_ExpenseToTag" (
  "A" uuid not null,
  "B" uuid not null,
  "ownerId" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  primary key ("A", "B"),
  foreign key ("ownerId", "A") references splitr."Expense" ("ownerId", "id") on delete cascade,
  foreign key ("ownerId", "B") references splitr."Tag" ("ownerId", "id") on delete cascade
);
create index "_ExpenseToTag_B_idx" on splitr."_ExpenseToTag" ("B");

-- ---------------------------------------------------------------------------
-- Sharing rules
-- ---------------------------------------------------------------------------
-- Security definer so the checks can read the tables they guard without the
-- policies recursing into each other. Both only ever answer for auth.uid().

create function splitr.can_view_expense(expense_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from splitr."Expense" e
    where e."id" = expense_id
      and (
        e."ownerId" = (select auth.uid())
        or exists (
          select 1
          from splitr."Person" p
          where p."ownerId" = e."ownerId"
            and p."linkedUserId" = (select auth.uid())
            and (
              p."id" = e."payerId"
              or exists (
                select 1 from splitr."ExpenseParticipant" ep
                where ep."expenseId" = e."id" and ep."personId" = p."id"
              )
              or exists (
                select 1
                from splitr."ItemAssignment" ia
                join splitr."Item" i on i."id" = ia."itemId"
                where i."expenseId" = e."id" and ia."personId" = p."id"
              )
            )
        )
      )
  )
$$;

-- A contact is visible to its owner, to the friend it is linked to, and to
-- anyone who can see a split it paid for or shares in (so a shared split
-- shows everyone's names).
create function splitr.can_view_person(person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from splitr."Person" p
    where p."id" = person_id
      and (
        p."ownerId" = (select auth.uid())
        or p."linkedUserId" = (select auth.uid())
        or exists (
          select 1 from splitr."Expense" e
          where e."payerId" = p."id" and splitr.can_view_expense(e."id")
        )
        or exists (
          select 1 from splitr."ExpenseParticipant" ep
          where ep."personId" = p."id" and splitr.can_view_expense(ep."expenseId")
        )
        or exists (
          select 1
          from splitr."ItemAssignment" ia
          join splitr."Item" i on i."id" = ia."itemId"
          where ia."personId" = p."id" and splitr.can_view_expense(i."expenseId")
        )
      )
  )
$$;

revoke all on function splitr.can_view_expense(uuid) from public;
revoke all on function splitr.can_view_person(uuid) from public;
grant execute on function splitr.can_view_expense(uuid) to authenticated;
grant execute on function splitr.can_view_person(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Grants and policies
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on all tables in schema splitr to authenticated;

-- Only the Worker's admin path links a contact to a Splitr user: the owner can
-- write every Person column except "linkedUserId" (and never "ownerId").
revoke insert, update on splitr."Person" from authenticated;
grant insert ("id", "name", "colorHex", "isDefault", "isMe", "archived", "createdAt")
  on splitr."Person" to authenticated;
grant update ("name", "colorHex", "isDefault", "isMe", "archived")
  on splitr."Person" to authenticated;

-- No row moves to another owner
do $$
declare t text;
begin
  foreach t in array array['PlaidItem', 'Account', 'Transaction', 'BalanceSnapshot', 'Expense', 'Item',
                           'ItemAssignment', 'ExpenseParticipant', 'Tag', '_ExpenseToTag']
  loop
    execute format('revoke update on splitr.%I from authenticated', t);
    execute format(
      'grant update (%s) on splitr.%I to authenticated',
      (select string_agg(quote_ident(column_name), ', ')
         from information_schema.columns
        where table_schema = 'splitr' and table_name = t and column_name <> 'ownerId'),
      t);
  end loop;
end $$;

alter table splitr."Person" enable row level security;
alter table splitr."PlaidItem" enable row level security;
alter table splitr."Account" enable row level security;
alter table splitr."Transaction" enable row level security;
alter table splitr."BalanceSnapshot" enable row level security;
alter table splitr."Expense" enable row level security;
alter table splitr."Item" enable row level security;
alter table splitr."ItemAssignment" enable row level security;
alter table splitr."ExpenseParticipant" enable row level security;
alter table splitr."Tag" enable row level security;
alter table splitr."_ExpenseToTag" enable row level security;

-- Owner-only tables: one policy covers read and write
create policy owner_all on splitr."PlaidItem" for all to authenticated
  using ("ownerId" = (select auth.uid())) with check ("ownerId" = (select auth.uid()));
create policy owner_all on splitr."Account" for all to authenticated
  using ("ownerId" = (select auth.uid())) with check ("ownerId" = (select auth.uid()));
create policy owner_all on splitr."Transaction" for all to authenticated
  using ("ownerId" = (select auth.uid())) with check ("ownerId" = (select auth.uid()));
create policy owner_all on splitr."BalanceSnapshot" for all to authenticated
  using ("ownerId" = (select auth.uid())) with check ("ownerId" = (select auth.uid()));
create policy owner_all on splitr."Tag" for all to authenticated
  using ("ownerId" = (select auth.uid())) with check ("ownerId" = (select auth.uid()));
create policy owner_all on splitr."_ExpenseToTag" for all to authenticated
  using ("ownerId" = (select auth.uid())) with check ("ownerId" = (select auth.uid()));

-- Shared tables: friends read, owner writes
create policy read_shared on splitr."Person" for select to authenticated
  using ("ownerId" = (select auth.uid()) or splitr.can_view_person("id"));
create policy read_shared on splitr."Expense" for select to authenticated
  using ("ownerId" = (select auth.uid()) or splitr.can_view_expense("id"));
create policy read_shared on splitr."Item" for select to authenticated
  using ("ownerId" = (select auth.uid()) or splitr.can_view_expense("expenseId"));
create policy read_shared on splitr."ExpenseParticipant" for select to authenticated
  using ("ownerId" = (select auth.uid()) or splitr.can_view_expense("expenseId"));
create policy read_shared on splitr."ItemAssignment" for select to authenticated
  using (
    "ownerId" = (select auth.uid())
    or exists (
      select 1 from splitr."Item" i
      where i."id" = "itemId" and splitr.can_view_expense(i."expenseId")
    )
  );

do $$
declare t text;
begin
  foreach t in array array['Person', 'Expense', 'Item', 'ExpenseParticipant', 'ItemAssignment']
  loop
    execute format(
      'create policy owner_insert on splitr.%I for insert to authenticated
         with check ("ownerId" = (select auth.uid()))', t);
    execute format(
      'create policy owner_update on splitr.%I for update to authenticated
         using ("ownerId" = (select auth.uid())) with check ("ownerId" = (select auth.uid()))', t);
    execute format(
      'create policy owner_delete on splitr.%I for delete to authenticated
         using ("ownerId" = (select auth.uid()))', t);
  end loop;
end $$;
