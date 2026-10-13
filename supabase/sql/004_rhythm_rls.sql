-- ============================================================================
-- WONY RHYTHM 004 — RLS · 권한 (003 다음에 실행)
--
--                          anon(비로그인)   authenticated(로그인 회원)      Render 서버
--   rhythm_play_records     권한 없음        본인 기록만 SELECT              rhythm_submit_play (서명)
--   rhythm_scores           권한 없음        SELECT (랭킹)                   (트리거가 갱신)
--   INSERT/UPDATE/DELETE    없음             없음 → 다른 회원 기록 수정·삭제 불가, user_id 위조 저장 불가
--   rhythm_private 스키마   접근 불가        접근 불가
-- Supabase 는 public 스키마 새 테이블에 anon · authenticated 권한을 기본으로 주므로, 먼저 전부 회수한 뒤 필요한 것만 다시 줍니다.
-- 기존 WONY PHONE 테이블의 RLS · 정책은 건드리지 않습니다. 여러 번 실행해도 안전합니다.
-- ============================================================================
begin;

alter table public.rhythm_play_records enable row level security;
alter table public.rhythm_scores enable row level security;

revoke all on public.rhythm_play_records from public, anon, authenticated;
revoke all on public.rhythm_scores from public, anon, authenticated;

-- 랭킹: 로그인 회원은 최고 기록 조회 가능 (닉네임은 profiles 정책/공개 설정을 따름)
grant select on public.rhythm_scores to authenticated;
drop policy if exists "rhythm_scores: 로그인 회원 랭킹 조회" on public.rhythm_scores;
create policy "rhythm_scores: 로그인 회원 랭킹 조회" on public.rhythm_scores
  for select to authenticated using (true);

-- 플레이 기록: 본인 것만 조회
grant select on public.rhythm_play_records to authenticated;
drop policy if exists "rhythm_play_records: 본인 기록 조회" on public.rhythm_play_records;
create policy "rhythm_play_records: 본인 기록 조회" on public.rhythm_play_records
  for select to authenticated using (user_id = (select auth.uid()));
-- INSERT / UPDATE / DELETE 정책 없음 + 권한 없음 = 앱에서 직접 쓰기 불가 (저장은 서명된 함수로만)

-- 비공개 스키마: 앱에서 접근 불가
revoke all on all tables in schema rhythm_private from public, anon, authenticated;
revoke all on all functions in schema rhythm_private from public, anon, authenticated;
alter table rhythm_private.settings enable row level security;
alter table rhythm_private.used_nonces enable row level security;

-- 공개 함수 실행 권한
revoke all on function public.rhythm_submit_play(text, text) from public;
revoke all on function public.rhythm_get_ranking_signed(text, text) from public;
revoke all on function public.rhythm_get_ranking(text, text, integer, integer) from public, anon;
-- 서명 함수: publishable key(anon) 로 호출하지만 서버 비밀값으로 서명된 요청만 통과
grant execute on function public.rhythm_submit_play(text, text) to anon, authenticated;
grant execute on function public.rhythm_get_ranking_signed(text, text) to anon, authenticated;
-- 로그인 회원 직접 조회용 (WONY PHONE 등)
grant execute on function public.rhythm_get_ranking(text, text, integer, integer) to authenticated;

commit;
