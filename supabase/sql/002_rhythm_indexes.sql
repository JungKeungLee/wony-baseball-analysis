-- ============================================================================
-- WONY RHYTHM 002 — 인덱스 (001 다음에 실행)
-- 곡 + 난이도 랭킹 조회, 내 최근 기록 조회, 만료 nonce 정리를 빠르게 합니다. 여러 번 실행해도 안전합니다.
-- ============================================================================
begin;

-- 랭킹: 곡 + 난이도 + 레인 수 안에서 점수 높은 순, 같은 점수면 먼저 달성한 순
create index if not exists rhythm_scores_ranking_idx
  on public.rhythm_scores (song_id, difficulty, lane_count, best_score desc, best_score_at asc);

-- 내 기록: 회원별 최근 플레이
create index if not exists rhythm_play_records_user_recent_idx
  on public.rhythm_play_records (user_id, created_at desc);

-- 곡별 최근 플레이 (운영 확인 · 향후 통계)
create index if not exists rhythm_play_records_song_recent_idx
  on public.rhythm_play_records (song_id, difficulty, created_at desc);

-- best_record_id 외래키 (플레이 기록 삭제 시 on delete set null 처리용)
create index if not exists rhythm_scores_best_record_idx
  on public.rhythm_scores (best_record_id);

-- 만료된 nonce 정리
create index if not exists rhythm_used_nonces_expires_idx
  on rhythm_private.used_nonces (expires_at);

commit;
