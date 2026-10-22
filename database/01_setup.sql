-- =====================================================================
-- Mapdogs: database setup, part 1 (Phase 1)
--
-- Run ONCE in Supabase: SQL Editor > New query > paste all of this > Run.
-- Creates the tables, security rules, photo storage and the functions
-- the website calls. Requirement IDs (FR-xx, NFR-xx) refer to the
-- Phase 1 requirements document.
--
-- Design notes
-- * The website never reads or writes tables directly. Row level
--   security is on for every table with no access rules, so the only
--   way in is through the functions at the bottom, which check who is
--   calling and what they may do.
-- * Contributors are Supabase "anonymous" users: no email or phone
--   (NFR-12). Their phone keeps the login; a contributor code restores
--   it on a new phone (FR-42, FR-43).
-- * Admins (Screener = parent, Reviewer = student) are ordinary email
--   and password users listed in public.admins (FR-30).
-- =====================================================================

create schema if not exists internal;
grant usage on schema internal to anon, authenticated;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- One row per person who contributes (FR-44).
create table public.contributors (
  id             uuid primary key default gen_random_uuid(),
  nickname       text not null check (char_length(nickname) between 2 and 20),
  code           text not null unique,  -- private restore code, e.g. RIYA-7KQ2XM (FR-42)
  tag            text not null,         -- public 4-digit suffix for the leaderboard (FR-28)
  blocked        boolean not null default false,   -- FR-53
  blocked_reason text,
  created_at     timestamptz not null default now()
);

-- Each phone or browser login linked to a contributor. One contributor
-- can have several (new phone, restored with the code).
create table public.contributor_devices (
  auth_uid       uuid primary key references auth.users (id) on delete cascade,
  contributor_id uuid not null references public.contributors (id) on delete cascade,
  linked_at      timestamptz not null default now()
);
create index contributor_devices_contributor_idx on public.contributor_devices (contributor_id);

-- One row per individual dog (FR-19).
create table public.dogs (
  id            bigint generated always as identity primary key,
  code          text unique,            -- PUN-0001, set automatically
  name          text check (name is null or char_length(name) between 1 and 40),
  sex           text check (sex in ('male', 'female', 'unknown')),        -- FR-20
  age_group     text check (age_group in ('puppy', 'adult', 'senior')),   -- FR-20
  notes         text check (notes is null or char_length(notes) <= 280),  -- FR-22
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  created_by    uuid references public.contributors (id) on delete set null,
  merged_into   bigint references public.dogs (id),                       -- FR-33
  -- Latest APPROVED sighting only, so unreviewed sightings never move a dog on the public map.
  last_seen_at  timestamptz,
  last_lat      double precision,
  last_lng      double precision,
  ear_notch     text,
  collar        text,
  injured       text,
  created_at    timestamptz not null default now()
);
create index dogs_status_idx on public.dogs (status);
create index dogs_created_by_idx on public.dogs (created_by);

-- One row per sighting a contributor submits (1 to 5 photos of one dog).
create table public.submissions (
  id              uuid primary key,     -- made by the phone, so photo file names can use it
  contributor_id  uuid not null references public.contributors (id),
  auth_uid        uuid not null,        -- which phone login sent it (for blocking, FR-53)
  dog_id          bigint references public.dogs (id),
  choice          text not null check (choice in ('known', 'new', 'unsure', 'add_more')),  -- FR-18, FR-23
  lat             double precision not null check (lat between -90 and 90),
  lng             double precision not null check (lng between -180 and 180),
  accuracy_m      double precision check (accuracy_m is null or accuracy_m >= 0),
  location_source text not null check (location_source in ('live', 'exif', 'manual')),     -- FR-14
  captured_at     timestamptz not null,                                                   -- FR-16
  ear_notch       text check (ear_notch in ('yes', 'no', 'unsure')),                      -- FR-21
  collar          text check (collar in ('yes', 'no', 'unsure')),
  injured         text check (injured in ('yes', 'no', 'unsure')),
  accuracy_flag   boolean generated always as (accuracy_m is not null and accuracy_m > 100) stored,  -- FR-15
  status          text not null default 'screening'
                    check (status in ('screening', 'review', 'approved', 'rejected', 'deleted')),  -- FR-51, FR-31
  reject_reason   text,
  screened_by     uuid,
  screened_at     timestamptz,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index submissions_contributor_idx on public.submissions (contributor_id, created_at desc);
create index submissions_dog_idx on public.submissions (dog_id);
create index submissions_status_idx on public.submissions (status, created_at);

-- One row per photo (FR-07, FR-08). The file itself is in Storage.
create table public.photos (
  id              uuid primary key,     -- made by the phone, matches the file name
  submission_id   uuid not null references public.submissions (id) on delete cascade,
  dog_id          bigint references public.dogs (id),   -- can be moved by an admin (FR-34)
  storage_path    text not null unique,
  angle           text not null check (angle in ('face', 'left', 'right', 'nose', 'full', 'other')),
  source          text not null check (source in ('camera', 'gallery')),  -- FR-06
  position        smallint not null check (position between 1 and 5),
  width           integer,
  height          integer,
  bytes           integer,
  exif_lat        double precision,     -- GPS read from the original photo, admin-only (NFR-11)
  exif_lng        double precision,
  exif_time       timestamptz,
  quality_warning text check (quality_warning in ('dark', 'blurry')),  -- warning shown, kept anyway (FR-10)
  flags           text[] not null default '{}',   -- admin flags (FR-35)
  hidden          boolean not null default false,
  created_at      timestamptz not null default now()
);
create index photos_dog_idx on public.photos (dog_id);
create index photos_submission_idx on public.photos (submission_id);

-- Admin accounts and their role (FR-30).
create table public.admins (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('screener', 'reviewer')),
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- Every admin action (FR-36).
create table public.admin_log (
  id            bigint generated always as identity primary key,
  admin_user_id uuid,                   -- empty when run from the SQL editor
  action        text not null,
  target_type   text not null,
  target_id     text not null,
  details       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

-- Contributor-code attempts, to stop guessing.
create table public.claim_attempts (
  id           bigint generated always as identity primary key,
  auth_uid     uuid not null,
  success      boolean not null,
  attempted_at timestamptz not null default now()
);
create index claim_attempts_uid_idx on public.claim_attempts (auth_uid, attempted_at desc);

-- Lock every table: no direct access from the website.
alter table public.contributors        enable row level security;
alter table public.contributor_devices enable row level security;
alter table public.dogs                enable row level security;
alter table public.submissions         enable row level security;
alter table public.photos              enable row level security;
alter table public.admins              enable row level security;
alter table public.admin_log           enable row level security;
alter table public.claim_attempts      enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Dog codes: PUN-0001, PUN-0002, ...
create function internal.set_dog_code() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.code := 'PUN-' || lpad(new.id::text, 4, '0');
  return new;
end;
$$;
create trigger dogs_set_code before insert on public.dogs
  for each row execute function internal.set_dog_code();

-- ---------------------------------------------------------------------
-- Internal helpers (not callable from the website)
-- ---------------------------------------------------------------------

create function internal.my_contributor_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select d.contributor_id
  from public.contributor_devices d
  where d.auth_uid = auth.uid();
$$;

create function internal.admin_role() returns text
language sql stable security definer set search_path = '' as $$
  select a.role from public.admins a where a.user_id = auth.uid();
$$;

create function internal.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

create function internal.require_role(p_roles text[]) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(internal.admin_role() = any (p_roles), false) is not true then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
end;
$$;

-- Can the person calling upload photos? (used by the Storage rule)
create function internal.can_upload() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.contributor_devices d
    join public.contributors c on c.id = d.contributor_id
    where d.auth_uid = auth.uid() and not c.blocked
  );
$$;

-- Can the person calling see this photo file? (used by the Storage rule)
-- Yes when: it is approved and not hidden (FR-50), or it is their own
-- and not removed (FR-48), or they are an admin, or they have just
-- uploaded it and not yet submitted.
create function internal.can_view_photo(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select
    split_part(p_path, '/', 1) = coalesce(auth.uid()::text, '-')
    or internal.is_admin()
    or exists (
      select 1
      from public.photos p
      join public.submissions s on s.id = p.submission_id
      where p.storage_path = p_path
        and not p.hidden
        and (
          s.status = 'approved'
          or (s.contributor_id = internal.my_contributor_id()
              and s.status in ('screening', 'review'))
        )
    );
$$;

-- Distance in metres between two points (haversine).
create function internal.distance_m(lat1 double precision, lng1 double precision,
                                    lat2 double precision, lng2 double precision)
returns double precision
language sql immutable set search_path = '' as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- Random characters from a strong random source, without look-alikes (0/O, 1/I/L).
create function internal.random_chars(p_len int) returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  result text := '';
  i int;
begin
  -- Bytes 0-5 and 16-21 are fully random in version 4 UUIDs.
  for i in 0 .. p_len - 1 loop
    result := result || substr(alphabet, (get_byte(b, case when i < 6 then i else 10 + i end) % 31) + 1, 1);
  end loop;
  return result;
end;
$$;

-- Contributor profile with counts and leaderboard rank (FR-28, FR-29, FR-45).
create function internal.profile_json(p_contributor uuid) returns json
language sql stable security definer set search_path = '' as $$
  with counts as (
    select c.id,
           count(s.id) filter (where s.status = 'approved') as approved,
           count(s.id) filter (where s.status in ('screening', 'review', 'approved')) as total
    from public.contributors c
    left join public.submissions s on s.contributor_id = c.id
    group by c.id
  ),
  ranked as (
    select id, approved, total,
           case when approved > 0 then rank() over (order by approved desc) end as rank
    from counts
  )
  select json_build_object(
    'contributor_id', c.id,
    'nickname', c.nickname,
    'code', c.code,
    'tag', c.tag,
    'blocked', c.blocked,
    'approved_count', r.approved,
    'total_count', r.total,
    'rank', case when r.approved > 0 then r.rank end
  )
  from public.contributors c
  join ranked r on r.id = c.id
  where c.id = p_contributor;
$$;

-- Approve one submission: used by review_approve below, and can be run
-- directly from the SQL editor while the admin pages are being built.
create function internal.apply_approval(p_submission uuid, p_admin uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.submissions;
begin
  select * into s from public.submissions where id = p_submission for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if s.status not in ('screening', 'review') then
    raise exception 'wrong_status' using errcode = 'P0001';
  end if;
  if s.dog_id is null then
    -- "Not sure" sightings need a dog chosen first (FR-32).
    raise exception 'needs_dog' using errcode = 'P0001';
  end if;

  update public.submissions
     set status = 'approved',
         reviewed_by = p_admin,
         reviewed_at = now(),
         screened_at = coalesce(screened_at, now()),
         screened_by = coalesce(screened_by, p_admin)
   where id = p_submission;

  update public.dogs d
     set status = 'approved',
         last_seen_at = s.captured_at,
         last_lat = s.lat,
         last_lng = s.lng,
         ear_notch = coalesce(s.ear_notch, d.ear_notch),
         collar = coalesce(s.collar, d.collar),
         injured = coalesce(s.injured, d.injured)
   where d.id = s.dog_id
     and (d.last_seen_at is null or d.last_seen_at <= s.captured_at);

  -- Older sighting approved after a newer one: still approve the dog.
  update public.dogs set status = 'approved'
   where id = s.dog_id and status = 'pending';

  insert into public.admin_log (admin_user_id, action, target_type, target_id)
  values (p_admin, 'approve', 'submission', p_submission::text);
end;
$$;

-- ---------------------------------------------------------------------
-- Functions the contributor website calls
-- ---------------------------------------------------------------------

-- First visit: create the contributor for this phone (FR-02, FR-42, FR-44).
-- Safe to call twice; returns the existing profile.
create function public.register_contributor(p_nickname text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_cid  uuid;
  v_nick text;
  v_prefix text;
  v_code text;
  v_tag  text;
  v_try  int := 0;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  v_cid := internal.my_contributor_id();
  if v_cid is not null then
    return internal.profile_json(v_cid);
  end if;

  v_nick := btrim(regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]|\s+', ' ', 'g'));
  if char_length(v_nick) < 2 or char_length(v_nick) > 20 then
    raise exception 'bad_nickname' using errcode = 'P0001';
  end if;

  v_prefix := left(upper(regexp_replace(v_nick, '[^A-Za-z]', '', 'g')), 4);
  if char_length(v_prefix) < 2 then
    v_prefix := 'DOGS';
  end if;

  loop
    v_try := v_try + 1;
    v_code := v_prefix || '-' || internal.random_chars(6);
    exit when not exists (select 1 from public.contributors where code = v_code);
    if v_try > 20 then
      raise exception 'code_failed' using errcode = 'P0001';
    end if;
  end loop;

  v_tag := lpad(((get_byte(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 0) * 256
                + get_byte(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 1)) % 9000 + 1000)::text, 4, '0');

  insert into public.contributors (nickname, code, tag)
  values (v_nick, v_code, v_tag)
  returning id into v_cid;

  insert into public.contributor_devices (auth_uid, contributor_id) values (v_uid, v_cid);

  return internal.profile_json(v_cid);
end;
$$;

-- Profile for the home screen; null if this phone is not linked yet.
create function public.my_profile() returns json
language sql stable security definer set search_path = '' as $$
  select internal.profile_json(internal.my_contributor_id());
$$;

-- Restore a contributor on a new phone with their code (FR-43).
-- At most 10 wrong attempts per hour per phone.
create function public.claim_code(p_code text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_cid uuid;
  v_clean text;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  if (select count(*) from public.claim_attempts
      where auth_uid = v_uid and not success and attempted_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;

  v_clean := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  select id into v_cid from public.contributors
   where replace(code, '-', '') = v_clean;

  insert into public.claim_attempts (auth_uid, success) values (v_uid, v_cid is not null);

  -- Not an error, so the failed attempt above is kept and counts towards the limit.
  if v_cid is null then
    return json_build_object('error', 'code_not_found');
  end if;

  insert into public.contributor_devices (auth_uid, contributor_id)
  values (v_uid, v_cid)
  on conflict (auth_uid) do update set contributor_id = excluded.contributor_id, linked_at = now();

  return internal.profile_json(v_cid);
end;
$$;

-- "Is it one of these?" (FR-17): dogs within p_radius_m metres, nearest
-- first. Approved dogs for everyone; dogs still under review only for
-- the contributor who submitted them.
create function public.nearby_dogs(p_lat double precision, p_lng double precision,
                                   p_radius_m integer default 500)
returns table (
  dog_id       bigint,
  code         text,
  name         text,
  last_seen_at timestamptz,
  distance_m   integer,
  is_pending   boolean,
  photo_count  integer,
  thumb_path   text
)
language sql stable security definer set search_path = '' as $$
  with me as (
    select internal.my_contributor_id() as cid,
           least(greatest(coalesce(p_radius_m, 500), 50), 2000) as radius
  ),
  candidates as (
    select d.id, d.code, d.name, d.last_seen_at, d.last_lat as lat, d.last_lng as lng, false as is_pending
    from public.dogs d
    where d.status = 'approved' and d.merged_into is null
    union all
    select d.id, d.code, d.name, s.captured_at, s.lat, s.lng, true
    from public.dogs d
    cross join me
    join lateral (
      select s.captured_at, s.lat, s.lng
      from public.submissions s
      where s.dog_id = d.id and s.contributor_id = me.cid
        and s.status in ('screening', 'review')
      order by s.captured_at desc
      limit 1
    ) s on true
    where d.status = 'pending' and d.merged_into is null and d.created_by = me.cid
  ),
  near as (
    select c.*, internal.distance_m(p_lat, p_lng, c.lat, c.lng) as dist
    from candidates c, me
    where c.lat between p_lat - me.radius / 111000.0 and p_lat + me.radius / 111000.0
      and internal.distance_m(p_lat, p_lng, c.lat, c.lng) <= me.radius
  ),
  visible as (
    select p.dog_id, p.storage_path, p.angle, p.created_at
    from public.photos p
    join public.submissions s on s.id = p.submission_id
    cross join me
    where not p.hidden
      and (s.status = 'approved'
           or (s.contributor_id = me.cid and s.status in ('screening', 'review')))
  )
  select n.id, n.code, n.name, n.last_seen_at, round(n.dist)::integer, n.is_pending,
         (select count(*)::integer from visible v where v.dog_id = n.id),
         (select v.storage_path from visible v where v.dog_id = n.id
          order by case v.angle when 'face' then 0 when 'full' then 1 when 'left' then 2
                                when 'right' then 3 else 4 end,
                   v.created_at desc
          limit 1)
  from near n
  order by n.dist
  limit 20;
$$;

-- Photos of one dog for comparing (FR-46): same visibility as above.
create function public.dog_photos(p_dog_id bigint)
returns table (storage_path text, angle text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.storage_path, p.angle, p.created_at
  from public.photos p
  join public.submissions s on s.id = p.submission_id
  where p.dog_id = p_dog_id
    and not p.hidden
    and (s.status = 'approved'
         or (s.contributor_id = internal.my_contributor_id() and s.status in ('screening', 'review')))
  order by case p.angle when 'face' then 0 when 'full' then 1 when 'left' then 2
                        when 'right' then 3 else 4 end,
           p.created_at desc
  limit 12;
$$;

-- Save a sighting after its photos are uploaded.
-- Safe to call again with the same id (after a network failure).
create function public.submit_sighting(p jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_cid     uuid;
  v_blocked boolean;
  v_id      uuid;
  v_choice  text;
  v_dog     bigint;
  v_photos  jsonb;
  v_photo   jsonb;
  v_prefix  text;
  v_path    text;
  v_pos     int := 0;
  v_time    timestamptz;
  v_result  json;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  select c.id, c.blocked into v_cid, v_blocked
  from public.contributor_devices d
  join public.contributors c on c.id = d.contributor_id
  where d.auth_uid = v_uid;
  if v_cid is null then
    raise exception 'not_registered' using errcode = 'P0001';
  end if;
  if v_blocked then
    raise exception 'blocked' using errcode = 'P0001';   -- FR-53
  end if;

  v_id := (p ->> 'id')::uuid;
  if v_id is null then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;

  -- Same sighting sent twice: return what was saved the first time.
  select s.dog_id into v_dog from public.submissions s
   where s.id = v_id and s.contributor_id = v_cid;
  if found then
    return json_build_object(
      'submission_id', v_id,
      'dog_id', v_dog,
      'dog_code', (select code from public.dogs where id = v_dog),
      'dog_name', (select name from public.dogs where id = v_dog),
      'dog_photo_count', (select count(*) from public.dog_photos(v_dog)));
  end if;

  -- About 30 sightings per hour per contributor (NFR-13).
  if (select count(*) from public.submissions
      where contributor_id = v_cid and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  v_photos := p -> 'photos';
  if jsonb_typeof(v_photos) <> 'array'
     or jsonb_array_length(v_photos) < 1 or jsonb_array_length(v_photos) > 5 then
    raise exception 'bad_photos' using errcode = 'P0001';   -- FR-07
  end if;

  v_choice := p ->> 'choice';
  if v_choice in ('known', 'add_more') then
    v_dog := (p ->> 'dog_id')::bigint;
    if not exists (
      select 1 from public.dogs d
      where d.id = v_dog and d.merged_into is null
        and (d.status = 'approved' or (d.status = 'pending' and d.created_by = v_cid))
    ) then
      raise exception 'dog_not_found' using errcode = 'P0001';
    end if;
  elsif v_choice = 'new' then
    insert into public.dogs (name, sex, age_group, notes, created_by)
    values (
      nullif(left(btrim(p -> 'new_dog' ->> 'name'), 40), ''),
      nullif(p -> 'new_dog' ->> 'sex', ''),
      nullif(p -> 'new_dog' ->> 'age_group', ''),
      nullif(left(btrim(p -> 'new_dog' ->> 'notes'), 280), ''),
      v_cid)
    returning id into v_dog;
  elsif v_choice = 'unsure' then
    v_dog := null;
  else
    raise exception 'bad_choice' using errcode = 'P0001';
  end if;

  -- The phone's clock decides the time, but not more than a day ahead.
  v_time := least(coalesce((p ->> 'captured_at')::timestamptz, now()), now() + interval '1 day');

  insert into public.submissions (
    id, contributor_id, auth_uid, dog_id, choice, lat, lng, accuracy_m, location_source,
    captured_at, ear_notch, collar, injured)
  values (
    v_id, v_cid, v_uid, v_dog, v_choice,
    (p ->> 'lat')::double precision, (p ->> 'lng')::double precision,
    (p ->> 'accuracy_m')::double precision, p ->> 'location_source',
    v_time,
    nullif(p ->> 'ear_notch', ''), nullif(p ->> 'collar', ''), nullif(p ->> 'injured', ''));

  -- Photo files must be in this phone's own folder for this sighting.
  v_prefix := v_uid::text || '/' || v_id::text || '/';
  for v_photo in select * from jsonb_array_elements(v_photos) loop
    v_pos := v_pos + 1;
    v_path := v_photo ->> 'path';
    if v_path is null or left(v_path, length(v_prefix)) <> v_prefix
       or v_path !~ '^[0-9a-f-]+/[0-9a-f-]+/[0-9a-f-]+\.jpg$' then
      raise exception 'bad_photo_path' using errcode = 'P0001';
    end if;
    insert into public.photos (
      id, submission_id, dog_id, storage_path, angle, source, position,
      width, height, bytes, exif_lat, exif_lng, exif_time, quality_warning)
    values (
      (v_photo ->> 'id')::uuid, v_id, v_dog, v_path,
      v_photo ->> 'angle', v_photo ->> 'source', v_pos,
      (v_photo ->> 'width')::integer, (v_photo ->> 'height')::integer, (v_photo ->> 'bytes')::integer,
      (v_photo ->> 'exif_lat')::double precision, (v_photo ->> 'exif_lng')::double precision,
      (v_photo ->> 'exif_time')::timestamptz,
      nullif(v_photo ->> 'quality_warning', ''));
  end loop;

  select json_build_object(
    'submission_id', v_id,
    'dog_id', v_dog,
    'dog_code', d.code,
    'dog_name', d.name,
    'dog_photo_count', (select count(*) from public.dog_photos(v_dog)))
  into v_result
  from (select 1) x
  left join public.dogs d on d.id = v_dog;

  return v_result;
end;
$$;

-- "My contributions" (FR-29).
create function public.my_submissions(p_limit integer default 50)
returns table (
  submission_id uuid,
  created_at    timestamptz,
  status        text,
  reject_reason text,
  choice        text,
  dog_id        bigint,
  dog_code      text,
  dog_name      text,
  photo_count   integer,
  thumb_path    text
)
language sql stable security definer set search_path = '' as $$
  select s.id, s.created_at, s.status, s.reject_reason, s.choice,
         d.id, d.code, d.name,
         (select count(*)::integer from public.photos p where p.submission_id = s.id),
         case when s.status in ('screening', 'review', 'approved') then
           (select p.storage_path from public.photos p
             where p.submission_id = s.id and not p.hidden
             order by p.position limit 1)
         end
  from public.submissions s
  left join public.dogs d on d.id = s.dog_id
  where s.contributor_id = internal.my_contributor_id()
  order by s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- ---------------------------------------------------------------------
-- Functions the admin pages will call (pages come in build step 5)
-- ---------------------------------------------------------------------

-- Who am I as an admin? null for everyone else.
create function public.admin_me() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('role', a.role, 'display_name', a.display_name)
  from public.admins a where a.user_id = auth.uid();
$$;

-- Screener clears submissions to the Reviewer queue (FR-51, FR-52).
create function public.screen_clear(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  perform internal.require_role(array['screener']);
  update public.submissions
     set status = 'review', screened_by = auth.uid(), screened_at = now()
   where id = any (p_ids) and status = 'screening';
  get diagnostics v_count = row_count;
  insert into public.admin_log (admin_user_id, action, target_type, target_id, details)
  select auth.uid(), 'screen_clear', 'submission', x::text, '{}'::jsonb from unnest(p_ids) x;
  return v_count;
end;
$$;

-- Screener deletes submissions (FR-52). Returns the photo files for the
-- page to remove from Storage.
create function public.screen_delete(p_ids uuid[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  v_paths text[];
begin
  perform internal.require_role(array['screener']);
  select coalesce(array_agg(p.storage_path), '{}') into v_paths
  from public.photos p
  join public.submissions s on s.id = p.submission_id
  where s.id = any (p_ids) and s.status in ('screening', 'review');

  update public.submissions
     set status = 'deleted', screened_by = auth.uid(), screened_at = now()
   where id = any (p_ids) and status in ('screening', 'review');

  update public.photos set hidden = true
   where submission_id = any (p_ids);

  -- A new dog whose only sightings are deleted disappears too.
  update public.dogs d set status = 'rejected'
   where d.status = 'pending'
     and d.id in (select dog_id from public.submissions where id = any (p_ids))
     and not exists (select 1 from public.submissions s
                     where s.dog_id = d.id and s.status in ('screening', 'review', 'approved'));

  insert into public.admin_log (admin_user_id, action, target_type, target_id)
  select auth.uid(), 'screen_delete', 'submission', x::text from unnest(p_ids) x;
  return v_paths;
end;
$$;

-- Reviewer approves (FR-31).
create function public.review_approve(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.require_role(array['reviewer', 'screener']);
  if (select status from public.submissions where id = p_id) <> 'review' then
    raise exception 'wrong_status' using errcode = 'P0001';
  end if;
  perform internal.apply_approval(p_id, auth.uid());
end;
$$;

-- Reviewer rejects with a reason (FR-31).
create function public.review_reject(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_dog bigint;
begin
  perform internal.require_role(array['reviewer', 'screener']);
  update public.submissions
     set status = 'rejected', reject_reason = left(nullif(btrim(p_reason), ''), 200),
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id and status = 'review'
  returning dog_id into v_dog;
  if not found then
    raise exception 'wrong_status' using errcode = 'P0001';
  end if;
  update public.dogs d set status = 'rejected'
   where d.id = v_dog and d.status = 'pending'
     and not exists (select 1 from public.submissions s
                     where s.dog_id = d.id and s.status in ('screening', 'review', 'approved'));
  insert into public.admin_log (admin_user_id, action, target_type, target_id, details)
  values (auth.uid(), 'reject', 'submission', p_id::text, jsonb_build_object('reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------

revoke execute on all functions in schema internal from public, anon, authenticated;
grant execute on function internal.can_view_photo(text) to anon, authenticated;
grant execute on function internal.can_upload() to authenticated;
grant execute on function internal.is_admin() to anon, authenticated;
grant execute on function internal.my_contributor_id() to anon, authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.register_contributor(text) to authenticated;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.claim_code(text) to authenticated;
grant execute on function public.nearby_dogs(double precision, double precision, integer) to authenticated;
grant execute on function public.dog_photos(bigint) to authenticated;
grant execute on function public.submit_sighting(jsonb) to authenticated;
grant execute on function public.my_submissions(integer) to authenticated;
grant execute on function public.admin_me() to authenticated;
grant execute on function public.screen_clear(uuid[]) to authenticated;
grant execute on function public.screen_delete(uuid[]) to authenticated;
grant execute on function public.review_approve(uuid) to authenticated;
grant execute on function public.review_reject(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Photo storage
-- ---------------------------------------------------------------------

-- Private bucket: photos are only shown through the rules below.
-- JPEG only, at most 2 MB each (the website sends about 200 KB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

-- Contributors upload only into their own folder, and not when blocked.
create policy "mapdogs: contributors upload own photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (select internal.can_upload())
);

-- Viewing follows internal.can_view_photo above.
create policy "mapdogs: view approved or own photos"
on storage.objects for select to anon, authenticated
using (bucket_id = 'photos' and internal.can_view_photo(name));

-- Only admins remove photo files (FR-52).
create policy "mapdogs: admins delete photos"
on storage.objects for delete to authenticated
using (bucket_id = 'photos' and (select internal.is_admin()));

-- Done.
select 'Mapdogs database is ready' as result;
