# 5툴 스카우팅 — 영상 근거 기반 관찰 계약

구현 전 GAP은 [SCOUTING_GAP.md](SCOUTING_GAP.md)에 있다. 기존 역할 analyzer는 유지했다. LIVE/VOD/upload 모두 `segments/execution.py → api/routes.process_frames → scouting/report.build_report → scouting/tools.build_tools`를 공유한다. `scouting/proxies.py`는 공통 `analysis/shared/pose_metrics.pose_rows`와 confidence utility를 재사용한다. 새 역할 판별기·LIVE/VOD 전용 스카우팅 엔진은 없다.

## 결과와 상태

기존 `schema_version=0.4.0`, metrics/summary/events/visualization/role_evaluations/ratings를 보존한다. 새 분석의 `scouting_report`에 다음 필드를 추가한다.

- `player_tools`: contact / power / speed / fielding / arm. 각 항목에 status, score=null, grade=null, estimated=true, confidence, confidence_grade, summary, observations, evidence, reason.
- `additional_evaluations`: reaction / balance / footwork / baserunning / catching / timing / swing_consistency.
- `proxy_metrics`: 실제 계산한 숫자·단위·method와 confidence.
- `role_summary`: role, position_type, summary, 역할별 assessments.
- `observation_window`: usable pose duration/sample count/max gap. 촬영 조건이 같아도 비교할 관측 범위가 다르면 비교를 보류한다.
- `movement_signature`: 스윙 후보 전후 -0.2~+0.2초의 몸통 기준 손 중심 경로 20점. 후보 전후 데이터가 충분할 때만 저장한다. 반복성 집계를 위한 작은 서명이며 접촉 이벤트가 아니다.
- `tools_method_version=tools-image-proxies-v1`.
- `best_tool`, `development_area`, `play_style`: 검증된 상대평가 근거가 없어 null. 기존 관측 기반 개선점 배열은 유지한다.

| status | 의미 |
|---|---|
| measured | 측정/보정 근거가 확인된 값용 예약 상태. 현재 5툴 구현은 사용하지 않는다. |
| estimated | 실제 pose 좌표로 계산한 **영상 평면 대리 지표**가 있다. 경기 능력이 측정됐다는 뜻이 아니다. |
| insufficient_data | 해당 역할/움직임/연속 샘플/반복 후보가 부족하다. |
| not_supported | 필요한 공·배트·미트·자극·필드 추적/보정 기능이 현재 없다. |

상위 툴 status=estimated라도 일부 observations는 not_supported다. 예: CONTACT는 머리 움직임 관측이 있어 estimated지만 실제 contact observation은 null/not_supported. UI 한줄 요약이 이 차이를 설명한다. 단순히 주루 역할을 지정한 정지 영상은 SPEED=insufficient_data다.

Confidence는 보정된 확률이 아닌 휴리스틱 제한값이다. 새 속도/경로 대리 지표는 대부분 0.20~0.30, 중심 변동은 최대 0.45. low/medium/high 구분은 기존 규칙(0.4/0.75 경계)을 사용한다. 점수·excellent/good 등 능력 등급을 생성하지 않는다. heuristic confidence를 성공률로 읽으면 안 된다.

## 실제 계산

좌표는 x에 aspect ratio를 곱한 2D 영상 평면이다. 몸통 길이 L은 양어깨 중심–양골반 중심 거리의 구간 중앙값. 샘플 5개 이상, 0.4초 이상에서 새 proxy를 계산한다. 속도/가속도는 사용 가능한 샘플 사이 공백이 0.25초를 넘으면 제공하지 않는다. 시간은 프레임 timestamp를 사용한다.

| 지표 | 계산 및 한계 |
|---|---|
| hand_speed_proxy | 손목 양쪽 중심–골반 중심을 L로 나눈 경로의 시간 차분 속도 최댓값. torso_lengths_per_second. 배트 속도가 아니다. |
| hand_acceleration_proxy | 위 속도 변화/인접 시간 간격, 절댓값 최대. 노이즈/샘플링에 민감. |
| hip_shoulder_separation_proxy | 골반선과 어깨선의 영상 평면 각도 차를 [-180,180]으로 감아 절댓값 최대. 실제 축 회전 분리각이 아니다. |
| trunk_orientation_speed_proxy | 어깨 중심–골반 중심 축의 영상 평면 방향 변화 속도 최대. 실제 축 회전 속도가 아니다. |
| arm_path_proxy / arm_speed_proxy | 지정한 송구 팔의 손목–골반 중심 경로 길이 합/속도 최대. 실제 송구·릴리스 여부는 미확인. |
| arm_elevation_proxy | 지정 팔 손목–어깨의 영상 평면 고도각 중앙값. |
| elbow_mechanics_proxy / shoulder_mechanics_proxy | 공통 2D 각도 함수로 계산한 지정 팔 각도의 구간 중앙값. |
| balance_variability_proxy | 양발 중심 대비 골반 수평 오프셋/L의 표준편차. 압력 중심이 아니다. |
| body_control_proxy | 초기 골반 대비 최대 영상 이동/L. 몸 중심 이동량이며 능력 점수가 아니다. |
| range_proxy | 골반 위치의 x/y 범위로 구성한 대각 길이/L. 실제 필드 수비 범위가 아니다. |
| footwork_path_proxy | 양발목의 프레임 간 경로 길이 합/L. 스텝 수가 아니다. |
| stride_width_proxy | 양발목 영상 거리의 중앙값/L. 실제 보폭/stride length가 아니다. |
| running_speed_proxy | 주루 역할에서 골반 순이동 >0.2L일 때, 영상 평면 골반 속도의 중앙값. 카메라 이동 영향 포함. |
| running_acceleration_proxy / deceleration_proxy | 위 속도의 시간 차분 최대/감속 최대. 실제 m/s²가 아니다. |
| direction_change_proxy | 유의미한 영상 이동 방향의 펼친 각도 범위. 필드 전후 방향이 아니다. |
| running_consistency_proxy | 한 클립 영상 이동 속도의 표준편차/평균. 여러 주루 플레이의 일관성이 아니다. |
| stride_frequency_proxy / cadence_proxy | 양발목 y 차/L의 진폭 있는 교대 주기에서 양의 peak 3개 이상·중간 음의 trough·주기 0.25~2.5초일 때 주파수 계산. cadence=frequency×120. 실제 발 접촉·압력·물리적 보폭은 미확인. |
| hand_path_consistency_proxy | 같은 선수·촬영 조건의 별개 스윙 후보 클립 3개 이상(최근 선언된 촬영 조건 그룹)을 정렬한 손 경로와 중앙 경로 사이 RMS 편차. 몸통 단위, confidence=0.2. 실제 컨택/스윙 성공의 일관성이 아니다. |

기존 머리 안정성, 골반/어깨선 변화, 중심/무릎/손목 관측과 함께 역할별 요약에 연결한다. catcher receiving은 낮은 자세/중심 높이 관찰을 제공하되 실제 receiving_posture/receive_success는 계속 미지원이다. 내야/외야는 기존 수동 context를 보존하며 자동 확정하지 않는다.

## 근거와 집계

`evidence`는 analysis_id, role, play_id(없으면 null), timestamp, scope=whole_clip, candidate=true, synthetic_demo, visualization_reference를 가진다. 첫 이벤트 후보는 클립 검토를 여는 연결점이다. **클립 전체의 숫자나 피드백을 해당 플레이의 국소 판정으로 재분류하지 않는다.** 기존 play의 keyframe/각도/2D overlay/3D reference를 재사용한다. 이벤트가 없으면 클립 전체 보기로 연결한다.

`GET /api/reports/{id}`는 5툴을 최상위에 집계한다. 동일 분석 ID는 한 번만 센다. 각 툴 관측값은 최근 해당 역할 클립을 대표로 선택하고 근거 목록을 모으며, 서로 다른 각도/역할의 수치를 평균내지 않는다. 서로 다른 선수 ID(미지정 혼합 포함)나 실제/DEMO 소스는 한 평가로 묶지 않는다. 선수 ID가 없는 단일 소스 묶음은 신원이 확인된 선수 평가가 아니다.

과거 저장 파일과 `GET /api/analysis/{id}` 응답을 변경하지 않는다. 5툴이 없는 과거 기록은 report endpoint가 읽기 전용 `entries[].scouting_extension`을 별도로 구성한다. pose가 없는 기록에서는 새 계산을 억지로 만들지 않는다.

`GET /api/players/{player_id}/scouting-report?source=real|demo`도 player_tools/근거 집계를 반환한다. 새 기록의 compact movement_signature로 복수 후보 경로 반복성을 비교한다. 실제 공 접촉을 검사하는 contact classifier가 아니다.

## API 입력과 성장 비교

추가 endpoint는 없다. `/api/analyze`, `/api/demo/{role}`, `/api/vod`, `/api/live`의 multipart에 선택적 `capture_context` JSON과 `comparison_context`를 사용한다. player_id는 기존 형식을 유지한다.

```json
{
  "camera_angle": "side-fixed-A",
  "environment": "vr",
  "vr_environment": "WONY-baseball-same-build",
  "video_quality": "good",
  "camera_motion": "fixed",
  "projection": "flat"
}
```

VR은 vr_environment 필수. environment는 real/vr, quality는 good/fair/poor, camera_motion은 fixed/moving/unknown, projection은 flat/360. 잘못된 JSON/조건은 분석 시작 전 422. 조건은 **사용자가 선언한 정보**이며 카메라 calibration 인증이 아니다.

PowerShell 예시(주소는 로컬 PC에서 서버 실행 후 사용):

```powershell
$ctx = '{"camera_angle":"side-A","environment":"vr","vr_environment":"same-game-build","video_quality":"good","camera_motion":"fixed","projection":"flat"}'
curl.exe -X POST "http://127.0.0.1:8000/api/analyze" -F "video=@practice.mp4" -F "role=batter" -F "player_id=PLAYER-1" -F "comparison_context=same-practice" --form-string "capture_context=$ctx"
```

DEMO 확인은 `/api/demo/batter`에 위 player/context를 넣어 POST. LIVE/VOD도 동일 metadata가 공통 상세 분석 엔진까지 전달되고 수동 구간 재분석에 보존된다. 독립 엔진의 인증/보관 구조는 이번에 변경하지 않았다.

`GET /api/players/{id}/history?source=real|demo`의 각 point:

- `comparison_compatible`, `comparison_reason`, `capture_context`.
- `tool_changes.{contact|power|speed|fielding|arm}.{metric}`에 value, previous_value, delta, unit, comparable, reason, confidence.
- 기존 observations/criterion_scores/rating_deltas 유지. 점수 변화는 계속 null.

수치 비교는 같은 identified player, 역할, real/DEMO, 명시한 comparison_context, 카메라 각도/환경/VR 환경/화질/투영, 팔/포지션, observation method가 모두 일치해야 한다. fixed camera·usable quality·flat projection만 허용한다. 관측 시간/샘플 개수가 10% 넘게 다르거나 pose gap>0.25초면 비교하지 않는다. 누락 metadata도 비교 불가. 각 숫자는 단위/method 일치·finite number·confidence 기준이 추가로 필요하다(기존 observations ≥0.4, 새 tools ≥0.2). 호환 플래그가 true라도 미지원/저신뢰 observation의 delta는 null이다. 툴 변화는 저신뢰 이미지 proxy 비교이며 실력 향상을 증명하지 않는다.

## 통합 UI

기존 메인 3메뉴와 `/demo/analysis/{id}`를 유지한다. 종합은 PLAYER TOOLS → 강점 → 개선점 → 역할별 요약 → 성장 비교 → 플레이 근거 순서. 5툴 카드 앞면에는 상태와 짧은 관찰 요약만 표시하고, confidence/estimated/단위/method/raw values/근거 버튼은 펼친 상세에 둔다. 근거 버튼은 기존 원본/2D/3D/keyframe 영역을 연다. 역할 탭은 스카우팅 요약/assessment를 먼저 보여주고 관절 raw 값은 상세로 옮겼다. 성장 조건은 대시보드/LIVE/VOD의 기존 고급 설정에서 입력한다. DEMO 표시는 유지한다.

## 검증과 남은 한계

Linux Python3.12 서버 테스트 **172개 통과**(기존 129개 유지, 새 43개), 기존 third-party deprecation 경고 3개. 계산식·연속 샘플·발 주기·실제 구속 null·역할 요약·중복/서로 다른 선수/DEMO 집계 차단·근거 시각화·성장 조건/관측 범위·LIVE/VOD metadata 전달을 검증한다. 기존 테스트의 비교 fixture에는 새 필수 촬영 조건을 선언했고 기존 assertion은 보존했다.

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests -q
cd frontend-demo
npm ci
$env:CHROMIUM_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node tests/unified.mjs
node tests/modes.mjs
node tests/broadcast.mjs
node tests/tools.mjs
```

실제 사람/WONY/VR의 pose 정확도, projected speed/가속도의 흔들림, cadence 오탐, 카메라/원근 영향, 자동 역할/야구 구간 탐지 정확도는 실제 영상으로 검증해야 한다. 서로 다른 VR build/아바타 스케일/애니메이션, 카메라 움직임과 컷, 다인 화면/가림, 낮은 FPS/360 영상에서 실제 경기 능력을 해석하지 않는다. 합성 pose·DEMO와 검은 영상 테스트가 실방 정확도를 입증하지 않는다.

현재 미지원: 실제 컨택/헛스윙·반응 자극·bat/exit/throw velocity·비거리·필드 거리 보정·actual speed·60야드·베이스 접근/슬라이딩/판단·실제 송구 전환/릴리스 일관성·fielding 성공/프레이밍·검증된 점수/등급/강한 툴/스타일 분류. 거리 calibration+정확한 FPS+물체 추적을 제공하는 검증된 측정 adapter가 추가되기 전까지 physical observation을 pose proxy로 채우지 않는다. 실제 힘/압력은 pose만으로 측정하지 않는다.

## 이번 변경 파일

이전 URL/자동 역할/LIVE 신호 작업의 미커밋 변경은 보존했다. 이번 5툴 작업의 범위:

새 파일:

- backend/app/api/capture.py
- backend/app/scouting/context.py, proxies.py, tools.py
- backend/tests/test_player_tools.py
- frontend-demo/capture.js, tests/tools.mjs
- docs/SCOUTING_GAP.md, SCOUTING_TOOLS.md

수정 파일:

- backend/app/api/routes.py, modes.py, reports.py
- backend/app/models/result.py, storage.py
- backend/app/scouting/report.py, growth.py
- backend/app/segments/execution.py
- backend/tests/test_scouting.py (기존 assertion 유지, 비교 fixture 조건 선언)
- frontend-demo/analysis.html, report.js, styles.css
- frontend-demo/dashboard.js, broadcast.js, live.js, README.md
- README.md, docs/HANDOFF.md, docs/CLAUDE_HANDOFF.md

WONY PHONE은 수정하지 않았으며 commit/push하지 않았다. 테스트 분석 데이터와 캡처는 /tmp의 별도 디렉터리에 생성했다.

타격만 분석한 경우 응답의 일부(전체 fields/다른 툴은 생략):

```json
{
  "scouting_report": {
    "player_tools": {
      "speed": {
        "status": "insufficient_data",
        "score": null,
        "grade": null,
        "estimated": true,
        "confidence": 0.0,
        "summary": "분석한 역할에 해당하는 데이터가 없습니다."
      }
    },
    "best_tool": null,
    "development_area": null,
    "play_style": null
  }
}
```

역할 탭의 assessment는 최근 역할 클립의 대표 관찰로 한 번 표시하며, 클립별 raw 값/시각화는 상세와 플레이에 둔다. 여러 호환 스윙 후보가 있는 방송 묶음에서는 aggregate hand_path_consistency_proxy를 역할 탭에도 연결한다.
