-- =====================================================================
-- Mapdogs: database setup, part 4 (Phase 1, build step 6)
--
-- Run ONCE in Supabase: SQL Editor > New query > paste all of this > Run.
-- Needs parts 1 to 3 to have been run first.
--
-- Adds the details screen for one of your own sightings (FR-55).
-- =====================================================================

-- Who can see a photo file. Same as before, plus: contributors can always
-- see their own photos while a sighting is waiting or approved, even ones a
-- reviewer hid from the public (FR-55).
create or replace function internal.can_view_photo(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select
    split_part(p_path, '/', 1) = coalesce(auth.uid()::text, '-')
    or internal.is_admin()
    or exists (
      select 1
      from public.photos p
      join public.submissions s on s.id = p.submission_id
      where p.storage_path = p_path
        and (
          (s.status = 'approved' and not p.hidden)
          or (s.contributor_id = internal.my_contributor_id()
              and s.status in ('screening', 'review', 'approved'))
        )
    );
$$;

-- One of the caller's own sightings, with every photo and answer (FR-55).
-- Rejected and deleted sightings come back without photos.
create function public.my_submission_detail(p_id uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'id', s.id,
    'status', s.status,
    'reject_reason', s.reject_reason,
    'created_at', s.created_at,
    'captured_at', s.captured_at,
    'choice', s.choice,
    'location_source', s.location_source,
    'ear_notch', s.ear_notch,
    'collar', s.collar,
    'injured', s.injured,
    'dog', case when d.id is null then null else json_build_object(
             'id', d.id, 'code', d.code, 'name', d.name, 'sex', d.sex,
             'age_group', d.age_group, 'notes', d.notes, 'status', d.status) end,
    'photos', case when s.status in ('rejected', 'deleted') then '[]'::json else coalesce((
      select json_agg(json_build_object(
               'path', p.storage_path, 'angle', p.angle, 'source', p.source,
               'hidden', p.hidden,
               'moved_to', case when p.dog_id is distinct from s.dog_id then pd.code end)
             order by p.position)
      from public.photos p
      left join public.dogs pd on pd.id = p.dog_id
      where p.submission_id = s.id), '[]'::json) end
  )
  from public.submissions s
  left join public.dogs d on d.id = s.dog_id
  where s.id = p_id
    and s.contributor_id = internal.my_contributor_id();
$$;

revoke execute on function public.my_submission_detail(uuid) from public, anon;
grant execute on function public.my_submission_detail(uuid) to authenticated;

select 'Mapdogs sighting details are ready' as result;
