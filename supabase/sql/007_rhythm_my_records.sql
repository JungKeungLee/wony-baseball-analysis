-- ============================================================================
-- WONY RHYTHM 007 — 내 기록 조회 (001~006 다음에 실행)
--
-- 로그인 필수 정책: 최고 기록 · 최근 플레이 기록은 브라우저(localStorage)가 아니라 DB 에서만 읽는다.
-- public.rhythm_get_my_records_signed: WONY RHYTHM 서버(Render)만 호출 (서명 필요, action = 'records').
--   best   : 이 회원의 곡 · 난이도별 최고 기록 (rhythm_scores = 정상 CLEAR 만)
--   recent : 최근 플레이 기록 20개 (CLEAR · GAME OVER · NO FAIL. AUTO · PREVIEW 는 애초에 저장되지 않음)
-- 조회만 합니다 (테이블 · 데이터 변경 없음). 기존 WONY PHONE 객체는 수정하지 않습니다. 여러 번 실행해도 안전합니다.
-- ============================================================================
begin;

create or replace function public.rhythm_get_my_records_signed(p_payload text, p_signature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_body jsonb;
  v_uid  uuid;
begin
  v_body := rhythm_private.verify_request(p_payload, p_signature, 'records', false);
  v_uid := nullif(v_body ->> 'user_id', '')::uuid;
  return jsonb_build_object(
    'best', coalesce((
      select jsonb_agg(jsonb_build_object(
               'song_id', s.song_id, 'difficulty', s.difficulty, 'lane_count', s.lane_count,
               'best_score', s.best_score, 'best_grade', s.best_grade, 'best_accuracy', s.best_accuracy,
               'best_max_combo', s.best_max_combo, 'clear_count', s.clear_count, 'best_score_at', s.best_score_at)
             order by s.song_id, s.difficulty, s.lane_count)
        from public.rhythm_scores s where s.user_id = v_uid), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'song_id', r.song_id, 'difficulty', r.difficulty, 'lane_count', r.lane_count, 'note_speed', r.note_speed,
               'status', r.status, 'no_fail', r.no_fail, 'score', r.score, 'grade', r.grade, 'accuracy', r.accuracy,
               'max_combo', r.max_combo, 'perfect_count', r.perfect_count, 'great_count', r.great_count,
               'good_count', r.good_count, 'miss_count', r.miss_count, 'total_notes', r.total_notes,
               'final_life', r.final_life, 'ranked', r.ranked, 'created_at', r.created_at)
             order by r.created_at desc, r.id)
        from (select * from public.rhythm_play_records p where p.user_id = v_uid
               order by p.created_at desc, p.id limit 20) r), '[]'::jsonb)
  );
end $$;

revoke all on function public.rhythm_get_my_records_signed(text, text) from public;
grant execute on function public.rhythm_get_my_records_signed(text, text) to anon, authenticated;

commit;
