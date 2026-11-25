-- Drizzle names every column in an insert, sending DEFAULT for the ones it
-- doesn't set, and Postgres needs insert privilege on every named column. The
-- column-limited insert grant on Person therefore refused every new contact.
-- Grant insert on the whole table and keep the rule with a trigger instead:
-- only the Worker's admin path links a contact to a Splitr user. ("ownerId"
-- stays guarded by the owner_insert policy; updates keep their column grants,
-- since an update names only the columns it changes.)

grant insert on splitr."Person" to authenticated;

create function splitr.person_link_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new."linkedUserId" is not null and current_user = 'authenticated' then
    raise exception 'Only an accepted invite links a contact to a Splitr user'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function splitr.person_link_guard() from public;

create trigger person_link_guard
  before insert on splitr."Person"
  for each row execute function splitr.person_link_guard();
