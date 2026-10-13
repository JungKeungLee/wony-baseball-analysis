-- ============================================================================
-- WONY RHYTHM 005 — 서버 서명 비밀값 등록 (004 다음에 실행)
--
-- ⚠️ 이 파일은 "틀"입니다. 실제 값을 이 파일에 저장하거나 git 에 올리지 마세요.
--    SQL Editor 에 붙여 넣은 뒤 아래 '여기에_RHYTHM_DB_SECRET' 부분만 바꿔서 실행하고, 편집기 내용은 저장하지 마세요.
--
-- 값 만들기 (아무 PC 터미널에서, 64자 16진수):
--   python -c "import secrets; print(secrets.token_hex(32))"
-- 같은 값을 Render 환경변수 RHYTHM_DB_SECRET 에도 넣어야 합니다 (WONY PHONE · 브라우저에는 넣지 않음).
-- 값을 바꾸고 싶으면(유출 의심 등) 이 문장을 새 값으로 다시 실행하고 Render 값도 같이 바꾸면 됩니다.
-- ============================================================================
insert into rhythm_private.settings (key, value)
values ('server_hmac_secret', '여기에_RHYTHM_DB_SECRET')
on conflict (key) do update set value = excluded.value, updated_at = now();
-- 32자보다 짧으면(위 예시 그대로 실행하면) check 제약 때문에 실패합니다 → 실제 값을 넣었는지 확인하는 장치
