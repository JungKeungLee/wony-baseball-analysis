# WONY RHYTHM

PC는 키보드, 모바일은 터치로 플레이하는 가벼운 4레인 리듬게임입니다.
(저장소 이름은 이전 프로젝트 `wony-baseball-analysis`를 그대로 씁니다. 이전 AI 야구 분석 기능은 제거했습니다.)

**영상이 음악이고, 영상이 게임 시계입니다.** 곡마다 영상+음악이 합쳐진 MP4 하나만 쓰고, 노트 위치·판정·진행률·종료는 모두 `video.currentTime` 기준입니다.

- 게임 로직은 **전부 브라우저**에서 처리합니다. 플레이 중에는 서버 요청이 없습니다.
- 서버(FastAPI)는 정적 파일, `GET /health`, 온라인 기록 API(게임 종료 시 1번)만 제공합니다. 런타임 의존성은 `fastapi`, `uvicorn` 두 개입니다.
- 곡 자동 생성(오디오 분석, 채보 생성)은 **로컬 PC 도구**(`tools/`)에서만 실행합니다. Render 서버는 이 코드를 import하지 않습니다.

## 곡 추가 (MP4 + 제목 → 자동 생성)

준비: Python 3.12, ffmpeg/ffprobe(PATH), `pip install -r tools/requirements-tools.txt`

**방법 A. 곡 추가 화면 (권장)**

```bash
python tools/admin_server.py          # http://127.0.0.1:8001/
```

MP4 선택 → 곡 제목 → [자동 생성] → [미리보기]에서 영상+4레인으로 EASY/NORMAL/HARD/HELL 확인 → [저장]

**방법 B. CLI**

```bash
python tools/import_song.py --video "C:/path/my-song.mp4" --title "여름이야 부탁해"
#   --artist WONY (기본)  --cover 이미지(선택)  --id 곡ID(선택)  --stage-only (등록 없이 미리보기만)
python tools/remove_song.py wony-cover-02     # 삭제
```

자동으로 만들어지는 것 (예: 곡 ID `wony-cover-01`):

```
frontend-demo/assets/videos/wony-cover-01.mp4      브라우저용 MP4 (H.264/AAC는 복사만, 원본 timeline 유지)
frontend-demo/assets/covers/wony-cover-01.webp     대표 이미지 (영상 10% 지점부터 어둡지 않은 선명한 프레임)
frontend-demo/songs/charts/wony-cover-01-{easy,normal,hard,hell}.json
frontend-demo/songs/songs.json                     곡 등록 (가장 마지막에 원자적으로 기록)
```

저장한 뒤 **git에 커밋하고 배포해야** Render 사이트에 나타납니다 (Render 디스크는 재배포 때 초기화됨).
영상이 커지면 Git LFS나 외부 저장소(Supabase Storage 등)를 고려하세요. `songs.json`의 `video`/`cover`는 전체 URL도 됩니다.

채보는 사람이 고치기 쉬운 초안입니다: `{"time": 7500, "lane": 0}` (time = MP4 시작 기준 ms, 같은 time이면 동시치기).
채보의 `"laneCount"`(4 / 6 / 8, 없으면 4)가 레인 수이고 lane 은 `0 <= lane < laneCount` 입니다.

**KEY 모드 (4 / 6 / 8 KEY, 기본 4)**: 곡 선택 · 설정 화면에서 고릅니다. 곡마다 채보가 있는 모드는 `songs.json` 의 `"laneModes"`
(없으면 4키만)이고, 4키 채보를 6/8키로 자동 변환하지 않습니다 (없는 모드는 "이 곡은 현재 4 KEY 채보만 지원합니다." 안내).
채보 파일: 4키 `{id}-{diff}.json`, 6/8키 `{id}-{diff}-6k.json` / `-8k.json`. 등록된 곡에 6/8키 채보 추가:

```bash
python tools/add_lane_modes.py --song demo-beat --lanes 6,8
```

기본 키: 4 KEY `← ↓ ↑ →`, 6 KEY `S D F J K L`, 8 KEY `A S D F J K L ;` (설정에서 모드별로 변경). 휴대폰 세로에서 터치 버튼이 44px 보다
좁아지는 모드(예: 8 KEY)는 시작하지 않고 가로 화면으로 안내합니다.

노트 배속: `1x · 1.5x · 2x · 3x · 4x · 6x` (노트가 내려오는 시간만. 영상/음악 `playbackRate` 는 항상 1.0).
난이도별 최소 간격/밀도/동시치기 비율은 `tools/chart_config.py` 한 곳에서 조정합니다.

## 로그인 필수 · 온라인 기록 · 랭킹 · 츄르 (WONY PHONE 회원)

WONY RHYTHM 은 **로그인한 WONY PHONE 회원만** 플레이할 수 있습니다. WONY PHONE 과 같은 Supabase 를 씁니다
(DB 객체 · 적용 순서: [supabase/README.md](supabase/README.md)).

- 이용 흐름: WONY PHONE 로그인 → "리듬게임" 앱 → 60초 1회용 입장권 → `/rhythm-login` → 이 서버의 HttpOnly 세션 (Supabase 토큰은 넘기지 않음)
- 세션이 없으면 모든 화면(`/`, `/game`, `/songs`, `/ranking`, `/shop`, `/scores`, `/settings`) 대신 **로그인 안내**
  ("로그인이 필요한 서비스입니다." + [WONY PHONE으로 이동] = `WONY_PHONE_URL`). 세션이 있으면 WONY PHONE 을 다시 거치지 않음, 로그아웃하면 다시 필요
- 게임 종료 시 1번 `POST /api/rhythm/results` → 서버가 세션의 user_id 로 Supabase 서명 함수 호출 (플레이 중 요청 없음, 게임 1판 = play_id 1개)
- 정상 CLEAR 만 최고 기록 · 랭킹 · 츄르, GAME OVER / NO FAIL 은 플레이 기록만, AUTO / PREVIEW 는 보내지 않음
- 게임 도중 세션이 만료돼도 판은 끝까지. 결과 저장 때 "로그인 세션이 만료되었습니다." + WONY PHONE 로그인 버튼 (저장 · 지급 없음, 재전송 없음)
- 이 기기(localStorage)에는 **게임 설정만**: 키 · 노트 배속 · 영상 ON/OFF · NO FAIL · 판정 보정 · 터치 버튼, 마지막 곡/난이도, 장착 스킨 선택.
  최고 기록 · 최근 플레이 · 랭킹 · 츄르 · 보유 스킨은 서버(회원)만. 이전 버전의 로컬 기록 · 비로그인 츄르는 자동으로 지움
- 곡 추가 도구의 미리보기(`tools/admin_server.py`, 127.0.0.1)는 로그인 없이 쓰며 아무것도 저장하지 않음

Render 환경변수 (모두 서버 전용, `RHYTHM_LINK_SECRET` 이 없으면 아무도 로그인할 수 없어 게임을 열 수 없음):

| 이름 | 값 |
|---|---|
| `RHYTHM_LINK_SECRET` | WONY PHONE(Vercel) 의 `RHYTHM_LINK_SECRET` 과 같은 값, 32자 이상 |
| `RHYTHM_DB_SECRET` | Supabase `005` SQL 로 넣은 값과 같은 값, 32자 이상 |
| `SUPABASE_URL` | WONY PHONE 과 같은 Supabase 주소 |
| `SUPABASE_PUBLISHABLE_KEY` | WONY PHONE 과 같은 공개 키 (`sb_publishable_…`). service role key 금지 |
| `WONY_PHONE_URL` | 로그인 안내 화면의 [WONY PHONE으로 이동] 주소 (없으면 버튼 대신 안내 문구) |

로컬: 저장소 루트에 `.env` (예시 `.env.example`, git 에 올라가지 않음). 연결 확인: `cd backend && python -m app.rhythm.check`

## URL

| 경로 | 화면 |
|---|---|
| `/` | 홈 (🐟 츄르, 게임 시작 · 곡 선택 · 랭킹 · 스킨 상점 · 최고 기록 · 설정) |
| `/songs` | 곡 → 난이도 → KEY 모드 → 배속 → 영상 ON/OFF → 시작 |
| `/game?song=wony-cover-01&diff=hard` | 플레이 |
| `/ranking?song=…&diff=…` | 전체 랭킹 (곡 + 난이도) |
| `/shop` | 스킨 상점 (준비 중) |
| `/settings` | KEY 모드별 키, 노트 배속, 영상 보기, 판정 보정, 터치 버튼, 스킨 |
| `/scores` | 내 최고 기록(곡+난이도별) · 최근 플레이 (서버 기록) |
(위 화면은 모두 로그인 필요. 세션이 없으면 같은 주소에서 로그인 안내)
| `/health` | `{"status": "ok"}` |
| `/rhythm-login?ticket=…` | WONY PHONE 입장권 → 회원 세션 |
| `/api/rhythm/me` · `results` · `records` · `ranking` · `logout` | 온라인 기록 API (me 외에는 로그인 필요) |
| `/demo/...` | 이전 주소 → `/`로 301 이동 |

## 실행 (게임 서버)

```bash
python -m venv .venv
.venv/bin/pip install -r backend/requirements.txt      # Windows: .venv\Scripts\pip
cd backend && ../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Render: Build `pip install -r backend/requirements.txt`, Start `cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT` (변경 없음). ffmpeg 등 시스템 패키지는 게임 서버에 필요 없습니다.

## WONY PHONE 인증 (선택)

`WONY_AUTH_SECRET`(32자 이상)을 설정하면 WONY PHONE에서 발급한 1회용 admin ticket(`/wony-login?ticket=...`)으로만 들어올 수 있습니다 (`/health`는 항상 공개). 설정하지 않으면 누구나 접속할 수 있습니다. `backend/app/auth/wony_link.py` 참고.

## 구조

```
backend/app/main.py            정적 페이지 + /health (+ 인증 미들웨어). 허용 목록(css/js/songs/assets)만 제공
tools/                         ── 로컬 전용 (게임 서버가 import 하지 않음) ──
  import_song.py               MP4 + 제목 → staging → 검증 → 등록 (CLI)
  admin_server.py, admin/      곡 추가 화면 + 미리보기 (127.0.0.1)
  media.py                     ffprobe/ffmpeg: 정보, 웹용 MP4, 오디오/프레임 추출
  audio_analyzer.py            onset/BPM/beat/강박/음악 구간 (numpy)
  chart_generator.py           난이도별 채보 + 검증
  chart_config.py              난이도 규칙 (최소 간격 등)
  cover_generator.py           대표 이미지 WebP
  song_store.py                ID 발급, staging, 원자적 등록/삭제
frontend-demo/
  js/clock.js     VideoClock: video.currentTime = 게임 시계, 플레이 중 seek 금지, playbackRate 1.0 고정
  js/engine.js    게임 상태: hitLane() / updateGame() / pause / resume (DOM 없음)
  js/layout.js    화면 크기 → 좌표, 배속 → 노트 접근 시간 (2000ms / 배속)
  js/config.js    판정 창·점수·정확도·배속 (모든 난이도 공통)
  js/storage.js   이 기기 저장: 게임 설정만 (loadSettings / saveSettings / purgeMemberData)
  js/session.js   로그인 필수 확인 (requireMember), 세션 만료 안내
  js/input.js     키보드 + pointer(멀티터치) → 같은 hitLane
```

## 테스트

```bash
pip install -r tools/requirements-tools.txt -r backend/requirements-dev.txt
python -m pytest backend/tests/test_site.py backend/tests/test_wony_link.py tools/tests

cd frontend-demo && npm test                       # 게임 로직 (Node 18+)
cd supabase/tests && npm install && npm test       # Supabase SQL (PGlite, 운영 DB 접속 없음)
CHROMIUM_PATH="…/msedge.exe" node frontend-demo/tests/online-e2e.mjs   # 로그인 → 플레이 → 저장 → 랭킹 전체 흐름
# 브라우저: 서버 실행 후. MP4(H.264) 재생을 위해 Chrome/Edge 실행 파일 지정
CHROMIUM_PATH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run test:browser   # 서버 · 가짜 Supabase 를 직접 띄움 (supabase/tests 에서 npm install 필요)
```

`python tools/make_demo_song.py`는 저작권 없는 합성 테스트곡(`demo-beat`)을 같은 자동 생성 경로로 등록합니다.
`/game?autoplay=1`은 자동 플레이(테스트용, 기록 저장 안 함)입니다.
