-- Inbox.lv user survey: tables and functions for Supabase (Postgres).
--
-- Safe to run more than once: tables are created only if missing and functions are replaced.
-- It only adds objects whose names start with "survey_" / "_survey_", and never touches other tables.
--
-- Access model (same idea as the theme vote):
--   * The tables have row level security switched on and no policies, and every privilege is
--     revoked from anon / authenticated, so the public API key cannot read or write them directly.
--   * The browser only calls the survey_* functions below (RPC). They run as the table owner
--     (security definer), validate every answer against the questions stored in survey_config,
--     and return only what the respondent is allowed to see.
--   * Results are read with survey_export(token). Only the SHA-256 of the token is stored.
--
-- After running this file, load the questions with seed-questions.sql (generated from
-- questions.json) and set the results token (see the end of this file).

begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The survey definition (the content of questions.json). A single row.
create table if not exists public.survey_config (
  id boolean primary key default true check (id),
  config jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.survey_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.survey_answers (
  submission_id uuid not null references public.survey_submissions(id) on delete cascade,
  question_id text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (submission_id, question_id)
);

create table if not exists public.survey_meta (
  key text primary key,
  value text not null
);

alter table public.survey_config enable row level security;
alter table public.survey_submissions enable row level security;
alter table public.survey_answers enable row level security;
alter table public.survey_meta enable row level security;
revoke all on public.survey_config, public.survey_submissions, public.survey_answers, public.survey_meta
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable through the API)
-- ---------------------------------------------------------------------------

-- Checks one answer against its question. Mirrors public/validate.js.
-- Returns {"ok": true, "value": <value or null>} or {"ok": false, "error": "..."}.
-- A null value means "clear this answer".
create or replace function public._survey_validate(q jsonb, raw jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  kind text := q->>'type';
  is_required boolean := coalesce((q->>'required')::boolean, false);
  item jsonb;
  unique_items jsonb := '[]'::jsonb;
  seen text[] := '{}';
  num numeric;
  clean text;
begin
  if raw is null or jsonb_typeof(raw) = 'null' then
    if is_required then
      return jsonb_build_object('ok', false, 'error', 'This question is required');
    end if;
    return jsonb_build_object('ok', true, 'value', null);
  end if;

  if kind = 'single' then
    if jsonb_typeof(raw) <> 'string'
       or not exists (select 1 from jsonb_array_elements(q->'options') o where o.value->'value' = raw) then
      return jsonb_build_object('ok', false, 'error', 'Invalid answer');
    end if;
    return jsonb_build_object('ok', true, 'value', raw);

  elsif kind = 'multi' then
    if jsonb_typeof(raw) <> 'array' then
      return jsonb_build_object('ok', false, 'error', 'Invalid answer');
    end if;
    for item in select e.value from jsonb_array_elements(raw) e loop
      if jsonb_typeof(item) <> 'string'
         or not exists (select 1 from jsonb_array_elements(q->'options') o where o.value->'value' = item) then
        return jsonb_build_object('ok', false, 'error', 'Invalid answer');
      end if;
      if not ((item #>> '{}') = any (seen)) then
        seen := seen || (item #>> '{}');
        unique_items := unique_items || jsonb_build_array(item);
      end if;
    end loop;
    if jsonb_array_length(unique_items) = 0 then
      if is_required then
        return jsonb_build_object('ok', false, 'error', 'This question is required');
      end if;
      return jsonb_build_object('ok', true, 'value', null);
    end if;
    if jsonb_array_length(unique_items) > coalesce((q->>'maxSelect')::int, jsonb_array_length(q->'options')) then
      return jsonb_build_object('ok', false, 'error', 'Too many options selected');
    end if;
    return jsonb_build_object('ok', true, 'value', unique_items);

  elsif kind = 'scale' then
    if jsonb_typeof(raw) <> 'number' then
      return jsonb_build_object('ok', false, 'error', 'Invalid answer');
    end if;
    num := (raw #>> '{}')::numeric;
    if num <> trunc(num) or num < (q->>'min')::numeric or num > (q->>'max')::numeric then
      return jsonb_build_object('ok', false, 'error', 'Invalid answer');
    end if;
    return jsonb_build_object('ok', true, 'value', to_jsonb(num::int));

  elsif kind = 'text' then
    if jsonb_typeof(raw) <> 'string' then
      return jsonb_build_object('ok', false, 'error', 'Invalid answer');
    end if;
    clean := regexp_replace(raw #>> '{}', '^\s+|\s+$', '', 'g');
    if clean = '' then
      if is_required then
        return jsonb_build_object('ok', false, 'error', 'This question is required');
      end if;
      return jsonb_build_object('ok', true, 'value', null);
    end if;
    if char_length(clean) > coalesce((q->>'maxLength')::int, 1000) then
      return jsonb_build_object('ok', false, 'error', 'Text is too long');
    end if;
    return jsonb_build_object('ok', true, 'value', to_jsonb(clean));
  end if;

  return jsonb_build_object('ok', false, 'error', 'Unknown question type');
end;
$$;

-- Is the question on this respondent's path? Mirrors isQuestionVisible() in public/validate.js.
create or replace function public._survey_visible(q jsonb, answers jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when q->'visibleIf' is null then true
    when (q->'visibleIf') ? 'equals'
      then (answers -> (q->'visibleIf'->>'question')) is not distinct from (q->'visibleIf'->'equals')
    when (q->'visibleIf') ? 'notEquals'
      then (answers -> (q->'visibleIf'->>'question')) is distinct from (q->'visibleIf'->'notEquals')
    else true
  end;
$$;

-- All answers of one submission as {"question_id": value, ...}.
create or replace function public._survey_answers(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(question_id, value), '{}'::jsonb)
  from public.survey_answers
  where submission_id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Public API (called from the browser with the publishable key)
-- ---------------------------------------------------------------------------

-- The survey definition: {"intro": ..., "thanks": ..., "questions": [...]}.
create or replace function public.survey_get_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cfg jsonb;
begin
  select config into cfg from public.survey_config where id;
  if cfg is null then
    raise exception 'survey_not_configured';
  end if;
  return cfg;
end;
$$;

-- Starts a new anonymous submission and returns its random id.
create or replace function public.survey_create_submission()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  insert into public.survey_submissions default values returning id into new_id;
  return new_id;
end;
$$;

-- Lets a respondent resume: {"id": ..., "completed": bool, "answers": {...}}.
create or replace function public.survey_get_submission(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sub public.survey_submissions%rowtype;
begin
  select * into sub from public.survey_submissions where id = p_id;
  if not found then
    raise exception 'survey_not_found';
  end if;
  return jsonb_build_object(
    'id', sub.id,
    'completed', sub.completed_at is not null,
    'answers', public._survey_answers(p_id)
  );
end;
$$;

-- Saves (or clears) one answer. An answer that changes the respondent's path removes the
-- answers that no longer belong to it.
create or replace function public.survey_save_answer(p_id uuid, p_question text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  sub public.survey_submissions%rowtype;
  cfg jsonb;
  q jsonb;
  other jsonb;
  current_answers jsonb;
  checked jsonb;
begin
  -- Lock the submission so two saves for the same respondent cannot interleave.
  select * into sub from public.survey_submissions where id = p_id for update;
  if not found then
    raise exception 'survey_not_found';
  end if;

  select config into cfg from public.survey_config where id;
  if cfg is null then
    raise exception 'survey_not_configured';
  end if;

  select e.value into q from jsonb_array_elements(cfg->'questions') e where e.value->>'id' = p_question;
  if q is null then
    raise exception 'survey_question_not_found';
  end if;
  if sub.completed_at is not null then
    raise exception 'survey_already_submitted';
  end if;

  current_answers := public._survey_answers(p_id);
  if not public._survey_visible(q, current_answers) then
    raise exception 'survey_not_on_path';
  end if;

  checked := public._survey_validate(q, p_value);
  if not (checked->>'ok')::boolean then
    raise exception 'survey_invalid: %', checked->>'error';
  end if;

  if jsonb_typeof(checked->'value') = 'null' then
    delete from public.survey_answers where submission_id = p_id and question_id = p_question;
    current_answers := current_answers - p_question;
  else
    insert into public.survey_answers (submission_id, question_id, value)
      values (p_id, p_question, checked->'value')
      on conflict (submission_id, question_id)
      do update set value = excluded.value, updated_at = now();
    current_answers := current_answers || jsonb_build_object(p_question, checked->'value');
  end if;

  for other in select e.value from jsonb_array_elements(cfg->'questions') e loop
    if current_answers ? (other->>'id') and not public._survey_visible(other, current_answers) then
      delete from public.survey_answers where submission_id = p_id and question_id = other->>'id';
    end if;
  end loop;
end;
$$;

-- Finishes the survey. Returns {"ok": true} or {"ok": false, "missing": [question ids]}.
create or replace function public.survey_complete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  sub public.survey_submissions%rowtype;
  cfg jsonb;
  current_answers jsonb;
  missing jsonb;
begin
  select * into sub from public.survey_submissions where id = p_id for update;
  if not found then
    raise exception 'survey_not_found';
  end if;
  select config into cfg from public.survey_config where id;
  if cfg is null then
    raise exception 'survey_not_configured';
  end if;

  current_answers := public._survey_answers(p_id);
  select coalesce(jsonb_agg(e.value->>'id' order by e.position), '[]'::jsonb) into missing
  from jsonb_array_elements(cfg->'questions') with ordinality as e(value, position)
  where coalesce((e.value->>'required')::boolean, false)
    and public._survey_visible(e.value, current_answers)
    and not (current_answers ? (e.value->>'id'));

  if jsonb_array_length(missing) > 0 then
    return jsonb_build_object('ok', false, 'missing', missing);
  end if;

  update public.survey_submissions set completed_at = coalesce(completed_at, now()) where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Everything the results page needs: the survey definition and all submissions, oldest first.
-- Requires the secret results token.
create or replace function public.survey_export(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  expected text;
begin
  select value into expected from public.survey_meta where key = 'admin_token_sha256';
  if expected is null
     or p_token is null
     or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') <> expected then
    raise exception 'survey_unauthorized';
  end if;

  return jsonb_build_object(
    'config', (select config from public.survey_config where id),
    'submissions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'created_at', s.created_at,
          'completed_at', s.completed_at,
          'answers', coalesce(a.answers, '{}'::jsonb)
        )
        order by s.created_at, s.id
      )
      from public.survey_submissions s
      left join lateral (
        select jsonb_object_agg(question_id, value) as answers
        from public.survey_answers
        where submission_id = s.id
      ) a on true
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: only the public API functions are callable with the publishable key
-- ---------------------------------------------------------------------------

revoke all on function public._survey_validate(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public._survey_visible(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public._survey_answers(uuid) from public, anon, authenticated;

revoke all on function public.survey_get_config() from public, anon, authenticated;
revoke all on function public.survey_create_submission() from public, anon, authenticated;
revoke all on function public.survey_get_submission(uuid) from public, anon, authenticated;
revoke all on function public.survey_save_answer(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.survey_complete(uuid) from public, anon, authenticated;
revoke all on function public.survey_export(text) from public, anon, authenticated;

grant execute on function public.survey_get_config() to anon;
grant execute on function public.survey_create_submission() to anon;
grant execute on function public.survey_get_submission(uuid) to anon;
grant execute on function public.survey_save_answer(uuid, text, jsonb) to anon;
grant execute on function public.survey_complete(uuid) to anon;
grant execute on function public.survey_export(text) to anon;

commit;

-- ---------------------------------------------------------------------------
-- Results token (run once, with your own secret; never commit the secret itself).
-- Only its SHA-256 is stored, so it cannot be read back from the database.
--
--   insert into public.survey_meta (key, value)
--   values ('admin_token_sha256', encode(sha256(convert_to('PUT-A-LONG-RANDOM-SECRET-HERE', 'UTF8')), 'hex'))
--   on conflict (key) do update set value = excluded.value;
--
-- The results page is then opened as  .../inbox-survey/results.html#token=PUT-A-LONG-RANDOM-SECRET-HERE
-- ---------------------------------------------------------------------------
