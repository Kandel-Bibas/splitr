-- The hosted project's auth.uid(): reads the sub from request.jwt.claims, which
-- asUser sets. The supabase/postgres image ships an older one that ignores it.
-- Only a superuser can replace it: run as supabase_admin (see setup.ts).
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
