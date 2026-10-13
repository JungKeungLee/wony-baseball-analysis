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
채보의 `"laneCount"`(4 / 6 / 8, 없으면 4)가 레인 수이고 lane 은 `0 <= lane < laneCount` 입니다. 게임 UI 는 아직 4키만 쓰지만 키 설정·터치 버튼·레이아웃·생성기(`generate_chart(..., lane_count=)`)는 레인 수를 받습니다.
난이도별 최소 간격/밀도/동시치기 비율은 `tools/chart_config.py` 한 곳에서 조정합니다.

## 온라인 기록 · 랭킹 (WONY PHONE 회원)

WONY PHONE 과 같은 Supabase 를 씁니다 (DB 객체 · 적용 순서: [supabase/README.md](supabase/README.md)).

- WONY PHONE 의 "리듬게임" 앱 → 60초 1회용 입장권 → `/rhythm-login` → 이 서버의 HttpOnly 세션 (Supabase 토큰은 넘기지 않음)
- 게임 종료 시 1번 `POST /api/rhythm/results` → 서버가 세션의 user_id 로 Supabase 서명 함수 호출 (플레이 중 요청 없음)
- 정상 CLEAR 만 최고 기록 · 랭킹, GAME OVER / NO FAIL 은 플레이 기록만, AUTO / PREVIEW 는 보내지 않음 (로컬 기록 정책과 같음)
- 로그인하지 않았거나 Supabase 가 실패해도 게임 · 로컬 기록은 그대로 (결과 화면에 안내만)

Render 환경변수 (모두 서버 전용, 하나라도 없으면 온라인 기능만 꺼짐):

| 이름 | 값 |
|---|---|
| `RHYTHM_LINK_SECRET` | WONY PHONE(Vercel) 의 `RHYTHM_LINK_SECRET` 과 같은 값, 32자 이상 |
| `RHYTHM_DB_SECRET` | Supabase `005` SQL 로 넣은 값과 같은 값, 32자 이상 |
| `SUPABASE_URL` | WONY PHONE 과 같은 Supabase 주소 |
| `SUPABASE_PUBLISHABLE_KEY` | WONY PHONE 과 같은 공개 키 (`sb_publishable_…`). service role key 금지 |
| `WONY_PHONE_URL` | (선택) 홈의 "WONY PHONE에서 로그인" 링크 |

로컬: 저장소 루트에 `.env` (예시 `.env.example`, git 에 올라가지 않음). 연결 확인: `cd backend && python -m app.rhythm.check`

## URL

| 경로 | 화면 |
|---|---|
| `/` | 홈 |
| `/songs` | 곡 → 난이도 → 배속 → 영상 ON/OFF → 시작 |
| `/game?song=wony-cover-01&diff=hard` | 플레이 |
| `/settings` | 키, 노트 배속, 영상 보기, 판정 보정, 터치 버튼 |
| `/scores` | 최고 점수(곡+난이도별), 최근 플레이(배속 포함) |
| `/health` | `{"status": "ok"}` |
| `/rhythm-login?ticket=…` | WONY PHONE 입장권 → 회원 세션 |
| `/api/rhythm/me` · `results` · `ranking` · `logout` | 온라인 기록 API |
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
  js/storage.js   loadSettings / saveSettings / loadBestScore / saveBestScore / saveResult
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
WONY_BASE_URL=http://127.0.0.1:8000 CHROMIUM_PATH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run test:browser
```

`python tools/make_demo_song.py`는 저작권 없는 합성 테스트곡(`demo-beat`)을 같은 자동 생성 경로로 등록합니다.
`/game?autoplay=1`은 자동 플레이(테스트용, 기록 저장 안 함)입니다.
