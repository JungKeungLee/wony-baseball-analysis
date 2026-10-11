# Claude Code 시작 안내

**프로젝트:** `wony-baseball-analysis` — WONY PHONE과 분리된 Python/FastAPI 야구 영상 분석 MVP. 다섯 역할(batter/defense/catcher/pitcher/baserunning), 2D/추정3D, 플레이 후보, scouting/growth를 **하나의 통합 리포트**에서 제공합니다. LIVE/VOD는 입력·구간 탐색만 다르고 같은 분석 엔진을 재사용합니다.

**이번 목적:** Windows 로컬 설치·실행·확인. WONY PHONE 수정, 새 기능 추가, commit/push는 하지 마세요. 미커밋·미추적 소스를 보존하세요. 최신 main 또는 전달받은 전체 폴더를 사용하고 `git log -1`과 이 파일의 존재를 확인하세요. 오래된 clone/ZIP을 최신이라고 가정하지 마세요.

## 먼저 읽기

1. [HANDOFF.md](HANDOFF.md): 최신 구조/실행/계약/Windows 주의사항의 기준 문서.
2. [UNIFIED_UI.md](UNIFIED_UI.md): 메뉴3개·단일 리포트.
3. [LIVE_VOD.md](LIVE_VOD.md): 상태/탐색/입력 제한.
4. [ENGINE_INPUTS.md](ENGINE_INPUTS.md): VOD URL/자동 역할/복합 탐지의 최신 계약.
5. [BROADCAST_SEGMENTS.md](BROADCAST_SEGMENTS.md): 탐지 근거/보관 정책.

코드 시작점은 `backend/app/main.py`, `api/routes.py`, `segments/execution.py`, `analysis/engine.py`입니다. UI는 `frontend-demo/index.html`, `analysis.html`, `report.js`; 이전 `app.js`는 제거됐습니다.

## Windows 실행 순서

64-bit **Python3.12**, PATH의 **ffmpeg+ffprobe**(libx264 포함)가 필요합니다. 없다면 winget/공식 설치 프로그램으로 설치한 뒤 새 PowerShell을 여세요. Node.js는 서버 실행에는 필요 없습니다.

프로젝트 루트에서:

```powershell
py -3.12 --version
ffmpeg -version
ffprobe -version
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Linux venv를 복사하지 말고 Windows에서 새로 만드세요. 가상환경 활성화/실행 정책 변경은 필요 없습니다. 단일 worker, 초기 확인에는 reload 없이 실행합니다. 루트 위치·공백 경로 따옴표·FFmpeg PATH·지원 MediaPipe wheel을 먼저 확인하세요. 핀 버전을 임의로 올리지 마세요.

## 확인할 URL

PC에서 서버를 실행한 뒤:

- http://127.0.0.1:8000/health
- http://127.0.0.1:8000/demo/ — 대시보드, 짧은 영상/DEMO 시작
- http://127.0.0.1:8000/demo/broadcast/?tab=live — LIVE
- http://127.0.0.1:8000/demo/broadcast/?tab=vod — VOD
- http://127.0.0.1:8000/demo/analyses/ — 실제/DEMO 기록
- http://127.0.0.1:8000/demo/analysis/{analysisId} — UUID를 넣는 통합 리포트
- http://127.0.0.1:8000/docs — API

DEMO로 페이지 연결부터 확인하고 짧은 파일을 업로드하세요. 방송 결과 ID는 VOD job/LIVE session UUID도 지원합니다. 원본 삭제된 단일 분석은 원본 버튼 비활성화가 정상입니다.

## 테스트

새 터미널, 프로젝트 루트:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

현재 **172개**, 최신 Linux 기록172개 통과/의존성 경고3개. 기존129개+5툴/근거/촬영 조건/성장43개입니다. **Windows 실행 성공은 아직 확인하지 않았습니다.**

브라우저 검증은 서버+Node+Chromium이 필요합니다. `frontend-demo`에서 `npm ci`, Windows의 실제 Chrome/Edge 경로를 `CHROMIUM_PATH`로 지정하고 `npm run test:browser`, `npm run test:broadcast`, `npm run test:modes`. 구체적인 PowerShell 명령은 HANDOFF에 있습니다. `test:scouting`은 통합 회귀의 alias입니다.

## 미구현/미검증과 유지할 구조

- 실제 야구/VR 영상 정확도, 외부 LIVE/HLS와 10시간 부하, Windows 호환성은 미검증입니다.
- VOD 직접 MP4/종료 HLS URL과 자동 역할 휴리스틱을 지원합니다. 플랫폼 페이지/SOOP adapter는 미구현입니다. 객체/선택 장면 ONNX 가중치는 별도 준비·검증 필요하며, 색상/자세만으로 LIVE를 확정하지 않습니다. 역할/야구 근거 부족 시 unknown/검토 요청으로 보류합니다.
- 3D는 미보정 상대 좌표, estimated=true/confidence≤0.35. 실제 힘·발 압력·구속·타구속도·성공/실패를 만들지 마세요. 실제 점수/등급은 null이며 DEMO는 구분합니다.
- LIVE/VOD 각각 analyzer를 만들면 결과/시간/신뢰도 정책이 달라집니다. source/discovery → 공통 execution → 기존 engine 구조를 유지하세요.
- UI는 대시보드/방송/기록과 하나의 통합 리포트입니다. 2D/3D/Scouting을 별도 메인 화면으로 분리하지 마세요.
- 데이터는 data 또는 WONY_DATA_DIR에 남습니다. 원본/오버레이/JSON을 임의 삭제하지 말고 `.venv`, 캐시, 결과물은 Git에 넣지 마세요.

실행 오류가 있으면 재현/로그와 설치 문제인지 코드 문제인지 먼저 보고하고, 요구사항·분석 수식·응답 schema·confidence 정책·vendor를 임의 변경하지 마세요. HANDOFF의 보호 경계와 Windows 진단 순서를 따르세요.

5툴은 `scouting/tools.py`가 실제 2D 계산(`proxies.py`)을 CONTACT/POWER/SPEED/FIELDING/ARM 및 역할별 요약에 연결합니다. [SCOUTING_GAP.md](SCOUTING_GAP.md) → [SCOUTING_TOOLS.md](SCOUTING_TOOLS.md)를 읽으세요. 실제 구속/컨택 성공/exit velocity/능력 점수/스타일은 만들지 않습니다. 성장 비교는 capture_context·카메라/VR/화질·관측 범위 호환 조건을 지켜야 합니다. confidence는 확률이 아닙니다. 브라우저 추가 확인: `node tests/tools.mjs`.
