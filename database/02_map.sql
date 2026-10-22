-- =====================================================================
-- Mapdogs: database setup, part 2 (Phase 1, build step 4: public map)
--
-- Run ONCE in Supabase: SQL Editor > New query > paste all of this > Run.
-- Needs part 1 (01_setup.sql) to have been run first.
--
-- Adds the read-only functions behind the public map and leaderboard.
-- Anyone can call them, including visitors who never sign in. Public
-- locations are rounded to about 100 m (NFR-09).
-- =====================================================================

-- Rounds a coordinate to 3 decimal places: about 110 m north-south and
-- 105 m east-west in Pune.
create function internal.round_coord(v double precision) returns double precision
language sql immutable set search_path = '' as $$
  select round(v::numeric, 3)::double precision;
$$;

-- Approved dogs at their last approved sighting (FR-24, FR-25).
create function public.map_dogs()
returns table (
  dog_id       bigint,
  code         text,
  name         text,
  lat          double precision,
  lng          double precision,
  last_seen_at timestamptz,
  ear_notch    text,
  photo_count  integer,
  thumb_path   text
)
language sql stable security definer set search_path = '' as $$
  with visible as (
    select p.dog_id, p.storage_path, p.angle, p.created_at
    from public.photos p
    join public.submissions s on s.id = p.submission_id
    where s.status = 'approved' and not p.hidden
  )
  select d.id, d.code, d.name,
         internal.round_coord(d.last_lat), internal.round_coord(d.last_lng),
         d.last_seen_at, d.ear_notch,
         (select count(*)::integer from visible v where v.dog_id = d.id),
         (select v.storage_path from visible v where v.dog_id = d.id
          order by case v.angle when 'face' then 0 when 'full' then 1 when 'left' then 2
                                when 'right' then 3 else 4 end,
                   v.created_at desc
          limit 1)
  from public.dogs d
  where d.status = 'approved' and d.merged_into is null and d.last_lat is not null
  order by d.id;
$$;

-- Sightings still being checked (FR-48, FR-49).
-- The contributor's own: exact spot, dog and photo, shown as Under review.
-- Everyone else's: a rounded spot only, no photo and no dog details.
create function public.map_pending()
returns table (
  is_mine      boolean,
  lat          double precision,
  lng          double precision,
  created_at   timestamptz,
  dog_code     text,
  dog_name     text,
  thumb_path   text
)
language sql stable security definer set search_path = '' as $$
  with me as (select internal.my_contributor_id() as cid)
  select
    (s.contributor_id = me.cid) is true as mine,
    case when s.contributor_id = me.cid then s.lat else internal.round_coord(s.lat) end,
    case when s.contributor_id = me.cid then s.lng else internal.round_coord(s.lng) end,
    s.created_at,
    case when s.contributor_id = me.cid then d.code end,
    case when s.contributor_id = me.cid then d.name end,
    case when s.contributor_id = me.cid then
      (select p.storage_path from public.photos p
        where p.submission_id = s.id and not p.hidden
        order by p.position limit 1)
    end
  from public.submissions s
  cross join me
  join public.contributors c on c.id = s.contributor_id
  left join public.dogs d on d.id = s.dog_id
  where s.status in ('screening', 'review') and not c.blocked
  order by s.created_at desc
  limit 500;
$$;

-- Running totals (FR-27).
create function public.map_stats() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'dogs', (select count(*) from public.dogs
              where status = 'approved' and merged_into is null),
    'photos', (select count(*) from public.photos p
                 join public.submissions s on s.id = p.submission_id
                where s.status = 'approved' and not p.hidden),
    'contributors', (select count(distinct s.contributor_id) from public.submissions s
                       join public.contributors c on c.id = s.contributor_id
                      where s.status = 'approved' and not c.blocked)
  );
$$;

-- Leaderboard of individual contributors by approved sightings (FR-28).
-- Shows nickname and the public 4-digit number, never the private code.
create function public.leaderboard(p_limit integer default 50)
returns table (
  rank           integer,
  nickname       text,
  tag            text,
  approved_count integer,
  is_me          boolean
)
language sql stable security definer set search_path = '' as $$
  with counts as (
    select c.id, c.nickname, c.tag, count(*)::integer as approved
    from public.contributors c
    join public.submissions s on s.contributor_id = c.id and s.status = 'approved'
    where not c.blocked
    group by c.id
  )
  select (rank() over (order by approved desc))::integer, nickname, tag, approved,
         id = internal.my_contributor_id()
  from counts
  order by approved desc, nickname
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

revoke execute on function internal.round_coord(double precision) from public, anon, authenticated;
revoke execute on function public.map_dogs(), public.map_pending(), public.map_stats(),
                           public.leaderboard(integer) from public;
grant execute on function public.map_dogs(), public.map_pending(), public.map_stats(),
                          public.leaderboard(integer) to anon, authenticated;

select 'Mapdogs map is ready' as result;
