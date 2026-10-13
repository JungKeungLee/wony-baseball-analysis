-- ============================================================================
-- WONY RHYTHM 006 — 플레이 ID(중복 방지) · 순위 변화 · 츄르 지갑 (001~005 다음에 실행)
--
-- 1) rhythm_play_records.play_id (UNIQUE): 게임 1판 = 1 play_id. 같은 판을 다시 보내도(재시도 · 새로고침) 1번만 저장/지급
-- 2) 츄르: 지급량은 DB 설정(rhythm_reward_rules × 곡별 rhythm_song_rewards)으로 DB 가 계산. 클라이언트가 보낸 값은 받지 않음
--      지급 조건 = 랭킹 조건(rhythm_private.is_normal_clear: 정상 CLEAR + NO FAIL 미사용) — 같은 함수 하나
--      지급 기록(rhythm_churu_ledger.play_id UNIQUE)으로 판당 최대 1번
-- 3) rhythm_submit_play 가 저장 전/후 순위(같은 트랜잭션)를 함께 돌려줌 → 결과 화면 순위 변화 연출
-- 4) 랭킹 조회에 "내 주변 순위(around)" 추가
-- 기존 WONY PHONE 테이블 · RLS 는 수정하지 않습니다. 여러 번 실행해도 안전합니다.
-- (스킨 상점 테이블/구매 함수는 아직 만들지 않음: supabase/README.md "향후 스킨 상점" 참고)
-- ============================================================================
begin;

-- ── 1. 플레이 ID ─────────────────────────────────────────────────────────────
alter table public.rhythm_play_records add column if not exists play_id uuid;
create unique index if not exists rhythm_play_records_play_id_key on public.rhythm_play_records (play_id);
-- 006 이전 기록은 play_id 가 null (중복 확인 대상 아님). 006 이후 저장은 함수가 play_id 를 필수로 받음

-- ── 2. 츄르 보상 설정 (DB 가 최종 지급량을 결정) ──────────────────────────────
-- 난이도 기본값 (frontend-demo/js/config.js CHURU_REWARDS 와 같은 초기값. 이후 값 변경은 이 테이블만 고치면 됨)
create table if not exists public.rhythm_reward_rules (
  difficulty  text primary key check (difficulty in ('easy', 'normal', 'hard', 'hell')),
  base_churu  integer not null check (base_churu between 0 and 1000),
  updated_at  timestamptz not null default now()
);
insert into public.rhythm_reward_rules (difficulty, base_churu) values
  ('easy', 1), ('normal', 2), ('hard', 4), ('hell', 7)
on conflict (difficulty) do nothing;   -- 이미 운영 중 바꾼 값은 덮지 않음

-- 곡별 보상 조정 (선택, 지금은 비어 있음): 지급량 = round(기본값 × multiplier) + bonus
create table if not exists public.rhythm_song_rewards (
  song_id     text primary key check (song_id ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  multiplier  numeric(4, 2) not null default 1.00 check (multiplier between 0 and 10),
  bonus       integer not null default 0 check (bonus between 0 and 1000),
  updated_at  timestamptz not null default now()
);

-- ── 3. 츄르 지갑 · 지급 기록 ──────────────────────────────────────────────────
create table if not exists public.rhythm_wallet (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  churu_balance  integer not null default 0 check (churu_balance >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 츄르 증감 기록 (감사 · 중복 방지). 클리어 보상은 play_id 당 1행 (UNIQUE)
-- 향후 스킨 구매도 여기에 음수 amount 로 남기면 잔액을 언제든 다시 계산할 수 있음
create table if not exists public.rhythm_churu_ledger (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  play_id        uuid unique,
  amount         integer not null,
  reason         text not null check (reason in ('clear_reward')),
  balance_after  integer not null check (balance_after >= 0),
  created_at     timestamptz not null default now(),
  constraint rhythm_churu_ledger_reward_has_play check (reason <> 'clear_reward' or (play_id is not null and amount >= 0))
);
create index if not exists rhythm_churu_ledger_user_idx on public.rhythm_churu_ledger (user_id, created_at desc);

-- 지급량 계산 (DB 설정만 사용)
create or replace function rhythm_private.churu_reward(p_song_id text, p_difficulty text)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((
    select greatest(0, round(r.base_churu * coalesce(s.multiplier, 1))::integer + coalesce(s.bonus, 0))
      from public.rhythm_reward_rules r
      left join public.rhythm_song_rewards s on s.song_id = p_song_id
     where r.difficulty = p_difficulty
  ), 0)
$$;

-- 순위 (rhythm_private.ranking 과 같은 기준: 점수 높은 순, 같은 점수면 먼저 달성한 순). 기록 없으면 null
create or replace function rhythm_private.rank_of(p_user uuid, p_song_id text, p_difficulty text, p_lane_count integer)
returns integer language sql stable security definer set search_path = '' as $$
  select (select count(*)::integer + 1 from public.rhythm_scores o
           where o.song_id = me.song_id and o.difficulty = me.difficulty and o.lane_count = me.lane_count
             and (o.best_score > me.best_score or (o.best_score = me.best_score and o.best_score_at < me.best_score_at)))
    from public.rhythm_scores me
   where me.user_id = p_user and me.song_id = p_song_id and me.difficulty = p_difficulty and me.lane_count = p_lane_count
$$;

-- 결과 응답 (새 저장 / 중복 저장 모두 같은 형태)
create or replace function rhythm_private.play_outcome(p_row public.rhythm_play_records, p_duplicate boolean,
                                                       p_rank_before integer, p_best_before public.rhythm_scores)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_after  public.rhythm_scores;
  v_ledger public.rhythm_churu_ledger;
  v_total  integer;
begin
  select * into v_after from public.rhythm_scores s
   where s.user_id = p_row.user_id and s.song_id = p_row.song_id and s.difficulty = p_row.difficulty and s.lane_count = p_row.lane_count;
  select count(*)::integer into v_total from public.rhythm_scores s
   where s.song_id = p_row.song_id and s.difficulty = p_row.difficulty and s.lane_count = p_row.lane_count;
  select * into v_ledger from public.rhythm_churu_ledger l where l.play_id = p_row.play_id;
  return jsonb_build_object(
    'record_id', p_row.id,
    'play_id', p_row.play_id,
    'duplicate', p_duplicate,
    'ranked', p_row.ranked,
    'rank_before', p_rank_before,
    'rank_after', case when p_row.ranked then rhythm_private.rank_of(p_row.user_id, p_row.song_id, p_row.difficulty, p_row.lane_count) end,
    'total_ranked', v_total,
    'best_before', case when p_best_before.user_id is null then null else p_best_before.best_score end,
    'best', case when v_after.user_id is null then null else jsonb_build_object(
      'best_score', v_after.best_score, 'best_grade', v_after.best_grade,
      'best_accuracy', v_after.best_accuracy, 'best_max_combo', v_after.best_max_combo) end,
    'improved', jsonb_build_object(
      'score',     not p_duplicate and p_row.ranked and (p_best_before.user_id is null or v_after.best_score > p_best_before.best_score),
      'grade',     not p_duplicate and p_row.ranked and (p_best_before.user_id is null or v_after.best_grade is distinct from p_best_before.best_grade),
      'accuracy',  not p_duplicate and p_row.ranked and (p_best_before.user_id is null or v_after.best_accuracy > p_best_before.best_accuracy),
      'max_combo', not p_duplicate and p_row.ranked and (p_best_before.user_id is null or v_after.best_max_combo > p_best_before.best_max_combo)),
    'churu', case when v_ledger.id is null then jsonb_build_object('granted', false, 'amount', 0)
                  else jsonb_build_object('granted', true, 'amount', v_ledger.amount,
                                          'balance_before', v_ledger.balance_after - v_ledger.amount,
                                          'balance_after', v_ledger.balance_after) end
  );
end $$;

-- ── 4. 저장 함수 (003 버전을 교체: play_id 필수 · 중복 무시 · 츄르 지급 · 순위 전/후) ───────────
create or replace function public.rhythm_submit_play(p_payload text, p_signature text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_body        jsonb;
  v_rec         jsonb;
  v_uid         uuid;
  v_play        uuid;
  v_lane        smallint;
  v_existing    public.rhythm_play_records;
  v_row         public.rhythm_play_records;
  v_best_before public.rhythm_scores;
  v_rank_before integer;
  v_amount      integer;
  v_balance     integer;
begin
  v_body := rhythm_private.verify_request(p_payload, p_signature, 'submit', true);
  v_uid := (v_body ->> 'user_id')::uuid;
  if v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid) then
    raise exception 'rhythm: unknown member' using errcode = '28000';
  end if;
  v_rec := v_body -> 'record';
  if v_rec is null or jsonb_typeof(v_rec) <> 'object' then
    raise exception 'rhythm: record is missing' using errcode = '22023';
  end if;
  v_play := (v_rec ->> 'play_id')::uuid;
  if v_play is null then
    raise exception 'rhythm: play_id is required' using errcode = '22023';
  end if;
  v_lane := coalesce((v_rec ->> 'lane_count')::smallint, 4);

  -- 같은 판을 다시 보냄 → 새로 저장/지급하지 않고 처음 결과를 그대로 돌려줌
  select * into v_existing from public.rhythm_play_records r where r.play_id = v_play;
  if found then
    if v_existing.user_id <> v_uid then
      raise exception 'rhythm: play_id belongs to another member' using errcode = '22023';
    end if;
    return rhythm_private.play_outcome(v_existing, true, null, null);
  end if;

  select * into v_best_before from public.rhythm_scores s
   where s.user_id = v_uid and s.song_id = v_rec ->> 'song_id' and s.difficulty = v_rec ->> 'difficulty' and s.lane_count = v_lane;
  v_rank_before := rhythm_private.rank_of(v_uid, v_rec ->> 'song_id', v_rec ->> 'difficulty', v_lane);

  begin
    insert into public.rhythm_play_records (
      play_id, user_id, song_id, difficulty, lane_count, note_speed, status, no_fail, score, grade, accuracy, max_combo,
      perfect_count, great_count, good_count, miss_count, total_notes, final_life, result_version
    ) values (
      v_play, v_uid, v_rec ->> 'song_id', v_rec ->> 'difficulty', v_lane,
      (v_rec ->> 'note_speed')::numeric, v_rec ->> 'status', (v_rec ->> 'no_fail')::boolean,
      (v_rec ->> 'score')::integer, v_rec ->> 'grade', (v_rec ->> 'accuracy')::numeric, (v_rec ->> 'max_combo')::integer,
      (v_rec ->> 'perfect_count')::integer, (v_rec ->> 'great_count')::integer, (v_rec ->> 'good_count')::integer,
      (v_rec ->> 'miss_count')::integer, (v_rec ->> 'total_notes')::integer, (v_rec ->> 'final_life')::numeric,
      (v_rec ->> 'result_version')::smallint
    ) returning * into v_row;   -- 트리거가 정상 클리어면 rhythm_scores 갱신
  exception when unique_violation then
    -- 같은 play_id 가 동시에 두 번 들어온 경우: 먼저 저장된 쪽 결과
    select * into v_existing from public.rhythm_play_records r where r.play_id = v_play;
    if v_existing.user_id is distinct from v_uid then
      raise exception 'rhythm: play_id belongs to another member' using errcode = '22023';
    end if;
    return rhythm_private.play_outcome(v_existing, true, null, null);
  end;

  -- 츄르: 랭킹과 같은 조건(ranked = is_normal_clear). 지급량은 DB 설정으로 계산
  if v_row.ranked then
    v_amount := rhythm_private.churu_reward(v_row.song_id, v_row.difficulty);
    insert into public.rhythm_wallet as w (user_id, churu_balance) values (v_uid, v_amount)
    on conflict (user_id) do update set churu_balance = w.churu_balance + excluded.churu_balance, updated_at = now()
    returning churu_balance into v_balance;
    insert into public.rhythm_churu_ledger (user_id, play_id, amount, reason, balance_after)
    values (v_uid, v_play, v_amount, 'clear_reward', v_balance);   -- play_id UNIQUE: 판당 1번
  end if;

  return rhythm_private.play_outcome(v_row, false, v_rank_before, v_best_before);
end $$;

-- ── 5. 지갑 조회 (Render 서버 전용: 서명 필요) ─────────────────────────────────
create or replace function public.rhythm_get_wallet_signed(p_payload text, p_signature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_body jsonb;
begin
  v_body := rhythm_private.verify_request(p_payload, p_signature, 'wallet', false);
  return jsonb_build_object('churu_balance', coalesce((
    select w.churu_balance from public.rhythm_wallet w where w.user_id = nullif(v_body ->> 'user_id', '')::uuid), 0));
end $$;

-- ── 6. 랭킹: 상위 limit + 내 주변(around) ─────────────────────────────────────
create or replace function rhythm_private.ranking_window(p_song_id text, p_difficulty text, p_lane_count integer,
                                                         p_limit integer, p_viewer uuid, p_around integer)
returns table (
  rank bigint, nickname text, avatar_url text, best_score integer, best_grade text,
  best_accuracy numeric, best_max_combo integer, achieved_at timestamptz, is_me boolean
) language sql stable security definer set search_path = '' as $$
  -- rhythm_private.ranking 과 같은 순서 · 닉네임 공개 규칙. 상위 limit(최대 100) + 본인 + 본인 앞뒤 around(최대 5)
  with ranked as (
    select rank() over (order by s.best_score desc, s.best_score_at asc) as rnk,
           s.user_id, s.best_score, s.best_grade, s.best_accuracy, s.best_max_combo, s.best_score_at,
           p.nickname, p.avatar_url, p.is_public
      from public.rhythm_scores s
      join public.profiles p on p.id = s.user_id
     where s.song_id = p_song_id and s.difficulty = p_difficulty and s.lane_count = coalesce(p_lane_count, 4)
  ), me as (
    select r.rnk as my_rank from ranked r where r.user_id = p_viewer
  )
  select r.rnk,
         case when r.is_public or r.user_id = p_viewer then r.nickname end,
         case when r.is_public or r.user_id = p_viewer then r.avatar_url end,
         r.best_score, r.best_grade, r.best_accuracy, r.best_max_combo, r.best_score_at,
         coalesce(r.user_id = p_viewer, false)
    from ranked r
   where r.rnk <= least(greatest(coalesce(p_limit, 50), 1), 100)
      or r.user_id = p_viewer
      or exists (select 1 from me where abs(r.rnk - me.my_rank) <= least(greatest(coalesce(p_around, 0), 0), 5))
   order by r.rnk, r.best_score_at
$$;

create or replace function public.rhythm_get_ranking_signed(p_payload text, p_signature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_body jsonb;
begin
  v_body := rhythm_private.verify_request(p_payload, p_signature, 'ranking', false);
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.rank, x.achieved_at)
      from rhythm_private.ranking_window(v_body ->> 'song_id', v_body ->> 'difficulty',
                                         coalesce((v_body ->> 'lane_count')::integer, 4),
                                         coalesce((v_body ->> 'limit')::integer, 50),
                                         nullif(v_body ->> 'user_id', '')::uuid,
                                         coalesce((v_body ->> 'around')::integer, 0)) x
  ), '[]'::jsonb);
end $$;

-- ── 7. RLS · 권한 (004 와 같은 원칙: 앱 역할은 쓰기 불가) ─────────────────────
alter table public.rhythm_reward_rules enable row level security;
alter table public.rhythm_song_rewards enable row level security;
alter table public.rhythm_wallet enable row level security;
alter table public.rhythm_churu_ledger enable row level security;
revoke all on public.rhythm_reward_rules, public.rhythm_song_rewards, public.rhythm_wallet, public.rhythm_churu_ledger
  from public, anon, authenticated;

-- 보상 설정은 로그인 회원이 볼 수 있음 (값 변경은 SQL Editor 에서만)
grant select on public.rhythm_reward_rules, public.rhythm_song_rewards to authenticated;
drop policy if exists "rhythm_reward_rules: 로그인 회원 조회" on public.rhythm_reward_rules;
create policy "rhythm_reward_rules: 로그인 회원 조회" on public.rhythm_reward_rules for select to authenticated using (true);
drop policy if exists "rhythm_song_rewards: 로그인 회원 조회" on public.rhythm_song_rewards;
create policy "rhythm_song_rewards: 로그인 회원 조회" on public.rhythm_song_rewards for select to authenticated using (true);

-- 지갑 · 지급 기록: 본인 것만 조회
grant select on public.rhythm_wallet, public.rhythm_churu_ledger to authenticated;
drop policy if exists "rhythm_wallet: 본인 조회" on public.rhythm_wallet;
create policy "rhythm_wallet: 본인 조회" on public.rhythm_wallet for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "rhythm_churu_ledger: 본인 조회" on public.rhythm_churu_ledger;
create policy "rhythm_churu_ledger: 본인 조회" on public.rhythm_churu_ledger for select to authenticated using (user_id = (select auth.uid()));

revoke all on all functions in schema rhythm_private from public, anon, authenticated;
revoke all on function public.rhythm_submit_play(text, text) from public;
revoke all on function public.rhythm_get_ranking_signed(text, text) from public;
revoke all on function public.rhythm_get_wallet_signed(text, text) from public;
grant execute on function public.rhythm_submit_play(text, text) to anon, authenticated;
grant execute on function public.rhythm_get_ranking_signed(text, text) to anon, authenticated;
grant execute on function public.rhythm_get_wallet_signed(text, text) to anon, authenticated;

commit;
