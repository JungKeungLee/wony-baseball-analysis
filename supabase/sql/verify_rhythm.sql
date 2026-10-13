-- ============================================================================
-- WONY RHYTHM — 적용 확인 (001~006 실행 후 SQL Editor 에서 실행)
-- 데이터를 만들거나 바꾸지 않습니다 (조회만). 비밀값은 출력하지 않고 "설정됨/길이"만 봅니다.
-- 결과의 ok 가 모두 true 면 정상. false 인 줄의 check 이름을 알려주세요.
-- ============================================================================
with checks(check_name, ok, detail) as (
  -- 1. 테이블 / 스키마
  select 'table public.rhythm_play_records', to_regclass('public.rhythm_play_records') is not null, ''
  union all select 'table public.rhythm_scores', to_regclass('public.rhythm_scores') is not null, ''
  union all select 'schema rhythm_private', exists (select 1 from pg_namespace where nspname = 'rhythm_private'), ''
  union all select 'table rhythm_private.settings', to_regclass('rhythm_private.settings') is not null, ''
  union all select 'table rhythm_private.used_nonces', to_regclass('rhythm_private.used_nonces') is not null, ''

  -- 2. 컬럼
  union all select 'rhythm_play_records columns',
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'rhythm_play_records'
       and column_name in ('id','user_id','song_id','difficulty','lane_count','note_speed','status','no_fail','score','grade',
                           'accuracy','max_combo','perfect_count','great_count','good_count','miss_count','total_notes',
                           'final_life','result_version','ranked','created_at')) = 21, '21개 컬럼'
  union all select 'rhythm_scores columns',
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'rhythm_scores'
       and column_name in ('user_id','song_id','difficulty','lane_count','best_score','best_score_at','best_grade',
                           'best_accuracy','best_max_combo','best_record_id','clear_count','created_at','updated_at')) = 13, '13개 컬럼'
  union all select 'rhythm_scores primary key (user, song, difficulty, lane_count)',
    exists (select 1 from pg_constraint where conrelid = 'public.rhythm_scores'::regclass and contype = 'p'), ''
  union all select 'rhythm_play_records 일관성 제약 7개',
    (select count(*) from pg_constraint where conrelid = 'public.rhythm_play_records'::regclass and conname like 'rhythm_play_records_%' and contype = 'c') >= 7, ''

  -- 3. 인덱스
  union all select 'index rhythm_scores_ranking_idx', to_regclass('public.rhythm_scores_ranking_idx') is not null, ''
  union all select 'index rhythm_play_records_user_recent_idx', to_regclass('public.rhythm_play_records_user_recent_idx') is not null, ''
  union all select 'index rhythm_play_records_song_recent_idx', to_regclass('public.rhythm_play_records_song_recent_idx') is not null, ''
  union all select 'index rhythm_scores_best_record_idx', to_regclass('public.rhythm_scores_best_record_idx') is not null, ''
  union all select 'index rhythm_used_nonces_expires_idx', to_regclass('rhythm_private.rhythm_used_nonces_expires_idx') is not null, ''

  -- 4. 함수 · 트리거
  union all select 'function public.rhythm_submit_play', to_regprocedure('public.rhythm_submit_play(text,text)') is not null, ''
  union all select 'function public.rhythm_get_ranking_signed', to_regprocedure('public.rhythm_get_ranking_signed(text,text)') is not null, ''
  union all select 'function public.rhythm_get_ranking', to_regprocedure('public.rhythm_get_ranking(text,text,integer,integer)') is not null, ''
  union all select 'trigger rhythm_play_records_apply_best',
    exists (select 1 from pg_trigger where tgrelid = 'public.rhythm_play_records'::regclass and tgname = 'rhythm_play_records_apply_best' and not tgisinternal), ''
  union all select 'functions are security definer + search_path=''''',
    (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
       from pg_proc p where p.oid in (to_regprocedure('public.rhythm_submit_play(text,text)'),
                                      to_regprocedure('public.rhythm_get_ranking_signed(text,text)'),
                                      to_regprocedure('public.rhythm_get_ranking(text,text,integer,integer)'),
                                      to_regprocedure('rhythm_private.verify_request(text,text,text,boolean)'),
                                      to_regprocedure('rhythm_private.apply_best_record()'))), ''

  -- 5. RLS · 정책
  union all select 'RLS enabled: rhythm_play_records', (select relrowsecurity from pg_class where oid = 'public.rhythm_play_records'::regclass), ''
  union all select 'RLS enabled: rhythm_scores', (select relrowsecurity from pg_class where oid = 'public.rhythm_scores'::regclass), ''
  union all select 'policy: rhythm_scores 로그인 회원 랭킹 조회',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'rhythm_scores' and cmd = 'SELECT' and roles = '{authenticated}'), ''
  union all select 'policy: rhythm_play_records 본인 기록 조회',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'rhythm_play_records' and cmd = 'SELECT'
             and roles = '{authenticated}' and qual like '%auth.uid()%'), ''
  union all select 'rhythm 테이블에 INSERT/UPDATE/DELETE 정책 없음',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('rhythm_scores', 'rhythm_play_records') and cmd <> 'SELECT'), ''

  -- 6. 권한 (앱 역할)
  union all select 'anon: rhythm 테이블 권한 없음',
    not (has_table_privilege('anon', 'public.rhythm_scores', 'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('anon', 'public.rhythm_play_records', 'SELECT,INSERT,UPDATE,DELETE')), ''
  union all select 'authenticated: SELECT 만 (쓰기 권한 없음)',
    has_table_privilege('authenticated', 'public.rhythm_scores', 'SELECT')
    and has_table_privilege('authenticated', 'public.rhythm_play_records', 'SELECT')
    and not has_table_privilege('authenticated', 'public.rhythm_scores', 'INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated', 'public.rhythm_play_records', 'INSERT,UPDATE,DELETE'), ''
  union all select 'anon/authenticated: rhythm_private 스키마 사용 불가',
    not has_schema_privilege('anon', 'rhythm_private', 'USAGE') and not has_schema_privilege('authenticated', 'rhythm_private', 'USAGE'), ''
  union all select 'anon: 서명 함수만 실행 가능',
    has_function_privilege('anon', 'public.rhythm_submit_play(text,text)', 'EXECUTE')
    and has_function_privilege('anon', 'public.rhythm_get_ranking_signed(text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.rhythm_get_ranking(text,text,integer,integer)', 'EXECUTE'), ''
  union all select 'authenticated: 랭킹 직접 조회 함수 실행 가능',
    has_function_privilege('authenticated', 'public.rhythm_get_ranking(text,text,integer,integer)', 'EXECUTE'), ''

  -- 7. 서버 비밀값 (값은 출력하지 않음)
  union all select 'server secret configured (005)',
    exists (select 1 from rhythm_private.settings where key = 'server_hmac_secret' and char_length(value) >= 32),
    coalesce((select '길이 ' || char_length(value) || '자, 마지막 변경 ' || to_char(updated_at, 'YYYY-MM-DD HH24:MI')
                from rhythm_private.settings where key = 'server_hmac_secret'), '없음 → 005 실행 필요')

  -- 9. 006: 플레이 ID · 츄르 지갑
  union all select '006 play_id unique index', to_regclass('public.rhythm_play_records_play_id_key') is not null, ''
  union all select '006 tables (reward_rules, song_rewards, wallet, churu_ledger)',
    to_regclass('public.rhythm_reward_rules') is not null and to_regclass('public.rhythm_song_rewards') is not null
    and to_regclass('public.rhythm_wallet') is not null and to_regclass('public.rhythm_churu_ledger') is not null, ''
  union all select '006 reward rules (easy/normal/hard/hell)',
    (select count(*) from public.rhythm_reward_rules) = 4,
    (select string_agg(difficulty || '=' || base_churu, ', ' order by base_churu) from public.rhythm_reward_rules)
  union all select '006 function rhythm_get_wallet_signed', to_regprocedure('public.rhythm_get_wallet_signed(text,text)') is not null, ''
  union all select '006 RLS enabled: wallet · ledger · rules',
    (select bool_and(relrowsecurity) from pg_class where oid in ('public.rhythm_wallet'::regclass, 'public.rhythm_churu_ledger'::regclass,
                                                                 'public.rhythm_reward_rules'::regclass, 'public.rhythm_song_rewards'::regclass)), ''
  union all select '006 지갑 · 지급 기록: 앱 쓰기 권한 없음',
    not has_table_privilege('authenticated', 'public.rhythm_wallet', 'INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated', 'public.rhythm_churu_ledger', 'INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated', 'public.rhythm_reward_rules', 'INSERT,UPDATE,DELETE')
    and not has_table_privilege('anon', 'public.rhythm_wallet', 'SELECT,INSERT,UPDATE,DELETE'), ''
  union all select '006 policy: 지갑 본인 조회',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'rhythm_wallet' and cmd = 'SELECT' and qual like '%auth.uid()%'), ''
  union all select '006 anon: 지갑 서명 함수만',
    has_function_privilege('anon', 'public.rhythm_get_wallet_signed(text,text)', 'EXECUTE'), ''

  -- 8. 규칙 함수 (게임 config.js 와 같은 값인지)
  union all select 'rule: 정상 클리어 = CLEAR + NO FAIL 미사용',
    rhythm_private.is_normal_clear('CLEAR', false) and not rhythm_private.is_normal_clear('CLEAR', true)
    and not rhythm_private.is_normal_clear('GAME_OVER', false) and not rhythm_private.is_normal_clear('NO_FAIL_CLEAR', true), ''
  union all select 'rule: 등급 경계 (98/95/90/80/70/60, GAME OVER = F)',
    rhythm_private.grade_for(98, 'CLEAR') = 'S+' and rhythm_private.grade_for(97.99, 'CLEAR') = 'S'
    and rhythm_private.grade_for(60, 'CLEAR') = 'D' and rhythm_private.grade_for(59.99, 'CLEAR') = 'F'
    and rhythm_private.grade_for(100, 'GAME_OVER') = 'F', ''
)
select check_name, ok, detail from checks order by ok, check_name;

-- 참고: 기존 WONY PHONE profiles 정책이 그대로인지 눈으로 확인 (적용 전후 결과가 같아야 함)
select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'profiles' order by policyname;

-- 참고: 지금까지 쌓인 리듬 데이터 양 (개인정보 없이 개수만)
select (select count(*) from public.rhythm_play_records) as play_records,
       (select count(*) from public.rhythm_scores) as best_records;
