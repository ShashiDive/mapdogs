-- =====================================================================
-- Mapdogs: database setup, part 3 (Phase 1, build step 5: admin pages)
--
-- Run ONCE in Supabase: SQL Editor > New query > paste all of this > Run.
-- Needs parts 1 and 2 to have been run first.
--
-- Adds the functions behind the admin pages: the Screener and Reviewer
-- queues, labelling, merging, moving and flagging photos, blocking,
-- the dog list, the export and the activity log. Every function checks
-- the caller's admin role first (FR-30).
-- =====================================================================

-- Brings a dog's status and last-seen details in line with its approved,
-- visible photos. Used after labelling, merging, moving and flagging.
create function internal.refresh_dog(p_dog bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  latest public.submissions;
begin
  if p_dog is null then return; end if;
  select s.* into latest
  from public.submissions s
  join public.photos p on p.submission_id = s.id
  where p.dog_id = p_dog and not p.hidden and s.status = 'approved'
  order by s.captured_at desc
  limit 1;

  if found then
    update public.dogs
       set status = 'approved',
           last_seen_at = latest.captured_at,
           last_lat = latest.lat,
           last_lng = latest.lng,
           ear_notch = coalesce(latest.ear_notch, ear_notch),
           collar = coalesce(latest.collar, collar),
           injured = coalesce(latest.injured, injured)
     where id = p_dog and merged_into is null;
  else
    update public.dogs d
       set last_seen_at = null, last_lat = null, last_lng = null,
           status = case when exists (
               select 1 from public.photos p
               join public.submissions s on s.id = p.submission_id
               where p.dog_id = d.id and s.status in ('screening', 'review'))
             then 'pending' else 'rejected' end
     where d.id = p_dog and d.merged_into is null;
  end if;
end;
$$;

create function internal.log_action(p_action text, p_type text, p_id text, p_details jsonb default '{}')
returns void
language sql security definer set search_path = '' as $$
  insert into public.admin_log (admin_user_id, action, target_type, target_id, details)
  values (auth.uid(), p_action, p_type, p_id, coalesce(p_details, '{}'));
$$;

-- One submission as the admin pages need it, with exact location (NFR-09).
create function internal.submission_json(p_id uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'id', s.id,
    'status', s.status,
    'created_at', s.created_at,
    'captured_at', s.captured_at,
    'choice', s.choice,
    'lat', s.lat,
    'lng', s.lng,
    'accuracy_m', s.accuracy_m,
    'accuracy_flag', s.accuracy_flag,
    'location_source', s.location_source,
    'ear_notch', s.ear_notch,
    'collar', s.collar,
    'injured', s.injured,
    'contributor', json_build_object('id', c.id, 'nickname', c.nickname, 'tag', c.tag, 'blocked', c.blocked),
    'dog', case when d.id is null then null else
             json_build_object('id', d.id, 'code', d.code, 'name', d.name, 'status', d.status,
                               'sex', d.sex, 'age_group', d.age_group, 'notes', d.notes) end,
    'photos', coalesce((
      select json_agg(json_build_object(
               'id', p.id, 'path', p.storage_path, 'angle', p.angle, 'source', p.source,
               'quality_warning', p.quality_warning, 'flags', p.flags, 'hidden', p.hidden,
               'dog_id', p.dog_id, 'exif_lat', p.exif_lat, 'exif_lng', p.exif_lng)
             order by p.position)
      from public.photos p where p.submission_id = s.id), '[]'::json)
  )
  from public.submissions s
  join public.contributors c on c.id = s.contributor_id
  left join public.dogs d on d.id = s.dog_id
  where s.id = p_id;
$$;

-- Screening queue (Screener only, FR-51) or review queue (FR-31), oldest first.
create function public.admin_queue(p_status text) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_status = 'screening' then
    perform internal.require_role(array['screener']);
  elsif p_status = 'review' then
    perform internal.require_role(array['reviewer', 'screener']);
  else
    raise exception 'bad_request' using errcode = 'P0001';
  end if;
  return coalesce((
    select json_agg(internal.submission_json(s.id) order by s.created_at)
    from (select id, created_at from public.submissions
          where status = p_status order by created_at limit 200) s
  ), '[]'::json);
end;
$$;

-- Choose or change the dog for a sighting (FR-32). p_dog = null with
-- p_new_name given (or empty) creates a new dog.
create function public.admin_set_dog(p_submission uuid, p_dog bigint, p_new_name text default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s public.submissions;
  v_target bigint := p_dog;
begin
  perform internal.require_role(array['reviewer', 'screener']);
  select * into s from public.submissions where id = p_submission for update;
  if not found or s.status not in ('review', 'approved') then
    raise exception 'wrong_status' using errcode = 'P0001';
  end if;
  if v_target is null then
    insert into public.dogs (name, created_by)
    values (nullif(left(btrim(coalesce(p_new_name, '')), 40), ''), s.contributor_id)
    returning id into v_target;
  elsif not exists (select 1 from public.dogs where id = v_target and merged_into is null) then
    raise exception 'dog_not_found' using errcode = 'P0001';
  end if;

  update public.submissions set dog_id = v_target where id = p_submission;
  update public.photos set dog_id = v_target
   where submission_id = p_submission and dog_id is not distinct from s.dog_id;

  perform internal.refresh_dog(s.dog_id);
  perform internal.refresh_dog(v_target);
  perform internal.log_action('set_dog', 'submission', p_submission::text,
    jsonb_build_object('from_dog', s.dog_id, 'to_dog', v_target));
  return internal.submission_json(p_submission);
end;
$$;

-- Merge one dog record into another (FR-33).
create function public.admin_merge_dogs(p_from bigint, p_into bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  f public.dogs;
begin
  perform internal.require_role(array['reviewer', 'screener']);
  if p_from = p_into then
    raise exception 'same_dog' using errcode = 'P0001';
  end if;
  select * into f from public.dogs where id = p_from and merged_into is null for update;
  if not found or not exists (select 1 from public.dogs where id = p_into and merged_into is null) then
    raise exception 'dog_not_found' using errcode = 'P0001';
  end if;

  update public.photos set dog_id = p_into where dog_id = p_from;
  update public.submissions set dog_id = p_into where dog_id = p_from;
  update public.dogs set merged_into = p_into where merged_into = p_from;
  update public.dogs set merged_into = p_into where id = p_from;
  update public.dogs
     set name = coalesce(name, f.name),
         sex = coalesce(sex, f.sex),
         age_group = coalesce(age_group, f.age_group),
         notes = coalesce(notes, f.notes)
   where id = p_into;

  perform internal.refresh_dog(p_into);
  perform internal.log_action('merge', 'dog', p_from::text, jsonb_build_object('into', p_into));
end;
$$;

-- Move one photo to another dog, or to a new dog when p_dog is null (FR-34).
create function public.admin_move_photo(p_photo uuid, p_dog bigint, p_new_name text default null)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  ph public.photos;
  v_target bigint := p_dog;
  v_contributor uuid;
begin
  perform internal.require_role(array['reviewer', 'screener']);
  select * into ph from public.photos where id = p_photo for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_target is null then
    select contributor_id into v_contributor from public.submissions where id = ph.submission_id;
    insert into public.dogs (name, created_by)
    values (nullif(left(btrim(coalesce(p_new_name, '')), 40), ''), v_contributor)
    returning id into v_target;
  elsif not exists (select 1 from public.dogs where id = v_target and merged_into is null) then
    raise exception 'dog_not_found' using errcode = 'P0001';
  end if;

  update public.photos set dog_id = v_target where id = p_photo;
  perform internal.refresh_dog(ph.dog_id);
  perform internal.refresh_dog(v_target);
  perform internal.log_action('move_photo', 'photo', p_photo::text,
    jsonb_build_object('from_dog', ph.dog_id, 'to_dog', v_target));
  return v_target;
end;
$$;

-- Flag a photo; any flag hides it from the public (FR-35). Empty flags un-hide.
create function public.admin_flag_photo(p_photo uuid, p_flags text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_dog bigint;
  v_flags text[] := coalesce(p_flags, '{}');
begin
  perform internal.require_role(array['reviewer', 'screener']);
  if not v_flags <@ array['blurry', 'multiple_dogs', 'people_or_plates'] then
    raise exception 'bad_flags' using errcode = 'P0001';
  end if;
  update public.photos
     set flags = v_flags, hidden = cardinality(v_flags) > 0
   where id = p_photo
  returning dog_id into v_dog;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform internal.refresh_dog(v_dog);
  perform internal.log_action('flag_photo', 'photo', p_photo::text, jsonb_build_object('flags', v_flags));
end;
$$;

-- Edit a dog's details (FR-31).
create function public.admin_update_dog(p_dog bigint, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.require_role(array['reviewer', 'screener']);
  update public.dogs
     set name = nullif(left(btrim(coalesce(p ->> 'name', '')), 40), ''),
         sex = nullif(p ->> 'sex', ''),
         age_group = nullif(p ->> 'age_group', ''),
         notes = nullif(left(btrim(coalesce(p ->> 'notes', '')), 280), '')
   where id = p_dog and merged_into is null;
  if not found then
    raise exception 'dog_not_found' using errcode = 'P0001';
  end if;
  perform internal.log_action('edit_dog', 'dog', p_dog::text, p);
end;
$$;

-- Block or unblock a contributor (FR-53).
create function public.admin_block_contributor(p_contributor uuid, p_block boolean, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.require_role(array['reviewer', 'screener']);
  update public.contributors
     set blocked = p_block,
         blocked_reason = case when p_block then left(nullif(btrim(p_reason), ''), 200) end
   where id = p_contributor;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform internal.log_action(case when p_block then 'block' else 'unblock' end,
                              'contributor', p_contributor::text,
                              jsonb_build_object('reason', p_reason));
end;
$$;

-- Dog list for searching and choosing: by code or name, or nearest to a spot.
create function public.admin_dogs(p_search text default null,
                                  p_lat double precision default null,
                                  p_lng double precision default null)
returns json
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform internal.require_role(array['reviewer', 'screener']);
  return coalesce((
    select json_agg(row_to_json(x) order by x.sort_key, x.id)
    from (
      select d.id, d.code, d.name, d.status, d.last_seen_at, d.ear_notch,
             (select count(*) from public.photos p where p.dog_id = d.id and not p.hidden) as photo_count,
             (select p.storage_path from public.photos p where p.dog_id = d.id and not p.hidden
               order by case p.angle when 'face' then 0 when 'full' then 1 else 2 end, p.created_at desc
               limit 1) as thumb_path,
             loc.lat is not null and p_lat is not null as has_distance,
             case when loc.lat is not null and p_lat is not null
                  then round(internal.distance_m(p_lat, p_lng, loc.lat, loc.lng))::int end as distance_m,
             case when v_q is null and p_lat is not null and loc.lat is not null
                  then internal.distance_m(p_lat, p_lng, loc.lat, loc.lng)
                  else -d.id end as sort_key
      from public.dogs d
      left join lateral (
        select coalesce(d.last_lat, s.lat) as lat, coalesce(d.last_lng, s.lng) as lng
        from public.submissions s where s.dog_id = d.id order by s.created_at desc limit 1
      ) loc on true
      where d.merged_into is null and d.status <> 'rejected'
        and (v_q is null
             or d.code ilike '%' || v_q || '%'
             or d.name ilike '%' || v_q || '%')
        and (v_q is not null or p_lat is null or loc.lat is null
             or internal.distance_m(p_lat, p_lng, loc.lat, loc.lng) <= 1000)
      order by sort_key, d.id
      limit 50
    ) x
  ), '[]'::json);
end;
$$;

-- One dog with every photo, including hidden ones, for the Dogs page.
create function public.admin_dog_detail(p_dog bigint) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.require_role(array['reviewer', 'screener']);
  return (
    select json_build_object(
      'id', d.id, 'code', d.code, 'name', d.name, 'status', d.status,
      'sex', d.sex, 'age_group', d.age_group, 'notes', d.notes,
      'ear_notch', d.ear_notch, 'last_seen_at', d.last_seen_at,
      'photos', coalesce((
        select json_agg(json_build_object(
                 'id', p.id, 'path', p.storage_path, 'angle', p.angle, 'flags', p.flags,
                 'hidden', p.hidden, 'created_at', p.created_at, 'submission_status', s.status,
                 'contributor', c.nickname || ' #' || c.tag)
               order by p.created_at desc)
        from public.photos p
        join public.submissions s on s.id = p.submission_id
        join public.contributors c on c.id = s.contributor_id
        where p.dog_id = d.id and s.status <> 'deleted'), '[]'::json)
    )
    from public.dogs d
    where d.id = p_dog and d.merged_into is null
  );
end;
$$;

-- Everything for the ZIP export (FR-38, FR-39). Deleted sightings are left out.
create function public.admin_export() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.require_role(array['reviewer', 'screener']);
  return json_build_object(
    'exported_at', now(),
    'dogs', coalesce((
      select json_agg(json_build_object(
        'dog_id', d.code, 'name', d.name, 'status', d.status, 'sex', d.sex,
        'age_group', d.age_group, 'notes', d.notes, 'ear_notch', d.ear_notch,
        'collar', d.collar, 'injured', d.injured, 'last_seen_at', d.last_seen_at,
        'last_lat', d.last_lat, 'last_lng', d.last_lng, 'created_at', d.created_at,
        'merged_into', (select m.code from public.dogs m where m.id = d.merged_into))
        order by d.id)
      from public.dogs d), '[]'::json),
    'photos', coalesce((
      select json_agg(json_build_object(
        'photo_id', p.id, 'path', p.storage_path, 'dog_id', d.code, 'angle', p.angle,
        'source', p.source, 'width', p.width, 'height', p.height, 'bytes', p.bytes,
        'quality_warning', p.quality_warning, 'flags', array_to_string(p.flags, ' '),
        'hidden', p.hidden, 'sighting_id', s.id, 'sighting_status', s.status,
        'choice', s.choice, 'lat', s.lat, 'lng', s.lng, 'accuracy_m', s.accuracy_m,
        'location_source', s.location_source, 'captured_at', s.captured_at,
        'ear_notch', s.ear_notch, 'collar', s.collar, 'injured', s.injured,
        'exif_lat', p.exif_lat, 'exif_lng', p.exif_lng, 'exif_time', p.exif_time,
        'contributor', c.nickname || ' #' || c.tag, 'uploaded_at', p.created_at)
        order by s.created_at, p.position)
      from public.photos p
      join public.submissions s on s.id = p.submission_id
      join public.contributors c on c.id = s.contributor_id
      left join public.dogs d on d.id = p.dog_id
      where s.status <> 'deleted'), '[]'::json)
  );
end;
$$;

-- Recent admin actions (FR-36).
create function public.admin_activity(p_limit integer default 100) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.require_role(array['reviewer', 'screener']);
  return coalesce((
    select json_agg(row_to_json(x))
    from (
      select l.created_at, l.action, l.target_type, l.target_id, l.details,
             coalesce(a.display_name, 'SQL editor') as admin
      from public.admin_log l
      left join public.admins a on a.user_id = l.admin_user_id
      order by l.id desc
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x
  ), '[]'::json);
end;
$$;

revoke execute on all functions in schema internal from public, anon, authenticated;
grant execute on function internal.can_view_photo(text) to anon, authenticated;
grant execute on function internal.can_upload() to authenticated;
grant execute on function internal.is_admin() to anon, authenticated;
grant execute on function internal.my_contributor_id() to anon, authenticated;

revoke execute on function
  public.admin_queue(text), public.admin_set_dog(uuid, bigint, text),
  public.admin_merge_dogs(bigint, bigint), public.admin_move_photo(uuid, bigint, text),
  public.admin_flag_photo(uuid, text[]), public.admin_update_dog(bigint, jsonb),
  public.admin_block_contributor(uuid, boolean, text),
  public.admin_dogs(text, double precision, double precision), public.admin_dog_detail(bigint),
  public.admin_export(), public.admin_activity(integer)
from public, anon;
grant execute on function
  public.admin_queue(text), public.admin_set_dog(uuid, bigint, text),
  public.admin_merge_dogs(bigint, bigint), public.admin_move_photo(uuid, bigint, text),
  public.admin_flag_photo(uuid, text[]), public.admin_update_dog(bigint, jsonb),
  public.admin_block_contributor(uuid, boolean, text),
  public.admin_dogs(text, double precision, double precision), public.admin_dog_detail(bigint),
  public.admin_export(), public.admin_activity(integer)
to authenticated;

select 'Mapdogs admin is ready' as result;
