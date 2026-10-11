# wony-baseball-analysis

WONY PHONE과 분리된 Python/FastAPI 야구 영상 분석 MVP입니다. 타자·수비·포수·투수·주루의 단일 인물 영상에서 2D 자세 대리 지표를 분석합니다. 서비스 적용 우선순위는 타자 → 수비 → 포수 → 투수입니다. VR/360 영상 투영이나 VR 기기 연동은 아직 구현하지 않았습니다. VR 영상은 먼저 일반 평면 영상으로 변환해야 합니다.

## 현재 UI

메인 메뉴는 **대시보드 · 방송 분석 · 분석 기록**입니다. `/demo/broadcast/`에서 LIVE/VOD를 선택하고, 모든 결과는 `/demo/analysis/{id}`의 통합 리포트에서 봅니다. 역할별 정보·scouting·성장·플레이별 원본/2D/3D/keyframe을 한 페이지에서 탐색합니다. `/demo/analyses/`에 실제/DEMO 기록을 분리해서 제공합니다. [통합 UI 계약](docs/UNIFIED_UI.md)을 참고하세요. 아래 v0.3/v0.4 탭 설명은 이전 버전 기록입니다.

## 설치와 실행

Python 3.12와 PATH에 등록된 ffmpeg가 필요합니다. Linux에서는 시스템 패키지 관리자로 ffmpeg를 설치하세요. MediaPipe 0.10.21의 번들 Pose 모델을 사용하며 별도 키나 모델 다운로드는 필요하지 않습니다.

```bash
cd /workspace/wony-baseball-analysis
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
cd backend
mkdir -p /tmp/wony-mpl /tmp/wony-cache
export MPLCONFIGDIR=/tmp/wony-mpl XDG_CACHE_HOME=/tmp/wony-cache
../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

대화형 API 문서는 실행된 서버의 `/docs`에서 사용할 수 있습니다. 테스트:

```bash
cd /workspace/wony-baseball-analysis/backend
../.venv/bin/python -m pytest -q
```

## API 사용

```bash
curl -X POST http://localhost:8000/api/analyze \
  -F 'video=@bat.mp4' -F 'role=batter' -F 'throwing_hand=right' > result.json
curl http://localhost:8000/api/analysis/REPLACE_WITH_RESULT_ID
```

`role`은 `batter`, `defense`, `catcher`, `pitcher`, `baserunning`, `auto`이며 기본은 기존 요청 호환을 위해 `pitcher`입니다. `auto`는 분류기 미구현으로 `unknown`을 반환합니다. 수비는 `position_type=infielder|outfielder`를 수동 지정할 수 있고 기본 `auto`는 `unknown`입니다.

`throwing_hand`는 `left` 또는 `right`이며 기본값은 `right`입니다. POST는 동기 분석 완료 후 JSON을 반환합니다. 같은 프로세스에서 동시 분석 요청은 503을 반환합니다. MVP는 **uvicorn 단일 worker**로 실행하세요. GET은 저장된 JSON을 다시 반환하며 없는 ID는 404, 잘못된 UUID는 422입니다.

응답 예시의 아래 값은 형식 설명을 위한 예시이며 실제 측정값이 아닙니다(아래는 투수의 축약 응답입니다):

```json
{
  "id": "UUID",
  "status": "completed",
  "role": "pitcher",
  "metrics": {
    "release_time": {
      "value": 0.7,
      "unit": "seconds",
      "estimated": true,
      "confidence": 0.2,
      "confidence_grade": "low",
      "method": "Maximum sampled 2D wrist speed; ball release unverified"
    }
  },
  "ball_speed": null
}
```

실제 응답에는 역할별 `summary`, `metrics`, `events`, `strengths`, `weaknesses`, `coaching`과 프레임 수, 관절 좌표 배열(`pose`), 경고가 포함됩니다. 모든 metric과 summary 항목은 추정값 객체입니다. `confidence_grade`는 high/medium/low입니다. 낮은 신뢰도를 강조하지 마세요. 이벤트는 실제 접촉/포구를 확인한 결과가 아닌 움직임 후보입니다. 상세 지원 범위와 역할별 JSON은 HANDOFF를 참고하세요. 관절은 MediaPipe의 33개 landmark 순서이며 x/y는 이미지 정규화 좌표, z는 모델의 상대 깊이로 미터 단위가 아닙니다. 관절 `visibility`는 모델의 가시성 점수입니다. 추출한 관절도 모델 예측이며 원본 측정값이 아닙니다.

## 입력과 해석

- 최대 100 MiB, 최대 60초. ffmpeg 디코딩 제한 시간은 90초입니다. 확장자 대신 실제 디코딩으로 영상 여부를 확인합니다.
- 10 fps, 최대 320px로 축소하여 처리합니다. 짧은 릴리스 동작은 샘플링 때문에 놓칠 수 있습니다.
- 한 명의 대상, 한 번의 동작, 고정 카메라, 전신과 발목이 보이는 평면 영상을 권장합니다. 여러 사람이나 여러 동작을 자동 분리하지 않습니다.
- 투수 준비 자세는 첫 유효 프레임의 발 간격, 팔/팔꿈치/어깨/상체 각도는 후보 릴리스 프레임의 영상 평면 각도입니다.
- 스트라이드는 최대 발목 간격/몸통 길이, 하체 사용은 왼쪽 무릎 각도 변화, 체중 이동은 골반 수평 이동의 대리 지표입니다. 실제 체중·지면 반력은 측정하지 않습니다.
- 팔로스루는 후보 이후 손목 이동, 밸런스는 골반과 발목 중점의 수평 차이입니다. 투구폼 유형은 팔의 영상 내 고도에 따른 휴리스틱입니다. 카메라 시점에 따라 오분류할 수 있습니다.
- 모든 분석 항목은 `estimated=true`, `confidence`를 포함합니다. 신뢰도는 검증된 확률이 아닙니다. 값이 없는 항목은 `value=null`과 사유를 반환합니다.
- 충분한 관절이 없는 영상은 HTTP 200과 `status=insufficient_pose`를 반환합니다. 분석 완료 여부와 자세 검출 성공을 구분하세요.
- 구속은 항상 `null`입니다. 숫자 OCR이나 보정된 공 궤적 측정은 구현하지 않았습니다.

원본 업로드 파일은 처리 후 삭제하지만 **오버레이 MP4와 키프레임 JPEG에는 원본 영상 내용이 남습니다.** JSON은 `data/`에 보관합니다. `WONY_DATA_DIR`로 보관 위치를 변경할 수 있습니다. 결과에는 자세 데이터가 남으므로 필요에 따라 삭제하세요. 인증, 사용자별 접근 제어, 보관 정책이 없는 로컬 개발 MVP이므로 공개 서비스 배포 전 추가 구현이 필요합니다.

구조 및 다음 작업은 [docs/HANDOFF.md](docs/HANDOFF.md)를 참고하세요.

기존 결과 JSON은 GET으로 계속 조회할 수 있습니다. 신규 응답의 schema_version은 `0.4.0`입니다. 테스트는 저장소 루트에서도 `.venv/bin/python -m pytest -q`로 실행 가능합니다. 내부 오류는 500과 `analysis_failed`, 잘못된 role은 422를 반환합니다. 자동 역할/포지션 추정, 배트·공·미트 검출, 실제 반응시간/포구성공은 미지원으로 null 또는 unknown입니다.

## 2D / 3D 시각화 (v0.3)

서버의 `/demo/`에서 독립 시각화 데모를 사용합니다. 2D skeleton overlay, 단계별 키프레임, 3D stick figure를 한 화면에서 재생할 수 있습니다. 재생/일시정지, 프레임 슬라이더, front/side/rear, 마우스 회전, 키프레임 점프를 지원합니다. Three.js는 로컬에 포함되어 프론트 빌드나 CDN 연결이 필요 없습니다.

분석 응답의 `visualization`에 `overlay_video_url`, `keyframes`, `pose3d.frames`를 추가했습니다. assets는 `/api/analysis/{id}/assets/{filename}`에서 조회하며 MP4 byte-range 재생을 지원합니다. 10 fps로 샘플링한 입력 프레임 위에 skeleton을 표시합니다. 관절 없는 프레임은 빈 3D joints를 유지하고 다른 프레임을 대신 복사하지 않습니다.

3D는 MediaPipe 상대 z를 사용하는 **추정 시각화**이며 실제 깊이/생체역학 수치가 아닙니다. 모든 3D 프레임은 estimated=true, confidence≤0.35입니다. 앞발 착지/임팩트는 검출하지 않고 reference_only 키프레임으로 구분합니다. 경고색은 근거 있는 지표와 문제 항목 모두 confidence≥0.75일 때만 허용하며, 현재 3D 좌표에는 경고색을 적용하지 않습니다.

합성 데모와 화면 캡처는 실제 사람 영상의 정확도 검증이 아닙니다. `POST /api/demo/{role}`은 생성한 도형과 관절을 사용하며 `synthetic_demo=true`입니다. [시각화 데모 안내](frontend-demo/README.md), [화면 캡처](docs/screenshots/README.md)를 참고하세요.


## 스카우팅 리포트와 성장 추적 (v0.4)

기존 2D/3D 시각화를 유지하며 `/demo/`에 **Scouting Report** 탭을 추가했습니다. 선수 요약, 다섯 역할 평가 항목, 강점·개선점, 플레이별 분석, 성장 추적을 제공합니다. 플레이 버튼은 같은 분석의 2D/3D 프레임으로 이동합니다.

```bash
curl -X POST http://localhost:8000/api/analyze \
  -F video=@bat.mp4 -F role=batter -F player_id=PLAYER-001 \
  -F analysis_date=2026-10-12 -F comparison_context=side-camera-A
curl http://localhost:8000/api/players/PLAYER-001/history
curl http://localhost:8000/api/players/PLAYER-001/scouting-report
```

`player_id`는 영문·숫자·밑줄·하이픈 1~64자입니다. 날짜 생략 시 한국 시간 기준 오늘을 저장합니다. `comparison_context`는 동일 촬영 시점·과제를 나타내는 사용자 선언(1~80자)이며 서버가 촬영 조건을 검증하지는 않습니다.

응답 `scouting_report`에는 `role_evaluations`, `plays`, `ratings`, `strengths`, `development_areas`, `traits`, `overall_summary`가 포함됩니다. **검증된 점수 산정 기준이 없으므로 실제 분석의 모든 점수/등급은 null입니다.** 자세 관찰값은 별도 `observation`으로 제공하며 공식 프로 스카우팅 점수로 해석하면 안 됩니다. 주루 가속도·반응시간·판단·슬라이딩 등 근거 없는 항목도 null입니다.

선수 기록은 기본 `source=real`이며 합성 기록은 `?source=demo`로 따로 조회합니다. 같은 역할·촬영 조건·방법·단위와 충분한 신뢰도가 있을 때만 자세 대리 지표의 이전 대비 차이를 계산합니다. 차이는 기량 향상의 증거가 아닙니다. `GET /api/demo/growth`의 62→71→77 예시는 **DEMO 임의 데이터**로 실제 기록에 저장하지 않습니다.

검증: 백엔드 pytest **72개 통과**, 기존 시각화 및 새 리포트 Chromium 브라우저 테스트 통과. 실제 야구/VR 영상 정확도와 자동 플레이 분리는 아직 검증하지 않았습니다. [Windows 실행 안내](docs/WINDOWS.md), [리포트 화면 캡처](docs/screenshots/scouting-report.png)를 참고하세요.


## 긴 방송 분석

기존 엔진 앞에 sparse segment detection layer를 추가했습니다. `POST /api/analyze`의 `mode=auto_segments` 또는 수동 `segments`를 사용하면 HTTP 202 작업 ID를 반환하고 `/api/broadcasts/{id}`에서 진행/구간을 조회합니다. `/demo/` 하단에 타임라인·구간 미리보기·수정·재분석이 있습니다. 기본 10초 간격 스캔, 근접 병합/버퍼, 최대 스캔 프레임·정밀 클립 예산을 지원합니다.

**현재 기본 탐지는 색상 기반 검토 후보이며 완성된 야구 분류기가 아닙니다.** 선택적 로컬 YOLOv8 COCO ONNX로 배트/글러브 다중 근거를 추가할 수 있습니다. 역할 unknown/낮은 confidence는 정밀 분석을 건너뛰며 사람의 구간·역할 지정 후 분석합니다. VR UI/자동 역할 분류와 실제 장시간 정확도 검증은 미지원입니다. 전체 방송 원본은 보정용으로 보관합니다. [API·비용·모델·보관 정책](docs/BROADCAST_SEGMENTS.md)을 참고하세요.


## LIVE / VOD

`/demo/live/`는 HTTP(S) 스트림 또는 파일 리플레이를 저비용 감시하고 반복 다중 신호 확인/종료 유예를 적용합니다. `/demo/broadcast/`는 정확 구간, 대략 구간+버퍼, 중심 시점±탐색 폭, 전체 자동 탐색을 지원합니다. 둘 다 같은 detector와 `segments/execution.py`를 통해 기존 다섯 역할/2D/3D/events/scouting 엔진을 재사용합니다.

API: `POST /api/live`, `GET /api/live/{id}`, `POST /api/live/{id}/stop`, `PATCH /api/live/{id}/role`; `POST /api/vod`와 기존 broadcast 조회/수정 API. **기본 색상 단서만으로는 LIVE 분석이 활성화되지 않으며 자동 역할은 unknown**입니다. 선택 객체 모델과 사람 역할 힌트가 필요합니다. [설정·요청 예시·파일 목록·검증 한계](docs/LIVE_VOD.md)를 참고하세요.
