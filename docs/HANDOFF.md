# wony-baseball-analysis — 최신 인수인계

이 문서는 현재 로컬 소스 기준입니다. 이전 버전별 설명을 합쳐 **통합 리포트 UI / LIVE·VOD / 105개 테스트** 기준으로 정리했습니다. FastAPI 버전 표기는 0.4.0, 신규 단일 분석 응답 schema_version은 0.4.0입니다.

WONY PHONE과 분리된 독립 Python 야구 영상 분석 MVP입니다. 현재 작업 목표는 **Claude Code에서 Windows 로컬 실행과 확인**입니다. WONY PHONE 통합, 새 기능 추가, commit/push는 승인되지 않았습니다.

**소스 전달:** LIVE/VOD·통합 UI·전달 문서를 함께 버전 관리합니다. 원격 저장소를 사용할 때는 최신 main을 받고 `git log -1`과 `docs/CLAUDE_HANDOFF.md` 존재를 확인하세요. ZIP은 생성 시점이 다를 수 있으므로 최신이라고 가정하지 마세요. 로컬 변경은 보존하고 `.venv`, `node_modules`, `data`, 캐시는 전달 소스에서 제외하세요.

## 1. 시작 순서와 참고 문서

1. [CLAUDE_HANDOFF.md](CLAUDE_HANDOFF.md): 짧은 시작 안내.
2. 이 문서: 실행, 구조, 계약, 보호할 부분.
3. [UNIFIED_UI.md](UNIFIED_UI.md): 현재 메뉴와 리포트 구성.
4. [LIVE_VOD.md](LIVE_VOD.md): 입력 모드/상태/시간/제한.
5. [BROADCAST_SEGMENTS.md](BROADCAST_SEGMENTS.md): 구간 탐지 근거/보관 정책.
6. [WINDOWS.md](WINDOWS.md): 설치 보조 안내. 최신 소스 범위와 URL은 **이 문서를 우선**하세요.

README의 과거 v0.3/v0.4 탭 설명과 일부 PNG는 이전 UI 기록입니다. 별도 Motion Lab/Scouting Report 메뉴를 다시 만들지 마세요.

## 2. 전체 구조와 주요 폴더 역할

```text
wony-baseball-analysis/
  backend/
    app/
      main.py                     # FastAPI, API router, /demo static/UI route
      api/
        routes.py                 # 단일 분석, DEMO, 결과/자산, 선수 기록
        broadcasts.py             # 긴 영상 작업, 보정/삭제/원본 조회
        modes.py                  # LIVE 및 VOD exact/approximate/auto
        reports.py                # 읽기 전용 통합 리포트/목록/보관 원본
      source/
        base.py                   # provider 중립 sample/capture 인터페이스
        file.py                   # seek 가능한 파일 입력
        stream.py                 # HTTP(S) 스트림 입력
      segments/
        detection.py              # 저비용 신호 탐지, 병합, 시간/구간 검증
        vod.py                    # VOD 탐색 범위 계산
        jobs.py                   # 비동기 스캔/구간 추출 작업과 진행 저장
        execution.py              # LIVE/VOD가 공유하는 정밀 분석 연결부
      live/
        state.py                  # 반복 감지/종료 유예 상태기계
        sessions.py               # 감시 작업, 클립 검증/분석, 세션 저장
      video/frames.py             # ffmpeg 정규화 → OpenCV 프레임 추출
      pose/extractor.py           # MediaPipe Pose 관절 좌표
      analysis/
        engine.py                 # 공통 role 라우팅
        shared/                   # 각도/pose 지표/confidence/event/fielding
        batter/analyzer.py
        defense/{analyzer,infielder,outfielder}.py
        catcher/analyzer.py
        pitcher/analyzer.py
        baserunning/analyzer.py
      scouting/{report,growth}.py  # 근거 기반 리포트와 조건부 이력 비교
      visualization/              # 2D overlay, 3D 상대 좌표, keyframe, DEMO
      models/{result,storage}.py   # Pydantic 응답 계약, 원자적 JSON 저장
    requirements.txt              # 고정 Python 의존성
    tests/                        # 7개 test 파일, 현재 105개 테스트
  frontend-demo/
    index.html / dashboard.js     # 메인 대시보드, 짧은 영상 분석 시작
    broadcast/index.html          # 한 화면의 LIVE/VOD 탭
    broadcast.js / live.js / broadcast-tabs.js
    analyses/index.html / records.js
    analysis.html / report.js     # 종합·역할·플레이 시각화를 한 페이지에
    live/index.html               # 이전 URL 호환용 이동 안내
    styles.css
    vendor/                       # Three.js 0.174.0, OrbitControls, MIT LICENSE
    tests/                        # Playwright UI/방송/모드 검증
    package.json / package-lock.json
  data/                           # 기본 생성 결과/원본/작업, Git 제외
  docs/                           # 전달 문서, 과거 schema 예시, 캡처
  README.md / pytest.ini / .gitignore
```

프론트는 일반 HTML/ES module과 로컬 Three.js입니다. React/Vite 빌드나 CDN이 필요하지 않습니다. Node.js는 브라우저 테스트에만 필요합니다. `frontend-demo/app.js`는 통합 UI 정리 과정에서 삭제되었고 현재 구현은 `report.js`입니다.

## 3. 요구사항

- **64-bit CPython 3.12** 및 로컬에서 생성한 `.venv`. 다른 머신/Linux의 venv를 복사하지 마세요.
- PATH의 **ffmpeg + ffprobe**, 오버레이 인코딩에 **libx264** 필요.
- `backend/requirements.txt` 전체 설치: FastAPI 0.115.12, uvicorn 0.34.2, python-multipart 0.0.20, opencv-contrib-python 4.11.0.86, MediaPipe 0.10.21, numpy 1.26.4, pytest 8.3.5, httpx 0.28.1, tzdata 2025.2.
- MediaPipe의 `mp.solutions.pose.Pose`와 번들 모델 사용. 별도 API 키/기본 모델 다운로드는 필요하지 않습니다.
- pandas, GPU, 외부 3D 모델, 방송 플랫폼 인증은 필수 의존성이 아닙니다.
- uvicorn **단일 worker**. 현재 lock/작업 상태는 프로세스 안에서 관리합니다.

## 4. Windows 로컬 실행 — PowerShell

Python/FFmpeg가 없을 때만 설치하세요:

```powershell
winget install --id Python.Python.3.12 --exact
winget install --id Gyan.FFmpeg --exact
```

설치 뒤 새 터미널을 열어 PATH를 반영합니다. winget 미지원이면 공식 Python Windows 설치 프로그램과 FFmpeg 다운로드 안내를 사용하세요.

현재 소스를 받은 프로젝트 루트에서 실행합니다. 아래 경로는 예시이며 실제 위치로 바꾸세요.

```powershell
cd "C:\dev\wony-baseball-analysis"
py -3.12 --version
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -encoders | Select-String libx264

py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

실행 창을 유지하고 다른 터미널/브라우저에서 확인하세요:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

가상환경 활성화가 필요 없으므로 PowerShell 실행 정책을 바꿀 필요가 없습니다. `--reload`는 초기 확인에 사용하지 마세요. reload/프로세스 재시작은 실행 중 LIVE/VOD 작업을 중단할 수 있습니다.

### Linux / Codex 실행 참고

```bash
cd /workspace/wony-baseball-analysis
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
mkdir -p /tmp/wony-mpl /tmp/wony-cache
MPLCONFIGDIR=/tmp/wony-mpl XDG_CACHE_HOME=/tmp/wony-cache \
  .venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Cloud 내부 검증의 localhost는 PC에서 접근하는 서버가 아닙니다. 아래 주소는 **Windows PC에서 위 서버를 실행한 뒤** 열 수 있습니다.

## 5. 현재 데모 URL과 통합 UI

| URL | 내용 |
| --- | --- |
| http://127.0.0.1:8000/demo/ | 메인 대시보드, 최근 분석, 짧은 영상/DEMO 시작 |
| http://127.0.0.1:8000/demo/broadcast/ | 방송 분석, LIVE/VOD 탭 |
| http://127.0.0.1:8000/demo/broadcast/?tab=live | LIVE 탭 |
| http://127.0.0.1:8000/demo/broadcast/?tab=vod | VOD 탭 |
| http://127.0.0.1:8000/demo/analyses/ | 과거 분석 기록, 날짜/실제·DEMO 구분 |
| http://127.0.0.1:8000/demo/analysis/{analysisId} | 하나의 통합 리포트; 실제 UUID로 치환 |
| http://127.0.0.1:8000/docs | FastAPI API 문서 |
| http://127.0.0.1:8000/health | 준비 확인 |

메인 메뉴는 **대시보드 / 방송 분석 / 분석 기록** 3개입니다. `/demo/live/`는 방송 분석 LIVE 탭으로 redirect합니다. 이전 `/demo/?analysis_id=UUID`도 통합 리포트로 이동합니다.

리포트는 종합/타격/수비/포수/투수/주루 탭을 제공하고 미분석 역할은 비활성화합니다. 종합에 날짜·후보 구간·실제 처리 범위·역할·요약·장단점·이전 대비 변화·플레이 목록, 역할 탭에 summary/metrics/장단점/coaching/confidence를 표시합니다. 플레이를 고르면 **같은 영역에서 원본/2D/3D/keyframe/각도**를 전환합니다. 주요 지표 외의 미지원 항목은 펼치기 안에 남습니다.

리포트 ID는 단일 분석 UUID 또는 결과를 가진 VOD job/LIVE session UUID입니다. `api/reports.py`가 세션 내 여러 역할 클립을 묶으며 엔진 결과를 재계산하지 않습니다. 아직 분석 결과가 없는 작업은 과거 리포트 목록에 넣지 않습니다. 목록의 처리 시간은 실제 분석 클립 합계이지 후보 방송 전체 길이가 아닙니다.

## 6. 공통 분석 흐름과 역할 구조

```text
단일 업로드 → process → extract_frames → extract_pose → process_frames
LIVE/VOD 입력 → shared detector/구간 확인 → segments.execution.analyze_clip
              → extract_frames → extract_pose → process_frames
process_frames → analysis.engine.analyze_role
               → visualization.builder → scouting.build_report
               → AnalysisResult 검증 → JSON/자산 저장
```

| role | 모듈과 현재 관찰 |
| --- | --- |
| batter | 스탠스 폭, 무릎/상체, 팔꿈치, 머리 이동, 골반/어깨선 변화, 손 중심 스윙/팔로스루 후보, 밸런스 |
| defense | 준비 자세, 영상 평면 첫 이동, 손목 기반 글러브 대리값, 발목 이동, 종료 중심 안정성. infielder/outfielder는 수동 힌트 |
| catcher | receiving/blocking/throwing_transition 그룹, 무릎/높이/중심, 미트 대리 손목 이동, 일어남·상체 변화·균형 |
| pitcher | 기존 팔/팔꿈치/어깨/상체 각도, 스트라이드, 하체/골반 이동, 릴리스 손목 후보, 팔로스루/밸런스/폼 유형 추정 |
| baserunning | 영상 평면 주루 자세, 균형, 첫 이동 후보. 반응시간/가속도/베이스 접근/슬라이딩/판단은 근거 부족으로 null |

계산은 `analysis/shared`를 재사용합니다. 공·배트 접촉/실제 글러브/반응 자극/깊이 보정이 필요한 항목은 null입니다. 타자 stance_type, bat_start_position, hands_lead, impact_time, wrist_angle, whiff/contact/foul_or_in_play/pull_or_opposite 등은 실제 성과로 판정하지 않습니다. 미트/글러브 위치는 손목 대리값입니다. 회전/체중 이동은 2D 관찰이지 실제 힘·발 압력 측정이 아닙니다.

`auto`는 분류기 미구현으로 unknown과 confidence 0 후보를 반환합니다. 단일 영상 role 기본은 기존 호환을 위해 pitcher입니다. confidence는 검증된 확률이 아닙니다. 모든 metric은 value/unit/estimated/confidence/confidence_grade/method/reason이며 null을 0이나 실패로 바꾸지 마세요. grade는 high≥0.75, medium≥0.4, 나머지 low입니다.

## 7. 2D/3D와 플레이 연결

- `pose/extractor.py`: MediaPipe 33 landmarks, x/y 정규화, z 상대 깊이, visibility. 유효 pose 3프레임 미만은 insufficient_pose.
- `visualization/overlay.py` / `joints.py`: 10fps 샘플 원본 프레임의 머리·어깨·팔꿈치·손목·골반·무릎·발목/선과 주요 프레임 각도. 낮은 가시성 관절은 숨김.
- `keyframes.py`: 타자 stance/load/front_foot_landing/swing_start/estimated_impact/follow_through; 투수 setup/leg_lift/stride/arm_cocking/release/follow_through; 그 외 공통 단계. candidate/reference_only/unavailable을 구분. 앞발 착지/임팩트는 confidence 0 참고 프레임이며 검출 성공이 아님.
- `pose3d.py`: MediaPipe 상대 z와 영상 x/y를 골반 중심/영상 몸통 길이로 정규화. x=영상 오른쪽, y=위, z=카메라 쪽, 단위 visual_torso_lengths. **실제 3D 복원/미터/생체역학이 아니며 estimated=true, confidence≤0.35**. 누락 pose는 joints={}이며 다른 프레임을 복사하지 않음.
- `builder.py`: overlay.mp4(H.264/libx264/yuv420p/faststart), keyframe-NNNN.jpg 및 pose3d JSON. `report.js`의 Three.js가 재생/회전/시점/슬라이더/키프레임 이동을 담당.
- warning 색상은 지원 근거와 문제 항목 모두 confidence≥0.75일 때만. 3D는 저신뢰이므로 경고색을 사용하지 않음.
- frame은 10fps **샘플 인덱스**이며 원본 영상 프레임 번호가 아님. 클립 이벤트/키프레임은 clip-relative; 방송 초는 broadcast_offset_seconds를 더함. LIVE는 세션 경과 시간으로 원본 방송 PTS와 동일하지 않음.

단일 업로드 원본은 분석 후 삭제되어 원본 버튼이 비활성화됩니다. VOD/파일 리플레이에 원본이 남아 있을 때만 원본 재생을 제공합니다. overlay를 원본이라고 표시하지 마세요. 3D front/side/rear는 표시 좌표계 카메라 뷰이며 실제 피사체 방향 보정이 아닙니다.

## 8. Scouting report와 성장 추적

`scouting/report.py`의 scouting_report는 player_id/date/source, strengths/development_areas/traits/overall_summary, ratings/rating_reasons, role_evaluations, plays를 제공합니다. rating 그룹은 batting/defense/catching/pitching/baserunning입니다.

역할별 평가 항목:

- batting: contact/timing/balance/swing_consistency/weight_transfer/head_stability/hip_rotation/shoulder_rotation.
- defense: reaction/first_step/fielding/footwork/glove_position/throwing_transition/balance/range.
- catching: receiving/blocking/framing/throwing_transition/stability/balance.
- pitching: mechanics/balance/release_consistency/lower_body_usage.
- baserunning: start_reaction/acceleration/running_posture/direction_change/base_approach/sliding/decision_making.

각 criterion은 score/grade/estimated/confidence/reason/observation을 포함합니다. **검증된 채점 기준이 없으므로 실제 score/grade/ratings는 전부 null**입니다. 숫자 observation은 자세 대리 지표이지 공식 스카우팅 점수가 아닙니다. 현재 장단점은 confidence≥0.4인 머리/골반 안정성 관찰의 보수적 임계값으로만 생성됩니다.

plays는 이벤트 후보, keyframe, 시각화 참조, confidence 및 국소 feedback을 연결합니다. 해당 시각 샘플 차이가 0.051초 이내인 프레임만 연결하고 대응 keyframe이 없으면 null입니다. 현재 국소 장단점은 빈 배열이 정상이며 전체 영상 feedback은 context_feedback.scope=whole_clip로 분리합니다.

`scouting/growth.py`는 같은 선수/역할/source의 이전 관찰을 비교합니다. comparison_context가 같고 비어 있지 않으며, completed/방법 버전/손/포지션/단위/계산 방법이 같고 양쪽 confidence≥0.4인 숫자만 delta를 생성합니다. 나머지는 null+reason. source=real과 demo는 분리합니다. 날짜 기본은 Asia/Seoul의 오늘, created_at은 UTC; tzdata는 Windows 시간대 지원에 필요합니다.

criterion_scores와 rating_deltas는 아직 null입니다. `/api/demo/growth`의 62→71→77(+9/+6)는 confidence 0의 임의 DEMO 예시이며 실제 기록에 저장하지 않습니다. 변화는 실제 기량 향상 판정이 아닙니다.

## 9. LIVE / VOD와 공통 구간 탐색

**LIVE/VOD는 별도 자세 분석기를 만들지 않습니다.** source adapter/구간 discovery만 다르고 SignalDetector/evidence 및 `segments/execution.py` 이후 엔진은 공유합니다.

- VOD exact: 사람 확인 start/end와 role 지정, 스캔 생략. unknown은 보류.
- approximate: start/end+buffer_minutes 또는 center_time±search_window_minutes/2만 저비용 스캔. 범위 밖은 스캔/분석하지 않음.
- auto: 전체 저비용 스캔. 자동 역할은 unknown이므로 수정/확인 후 정밀 분석.
- 기본 스캔10초(5~60 설정), 최대10,000 프레임 예산, 가까운 후보 병합과 앞뒤10초 미리보기 buffer. 실제 분석은 core 범위만.
- 기본 정밀 클립10초·최대20개, 최대 설정30초·200개. 초과는 partial_budgeted/review_required. 전체 긴 구간을 다 분석했다는 뜻이 아님.
- 방송 파일 최대24시간, 업로드 기본8GiB. WONY_BROADCAST_MAX_BYTES로 한도 설정 가능하나 메모리/디스크/실제 부하 확인 필요.
- LIVE HTTP(S) stream URL 또는 파일 리플레이(100MiB). 플랫폼 웹페이지 URL 해석/플랫폼 adapter는 미지원.
- LIVE: IDLE→WATCHING→BASEBALL_CANDIDATE→BASEBALL_ANALYZING→BASEBALL_ENDING→REPORT_GENERATING→WATCHING. 기본10초 감시, 30초 반복확인/최소3hit, 종료유예240초(180~600 설정). 무신호 유예에는 pose/scouting 미실행.
- 알려진 사람 역할 힌트+다중근거 때만 LIVE 클립 획득. 캡처 클립도 5초 간격/끝 프레임 재검사 후 기존 엔진으로 넘김. stop은 제한시간 있는 현재 입력/분석 완료 후 종료.

기본 탐지기는 **그라운드색 후보뿐**이고 confidence≤0.49/review_required입니다. 이것만으로 LIVE 정밀 분석은 활성화되지 않습니다. 선택 `WONY_SEGMENT_ONNX`는 로컬 YOLOv8 COCO raw ONNX [1,84,N] 경로입니다. 모델은 포함하지 않았습니다. bat≥0.8+glove≥0.8+field≥0.25, threshold≥0.8의 다중근거 규칙을 사용합니다. 공 단독은 확정 근거가 아닙니다. 실제 객체/VR UI 탐지 정확도는 미검증입니다.

진행: SCAN→BASEBALL_SEGMENT_DETECTION→SEGMENT_EXTRACTION→ROLE_ANALYSIS→POSE_ANALYSIS→SCOUTING_REPORT→COMPLETE. 역할 선택 단계 뒤 실제 pose 기반 역할 계산은 공통 엔진에서 수행됩니다. 대상 없으면 정밀 단계를 건너뜁니다. 프로세스 재시작은 interrupted이며 자동 재개는 미구현입니다.

## 10. API 빠른 참고

| API | 용도 |
| --- | --- |
| POST /api/analyze | 단일 영상; mode=auto_segments/segments도 호환 |
| GET /api/analysis/{id} | 저장된 개별 결과 그대로 재조회 |
| GET /api/analysis/{id}/assets/{filename} | 제한된 overlay/keyframe 자산 |
| POST /api/demo/{role} | 다섯 역할 synthetic_demo=true |
| POST /api/vod | exact/approximate/auto 또는 수동 segments |
| POST /api/broadcasts, GET /api/broadcasts/{id} | 긴 영상 생성/진행 조회; GET /broadcasts 목록은 없음 |
| POST /api/broadcasts/{id}/segments | 보정 후 재분석 |
| GET /api/broadcasts/{id}/source, DELETE /api/broadcasts/{id} | 원본/작업 보관 관리 |
| POST /api/live, GET /api/live/{id} | 시작/진행 |
| POST /api/live/{id}/stop, PATCH /api/live/{id}/role | 종료/사람 역할 힌트 변경 |
| POST /api/live/{id}/segments | 종료된 파일 리플레이를 VOD 경로로 보정 |
| DELETE /api/live/{id} | 종료 세션/리플레이 삭제 |
| GET /api/reports, GET /api/reports/{id}, GET /api/reports/{id}/source | 읽기 전용 목록/통합 결과/보관 원본 |
| GET /api/players/{id}/history, /api/players/{id}/scouting-report | 선수 이력/역할별 최신 종합 |

단일 업로드 role=batter/defense/catcher/pitcher/baserunning/auto, throwing_hand=right|left, position_type=auto|infielder|outfielder. 선수 ID는 ASCII 영숫자/_/- 1~64자, analysis_date는 ISO 날짜, comparison_context는1~80자입니다.

PowerShell 예시(별도 터미널, 단일 분석):

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/analyze -F "video=@C:\clips\bat.mp4" -F "role=batter" -F "player_id=PLAYER-001" -F "comparison_context=fixed-side"
```

`curl`이 PowerShell alias인 환경이 있어 **curl.exe**를 사용하세요. 복잡한 segments JSON 요청은 우선 /docs 또는 방송 UI로 확인합니다. 단일 분석은 동기200, LIVE/VOD 작업은202와 ID/진행 조회입니다. 충분한 pose가 없으면200+insufficient_pose이며 정상 테스트 시나리오입니다. 손상 입력/잘못된 역할422, 용량 초과413, 처리중503, 내부 단일 분석 실패500입니다. completed가 플레이 성공/접촉을 의미하지 않습니다.

## 11. 저장/보관/운영

기본 data에 {id}.json, {id}-assets/overlay.mp4·keyframe JPG, broadcasts/{job}/job.json·source.upload, live/{session}/session.json·선택 source.upload를 저장합니다. WONY_DATA_DIR로 변경할 때는 **절대 경로와 쓰기 권한**을 확인하세요.

단일 업로드 원본/정규화 임시 파일은 삭제하지만 오버레이와 JPEG에는 영상 내용이 남습니다. VOD/파일 리플레이 원본은 보정용으로 남습니다. URL LIVE 전체는 녹화하지 않으며 과거 보정은 별도 녹화 VOD 업로드가 필요합니다. 작업/세션 DELETE는 파생 분석 JSON/자산까지 삭제하지 않습니다.

LIVE1개/VOD1개, 정밀 엔진 lock 공유. 외부 큐/인증/사용자 격리/DB 인덱스/자동 재개/보관기한은 미구현입니다. URL 기본 public DNS 검사는 있지만 HLS 참조/redirect/DNS 변화의 완전한 egress 격리는 미구현이므로 공개 배포 준비가 끝난 상태가 아닙니다.

## 12. 테스트 — 현재 105개

최신 Linux/Python3.12 실행 기록: **pytest105개 통과, 의존성 deprecation 경고3개**. 이번 문서 작업에서는 수집만 다시 확인하여105개임을 검증했습니다. 테스트 수집 성공은 Windows 실행 성공을 의미하지 않습니다. Windows 실행은 아직 미검증입니다.

프로젝트 루트, PowerShell:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m pytest --collect-only -q
```

Linux 루트: `.venv/bin/python -m pytest -q`. pytest.ini가 backend를 pythonpath에 추가합니다. backend 폴더에서도 `../.venv/bin/python -m pytest -q`로 실행할 수 있습니다.

브라우저 테스트는 실행 중 서버 + Node.js/npm + 지원 Chromium 필요. Windows에서 설치된 Chrome 경로를 확인해 설정하세요:

```powershell
cd .\frontend-demo
npm ci
$env:CHROMIUM_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
Test-Path $env:CHROMIUM_PATH
$env:WONY_BASE_URL = "http://127.0.0.1:8000"
npm run test:browser
npm run test:broadcast
npm run test:modes
```

경로가 다르면 실제 Chrome/Chromium/Edge 실행 파일로 바꾸세요. 기본 테스트 경로 `/usr/bin/chromium`은 Windows에 없습니다. Node/browser가 필요 없는 서버 실행과 구분하세요. test:scouting은 같은 통합 UI 회귀의 alias이므로 test:browser와 별도 중복 검증이 아닙니다. 이전 Linux Chromium에서 이3종이 통과했습니다. 브라우저 테스트가 PNG/분석 데이터를 생성하므로 git status를 확인하세요.

검증 범위: 다섯 역할/부족 pose/schema/confidence/실패 정리/재조회, 시각화 자산, scouting/growth 조건 비교, 구간 예산/보정, LIVE 상태/분석 차단, 읽기 전용 리포트 그룹/메뉴/통합 역할 탭/재생·시점·키프레임/원본 부재/모바일. 생성 빈 영상은 실제 ffmpeg/MediaPipe 경로, 합성 pose는 schema/계산 테스트입니다.

## 13. 실제 미검증/미구현 항목

- 실제 사람 야구와 VR 아바타의 pose/각도/이벤트/코칭 정확도. 합성 DEMO/검은 영상 테스트로 이를 주장하지 않기.
- 360/equirectangular 투영, 다중 인물 선택, 한 영상의 개별 플레이 자동 분할.
- 자동 역할/내야·외야 분류, 배트·공·글러브 접촉, 베이스/필드 보정, 실제 경기 성공·실패.
- 실제 구속/타구속도/힘 전달/발 압력/체중 분포, 정확한 3D 깊이/축 회전, 검증된 점수 체계.
- 선택 ONNX 실제 방송/VR 오탐·누락, VR UI/스코어보드/반복 자세 classifier.
- 외부 HTTP/HLS 라이브 에지·재접속·지연·타임코드, 1~10시간 성능/메모리/디스크, Windows 실제 호환성.
- 캐릭터형3D 모델, 플랫폼 고유 adapter, WONY PHONE 통합, production 큐/인증/보관 체계.

## 14. Claude Code가 유지해야 할 경계

1. WONY PHONE 저장소/통합 코드를 수정하지 않기. 현재 작업은 독립 엔진의 Windows 실행·확인.
2. 미커밋/미추적 소스를 보존하기. reset/clean/checkout/clone으로 현재 구현을 지우지 않기. commit/push는 별도 승인 전 금지.
3. 실행 문제를 해결하려고 requirements 핀/MediaPipe API/numpy/OpenCV 구성을 임의 업그레이드하지 않기. 원인과 재현을 확인하고 최소 수정 범위를 먼저 정리하기.
4. analysis/shared, 역할 analyzer, models/result 계약, 기존 GET 호환과 플레이 timestamp를 런타임 편의를 위해 바꾸지 않기.
5. LIVE/VOD 별도 분석 엔진을 만들지 않기. source/discovery만 분리하고 execution/process_frames 경로 공유.
6. confidence/null/estimated/unknown/review_required/DEMO·실제 분리/score null 정책을 유지하기. 구속·성공·힘·점수를 임의 생성하지 않기.
7. 메인3메뉴 및 단일 통합 리포트 구조 유지. 2D/3D/Scouting을 별도 메인 화면으로 다시 분리하지 않기.
8. vendor 배포 파일/라이선스와 누락 pose 처리, 경고색 임계값, 원본 미보관 표시를 유지하기.
9. 실패 테스트를 삭제/약화하거나 결과 데이터/비밀값/.venv/캐시를 Git에 넣지 않기. 테스트 실패는 설치 문제와 기존 코드 문제를 구분해서 보고하기.
10. 사용자 영상/분석 결과/보관 원본을 허가 없이 삭제하거나 외부 공유하지 않기.

## 15. Windows 문제 확인 순서

- **경로/import:** 실행 위치는 프로젝트 루트. `--app-dir backend` 없이 루트에서 app.main을 실행하면 import 실패. 공백 경로는 따옴표; 한글/OneDrive/긴 경로 문제 진단에는 `C:\dev\...`처럼 짧은 영문 경로 권장. 원인 확인 없이 소스 경로를 하드코딩하지 않기.
- **venv/interpreter:** py -3.12 및 .venv\Scripts\python.exe를 확인. Linux .venv/bin/python은 Windows에서 사용 불가. 이미 깨진 venv면 사용자 소스/데이터를 보존하고 새 가상환경을 별도 위치에 재생성.
- **FFmpeg:** Get-Command ffmpeg, Get-Command ffprobe; 둘 다 같은 설치의 bin을 PATH에 등록하고 새 터미널. ffmpeg-python 패키지가 실행 파일을 대신하지 않음. libx264 없으면 오버레이 인코딩 실패.
- **MediaPipe:** 64-bit Python3.12/지원 wheel 확인. ARM/native 또는 다른 Python 버전의 wheel 부재를 엔진 오류로 단정하지 않기. DLL load failed면 아키텍처/설치 로그/필요한 Microsoft VC++ runtime 확인. 시스템 python과 venv pip 혼용 금지.
- **OpenCV:** opencv-contrib-python 핀 사용. opencv-python/headless를 같은 환경에 추가 설치하지 않기. 영상 재생 실패는 codec/디코딩 로그와 FFmpeg를 확인.
- **시간대:** tzdata 누락은 Asia/Seoul ZoneInfo 오류를 만들 수 있음. requirements 전체 설치 확인 후 수정.
- **권한/cache:** Windows에 Linux /tmp 경로를 그대로 설정하지 않기. 필요한 경우 `$env:MPLCONFIGDIR = Join-Path $env:TEMP 'wony-mpl'` 후 디렉터리 생성. WONY_DATA_DIR는 절대 쓰기 가능 폴더. 백신/동기화가 미디어 파일을 잠그는 경우도 확인.
- **포트/브라우저:** 8000 사용 중이면 uvicorn --port 8001과 UI/테스트 주소를 함께 변경. 서버 콘솔을 유지. ES module/importmap은 file://로 열지 말고 FastAPI HTTP URL로 열기. WebGL 미지원은 3D 표시 실패이지 pose 분석 성공/실패와 별개.
- **긴 작업:** timeout, disk/full, 파일 codec, HLS/URL 만료·방화벽을 확인. 공개 HTTP stream URL만 받고 내부 주소/플랫폼 페이지를 우회 허용하지 않기. 첫 확인은 짧은 로컬 파일과 DEMO부터 시작.

첫 보고에는 Python/ffmpeg 버전, 설치·서버·health·3메뉴·통합 리포트 확인, pytest 실행 개수/결과, 실제 영상 사용 여부, Windows 특이 오류와 재현을 구분해 적으세요.
