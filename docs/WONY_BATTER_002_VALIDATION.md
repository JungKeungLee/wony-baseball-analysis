# WONY 실제 타격 영상 검증 — wony-batter-002

2026-10-12, Asia/Seoul. 사용자 확인: 홈플레이트 앞 베이지색 모자·검은 머리·흰옷·분홍색 다리 아바타가 WONY. 우타/우투/풀트/SBO 정보는 사용자 제공 정보이다. 자동 아바타 식별을 수행하지 않았다. 이 문서는 실제 영상 관찰, 기존 엔진의 결과, 새 제한적 2D 입력을 분리한다.

## 입력 / 범위

- 실제 사용자 MP4, 33,259,006 bytes, 32.034667초, 1920×1080, H.264, 60fps, AAC.
- 영상 첫 PTS 0.034초, time_base=1/60000. 원본 PTS mapping을 보존한다.
- 수동 3인칭 확인. 같은 WONY가 배트 오브젝트를 들고 움직이는 장면이다. 배경에도 다른 아바타가 보이지만 분석 대상에 포함하지 않았다.
- 화면에 보이는 목재형 **게임 배트 오브젝트**와 색상 line/curve/particle 효과를 구분한다. 게임 오브젝트는 실제 실물 배트를 촬영한 것이 아니다.
- 배트 움직임/타격 시도는 육안 확인 가능하다. particle/타구처럼 보이는 효과만으로 실제 contact 성공, hit, exit velocity를 확정하지 않는다.

## 13개 항목 판정

| 항목 | 판정 | 실제 관찰 / 코드 결과와 한계 |
|---|---|---|
| 1. WONY 수동 지정 | 가능 | 사용자 대상 확인 + 원본 pixel ROI + 실제 브라우저 드래그/API 검증 |
| 2. target tracking | 부분 가능 | 몸통 중심 ROI에서 321샘플 유지, low_confidence 2개에서 pose 중단. 경계에 가까운 최초 full ROI는1.1초에 terminal loss. 실제 가림/교차/장시간은 미검증 |
| 3. batter 역할 | 부분 가능 | 육안 타격 관찰 및 role_hint=batter 가능. 자동은unknown 유지; 자동 batter 판별 성공으로 보고하지 않음 |
| 4. SBO bat trail | 미검증 | 색상 효과 존재. bat trail, 타구 궤적, 디버그 vector의 의미를 확정하지 못함. 전용 detector 없음 |
| 5. swing start/end | 부분 가능 | 수동 검토 범위5개 기록. 정확한 자동 onset/end는null. 검토 범위를 스윙 시간 측정으로 해석하지 않음 |
| 6. swing path | 현재 불가 | 실제 배트의 시계열 object tracking 없음. 오른손 2D 참고 경로는 일부 가능하지만 bat path가 아님 |
| 7. downswing/level/uppercut | 현재 불가 | 검증된 배트 경로/카메라 보정이 없어 분류null |
| 8. 손/팔 pose | 부분 가능 | 오른손목306/321, 오른팔꿈치319/321 사용 가능. 왼손목1/321, 왼팔꿈치8/321. 양손/손가락/손목 회전 검증 아님 |
| 9. head stability | 부분 가능 | 머리와 어깨 상대2D 변위 입력은5개 검토 범위에서 계산 가능. 카메라 회전/원근 및 head landmark 정확도 미보정. 안정성 좋음/나쁨 등급 없음 |
| 10. swing consistency | 현재 불가 | 반복 움직임은 관찰됨. 검증된 bat/양손 경로 부족으로 consistency null |
| 11. CONTACT proxy | 부분 가능 | 머리/손 참고 입력 일부 가능. 실제 contact는미확인, CONTACT score=null. head 움직임을 컨택 능력으로 변환하지 않음 |
| 12. POWER proxy | 부분 가능 | 오른팔/손의2D mechanics 입력만 일부 가능. 전신 품질0이므로 골반/하체 POWER proxy 및 POWER score=null |
| 13. estimated 3D | 현재 불가 | 연결 구조는 유지되지만 이번321프레임 전부 joints={}, available=0. 기준을 낮추거나 전신을 완성하지 않음 |

## ROI와 추적 — 실패 실행도 보존

최초 대상 bbox=[425,125,390,950], margin=0.2. 발이 화면 하단에 가까워 target bbox bottom=1075였으며, CSRT가 몇 픽셀 내려가1.1초에 source 경계를 넘었다. reason=Target left the visible frame. 이후310샘플 모두 tracking_lost이며 pose는 추가 실행되지 않았다. 마지막 controller 상태 reidentification_required. 다른 대상을 자동 선택하거나 같은 실행에서 재초기화하지 않았다.

별도 실행에서 **같은 사용자 확인 WONY를 처음0초부터** 몸통 중심 bbox=[460,160,330,800]로 수동 지정했다. pose crop은 margin20%로 발까지 포함한다. 이 실행은 손실 복구/자동 재식별이 아니다. tracker 코드/appearance threshold/경계 기준을 변경하지 않았다.

| 실행 | pose 허용/샘플 | 검출 | 전신 사용 가능 | low confidence | lost |
|---|---:|---:|---:|---:|---|
| 경계에 가까운 최초 ROI | 11/321 | 11 | 0 | 0 | 1.1초 |
| 몸통 중심 + pose margin | 319/321 | 319 | 0 | 2 | 없음 |

321개 source sample을 기준으로 detection rate=99.38%, full-body usable rate=0%. 검출 성공은 관절 정확도나 신원 정확도가 아니다. Avatar가 화면에서 약900픽셀 높이로 보이고 원본 crop을 사용하지만, 반대쪽 팔/손과 일부 하체 visibility가 낮다. 후면/측면, 머리카락·옷·게임 아바타 비율과 모델의 적합성은 실제 관절 정답 없이 분리 측정할 수 없다.

## 수동 검토 범위와 제한적 입력

프레임을 검토해 다음 범위를 스윙/회복 장면을 다시 보는 envelope로 기록했다. 정확한 swing start/end나 verified play event가 아니다. source_time 초 단위이며 estimated=true, confidence=0.5 (수동 범위 휴리스틱, 확률 아님).

| 검토 범위 | head relative displacement proxy | 연속 오른손 path 샘플 | 양팔 동시 visibility 기준 통과 |
|---|---:|---:|---:|
| 0.9~2.3초 | 0.113 | 보류 | 0 |
| 7.4~9.6초 | 0.212 | 23 | 0 |
| 14.8~17.4초 | 0.192 | 27 | 0 |
| 22.3~24.5초 | 0.113 | 23 | 0 |
| 29.0~31.5초 | 0.167 | 25 | 0 |

Head 단위는 projected torso lengths, 어깨 중심 기준 최대 상대변위다. 카메라 translation에 대한 일부 상대화일 뿐 카메라 rotation/perspective를 보정하지 않았다. 상체/머리 방향 변화와 모델 오차도 섞인다. good/bad 또는 점수로 해석하지 않는다.

신규 batter_validation은 visible_joint threshold0.6에서만 처리한다. 머리·어깨·골반 anchor를 요구하고, 오른팔은 어깨·팔꿈치·손목 모두 보이는 샘플만 사용한다. 연속5개 이상, 0.4초 이상, sample gap≤0.25초가 없으면 해당 입력도null. confidence cap=0.25, estimated=true, accuracy_verified=false. 오른손 경로의 unit은 projected torso lengths이며 배트 경로나 실제 속도로 변환하지 않았다.

2D elbow angle range도 raw projected 입력만 제공한다. 실제 관절 범위/파워가 아니다. 매우 큰 범위가 계산되어도 좋은 mechanics나 실제 힘으로 해석하지 않는다. 근거 source-frame 번호와 overlay URL을 제공한다. 이 데이터를 기존 PLAYER TOOLS/성장 이력에 자동 반영하지 않는다.

## 역할 / 투수 template 과적합 검토

- 기존 auto engine: unknown, confidence0. 수동 관찰은 batter. 수동 role_hint=batter 실행은 role_input.source=user_provided이고 automatic_role_estimate=unknown을 별도로 보존한다.
- 처음 저비용1Hz 검사: pitching header template 감지0/32, max correlation0.
- 전체 검증5Hz 검사: 감지0/161. 최종 pitcher context=unknown. 이번 타격 영상을pitcher로 잘못 분류하지 않았다.
- **팔 올림/내림 cue 자체는 타격에도 검출됐다:** 약0.966~1.666초,8샘플. 따라서 이 신호는 투수에 특이적이지 않다. HUD/pose 두 종류의 결합이 잘못된 투수 확정을 막았다.
- 기존 template은 투수 영상 한 개의 고정 HUD 위치에서 만들었다. 다른 양성 투수 영상/다른 HUD 배치/타격 중 피칭 메뉴가 떠 있는 경우에는 아직 검증되지 않았다. 이 음성 사례 한 개로 과적합이 없거나 일반화 정확도가 높다고 주장하지 않는다.
- 투수 OCR crop을 타격 HUD에 그대로 적용하지 않았다. 타격 HUD의 배트파워/속도 등 게임 설정이나 표시값을 PLAYER TOOLS 점수/실제 bat speed로 사용하지 않았다. 숫자 crop의 위치·label 의미는 역할/영상별 재확인이 필요하다.
- 투수 template나 기존 역할 휴리스틱/threshold를 이 타격 영상에 맞춰 재학습/완화하지 않았다.

## 최소 코드 변경 / API

새 `backend/app/validation/batter_review.py`: 수동 검토 범위 schema, visible upper-body 2D 입력, 명시적 null/근거 reference. bat/trail detector, 새로운 역할 classifier, 3D 모델은 추가하지 않았다.

`validate_clip(..., batter_review=None)`과 CLI `--batter-review`를 추가하고, POST /api/validation의 선택 form field `batter_review` JSON도 지원한다. 기존 selection/hud/API 호출은 그대로 동작한다. GET /api/validation/{id}/analysis에서 새 batter_validation을 조회한다. 이 필드는 실험적 검토 입력이며 일반 분석 이벤트/능력 평가와 분리한다. UI 마무리 단계나 WONY PHONE 통합은 수행하지 않았다.

```json
{"windows":[{"start":0.9,"end":2.3},{"start":7.4,"end":9.6},{"start":14.8,"end":17.4},{"start":22.3,"end":24.5},{"start":29.0,"end":31.5}]}
```

```powershell
.\.venv\Scripts\python.exe backend\tools\validate_target.py C:\clips\wony-batter-002.mp4 --selection C:\clips\selection-body.json --batter-review C:\clips\review-windows.json --output data\validation
.\.venv\Scripts\python.exe -m pytest backend\tests -q
$env:WONY_REAL_BATTER_CLIP = "C:\clips\wony-batter-002.mp4"
node frontend-demo\tests\batter-validation.mjs
```

Windows browser test에는 CHROMIUM_PATH를 로컬 Chrome/Chromium 실행 파일로 설정한다. 실제 Windows 검증은 아직 없다. real browser test는 실제 클립 환경변수가 없으면 합성으로 대체하지 않고 실패한다.

## 테스트 / 결과 자산

Backend255 passed, 기존 의존성 경고3개. 이전239개에16개 추가. 수동 범위/시점 제한, 단일 손과 bat path 구분, contact/speed/score 생성 금지, 1인칭/unconfirmed 차단, pose loss/gap 보간 금지, head/hand 개별 품질, 투수 motion 단일 cue 배제, API optional field를 검증했다. DEMO 합성 fixture는 실제 영상 정확도 검증이 아니다.

실제 파일 실행:

- 최초 ROI/loss: data/validation/729c2460-588d-4968-91f4-d83e16f61a00/analysis.json.
- Body ROI/auto: data/validation/81e7e44e-8d71-448e-a382-5393d6581b5f/analysis.json.
- Body ROI/manual hint/review: data/validation/44db7798-fc0d-44cd-b6ac-8910a41b932b/analysis.json.

실제 브라우저 검증은 통과했다: data/validation/ee2f5598-83ab-4fe1-9c53-a816f7ad0ea1/analysis.json. 수동 ROI·역할 입력과 자동unknown의 분리, 2D overlay, 빈3D/점수·구속 null, 투수template 음성, 모바일/JS 오류 없음까지 확인했다. 캡처는 /tmp/wony-batter-002/manual-selection.png, real-2d-report.png, withheld-3d-report.png에 저장했다. 캡처/영상/분석 JSON은 Git 제외 경로에 보관한다. WONY PHONE 수정 및 commit/push 없음.

## 아직 필요한 검증

실제 배트 segmentation/tracking의 target 귀속, 빠른 swing/blur/가림, SBO 효과 종류 확인, bat trail과 ball trajectory의 구분, frame 단위 bat/ball/contact 정답, 적합한 VR pose 모델/다른 시점, 반복 swing 정렬, 양손/하체 품질, head landmark·camera 보정, 긴 실제 추적과 교차 상황이 필요하다. 전신 pose가 부족한 이번 영상에서는 3D 복원/하체 POWER/실제 CONTACT·능력점수를 주장하지 않는다.

기존 unified/tools/modes/broadcast 브라우저4종도 최종 코드에서 통과했다. 실제2D overlay는 media loadeddata와 seek 완료를 추가 확인하고 캡처했다. 초기 캡처가 decode 전에 촬영돼 빈 화면이었던 문제는 테스트의 media 대기 조건을 보완하고 저장된 실제 리포트를 재조회해 교체했다. 앱 UI 코드는 변경하지 않았다.
