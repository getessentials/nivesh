-- Distinct index_tri.index_name values, aggregated server-side (docs/09 §1's TRI presence check
-- for the Dashboard "manual step needed" banner). NOT a plain `select index_name from index_tri`
-- from the client with a `.limit()` — PostgREST's project-level max-rows setting silently caps
-- the response regardless of the client-requested limit (discovered live 2026-07-24: 9 indices ×
-- ~246 rows = 2214 total rows, well under any reasonable client-side limit, but PostgREST's own
-- cap truncated the response to ~1000 rows anyway, silently dropping whichever indices sorted
-- alphabetically past that cutoff). Aggregating DISTINCT in Postgres itself returns only the
-- ~9-20 distinct names that will ever exist here, immune to total row count entirely — this is
-- the actually-correct fix, not a bigger limit number.
create or replace function distinct_index_tri_names()
returns setof text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select distinct index_name from index_tri;
$$;

grant execute on function distinct_index_tri_names() to authenticated;
revoke execute on function distinct_index_tri_names() from public, anon;
