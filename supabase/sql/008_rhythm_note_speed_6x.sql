-- ============================================================================
-- WONY RHYTHM 008 — 노트 배속 목록 변경 (001~007 다음에 실행)
--
-- 게임의 노트 배속 선택지가 1x / 1.5x / 2x / 3x / 4x / 6x 로 바뀌었다 (frontend-demo/js/config.js NOTE_SPEEDS).
-- 001 의 rhythm_play_records.note_speed 제약(0.5 ~ 3.0)이면 4x · 6x 기록이 거절되므로 범위를 0.5 ~ 6.0 으로 넓힌다.
-- (배속은 노트가 내려오는 속도만 바꾸며 음악/영상 속도 · 판정과 무관. 이전 기록 0.75 / 1.25 / 1.75 도 그대로 유효)
-- 다른 컬럼 · 데이터 · WONY PHONE 객체는 바꾸지 않습니다. 여러 번 실행해도 안전합니다.
-- ============================================================================
begin;

alter table public.rhythm_play_records drop constraint if exists rhythm_play_records_note_speed_check;
alter table public.rhythm_play_records
  add constraint rhythm_play_records_note_speed_check check (note_speed between 0.5 and 6.0);

commit;
