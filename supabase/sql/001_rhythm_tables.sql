-- ============================================================================
-- WONY RHYTHM 001 — 테이블 (Supabase SQL Editor 에서 실행)
--
-- 리듬게임 전용 객체만 새로 만듭니다.
--   · public.rhythm_play_records  실제 플레이 기록 (CLEAR / GAME_OVER / NO FAIL 판 모두)
--   · public.rhythm_scores        회원 × 곡 × 난이도(× 레인 수) 최고 기록 (정상 CLEAR 판만)
--   · rhythm_private 스키마        서버 서명 비밀값 · 재전송 방지 nonce · 규칙 함수 (API 로 노출되지 않음)
-- 기존 auth.users / public.profiles / WONY PHONE 테이블 · RLS · 함수는 수정하지 않습니다.
--   (rhythm 테이블이 profiles(id) 를 외래키로 "참조"만 함: 회원 탈퇴 시 리듬 기록도 함께 삭제)
-- 여러 번 실행해도 안전합니다 (if not exists / create or replace).
-- ============================================================================
begin;

create extension if not exists pgcrypto with schema extensions;   -- WONY PHONE schema.sql 과 같은 위치 (이미 있으면 그대로)

create schema if not exists rhythm_private;
revoke all on schema rhythm_private from public;
revoke all on schema rhythm_private from anon, authenticated;

-- ── 기록 규칙 (게임 코드와 같은 규칙: frontend-demo/js/engine.js · judge.js · config.js) ──────────
-- 정상 클리어 판(최고 기록 · 랭킹 대상) = status CLEAR + NO FAIL 미사용.
--   AUTO / PREVIEW 판은 게임과 서버가 DB 로 보내지 않음 (shared/record_policy_cases.json 으로 세 곳 모두 테스트)
create or replace function rhythm_private.is_normal_clear(p_status text, p_no_fail boolean)
returns boolean language sql immutable set search_path = '' as $$
  select p_status = 'CLEAR' and p_no_fail = false
$$;

-- 결과 등급: 정확도(%) 기준, GAME OVER 는 F (config.js RANK_GRADES · GAME_OVER_GRADE 와 같은 값)
create or replace function rhythm_private.grade_for(p_accuracy numeric, p_status text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_status = 'GAME_OVER' then 'F'
    when p_accuracy >= 98 then 'S+'
    when p_accuracy >= 95 then 'S'
    when p_accuracy >= 90 then 'A'
    when p_accuracy >= 80 then 'B'
    when p_accuracy >= 70 then 'C'
    when p_accuracy >= 60 then 'D'
    else 'F'
  end
$$;

-- 등급 순위 (작을수록 좋음): S+ 1 … F 7
create or replace function rhythm_private.grade_rank(p_grade text)
returns integer language sql immutable set search_path = '' as $$
  select array_position(array['S+', 'S', 'A', 'B', 'C', 'D', 'F'], p_grade)
$$;

-- ── 서버 서명 비밀값 (Render 의 RHYTHM_DB_SECRET 과 같은 값, 005 파일로 넣음) ─────────────────
-- 앱(anon · authenticated)은 이 스키마에 접근할 수 없습니다. 값은 어떤 함수도 돌려주지 않습니다.
create table if not exists rhythm_private.settings (
  key         text primary key check (key in ('server_hmac_secret')),
  value       text not null check (char_length(value) between 32 and 256),
  updated_at  timestamptz not null default now()
);

-- 서명된 저장 요청의 재전송(replay) 방지: 한 번 쓴 nonce 는 10분 동안 다시 받지 않음
create table if not exists rhythm_private.used_nonces (
  nonce       text primary key check (nonce ~ '^[0-9a-f]{32}$'),
  expires_at  timestamptz not null
);

-- ── 플레이 기록 ──────────────────────────────────────────────────────────────
-- 컬럼 이름은 게임의 결과 객체(engine.resultRecord)를 snake_case 로 바꾼 것과 1:1 (js/ranking.js toRankingRow)
create table if not exists public.rhythm_play_records (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  song_id         text not null check (song_id ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  difficulty      text not null check (difficulty in ('easy', 'normal', 'hard', 'hell')),
  lane_count      smallint not null default 4 check (lane_count in (4, 6, 8)),
  note_speed      numeric(3, 2) not null check (note_speed between 0.5 and 3.0),
  status          text not null check (status in ('CLEAR', 'GAME_OVER', 'NO_FAIL_CLEAR')),
  no_fail         boolean not null,
  score           integer not null check (score >= 0),
  grade           text not null check (grade in ('S+', 'S', 'A', 'B', 'C', 'D', 'F')),
  accuracy        numeric(5, 2) not null check (accuracy between 0 and 100),
  max_combo       integer not null check (max_combo >= 0),
  perfect_count   integer not null check (perfect_count >= 0),
  great_count     integer not null check (great_count >= 0),
  good_count      integer not null check (good_count >= 0),
  miss_count      integer not null check (miss_count >= 0),
  total_notes     integer not null check (total_notes between 1 and 20000),
  final_life      numeric(4, 1) not null check (final_life between 0 and 100),
  result_version  smallint not null check (result_version between 1 and 100),
  -- 최고 기록 · 랭킹 대상 여부 (규칙은 위 함수 하나)
  ranked          boolean generated always as (rhythm_private.is_normal_clear(status, no_fail)) stored,
  created_at      timestamptz not null default now(),

  -- 결과 값 일관성 (조작 · 버그 방어). 게임 점수 규칙: PERFECT 1000 / GREAT 700 / GOOD 400 + 콤보 보너스 노트당 0~100
  constraint rhythm_play_records_counts_le_total
    check (perfect_count + great_count + good_count + miss_count <= total_notes),
  constraint rhythm_play_records_counts_complete
    check (status = 'GAME_OVER' or perfect_count + great_count + good_count + miss_count = total_notes),
  constraint rhythm_play_records_combo
    check (max_combo <= perfect_count + great_count + good_count),
  constraint rhythm_play_records_score_range
    check (score between perfect_count * 1000 + great_count * 700 + good_count * 400
                     and perfect_count * 1100 + great_count * 800 + good_count * 500),
  constraint rhythm_play_records_accuracy_consistent
    check (abs(accuracy - round((perfect_count * 100 + great_count * 80 + good_count * 50)::numeric / nullif(total_notes, 0), 2)) <= 0.01),
  constraint rhythm_play_records_grade_consistent
    check (grade = rhythm_private.grade_for(accuracy, status)),
  constraint rhythm_play_records_status_rules
    check ((status <> 'GAME_OVER' or (final_life = 0 and no_fail = false))
       and (status <> 'NO_FAIL_CLEAR' or no_fail = true)
       and (status <> 'CLEAR' or final_life > 0))
);

comment on table public.rhythm_play_records is
  'WONY RHYTHM 실제 플레이 기록 (CLEAR/GAME_OVER/NO FAIL). AUTO/PREVIEW 는 저장하지 않음. 쓰기는 public.rhythm_submit_play(서명 검증)로만.';

-- ── 최고 기록 (랭킹) ─────────────────────────────────────────────────────────
-- 회원 × 곡 × 난이도 × 레인 수(지금은 4) 당 한 행. 네 항목은 각각 따로 최고값 (게임 로컬 기록과 같은 정책)
-- 정상 클리어 판(ranked)이 저장될 때 트리거(003)가 갱신. 앱이 직접 쓰지 않음
create table if not exists public.rhythm_scores (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  song_id         text not null check (song_id ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  difficulty      text not null check (difficulty in ('easy', 'normal', 'hard', 'hell')),
  lane_count      smallint not null default 4 check (lane_count in (4, 6, 8)),
  best_score      integer not null check (best_score >= 0),
  best_score_at   timestamptz not null,           -- 같은 점수면 먼저 달성한 회원이 위
  best_grade      text not null check (best_grade in ('S+', 'S', 'A', 'B', 'C', 'D', 'F')),
  best_accuracy   numeric(5, 2) not null check (best_accuracy between 0 and 100),
  best_max_combo  integer not null check (best_max_combo >= 0),
  best_record_id  uuid references public.rhythm_play_records (id) on delete set null,
  clear_count     integer not null default 1 check (clear_count >= 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, song_id, difficulty, lane_count)
);

comment on table public.rhythm_scores is
  'WONY RHYTHM 회원별 최고 기록 (정상 CLEAR 판만, 항목별 독립 최고값). 온라인 랭킹 원본.';

commit;
