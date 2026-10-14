# WONY RHYTHM — Supabase (WONY PHONE 과 같은 프로젝트)

리듬게임 온라인 기록 · 랭킹용 DB 객체입니다. **WONY PHONE 의 auth.users · profiles · 기존 테이블 / RLS / 함수는 수정하지 않습니다.**
새로 만드는 것: `public.rhythm_play_records`, `public.rhythm_scores`, `public.rhythm_submit_play`, `public.rhythm_get_ranking_signed`,
`public.rhythm_get_ranking`, `rhythm_private` 스키마(규칙 함수 · 서버 서명 비밀값 · nonce),
006: `rhythm_play_records.play_id`(UNIQUE), `public.rhythm_wallet`, `public.rhythm_churu_ledger`, `public.rhythm_reward_rules`,
`public.rhythm_song_rewards`, `public.rhythm_get_wallet_signed`.

## 적용 순서 (Supabase Dashboard → SQL Editor, 위에서부터 하나씩)

| 순서 | 파일 | 하는 일 |
|---|---|---|
| 1 | `sql/001_rhythm_tables.sql` | 테이블 2개 + 비공개 스키마 + 기록 규칙 함수(정상 클리어 · 등급) + 값 검증 제약 |
| 2 | `sql/002_rhythm_indexes.sql` | 랭킹 · 최근 기록 조회 인덱스 |
| 3 | `sql/003_rhythm_functions.sql` | 최고 기록 갱신 트리거, 서명 확인, 저장 · 랭킹 함수 |
| 4 | `sql/004_rhythm_rls.sql` | RLS 켜기, 앱 역할 쓰기 권한 회수, 조회 정책, 함수 실행 권한 |
| 5 | `sql/005_rhythm_server_secret.TEMPLATE.sql` | **편집기에서만** 값을 바꿔 실행 (서버 서명 비밀값). 파일에 저장하지 말 것 |
| 6 | `sql/006_rhythm_play_id_and_churu.sql` | play_id 중복 방지, 저장 전/후 순위, 츄르 지갑 · 지급 기록 · 보상 설정, 내 주변 랭킹 |
| 7 | `sql/007_rhythm_my_records.sql` | 내 최고 기록 · 최근 플레이 조회 (서명 함수, 조회만). 로그인 필수 정책: 기록은 DB 에서만 읽음 |
| 8 | `sql/008_rhythm_note_speed_6x.sql` | 노트 배속 1x~6x 허용 (note_speed 제약 0.5~6.0). 없으면 4x · 6x 판 저장이 거절됨 |
| 확인 | `sql/verify_rhythm.sql` | 결과의 `ok` 가 모두 `true` 인지 (조회만, 비밀값 출력 안 함) |

001~004, 006~008 은 여러 번 실행해도 안전합니다. 순서를 지켜 주세요 (004 는 003 의 함수에 권한을 주고, 006 은 003 의 저장 · 랭킹 함수를 교체합니다).
**006 을 적용하기 전에 WONY RHYTHM 서버를 새 버전으로 배포하면 온라인 저장이 실패합니다** (새 서버는 play_id 를 보내고, 003 의 함수는 그 필드를 모름 → 결과 화면에 실패 안내, 로컬 기록은 정상).
권장 순서: 006 · 007 · 008 SQL 적용 → verify → 서버 배포 (007 이 없으면 최고 기록 화면 · 준비 화면 최고 점수만 "불러오지 못함").

## 되돌리기

`sql/rollback_rhythm.sql` — 위 리듬 객체와 그 안의 리듬 기록만 삭제합니다. profiles · auth · WONY PHONE 데이터는 그대로입니다.
다시 쓰려면 001~008 을 다시 실행합니다. ⚠️ 츄르 잔액 · 지급 기록도 함께 삭제됩니다.

## 저장 흐름과 권한

```
WONY PHONE (로그인 회원) ──POST /api/rhythm/ticket──▶ 60초 1회용 입장권 (Supabase 토큰은 넘기지 않음)
   └▶ WONY RHYTHM /rhythm-login (입장권 확인 → HttpOnly 세션 쿠키, user_id 확정)
        └▶ 게임 종료 시 1번: POST /api/rhythm/results
             └▶ public.rhythm_submit_play(payload, HMAC 서명)   ← RHYTHM_DB_SECRET 으로 서명, publishable key 로 호출
                  └▶ rhythm_play_records 1행 → 트리거: 정상 클리어면 rhythm_scores 갱신
```

- 브라우저(anon / authenticated)는 rhythm 테이블에 **INSERT / UPDATE / DELETE 권한이 없습니다.** 다른 회원 user_id 로 위조 저장 · 수정 · 삭제 불가.
- 로그인 회원(authenticated)은 `rhythm_scores`(랭킹) 조회, `rhythm_play_records` 는 **본인 것만** 조회.
- 랭킹 닉네임은 profiles 의 공개 설정을 따릅니다 (비공개 회원 = 닉네임 숨김). 이메일 · user_id 는 돌려주지 않습니다.
- service role key 는 사용하지 않습니다.

## 츄르 · 중복 방지 (006)

- 게임 1판 = `play_id`(UUID) 1개. `rhythm_play_records.play_id` UNIQUE, `rhythm_churu_ledger.play_id` UNIQUE →
  같은 판을 몇 번 보내도(재시도 · 새로고침) 기록 1행 · 츄르 1번. 재전송에는 처음 결과를 `duplicate: true` 로 돌려줌.
  다른 회원의 play_id 로 보내면 거절.
- 지급 조건 = 랭킹 조건(`rhythm_private.is_normal_clear`, 정상 CLEAR 만) — 같은 함수 하나.
- 지급량 = `round(rhythm_reward_rules.base_churu × rhythm_song_rewards.multiplier) + bonus` (DB 가 계산).
  클라이언트가 보낸 지급량 · 잔액은 받지 않음 (서버가 그런 필드가 있으면 422, DB 도 읽지 않음).
  초기값 EASY 1 · NORMAL 2 · HARD 4 · HELL 7 (`frontend-demo/js/config.js` `CHURU_REWARDS` 와 같음 — 테스트로 확인).
  값을 바꾸려면 SQL Editor 에서 `update public.rhythm_reward_rules set base_churu = … where difficulty = …;`
  곡별 이벤트: `insert into public.rhythm_song_rewards (song_id, multiplier, bonus) values ('곡-id', 1.5, 2);`
- 저장 · 순위 전/후 · 지급이 한 트랜잭션: 하나라도 실패하면 전부 롤백 (기록만 남고 츄르가 빠지는 일 없음).
- 앱 역할(anon / authenticated)은 지갑 · 지급 기록 · 보상 설정에 쓰기 권한 없음. 지갑 · 지급 기록은 본인 것만 조회.

## 향후 스킨 상점 (아직 만들지 않음 — 확인 후 007 로 추가 예정)

지금 게임에는 기본 스킨 2개(`default-ui`, `default-rhythm`)만 있고 상점은 "준비 중" 화면입니다 (`SHOP_OPEN = false`).
판매를 시작할 때 필요한 것 (모두 이 프로젝트의 새 rhythm 테이블 · 함수, WONY PHONE 기존 객체는 수정하지 않음):

| 테이블 | 용도 |
|---|---|
| `rhythm_skin_catalog` | skin_id PK, type(`ui` / `rhythm-bar`), name, price(츄르), enabled, is_default |
| `rhythm_user_skins` | (user_id, skin_id) PK, acquired_at, source(`purchase` / `default` / `event`) |
| `rhythm_user_settings` | user_id PK, ui_skin_id, rhythm_bar_skin_id (장착은 보유 스킨만, FK + 함수에서 확인) |
| `rhythm_wallet` · `rhythm_churu_ledger` | 006 에서 이미 만듦 (구매는 ledger 에 음수 amount, reason `skin_purchase`) |

구매 함수(서명 확인 + 한 트랜잭션): 회원 확인 → 판매 중(enabled)인지 → 이미 보유했는지 → **DB 의 가격** →
잔액 확인(`select … for update`) → 차감 → 보유 추가 → 지급 기록 → 커밋. 오류 코드는 게임 `js/skins.js` `PURCHASE_ERRORS` 와 같게
(`LOGIN_REQUIRED` · `UNKNOWN_SKIN` · `SKIN_DISABLED` · `ALREADY_OWNED` · `INSUFFICIENT_CHURU`). 브라우저는 skin_id 만 보냄.

## 테스트 (운영 DB 에 접속하지 않음)

```bash
cd supabase/tests && npm install && npm test      # PGlite(실제 Postgres)에 SQL 을 적용해 22개 시나리오 확인
```

`tests/fake_postgrest.mjs` 는 브라우저 ↔ 서버 ↔ SQL 전체 흐름 테스트(`frontend-demo/tests/online-e2e.mjs`)용 가짜 Supabase REST 입니다.
