# WONY PHASE 2 후속 엔진 개선 — 실제 입력 품질

2026-10-12 (Asia/Seoul). 사용자 확인을 받은 중앙 WONY 한 명의 동일 MP4를 다시 검증했다. 초기 결과는 [WONY_PHASE2_VALIDATION.md](WONY_PHASE2_VALIDATION.md)에 보존한다. 이 단계는 입력 품질 개선이며 실제 경기 능력, 투구 성공, 정확한 생체역학 검증이 아니다. WONY PHONE 변경 및 commit/push 없음.

## 1. Pose 원인과 전후 결과

입력: wony-batter-001.mp4, 20.045333초, H.264, 1920×1080, 60fps. 10fps로 201개 샘플. 최초 수동 대상 bbox=[920,65,410,740]. 원본 해상도 crop에서 MediaPipe full/model_complexity=1 실행. visibility 0.6 기준, 기존 pose_rows 기준을 유지했다. 초기 검증도 원본 crop을 사용했으므로 해상도 변경만으로 개선됐다고 주장하지 않는다.

직접 영상 관찰: 약 0.5초에 왼쪽 글러브/팔이 원래 bbox의 왼쪽 밖으로 나간다. 20% margin은 이 부분을 포함한다. 머리/발은 검토한 프레임에서 원래 ROI 안에 보이며, 아바타 높이는 대략 600픽셀 이상이므로 작은 캐릭터만으로 설명되지 않는다. 옆/뒷면, 모자·머리카락·옷·글러브의 가림, 비인간적인 아바타 비율과 사람용 MediaPipe 모델의 차이가 의심된다. 어떤 요인이 얼마나 영향을 주는지는 관절 정답/다른 모델과의 비교가 없어 확정할 수 없다. ROI에 큰 HUD와 장면 효과가 보이지만, 다른 선수가 이 ROI를 가로지르는 사례는 이번 영상에 없다. 배경 간섭을 독립적으로 측정하지 않았다.

ROI만 바꾼 비교에서는 초기 추적 bbox와 **동일한 201개 프레임을 고정**했다. pose 원본 해상도, 모델, confidence 기준은 동일하다.

| 각 방향 margin | pose 검출 | 전신 품질 통과 | 투수 profile 통과 |
|---|---:|---:|---:|
| 0% | 201/201 (100%) | 2/201 (1.0%) | 58/201 |
| 10% | 200/201 (99.5%) | 4/201 (2.0%) | 66/201 |
| 20% | 201/201 (100%) | 5/201 (2.5%) | 77/201 |

실제 최종 파이프라인은 **20% margin + low_confidence에서 pose 일시 중단**을 함께 적용했다.

| 항목 | 초기 | 최종 |
|---|---:|---:|
| 샘플 수 | 201 | 201 |
| Pose 실행 허용 | 201 | 167 |
| Pose 검출률 (전체 샘플 분모) | 201/201, 100% | 167/201, 83.08% |
| 실행 허용 프레임 중 검출률 | 100% | 100% |
| 전신 사용 가능률 | 2/201, 1.00% | 6/201, 2.99% |
| 투수 profile 사용 가능 | 58 | 48 |
| Low confidence 중단 | 0 | 34 |

최종 6개를 ROI만의 효과로 해석하지 않는다. pose에 들어가는 시퀀스도 달라졌기 때문이다. pose 검출률/투수 profile 수가 낮아진 부분도 함께 보고한다. 모든 수치는 **관측 사용 가능률**, 정확도가 아니다. MediaPipe가 33개 좌표를 출력했다고 33개 관절이 정확히 보였다는 뜻은 아니다.

주요 관절별 사용 가능률: visibility≥0.6, finite/in-frame. 미검출·일시 중단 프레임도 전체 분모 201에 포함한다.

| 관절 | 초기 | 최종 |
|---|---:|---:|
| head | 201/201 (100.0%) | 167/201 (83.1%) |
| left_shoulder | 201/201 (100.0%) | 167/201 (83.1%) |
| right_shoulder | 201/201 (100.0%) | 167/201 (83.1%) |
| left_elbow | 15/201 (7.5%) | 14/201 (7.0%) |
| right_elbow | 185/201 (92.0%) | 156/201 (77.6%) |
| left_wrist | 16/201 (8.0%) | 12/201 (6.0%) |
| right_wrist | 79/201 (39.3%) | 74/201 (36.8%) |
| left_hip | 201/201 (100.0%) | 167/201 (83.1%) |
| right_hip | 201/201 (100.0%) | 167/201 (83.1%) |
| left_knee | 48/201 (23.9%) | 42/201 (20.9%) |
| right_knee | 201/201 (100.0%) | 167/201 (83.1%) |
| left_ankle | 78/201 (38.8%) | 133/201 (66.2%) |
| right_ankle | 201/201 (100.0%) | 167/201 (83.1%) |

핵심 한계는 왼쪽 팔꿈치·손목·무릎이다. ROI를 확장해도 이 관절의 품질은 충분하지 않다. 사람용 모델과 VR 애니메이션의 적합성 검증, 보이는 관절의 정답 표시가 다음에 필요하다. Heavy 모델 실험은 다운로드가 거부되어 수행하지 못했으며, 현재 실행 모델을 바꾸지 않았다.

## 2. WONY 추적

대상 잠금 bbox와 pose용 margin bbox를 분리했다. margin이 대상 신원 범위를 확장하지 않는다. pose의 몸통 중심이 원래 잠금 bbox 밖에 있거나 core visibility가 부족하면 대상 귀속을 거부한다. 이 클립에서 pose 귀속 거부는 0개였다. 이 조건만으로 유사 아바타 식별이 보장되지는 않는다.

- 최초 `confirmed` → `tracking`: 기존 수동 확인을 유지한다.
- `low_confidence`: appearance 휴리스틱 confidence <0.45. bbox는 보존하고 pose/3D 입력은 중단한다. 동일 CSRT 대상이 기준을 회복하면 tracking으로 돌아간다.
- `tracking_lost`: CSRT 실패, 장면 전환, 경계 이탈, 급격한 이동/크기 변화, appearance 기준 미달, 잘못된 시간 또는 1초 초과 추적 샘플 공백. 대상 탐색/자동 초기화 없음.
- `reidentification_required`: 손실을 확인한 controller가 `require_reidentification()`을 호출해 수동 재지정을 기다린다. runner는 손실된 작업을 끝낼 때 이 상태를 기록한다. 새로운 사용자 확인으로 새 검증 작업을 시작해야 한다.

실제 결과: confirmed 1, tracking 166, low_confidence 34, tracking_lost 0. 마지막 상태 tracking. Low confidence는 신원 확률이 아니며 조심스럽게 중단하기 위한 정책이다.

검증 harness는 30초/32MiB에서 **120초/128MiB**로 확장했다. native ROI는 generator로 공통 pose extractor에 전달하고 preview는 임시 JPEG 경로로 보관한다. 모든 원본 crop을 메모리에 쌓지 않는다. 완료 후 preview 임시 폴더는 삭제한다. 40초 DEMO 생성 영상의 metadata와 120초 길이의 DEMO fake tracker 상태 시퀀스/디스크 preview 경로를 테스트했다. 이는 긴 실제 WONY 영상 검증이 아니다. 실제 카메라 전환·가림·유사 아바타 교차 영상은 아직 필요하다. 일반 LIVE/VOD 전체에 대상 잠금을 자동 적용한 것은 아니다.

## 3. 투수 역할과 동작 검증 분리

초기 generic auto=unknown → 최종 SBO context auto=pitcher, estimated=true, confidence=0.8, grade=medium. 이 confidence는 보정된 정답 확률이 아니다.

구성:

1. 이번 클립의 `피칭 설정` header에서 만든 템플릿을 제한된 HUD 영역에서 반복 matching한다. 동일 동작 시간 주변에서 3개 이상의 서로 다른 프레임/0.4초 이상 반복이 필요하다.
2. 수동 WONY ROI의 보이는 어깨·골반·던지는 팔 visibility≥0.6에서 팔을 올린 뒤 내리는 시간 순서를 확인한다. 숨은 글러브/무릎을 완성하지 않는다. 0~1.166초의 13개 샘플이 근거이며, 든 팔 후보는 약0.466초이다. 이것은 공 릴리스 시점이 아니다.
3. HUD의 같은 속도 필드가 동작 후 다른 안정된 표시값으로 바뀌었는지 보조 확인한다. 이미 계속 떠 있던 동일 HUD를 새 투구 신호로 세지 않는다. HUD 변화와 실제 투구의 연결은 미검증이다.

장면/pose-motion 두 종류의 근거가 모두 필요하다. 단일 header/단일 팔 동작/낮은 confidence는 unknown. Generic temporal 판별이 다른 역할을 강하게 지지하면 충돌을 unknown으로 남긴다. 기존 일반 역할 휴리스틱이나 full-body 품질 기준은 낮추지 않았다. 실제 마운드 detector와 lifting-leg 검증은 없으므로 context의 mound_position/leg_lift=null이다.

**중요:** header template은 같은 검증 클립에서 보정했다. 다른 SBO 영상의 해상도·시점·HUD 배치·다른 역할에서 false positive를 독립 검증하지 않았다. 이 결과로 일반화된 투수 정확도를 주장하지 않는다.

수동 역할 보조 입력 `role_hint=pitcher`도 지원한다. selection JSON에 `"role_hint":"pitcher"`를 넣는다. 자동 추정은 automatic_role_estimate에 별도로 남고, 수동 정보는 role_input.source=user_provided로 기록한다. 보조 입력은 pose/시점/3D/PLAYER TOOLS 품질 조건을 우회하지 않는다.

역할을 pitcher로 알아도 투구 단계를 확인한 것은 아니다. 기존 max wrist motion이 실제 동작과 다른 약9초를 릴리스 후보로 선택하는 문제를 발견했다. 최종 pipeline은 **감지한 초반 동작 구간의 연속 전신 pose가 부족하면 metrics·릴리스 이벤트·단계별 후보를 보류**한다. 이번 클립의 full_body_action_samples=0, events=[], release_time.value=null이다. 기존 viewer에는 품질을 통과한 자세 reference만 연결한다. PLAYER TOOLS도 여전히 5개 모두 insufficient_data이며 score/grade=null이다.

## 4. SBO HUD OCR

전체 화면 OCR을 하지 않는다. 이번 해상도의 수동 숫자 전용 crop:

```json
{"hud_original_speed":[1690,0,130,55],"hud_converted_speed":[1690,54,130,58]}
```

원본 crop에서 3배 확대, grayscale threshold 160/170의 두 전처리, Tesseract eng single-line, 엄격한 소수점 token parsing을 사용한다. 숫자 whitelist는 이 기울어진 HUD에서 confidence를 0으로 만들어 채택하지 않았다. 두 전처리가 다른 숫자를 내면 후보도 보류한다. Threshold 210에서는 실제121.3을127.3으로 읽는 사례가 있었으며, 밝은 가는 획을 보존하는 설정을 사용했다. 재설정만으로 정확도가 보장되지는 않는다.

5Hz로 읽고 1.2초 이내의 window에서:

- 서로 다른 시각 5개 이상, 0.6초 이상 유지, 샘플 공백≤0.35초.
- OCR confidence≥0.7인 같은 숫자가 4개 이상/전체의 80% 이상.
- 현재 프레임도 해당 숫자를 지지해야 한다. 값이 바뀌면 이전 값으로 채우지 않는다.
- 소수점 없는 값, 음수, 잘못된 token, 비정상 범위, 전처리 불일치, 낮은 confidence를 제외한다.
- 0..300 범위는 보수적 application guard이고 함수 인자로 변경 가능하다. 게임의 공식 한계나 물리 구속 제한을 주장하지 않는다.

초기: 전체 label을 포함한 crop에서 113.6→973.6 오독, 자동 채택 없음.
최종: raw/converted 각각 101개 관측. raw 24.9는 초기 2개 vote만 통과; 이후29.1의 OCR confidence가 부족해 보류. converted 113.6은2개,121.3은90개 vote 통과. **Vote 수는 투구 횟수가 아니다.** 원본속도29.1은 육안 관찰과 자동 채택 결과를 분리한다.

최종 최신 HUD 상태:

```json
{
  "raw_game_speed": null,
  "converted_game_speed_kmh": 121.3,
  "source": "sbo_hud_observed",
  "estimated": true,
  "review_required": true,
  "physical_velocity": null,
  "same_pitch_association_verified": false
}
```

raw가 보류됐으므로 summary 전체 review_required=true. 각 필드의 관측 시각은 timestamp_by_field에 제공한다. 이전에 읽힌24.9를 현재29.1 대신 재사용하지 않는다. 원시 후보는 hud_observations, 안정된 표시값/근거 crop 경로는 hud_temporal_votes에 있다. 실제 구속·구종·판정·투구별 연결은 생성하지 않는다. 영어 숫자 OCR이며 한국어 label은 수동 ROI 의미를 사용한다.

## 5. Estimated 3D

기존 projector/Three.js/JSON 계약은 유지한다. 검증 결과에서 기존 general pose_rows visibility≥0.6 조건을 통과한 프레임에만 3D joints를 남긴다. 불충분한 프레임은 joints={}, visualization_available=false. 숨은 팔·다리를 채우지 않는다. accuracy=null, accuracy_verified=false와 available_frames/availability_rate를 별도로 반환한다.

초기 일부 관절 visualization 201/201 → 최종 6/201 (2.99%). 더 낮은 availability는 품질 정책 강화 결과이다. 6개는 sampled frame29~34, clip_time2.866~3.366초의 투구 이후 준비 자세이며 투구 중 전신 3D를 확보한 것이 아니다. depth와 실제 관절 정확도 검증은 여전히 없다.

## 6. API / 실행

기존 LIVE/VOD/공통 역할·Scouting 엔진을 복제하지 않는다. 이 실제 입력 실험은 POST /api/validation, GET /api/validation/{id}/analysis와 기존 통합 viewer를 재사용한다. 일반 분석/선수 성장 이력과 분리되어 있다. validation에서 생성한 sbo_pitcher scene context는 공통 role_classifier로 전달한다. 기존 scene context가 없으면 기존 classifier 동작을 유지한다.

selection 예:

```json
{
  "player_id":"wony","confirmed_by_user":true,"viewpoint":"third_person",
  "source_time":0,"source_width":1920,"source_height":1080,
  "bbox":[920,65,410,740],"source":"manual_selection",
  "pose_margin":0.2,"role_hint":"auto"
}
```

확장 ROI는 원본 경계에 clip하며 좌표를 원본 normalized 계약으로 복원한다. ROI 밖 landmark 예측은 visibility=0으로 처리한다. /demo/validation의 margin/역할 보조 입력만 추가했고, 메인 통합 UI를 재작성하지 않았다. CLI 예:

```powershell
.\.venv\Scripts\python.exe backend\tools\validate_target.py C:\clips\wony-batter-001.mp4 --selection C:\clips\selection.json --hud-config C:\clips\hud-digits.json --output data\validation
.\.venv\Scripts\python.exe -m pytest backend\tests -q
$env:WONY_REAL_CLIP = "C:\clips\wony-batter-001.mp4"
node frontend-demo\tests\target-validation.mjs
```

Tesseract executable은 선택 의존성이다. 없으면 OCR not_supported/null이다. 임의 숫자로 대체하지 않는다. Windows 실행은 아직 미검증이다.

## 7. 테스트 / 실제 재검증

Backend **239 passed**, 기존 의존성 deprecation warning 3개. 기존 195개를 유지하고 **44개를 추가**했다. expanded ROI/범위/귀속, soft/terminal 추적 상태, 시간 공백/장기 fake sequence, 복합 pitcher context/시간 연결, 엄격 OCR parsing/연속 voting/이전 값 재사용 금지, 기존1인칭 차단, low-quality 3D 제한, 단계별 후보 보류, 명시적 hint, 디스크 preview,40초 metadata를 검증한다.

최종 실제 클립 브라우저에서 자동 투수 추정, score=null, events=[], release_time=null, 낮은 품질 3D 차단, 원본/2D/허용된 3D, 모바일과 JavaScript 오류 없음까지 통과했다. 최종 HUD CLI도 동일 원본으로 완료했다. 기존 unified/tools/modes/broadcast 브라우저 4종은 통과했고, 단일 엔진 lock을 사용하는 테스트는 순차 실행한다. 병렬 validation 중 다른 분석 버튼 테스트가 busy 상태로 timeout한 시도가 있었으며, 실제 입력 작업 종료 후 같은 테스트를 순차 재실행해 통과했다. 테스트 조건을 약화하지 않았다.

## 8. 남은 제한 / 다음 실제 영상

긴 실제 영상의 가림·카메라 전환·유사 아바타 교차/장기 drift, 다른 SBO HUD 배치, 아바타 모델 적합성, 실제 관절 정답, 3D 깊이, 정확한 공 릴리스, 투구별 HUD 연결, 반복 투구 ARM 평가는 미검증이다. 120초 harness 한계와 동기화 warning을 유지한다. 10fps overlay display clock과 원본 PTS를 분리하며 정확한 동기화/VFR/장시간 drift를 검증했다고 주장하지 않는다.

다음 타격 실제 영상이 제공되면 SBO bat trail, 실제 보이는 bat/swing path, role=batter, CONTACT/POWER proxy를 별도 검증한다. 이번 투수 클립으로 bat trail 완료 처리나 CONTACT/POWER/SPEED/FIELDING 점수를 만들지 않는다.

## 9. 이번 단계 수정 파일

- backend/app/validation/target.py: margin/hint, soft/recovery 상태, 시간 gap, pose 귀속 guard.
- backend/app/validation/runner.py: native stream, disk preview, context/voting/quality/3D/phase gate 연결.
- backend/app/validation/hud.py: decimal-only/dual preprocess/temporal votes/최신 상태 summary.
- 새 backend/app/validation/{quality,context,frames}.py 및 templates/sbo_pitching.json.
- backend/app/analysis/shared/role_classifier.py: SBO context 경로와 일반 역할 충돌 보류.
- backend/app/pose/extractor.py: 선택 model_complexity 인자; 기본값/threshold 유지.
- backend/app/visualization/keyframes.py: opt-in phase gate가 false이면 자세 reference만 반환. 기존 기본 경로 유지.
- backend/app/api/validation.py, backend/tools/validate_target.py: 크기 한계·CLI 출력.
- 새 backend/tests/test_input_quality.py; 기존195개 assertion 변경 없음.
- frontend-demo/validation/{index.html,selection.js}, frontend-demo/tests/target-validation.mjs: opt-in 입력과 실제 클립 검증.
- README.md, docs/HANDOFF.md, docs/CLAUDE_HANDOFF.md, docs/WONY_PHASE2_VALIDATION.md 및 본 문서.

영상·JSON·overlay·HUD crop은 Git에서 제외되는 data/validation에 저장한다. 실제 입력이며 합성 DEMO로 대체하지 않았다.

최종 실제 실행 자산 (Git 제외):

- CLI/HUD: data/validation/d939161c-8eb8-49c2-9fa2-b3042f3ad583/analysis.json
- 실제 브라우저: data/validation/e7878ac2-0eb6-41db-a8c2-9aa741494c22/analysis.json
- ROI 비교: /tmp/wony-real-validation/roi-comparison-native.jpg (노랑=초기, 초록=20% margin)
- 캡처: /tmp/wony-real-validation/improved-manual-selection.png, improved-2d-validation.png, improved-3d-validation.png

검증 결과를 공식 선수 성장 이력으로 등록하지 않았다. WONY PHONE 저장소는 변경하지 않았고 commit/push하지 않았다.
