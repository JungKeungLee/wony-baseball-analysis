-- ============================================================================
-- WONY RHYTHM — 되돌리기 (문제가 생겼을 때만 실행)
--
-- 리듬게임이 새로 만든 객체만 지웁니다:
--   public.rhythm_play_records · public.rhythm_scores (안의 플레이 기록 · 최고 기록 포함)
--   public.rhythm_wallet · rhythm_churu_ledger · rhythm_reward_rules · rhythm_song_rewards (006, 츄르 잔액 포함)
--   public.rhythm_submit_play · rhythm_get_ranking_signed · rhythm_get_ranking · rhythm_get_wallet_signed · rhythm_get_my_records_signed
--   rhythm_private 스키마 전체 (서버 비밀값 · nonce · 규칙 함수)
-- auth.users · public.profiles · 기존 WONY PHONE 테이블 / 정책 / 함수 / 데이터는 지우거나 바꾸지 않습니다.
--   (rhythm 테이블의 profiles 외래키는 rhythm 테이블과 함께 사라질 뿐 profiles 자체는 그대로)
-- pgcrypto 확장은 WONY PHONE 도 쓰므로 지우지 않습니다.
--
-- ⚠️ 리듬게임 온라인 기록이 모두 삭제됩니다. 기록을 남기려면 먼저 Table Editor 에서 CSV 로 내려받으세요.
--    (게임의 로컬 기록(브라우저 localStorage)은 영향 없음)
-- 다시 쓰려면 001 → 007 을 처음부터 다시 실행하면 됩니다.
-- ============================================================================
begin;

drop function if exists public.rhythm_submit_play(text, text);
drop function if exists public.rhythm_get_ranking_signed(text, text);
drop function if exists public.rhythm_get_ranking(text, text, integer, integer);
drop function if exists public.rhythm_get_wallet_signed(text, text);
drop function if exists public.rhythm_get_my_records_signed(text, text);

-- 006 (없으면 건너뜀)
-- play_outcome 은 테이블 행 형식을 매개변수로 받으므로 테이블보다 먼저 삭제
drop function if exists rhythm_private.play_outcome(public.rhythm_play_records, boolean, integer, public.rhythm_scores);
drop table if exists public.rhythm_churu_ledger;
drop table if exists public.rhythm_wallet;
drop table if exists public.rhythm_song_rewards;
drop table if exists public.rhythm_reward_rules;

-- rhythm_scores 가 rhythm_play_records 를 참조하므로 먼저 삭제 (트리거 · 정책 · 인덱스는 테이블과 함께 삭제)
drop table if exists public.rhythm_scores;
drop table if exists public.rhythm_play_records;

-- 남은 리듬 전용 함수 · 비밀값 · nonce (다른 스키마의 객체는 이 스키마에 의존하지 않음)
drop schema if exists rhythm_private cascade;

commit;
