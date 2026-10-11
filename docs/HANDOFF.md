# 독립 야구 분석 엔진 인수인계 — v0.4

서비스 적용 우선순위는 **batter → defense → catcher → pitcher**입니다. WONY PHONE 통합은 수행하지 않았습니다. 아래 UI 내용은 향후 연동을 위한 제안입니다.

## 구조와 실행

- `analysis/engine.py`: 수동 역할 라우팅 및 auto unknown 응답.
- `analysis/shared/angles.py`: 공통 관절 각도와 상체 기울기 계산.
- `analysis/shared/pose_metrics.py`: landmark 검증, 유효 프레임 선택, 공통 좌표/길이/동작 계산. 투수도 같은 경로 사용.
- `analysis/shared/confidence.py`: 추정값 형식, 신뢰도 등급, 제한적인 장점/단점/코칭.
- `analysis/shared/event_utils.py`: 역할별 공통 이벤트 포맷.
- `analysis/shared/fielding.py`: 수비·포수의 자세/이동 공통 계산.
- `analysis/{batter,defense,catcher,pitcher}/analyzer.py`: 역할별 분석.
- `analysis/defense/{infielder,outfielder}.py`: 세부 분석 확장 경계와 현재 미지원 항목.
- `models/result.py`: POST 응답과 저장 결과의 Pydantic 계약. GET은 이전 v0.1 JSON도 조회 가능하도록 그대로 반환.

Python 3.12, ffmpeg, 가상환경 설치와 실행은 README를 참고합니다. uvicorn은 단일 worker로 사용합니다. 입력 한 개에서 한 사람·한 동작을 분석하며 여러 투구/스윙 자동 분할은 아직 없습니다. 최대 100 MiB, 60초, 10 fps, 최대 320px입니다. 원본 업로드는 삭제하고 결과 JSON은 `backend/data/` 또는 `WONY_DATA_DIR`에 남습니다.

## 역할 지정과 API

`POST /api/analyze` multipart 필드:

| 필드 | 값 | 기본값/의미 |
|---|---|---|
| video | 영상 파일 | 필수 |
| role | batter / defense / catcher / pitcher / baserunning / auto | pitcher; 기존 요청 호환 |
| throwing_hand | right / left | right; 투구/송구 팔, 반대 손목을 글러브 대리값으로 사용 |
| position_type | auto / infielder / outfielder | auto; defense용 수동 포지션 힌트 |

```bash
curl -X POST http://localhost:8000/api/analyze -F video=@bat.mp4 -F role=batter
curl -X POST http://localhost:8000/api/analyze -F video=@field.mp4 -F role=defense -F position_type=infielder
curl -X POST http://localhost:8000/api/analyze -F video=@outfield.mp4 -F role=defense -F position_type=outfielder
curl -X POST http://localhost:8000/api/analyze -F video=@catch.mp4 -F role=catcher -F throwing_hand=right
curl -X POST http://localhost:8000/api/analyze -F video=@pitch.mp4 -F role=pitcher
curl -X POST http://localhost:8000/api/analyze -F video=@unknown.mp4 -F role=auto
curl http://localhost:8000/api/analysis/RESULT_UUID
```

타격 좌/우 타석 방향을 throwing_hand에서 추론하지 않습니다. `position_type`은 사용자의 선언이며 자동 추정의 성공으로 표시하지 마세요. 자동 분류기는 아직 없으므로 auto는 `role=unknown`, 다섯 후보의 confidence=0을 반환합니다. 내야/외야도 수동 힌트가 없으면 unknown과 두 후보를 반환합니다.

상태는 `completed`(자세 계산 완료), `insufficient_pose`(유효 pose 3개 미만), `unknown_role`(auto 분류 불가)입니다. auto에서 pose도 부족하면 insufficient_pose가 우선합니다. completed는 플레이 성공이나 객체 검출을 뜻하지 않습니다. 잘못된 role/position/hand와 손상 영상은 422, 크기 초과는 413, 동시 분석은 503, 내부 분석 실패는 500 + `detail.code=analysis_failed`입니다. 실패한 분석은 결과를 저장하지 않습니다. GET의 없는 ID는 404입니다.

## 타자 분석

| 항목 | 반환 키 | 현재 근거/상태 |
|---|---|---|
| 기본 스탠스 open/square/closed | stance_type | 타석/투구 방향 보정 없어 null |
| 스탠스 폭 | stance_width | 초기 발목 간격/몸통 길이 |
| 무릎 굽힘 | knee_flexion | 양 무릎 2D 굽힘 평균 |
| 상체 기울기 | trunk_lean | 영상 수직 기준 2D 각도 |
| 배트 시작 위치 | bat_start_position | 배트 검출 없어 null |
| 레그킥 여부 | leg_kick | 발목의 영상 위쪽 이동 >0.2 몸통 길이; 저신뢰 대리값 |
| 앞발 착지 | front_foot_landing_time | 앞발 식별/이벤트 분할 없어 null |
| 체중 이동 | weight_transfer_score | 골반 이동/몸통 길이; 실제 체중 아님 |
| 골반/어깨 회전 | hip_rotation / shoulder_rotation | 영상 내 관절선 각도 변화; 실제 3D 축 회전 아님 |
| 머리 고정 | head_stability_score | 초기 대비 최대 머리 좌표 이동/몸통 길이 |
| 손 선행 | hands_lead | 배트/이벤트 순서 검출 없어 null |
| downswing/level/uppercut | swing_type | 가장 빠른 양손 중심 이동 구간의 수직 경사; 배트 궤적 아님 |
| 임팩트 | impact_time | 공·배트 접촉 확인 없어 null |
| 팔꿈치/손목 | elbow_angle / wrist_angle | 지정 팔의 2D 팔꿈치; 손목은 손 landmark 없어 null |
| 팔로스루 | follow_through | 손 움직임 후보 이후 손 중심 이동 |
| 타격 후 밸런스 | balance | 마지막 프레임 골반-발목 중점 차이 |
| 헛스윙/컨택/파울·인플레이/당겨치기·밀어치기 | whiff / contact / foul_or_in_play / pull_or_opposite | 공·배트·필드 검출 없어 모두 null |

summary는 stance_type, swing_type, head_stability, weight_transfer의 **metric 객체**입니다. 예시의 단순 문자열 대신 confidence를 같이 전달합니다. swing_type의 level은 예시의 level swing에 대응합니다. 머리 안정성은 0.15 몸통 길이 임계값으로 stable_in_image/moving_in_image를 표시하며 기술 수준을 판정하지 않습니다.

## 수비 분석

| 항목 | 키 | 현재 근거/상태 |
|---|---|---|
| 준비/무릎/중심 높이·위치 | ready_stance / knee_flexion / center_height / center_position | 초기 2D 자세 |
| 첫 스텝 방향/시점 | first_step_direction / first_step_time | 골반 0.1 몸통 길이 이동 첫 시점; image_left/image_right/image_up/image_down |
| 첫 스텝 반응 시간 | reaction_time | 자극(타격) 시점 없어 null; 클립 시작 대비 시간과 구분 |
| 좌우/전후 이동 | lateral_movement / depth_movement | 영상 수평 이동; 전후는 보정 없어 null |
| 타구 방향 반응/포구 중심 | ball_direction_response / fielding_center | 타구·포구 검출 없어 null |
| 글러브 위치/이동 | glove_position / glove_movement | 비송구 손목 대리값; 글러브 검출 아님 |
| 몸 앞 포구/포핸드·백핸드 | catch_in_front / forehand_backhand | 깊이·공·글러브 검출 없어 null |
| 송구 전환/준비 | throwing_transition / throwing_preparation | 포구 이벤트/공 검출 없어 null |
| 풋워크 | footwork | 양 발목 누적 2D 이동; 스텝 수/효율 판정 아님 |
| 밸런스/종료 안정성 | balance / end_stability | 마지막 골반 중심 편차/마지막 3프레임 골반 변화 |

`fielding`, `tracking`, `catching`, `throwing_transition`, `infield` 그룹을 제공합니다. 내야의 ground_ball, double_play_preparation, first_base_throw_preparation, base_cover와 외야의 ball_judgment, landing_point_movement, advance_or_retreat, relay_direction은 공·필드·베이스 보정이 없어 null입니다. 내야·외야 전용 모델을 구현했다는 뜻은 아닙니다.

## 포수 분석

| 항목 | 키 | 현재 근거/상태 |
|---|---|---|
| 준비/무릎/상체 높이/중심 | ready_stance / knee_flexion / trunk_height / center_height / center_position | 초기 2D 자세 |
| 미트 시작/이동 | mitt_start_position / mitt_movement | 비송구 손목 대리값 |
| 포구 자세/프레이밍 | receiving_posture / framing | 공·미트/포구 이벤트 없어 null |
| 낮은 공 블로킹/좌우 이동 | low_blocking_posture / lateral_blocking | 무릎 굽힘 >60도 후보/골반 수평 이동; 공 블로킹 확인 아님 |
| 일어남 | standing_up | 초기 대비 골반 위쪽 이동 대리값 |
| 포구 후 송구 준비/전환 시간 | throwing_preparation / transition_time | 포구·송구 검출 없어 null |
| 상체 회전/밸런스 | upper_body_rotation / balance | 영상 관절선 방향 변화/골반 편차 |
| 포구·블로킹 성공/송구 시작/2루 준비 | receive_success / blocking_success / throw_start_time / second_base_preparation | 공·이벤트·타깃 확인 없어 null |

`receiving`, `blocking`, `throwing_transition` 그룹과 자세/무릎/밸런스 summary를 제공합니다.

## 투수 유지

12개 기존 metrics 및 ball_speed=null을 유지합니다. 관절/각도 계산은 공통 모듈로 이동했습니다. 정지 자세에서는 release_time=null, 이벤트 없음으로 반환하도록 개선했습니다. 동작이 없을 때 각도는 첫 유효 프레임 기준입니다. 후보 이후 동작과 투구폼 유형은 여전히 저신뢰 휴리스틱입니다.

## 응답 JSON과 이벤트

신규 응답은 schema_version=0.4.0, id, role, requested_role, status, summary, metrics, events, strengths, weaknesses, coaching, pose, warnings 등을 포함합니다. 다음은 **구조 설명용 축약 JSON**이며 실제 영상 분석 결과가 아닙니다. 완전한 합성 pose 예시는 `docs/examples/`에 있습니다.

```json
{"role":"batter","summary":{"swing_type":{"value":"level","estimated":true,"confidence":0.2,"confidence_grade":"low"}},"metrics":{},"events":[],"strengths":[],"weaknesses":[],"coaching":[]}
```
```json
{"role":"defense","position_type":"infielder","position_source":"manual","summary":{},"fielding":{},"tracking":{},"catching":{},"throwing_transition":{},"metrics":{},"events":[]}
```
```json
{"role":"catcher","summary":{},"receiving":{},"blocking":{},"throwing_transition":{},"metrics":{},"events":[]}
```
```json
{"role":"pitcher","summary":{},"metrics":{"release_time":{"value":null,"estimated":true,"confidence":0,"confidence_grade":"low","reason":"No significant wrist motion; release candidate unavailable"}},"events":[],"ball_speed":null}
```

공통 이벤트는 `{timestamp, role, type, estimated, confidence, confidence_grade, candidate, metrics}`입니다. timestamp는 정규화된 영상의 초 단위 시간입니다. batter의 swing은 가장 빠른 양손 중심 이동, catcher receive/defense fielding은 가장 빠른 비송구 손목 이동, pitcher release는 가장 빠른 투구 손목 이동에서 발생하는 **미확인 후보**입니다. 영상 초당 몸통 길이 0.5 이상의 움직임이 필요하며 정지 자세는 이벤트를 생성하지 않습니다. 실제 접촉/포구/릴리스를 확인한 것으로 표시하지 마세요. 역할별 한 후보만 반환하며 여러 동작 이벤트 분할은 미구현입니다.

## confidence와 VR 한계

모든 metric은 value, unit, estimated=true, confidence(0–1), confidence_grade, method, reason을 갖습니다. null 값은 confidence=0과 사유가 있습니다. 요약과 장점/단점/코칭 항목도 추정/신뢰도 정보를 유지합니다. grade는 high≥0.75, medium≥0.4, 그 미만 low입니다. 신뢰도는 가시성과 보수적 규칙 기반의 **비보정 점수**이며 확률/정확도가 아닙니다. MVP 지표는 대부분 medium 또는 low이며 high 정확도를 주장하지 않습니다.

VR 아바타는 실제 관절과 애니메이션이 다를 수 있고 MediaPipe가 실패할 수도 있습니다. 360/equirectangular 투영은 미지원이며 평면 영상으로 변환해야 합니다. 고정 카메라·한 사람·전신 가시성을 전제로 하며 카메라 이동/원근/가림에 따라 값이 변합니다. 실제 힘 전달, 발 압력, 체중 분포, 실제 구속/타구 속도를 확정하지 않습니다. 공 속도와 타구 속도는 null입니다.

## 향후 WONY PHONE 표시 권장

이 단계에서는 WONY PHONE 코드 변경이나 API 연동을 하지 않았습니다.

- 바로 연결하기 좋은 것: role/수동 position 표시, 분석 상태, confidence 배지, 관절·프레임 수, medium 이상의 영상 평면 자세 수치(스탠스 폭/무릎/상체 기울기/머리 이동/중심 편차). 화면에 '영상 기반 추정'과 단위를 함께 표시하세요.
- 강조하면 안 되는 것: low 이벤트와 swing_type, 체중 이동/회전 대리값, 미트/글러브 대리값. 상세 펼침에서 계산 근거와 함께만 노출하세요.
- 아직 표시하면 안 되는 것: null을 0이나 '실패'로 바꾼 결과, 컨택/헛스윙/파울/성공 판정, 실제 반응/송구 전환 시간, 자동 포지션, 실제 배트 궤적/구속/타구 속도, 실제 발 압력/힘. 미지원 안내 또는 항목 숨김을 사용하세요.

UI 추천:

1. 타자: 첫 탭. 머리 이동·스탠스 폭·무릎 굽힘 카드 → 추정 스윙 후보 타임라인 → 장점/단점/코칭(있을 때만).
2. 수비: 내야/외야 수동 선택 → 영상 좌우 이동·풋워크·종료 중심 카드. '빠른 반응', '몸 앞 포구' 같은 미검증 칭찬은 하지 않기.
3. 포수: receiving/blocking/throwing_transition 섹션. 실제 성공 판정 대신 자세·손목 대리값과 미지원 안내.
4. 투수: 기존 각도/중심 카드 유지. 릴리스는 후보 표시, 구속은 숨김.

장점/단점은 현재 머리 안정성과 밸런스의 보수적 임계값에만 기반합니다. confidence<0.4이면 생성하지 않으며 빈 배열도 정상입니다. 전문가 판정이나 개인 맞춤 훈련 처방은 아닙니다.

## 검증과 다음 작업

자동 테스트는 기존 투수 회귀, 네 역할 합성 pose 정상/부족/정지 상태, 지표 신뢰도, 이벤트 schema, 수동 포지션/auto unknown, 잘못된 role, 내부 실패 정리, POST/GET 동일 결과를 검증합니다. 실제 ffmpeg/OpenCV/MediaPipe 경로는 사람 없는 생성 영상으로 검증합니다. 합성 pose 테스트는 실제 야구/VR 영상 정확도를 입증하지 않습니다.

다음 순서: 실제 영상과 라벨 확보 → 타석/필드 보정과 배트·공·글러브 검출 → 이벤트 분할/3D 모델·VR 투영 검토 → 비동기 큐/인증/보관 정책 → 별도 UI → 승인된 WONY PHONE 연동. 현재 인증/사용자 격리는 없어 공개 서비스 배포 전 추가 작업이 필요합니다.

현재 환경 검증: **pytest 72개 통과**, 기존 투수 회귀 포함, 의존성 `pip check` 통과. MP4 인코딩/프레임 수/byte-range, JPEG, 추정 3D schema, 누락 pose, 경고색 제한, 인코딩/저장 실패 시 자산 정리를 검증했습니다. Chromium 브라우저 테스트도 통과했습니다: 4가지 합성 역할 데모, Three.js 렌더링, 재생/회전/슬라이더/키프레임 점프, 업로드/insufficient_pose, 모바일 폭 레이아웃과 JS 오류 확인. 의존성 deprecation 경고 3개가 있습니다. 실제 사람/VR 영상의 정확도는 아직 검증하지 않았습니다.

## 시각화 추가 (v0.3)

`app/visualization/`에 joints, overlay, pose3d, keyframes, builder, demo를 추가했습니다. 기존 role 분석 이후 같은 프레임과 관절 좌표를 사용해 시각화 자산을 생성합니다. 별도의 3D pose estimation 모델을 추가한 것은 아닙니다.

- 2D: 샘플링된 원본 프레임 위에 머리(코 landmark 대리), 어깨/팔꿈치/손목/골반/무릎/발목과 연결선을 표시합니다. 가시성<0.5 관절은 숨깁니다. 키프레임/이벤트 프레임에는 어깨/팔꿈치 각도, 무릎 굽힘, 상체 기울기, 초기 대비 영상 평면 골반선 변화를 표시합니다.
- 키프레임: 타자 stance/load/front_foot_landing/swing_start/estimated_impact/follow_through, 투수 setup/leg_lift/stride/arm_cocking/release/follow_through. 포수/수비는 ready/action/finish입니다. 상태는 candidate/reference_only/unavailable이며 phase_detected=false입니다. 확인되지 않은 단계가 검출된 것처럼 표시하지 마세요. 앞발 착지/임팩트는 confidence=0의 참고 프레임입니다. 같은 프레임이 여러 후보 단계에 대응할 수 있습니다.
- 3D: MediaPipe 정규화 x/y와 상대 z에서 골반 중심을 빼고 영상 평면 몸통 길이로 나눕니다. x는 영상 오른쪽, y는 위쪽, z는 카메라 쪽입니다. 단위는 visual_torso_lengths이며 미터/실제 관절 회전/힘이 아닙니다. 실제 3D 복원이나 보정된 깊이 추정이 아닙니다. estimated=true, confidence≤0.35, confidence_grade=low; 각 관절 신뢰도는 joint_confidence에 있습니다.
- 시간: frame은 10 fps 샘플링 후의 0 기반 인덱스입니다. 원본 영상 프레임 번호가 아닙니다. timestamp는 정규화 영상의 초 단위 시간이며 누락 프레임은 joints={}로 남습니다. 누락 프레임을 보간하거나 다른 포즈로 채우지 않습니다.
- 경고: 현재 엔진의 지원된 head_stability_score/balance 문제 항목만 고려합니다. 문제와 metric 모두 confidence≥0.75이고 해당 키프레임에 근거가 있을 때만 2D 관절 경고색이 가능합니다. '상체가 빨리 열림/힘 전달 부족/체중 이동 부족' 같은 인과 판정은 하지 않습니다. 현재 엔진의 confidence가 이 기준보다 낮으므로 일반적으로 경고색이 없습니다. 3D는 모두 저신뢰로 경고색을 적용하지 않습니다.
- 자산: backend/data/{id}-assets/overlay.mp4와 keyframe-NNNN.jpg에 저장하고 제한된 assets API로 제공합니다. H.264/libx264, yuv420p, faststart MP4입니다. ffmpeg에 libx264 인코더가 필요합니다. 인코딩/JSON 저장 실패 시 이번 분석의 자산과 임시 폴더를 정리합니다. 기존 결과는 유지합니다.

응답 구조 예시(축약, 실제 측정값 아님):

```json
{
  "schema_version": "0.3.0",
  "visualization": {
    "overlay_video_url": "/api/analysis/UUID/assets/overlay.mp4",
    "keyframes": [{"stage":"estimated_impact","frame":12,"timestamp":1.2,"estimated":true,"confidence":0,"confidence_grade":"low","status":"reference_only","phase_detected":false}],
    "pose3d": {
      "estimated": true,
      "confidence": 0.3,
      "confidence_grade": "low",
      "units": "visual_torso_lengths",
      "frames": [{"frame":12,"timestamp":1.2,"estimated":true,"confidence":0.3,"confidence_grade":"low","joints":{"left_shoulder":[-0.3,1.0,0.1]},"joint_confidence":{"left_shoulder":0.3}}]
    }
  }
}
```

프론트는 `/demo/`에서 FastAPI와 같은 origin으로 제공합니다. Three.js 0.174.0/OrbitControls는 로컬에 포함했습니다. 재생/일시정지, 프레임 슬라이더, 정면/측면/후면, 마우스 회전, 키프레임 이동을 지원합니다. 캐릭터형 모델과 WONY PHONE 통합은 미구현입니다.

합성 데모 POST /api/demo/{batter|defense|catcher|pitcher}는 도형과 생성된 관절 좌표를 사용하며 MediaPipe 정확도 검증이 아닙니다. 모두 synthetic_demo=true이고 화면에도 명시합니다. 실제 영상 업로드 경로는 MediaPipe를 실행합니다. PNG는 docs/screenshots/, 브라우저 테스트는 frontend-demo/tests/browser.mjs에 있습니다.

**보관 주의:** 원본 업로드 파일은 삭제하지만 overlay.mp4/JPEG에 입력 영상 내용이 남습니다. 결과 JSON과 {id}-assets 디렉터리를 함께 삭제하세요. 인증/보관 기한/공개 서비스용 접근 제어는 미구현입니다.

3D는 매 프레임 골반 중심으로 정렬하므로 실세계 이동 궤적을 표현하지 않습니다. front/side/rear는 시각화 좌표계의 카메라 보기이며 피사체의 실제 정면/측면을 보정한 결과가 아닙니다. 2D 각도 값은 3D 시점을 돌려도 변하지 않습니다.


## 스카우팅 추가 (v0.4)

### 추가 파일과 계약

- `app/scouting/report.py`: 역할별 관찰 항목, 영상 리포트, 이벤트별 시각화 연결, 선수 최신 역할별 종합 리포트.
- `app/scouting/growth.py`: 동일 조건 관찰값 비교, DEMO 점수 예시.
- `app/analysis/baserunning/analyzer.py`: 주루 영상 평면 자세/이동 후보. 기존 shared 관절 계산을 재사용.
- `models/result.py`: typed scouting/play/criterion schema. 기존 0.2/0.3 결과 GET 호환 유지.
- `models/storage.py`: 결과 JSON 기반 선수 기록 조회. 선수 ID를 파일 경로로 사용하지 않음.
- `frontend-demo/tests/scouting.mjs`, `backend/tests/test_scouting.py`: 새 기능 검증.

### 역할별 항목

| 평가 | 항목 |
| --- | --- |
| batting | contact, timing, balance, swing_consistency, weight_transfer, head_stability, hip_rotation, shoulder_rotation |
| defense | reaction, first_step, fielding, footwork, glove_position, throwing_transition, balance, range |
| catching | receiving, blocking, framing, throwing_transition, stability, balance |
| pitching | mechanics, balance, release_consistency, lower_body_usage |
| baserunning | start_reaction, acceleration, running_posture, direction_change, base_approach, sliding, decision_making |

모든 criterion은 score, grade, estimated, confidence, confidence_grade, reason과 observation을 갖습니다. **score/grade는 전부 null**: 검증된 채점 기준이 없고 관절 가시성만으로 기량 점수를 만들지 않습니다. observation은 기존 자세 대리 지표이며 score가 아닙니다. 공·배트·글러브·베이스·필드 방향·반응 자극 검출과 보정이 필요한 항목은 null입니다. 주루는 몸통 기울기·균형·첫 이동 후보만 제공하며 실제 가속도, 경기 판단, 슬라이딩 성공을 판정하지 않습니다.

### API와 응답

POST `/api/analyze`에 player_id, analysis_date, comparison_context를 multipart로 추가합니다. 모두 선택이며 선수 ID가 없는 결과도 분석/재조회 가능합니다. player_id는 ASCII 영숫자/_/- 1~64자, analysis_date는 ISO 날짜, comparison_context는 1~80자입니다. 날짜 기본은 Asia/Seoul의 오늘, created_at은 UTC ISO datetime입니다. 서버는 context 선언의 사실 여부를 검증하지 않습니다.

```bash
curl -X POST http://localhost:8000/api/analyze \
  -F video=@run.mp4 -F role=baserunning -F player_id=PLAYER-001 \
  -F analysis_date=2026-10-12 -F comparison_context=fixed-side-running
curl http://localhost:8000/api/players/PLAYER-001/history
curl http://localhost:8000/api/players/PLAYER-001/scouting-report
curl 'http://localhost:8000/api/players/PLAYER-001/history?source=demo'
```

다음은 **구조 설명용 JSON이며 실제 평가 결과가 아닙니다**:

```json
{
  "schema_version": "0.4.0",
  "player_id": "PLAYER-001",
  "analysis_date": "2026-10-12",
  "scouting_report": {
    "strengths": [],
    "development_areas": [],
    "traits": [],
    "overall_summary": "영상 기반 자세 관찰; 기량 점수 판정 보류",
    "ratings": {"batting": null, "defense": null, "catching": null, "pitching": null, "baserunning": null}
  }
}
```

`scouting_report.plays[]`는 이벤트 원문, confidence/estimated, metrics, strengths/weaknesses/coaching, keyframe과 visualization_reference를 연결합니다. 해당 시각의 샘플 프레임(허용 차이 0.051초)을 연결하며 범위 밖이면 다른 프레임으로 대체하지 않습니다. 정확히 대응하는 단계 키프레임이 없으면 keyframe=null, 3D 프레임/2D 영상 참조는 유지합니다. 이벤트는 휴리스틱 후보이며 확인된 타격/포구/주루 플레이가 아닙니다. 한 영상의 여러 플레이 자동 분리는 아직 없습니다.

플레이별 장단점은 검증된 국소 근거가 없어 현재 빈 배열이며 코칭은 중립적 프레임 확인 안내입니다. 기존 영상 전체 장단점은 `context_feedback.scope=whole_clip`로 분리합니다. 영상 전체 피드백을 특정 이벤트의 성과로 표시하지 마세요.

### 선수 종합과 성장 추적

GET history는 points/count/skipped_records와 경고를 반환합니다. GET scouting-report는 역할별 가장 최근 분석, 원본 analysis_id/date, 종합 strengths/development_areas/traits와 플레이 참조를 반환합니다. 역할별 최신 분석일은 서로 다를 수 있으며 서버가 선수의 동일 인물을 검증하지 않습니다. 기존 ID 없는 결과는 선수 기록에 자동 포함하지 않습니다.

source 기본 real은 실제 업로드 경로이고 demo는 합성 pose 경로입니다. 실제/합성, 역할을 분리해서 이전 기록을 찾습니다. comparison_context가 같고 비어 있지 않으며 상태 completed, 방법 버전/손/포지션/단위/계산 방법이 동일하고 양쪽 confidence≥0.4인 숫자만 delta를 계산합니다. 미충족이면 delta=null과 reason을 반환합니다. **영상 평면 대리 지표 변화이며 실제 성장/힘 전달 개선 판정이 아닙니다.**

points의 `criterion_scores["batting.balance"]` 등에 score/previous_score/delta 구조를 준비했지만 현재 모두 null입니다. `rating_deltas`도 null입니다. 검증된 채점 엔진을 추가하기 전 관찰값을 0~100점으로 변환하지 마세요. GET `/api/demo/growth`만 62→71→77, +9/+6의 구조 설명용 임의 예시를 반환합니다. 모든 항목 synthetic_demo=true, confidence=0이며 선수 기록에 저장하지 않습니다.

### UI와 한계

Scouting Report 탭에 선수 요약, 다섯 역할, 강점/개선점, 플레이별 분석, 성장 추적을 표시합니다. 플레이의 2D/3D 보기 버튼으로 Motion Lab 프레임에 이동합니다. 선수 기록 조회는 현재 결과의 source를 유지하고 과거 영상 프레임도 다시 조회할 수 있습니다. DEMO 예시는 별도 버튼/라벨로 구분합니다.

WONY PHONE에 향후 표시하기 좋은 항목: 선수/날짜/역할, 추정 라벨과 신뢰도가 있는 자세 관찰값, 후보 이벤트 시각과 시각화 링크, 동일 조건 관찰값 변화 및 보류 사유. 실제 기량 점수/공식 스카우트 등급/실제 성장/주루 속도·가속도/판단 성공/공 접촉·포구 성과는 아직 표시하면 안 됩니다. VR 아바타 관절은 실제 신체와 다르고 3D는 미보정 추정입니다. WONY PHONE 통합과 캐릭터 모델은 이번 변경에 포함하지 않았습니다.

검증: pytest 72개 통과(의존성 경고 3개), 기존 브라우저 회귀와 신규 scouting 브라우저 테스트 통과. 5역할 보고서, 점수 보류, 메타데이터 유효성, 부족 pose, 결과 재조회, 조건 불일치 비교 거부, 실제/DEMO 분리, 선수 종합, 리포트→2D/3D 이동, 모바일 폭을 확인했습니다. 실제 야구/VR 평가 정확도는 검증하지 않았습니다.
