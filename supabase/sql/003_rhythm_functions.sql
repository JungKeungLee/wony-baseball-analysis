-- ============================================================================
-- WONY RHYTHM 003 — 함수 · 트리거 (002 다음에 실행)
--
-- 저장 흐름
--   게임(브라우저) → WONY RHYTHM 서버(Render, 로그인 세션 확인)
--     → public.rhythm_submit_play(payload, signature)   ← 서버만 아는 비밀값으로 HMAC 서명
--       → 서명 · 시간 · 1회용 nonce 확인 → rhythm_play_records 에 1행
--         → 트리거가 정상 클리어 판이면 rhythm_scores 최고 기록 갱신
-- 브라우저는 이 함수에 필요한 비밀값을 모르므로 직접 저장할 수 없고, user_id 도 서버가 로그인 세션에서 정합니다.
-- service role key 는 사용하지 않습니다 (Render 에는 공개 publishable key + 리듬 전용 비밀값만).
-- 모든 함수: security definer + search_path = '' (스키마를 모두 명시)
-- ============================================================================
begin;

-- ── 최고 기록 갱신 (트리거) ──────────────────────────────────────────────────
-- 정상 클리어 판만. 점수 · 등급 · 정확도 · 최대 콤보는 각각 더 좋을 때만 바뀜 (낮은 점수가 덮지 않음)
create or replace function rhythm_private.apply_best_record()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.ranked then
    return null;
  end if;
  insert into public.rhythm_scores as s (
    user_id, song_id, difficulty, lane_count,
    best_score, best_score_at, best_grade, best_accuracy, best_max_combo, best_record_id, clear_count
  ) values (
    new.user_id, new.song_id, new.difficulty, new.lane_count,
    new.score, new.created_at, new.grade, new.accuracy, new.max_combo, new.id, 1
  )
  on conflict (user_id, song_id, difficulty, lane_count) do update set
    best_score     = greatest(s.best_score, excluded.best_score),
    best_score_at  = case when excluded.best_score > s.best_score then excluded.best_score_at else s.best_score_at end,
    best_record_id = case when excluded.best_score > s.best_score then excluded.best_record_id else s.best_record_id end,
    best_grade     = case when rhythm_private.grade_rank(excluded.best_grade) < rhythm_private.grade_rank(s.best_grade)
                          then excluded.best_grade else s.best_grade end,
    best_accuracy  = greatest(s.best_accuracy, excluded.best_accuracy),
    best_max_combo = greatest(s.best_max_combo, excluded.best_max_combo),
    clear_count    = s.clear_count + 1,
    updated_at     = now();
  return null;
end $$;

drop trigger if exists rhythm_play_records_apply_best on public.rhythm_play_records;
create trigger rhythm_play_records_apply_best
  after insert on public.rhythm_play_records
  for each row execute function rhythm_private.apply_best_record();

-- ── 서버 요청 서명 확인 ──────────────────────────────────────────────────────
-- payload = 서버가 만든 JSON 문자열 그대로, signature = hex(HMAC-SHA256(server_hmac_secret, payload))
-- 확인: 비밀값 설정 · 서명 · action · 5분 이내 시각 · (저장 요청) 1회용 nonce
create or replace function rhythm_private.verify_request(p_payload text, p_signature text, p_action text, p_use_nonce boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_secret text;
  v_body   jsonb;
  v_ts     numeric;
  v_nonce  text;
begin
  select value into v_secret from rhythm_private.settings where key = 'server_hmac_secret';
  if v_secret is null then
    raise exception 'rhythm: server secret is not configured' using errcode = '55000';
  end if;
  if p_payload is null or p_signature is null or char_length(p_payload) > 8192 then
    raise exception 'rhythm: invalid request' using errcode = '22023';
  end if;
  if lower(p_signature) <> encode(extensions.hmac(p_payload, v_secret, 'sha256'), 'hex') then
    raise exception 'rhythm: invalid signature' using errcode = '28000';
  end if;
  v_body := p_payload::jsonb;
  if v_body ->> 'action' is distinct from p_action then
    raise exception 'rhythm: wrong action' using errcode = '28000';
  end if;
  v_ts := (v_body ->> 'ts')::numeric;
  if v_ts is null or abs(extract(epoch from now()) - v_ts) > 300 then
    raise exception 'rhythm: request expired' using errcode = '28000';
  end if;
  if p_use_nonce then
    v_nonce := v_body ->> 'nonce';
    delete from rhythm_private.used_nonces where expires_at < now();
    begin
      insert into rhythm_private.used_nonces (nonce, expires_at) values (v_nonce, now() + interval '10 minutes');
    exception when unique_violation then
      raise exception 'rhythm: replayed request' using errcode = '28000';
    end;
  end if;
  return v_body;
end $$;

-- ── 플레이 결과 저장 (Render 서버 전용: 서명 필요) ─────────────────────────────
-- 반환: { record_id, ranked, best: {...} | null, improved: {score, grade, accuracy, max_combo} }
create or replace function public.rhythm_submit_play(p_payload text, p_signature text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_body   jsonb;
  v_rec    jsonb;
  v_uid    uuid;
  v_before public.rhythm_scores;
  v_after  public.rhythm_scores;
  v_row    public.rhythm_play_records;
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

  select * into v_before from public.rhythm_scores s
   where s.user_id = v_uid and s.song_id = v_rec ->> 'song_id' and s.difficulty = v_rec ->> 'difficulty'
     and s.lane_count = coalesce((v_rec ->> 'lane_count')::smallint, 4);

  insert into public.rhythm_play_records (
    user_id, song_id, difficulty, lane_count, note_speed, status, no_fail, score, grade, accuracy, max_combo,
    perfect_count, great_count, good_count, miss_count, total_notes, final_life, result_version
  ) values (
    v_uid, v_rec ->> 'song_id', v_rec ->> 'difficulty', coalesce((v_rec ->> 'lane_count')::smallint, 4),
    (v_rec ->> 'note_speed')::numeric, v_rec ->> 'status', (v_rec ->> 'no_fail')::boolean,
    (v_rec ->> 'score')::integer, v_rec ->> 'grade', (v_rec ->> 'accuracy')::numeric, (v_rec ->> 'max_combo')::integer,
    (v_rec ->> 'perfect_count')::integer, (v_rec ->> 'great_count')::integer, (v_rec ->> 'good_count')::integer,
    (v_rec ->> 'miss_count')::integer, (v_rec ->> 'total_notes')::integer, (v_rec ->> 'final_life')::numeric,
    (v_rec ->> 'result_version')::smallint
  ) returning * into v_row;

  select * into v_after from public.rhythm_scores s
   where s.user_id = v_uid and s.song_id = v_row.song_id and s.difficulty = v_row.difficulty and s.lane_count = v_row.lane_count;

  return jsonb_build_object(
    'record_id', v_row.id,
    'ranked', v_row.ranked,
    'best', case when v_after.user_id is null then null else jsonb_build_object(
      'best_score', v_after.best_score, 'best_grade', v_after.best_grade,
      'best_accuracy', v_after.best_accuracy, 'best_max_combo', v_after.best_max_combo) end,
    'improved', jsonb_build_object(
      'score',     v_row.ranked and (v_before.user_id is null or v_after.best_score > v_before.best_score),
      'grade',     v_row.ranked and (v_before.user_id is null or v_after.best_grade is distinct from v_before.best_grade),
      'accuracy',  v_row.ranked and (v_before.user_id is null or v_after.best_accuracy > v_before.best_accuracy),
      'max_combo', v_row.ranked and (v_before.user_id is null or v_after.best_max_combo > v_before.best_max_combo))
  );
end $$;

-- ── 랭킹 (공통) ──────────────────────────────────────────────────────────────
-- 곡 + 난이도 + 레인 수. 회원당 최고 기록 한 줄 (rhythm_scores 가 이미 회원당 1행)
-- 닉네임 · 아바타는 profiles 의 "공개 프로필" 설정을 따름: 비공개 회원은 null (본인에게는 보임)
-- 이메일 · user_id 는 돌려주지 않음. 상위 p_limit(최대 100) + 순위 밖이어도 본인 행
create or replace function rhythm_private.ranking(p_song_id text, p_difficulty text, p_lane_count integer, p_limit integer, p_viewer uuid)
returns table (
  rank bigint, nickname text, avatar_url text, best_score integer, best_grade text,
  best_accuracy numeric, best_max_combo integer, achieved_at timestamptz, is_me boolean
) language sql stable security definer set search_path = '' as $$
  with ranked as (
    select rank() over (order by s.best_score desc, s.best_score_at asc) as rnk,
           s.user_id, s.best_score, s.best_grade, s.best_accuracy, s.best_max_combo, s.best_score_at,
           p.nickname, p.avatar_url, p.is_public
      from public.rhythm_scores s
      join public.profiles p on p.id = s.user_id
     where s.song_id = p_song_id and s.difficulty = p_difficulty and s.lane_count = coalesce(p_lane_count, 4)
  )
  select r.rnk,
         case when r.is_public or r.user_id = p_viewer then r.nickname end,
         case when r.is_public or r.user_id = p_viewer then r.avatar_url end,
         r.best_score, r.best_grade, r.best_accuracy, r.best_max_combo, r.best_score_at,
         coalesce(r.user_id = p_viewer, false)
    from ranked r
   where r.rnk <= least(greatest(coalesce(p_limit, 50), 1), 100) or r.user_id = p_viewer
   order by r.rnk, r.best_score_at
$$;

-- 랭킹: Render 서버용 (서명 필요, 조회는 nonce 없이 5분 이내 요청만)
create or replace function public.rhythm_get_ranking_signed(p_payload text, p_signature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_body jsonb;
begin
  v_body := rhythm_private.verify_request(p_payload, p_signature, 'ranking', false);
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.rank, x.achieved_at)
      from rhythm_private.ranking(v_body ->> 'song_id', v_body ->> 'difficulty',
                                  coalesce((v_body ->> 'lane_count')::integer, 4),
                                  coalesce((v_body ->> 'limit')::integer, 50),
                                  nullif(v_body ->> 'user_id', '')::uuid) x
  ), '[]'::jsonb);
end $$;

-- 랭킹: WONY PHONE 등에서 로그인 회원이 직접 조회할 때 (Supabase 세션 필요, auth.uid() = 본인)
create or replace function public.rhythm_get_ranking(p_song_id text, p_difficulty text, p_lane_count integer default 4, p_limit integer default 50)
returns table (
  rank bigint, nickname text, avatar_url text, best_score integer, best_grade text,
  best_accuracy numeric, best_max_combo integer, achieved_at timestamptz, is_me boolean
) language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'rhythm: login required' using errcode = '28000';
  end if;
  return query select * from rhythm_private.ranking(p_song_id, p_difficulty, p_lane_count, p_limit, (select auth.uid()));
end $$;

commit;
