-- 테스트 전용: Supabase 환경 흉내 (PGlite 에서만 실행. 운영 DB 에 실행하지 마세요)
-- 역할 · auth.uid() · 기본 권한 + WONY PHONE schema.sql 의 profiles 정의 · 정책을 그대로 옮긴 것
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension pgcrypto with schema extensions;

-- Supabase 기본 권한: public 스키마의 새 테이블/함수에 anon · authenticated · service_role 권한 (004 가 회수해야 함)
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ── WONY PHONE profiles (phone-os/supabase/schema.sql 2절 · 7절과 같은 정의) ──
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  nickname    text not null check (char_length(nickname) between 1 and 30),
  avatar_url  text check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 1000)),
  role        text not null default 'user',
  is_public   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.profiles add constraint profiles_role_check check (role in ('user', 'manager', 'admin'));

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin')
$$;

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select (id, nickname, avatar_url, created_at, updated_at) on public.profiles to anon, authenticated;
grant update (nickname, avatar_url, is_public) on public.profiles to authenticated;
create policy "profiles: 공개 정보 조회" on public.profiles for select to anon, authenticated
  using (is_public or id = (select auth.uid()) or public.is_admin());
create policy "profiles: 본인 수정" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
