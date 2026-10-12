# WONY PHASE 2 — 실제 영상 검증

기준 코드 a62554f에서 시작한 미커밋 실험 구현이다. 대상은 사용자 확인을 받은 영상 중앙의 WONY 한 명이다. 우타/우투/풀트/SBO VR이라는 정보는 **사용자 제공 정보**이고 센서 데이터로 검증한 정보가 아니다. 자동 아바타 식별·다중 선수 관리는 구현하지 않았다.

## 실제 입력과 관찰

- 파일: wony-batter-001.mp4, 20,761,001 bytes.
- 컨테이너 길이: 20.045333초. 영상 스트림 H.264, 1920×1080, 60fps, 영상 스트림 길이 20.006초. 오디오 AAC, 약18.005초.
- 영상 첫 PTS:2360, time_base=1/60000, 약0.039333초.
- 파일의 인코딩 해상도이며 원래 게임 렌더링이 네이티브1080p였다는 뜻은 아니다.
- 중앙 아바타: 베이지색 모자, 검은 머리, 흰옷, 분홍색 다리, 파란 글러브. 사용자가 이 아바타가 WONY라고 확인했다.
- 검토한 구간은 **3인칭**이다. 자동 viewpoint 분류를 수행한 것은 아니다.
- 0~약1.5초에 공을 든 손을 올리고 다리를 들었다가 상체를 숙이며 팔을 뻗는 동작이 보인다. 마운드/투구판, `피칭 설정`, `Pitch!`, `Not Ready` 표시가 보인다. **수동 관찰은 투구 준비/시도**이며 파일명 때문에 타자로 강제하지 않았다.
- 색상 벡터/잔상처럼 보이는 효과가 있으나 WONY의 타격 배트 잔상이라고 확인하지 못했다. 이를 bat trail/bat path로 저장하지 않았다.

## 기능 판정

| 항목 | 판정 | 관찰/엔진 근거와 제한 |
|---|---|---|
| 1. metadata | 가능 | ffprobe로 codec/해상도/FPS/길이/원본 PTS 확인 |
| 2. WONY 수동 지정 | 가능 | 사용자의 대상 확인, 원본 픽셀 bbox 지정/재확인 UI와 JSON 저장·검증 API 시험 |
| 3. WONY ROI pose | 부분 가능 | 두 ROI 모두201/201 검출. 전신 품질 통과는2/201,4/201. 검출률을 관절 정확도로 해석하지 않음 |
| 4. target tracking | 부분 가능 | 이 클립의201샘플에서 ROI 유지. 카메라 전환·완전 가림·유사 아바타 교차는 실제 영상에 없어 미검증 |
| 5. first/third person | 가능(수동 확인) | 현재 클립3인칭. 자동/혼합 구간 분류는 미구현·미검증. first_person/unknown에서는 전신 pose를 실행하지 않음 |
| 6. 역할 자동 판별 | 현재 불가(이 클립의 자동 결과) | 수동 관찰은 투구 준비/시도. 기존 자동 판별 결과는unknown. 최소5개 전신 품질 샘플을 확보하지 못함 |
| 7. SBO bat trail | 미검증 | 확인된 WONY 타격 잔상 근거 없음. 색상 효과의 정체를 bat trail로 가정하지 않음 |
| 8. bat path | 현재 불가 | 확인된 배트/타격 잔상이 없어 궤적·스윙 유형·배트 속도를 생성하지 않음. 전용 bat tracking 미구현 |
| 9. HUD OCR | 부분 가능 | 원본 해상도 수동 crop의 숫자 OCR 후보 생성. 잘못된 숫자도 발생하므로 value=null, review_required=true. 구종/판정 OCR·투구별 연결은 미검증 |
| 10. estimated3D | 부분 가능 | 기존 공통projector/Three.js에 ROI pose 연결,201개 프레임에 일부 관절 표시. 실제 깊이/3D복원 정확도 검증 아님 |
| 11. PLAYER TOOLS 연결 | 부분 가능(구조/시각화) | 공통 report builder/UI에 연결. 자동 역할과 pose 품질이 부족해5툴은전부insufficient_data, score/grade=null. 선수 능력 평가 완료 아님 |

## ROI 민감도 — 좋은 결과만 골라 보고하지 않음

원본 픽셀 기준 bbox=[x,y,width,height]. 첫 ROI에서 팔/손이 경계 가까이 가므로 같은 선수의 여유 영역을 확대한 두 번째 ROI도 시험했다. 기존visibility≥0.6 및 role/metrics 품질 기준은 낮추지 않았다.

| 검증 | 초기 bbox | 추적허용/샘플 | pose 검출 | 전신 품질 | 투수 전용 품질 | auto role | 일부3D관절 |
|---|---|---|---|---|---|---|---|
| 기본 ROI | [920,65,410,740] | 201/201 | 201/201 | 2/201 | 58/201 | unknown | 201/201 |
| 여유 ROI | [820,50,600,760] | 201/201 | 201/201 | 4/201 | 68/201 | unknown | 201/201 |

기본 ROI의 손목·무릎 visibility 중앙값: left_wrist 약0.048, right_wrist 약0.453, left_knee 약0.349. 전신 조건을 만족하지 못하는 이유가 있다. 검출 결과의33개 좌표는 모델 예측이며 모두 보이는 실제 관절이 아니다. 가려진 관절을 표시/성과 측정에 사용하는 기준은 기존 utility를 유지했다.

CSRT와 초기 ROI의 색상 appearance/프레임 변화/이동·크기·경계 guard를 사용한다. 기본 ROI 추적 confidence 범위0.413~0.6은 **휴리스틱**, 신원 확률이 아니다. 실제 클립에서 tracking_lost는 발생하지 않았다. 손실 후 다른 대상 탐색 없이 중단하는 코드 경로는 별도 단위 테스트로 확인했으며, 실제 가림/교차 정확도를 증명하지 않는다.

## HUD: 직접 관찰과 OCR를 분리

화면의 직접 관찰:

- 처음 화면에는 `원본속도:24.9 km/h`, `환산속도:113.6 km/h`가 보인다.
- 약2초 이후 샘플에는 `원본속도:29.1 km/h`, `환산속도:121.3 km/h`가 보인다.
- 이는 **SBO 표시값**이다. 실제 신체/실제 공 구속으로 바꾸지 않았다. 동일 값이 여러 프레임에 남아 있는 것을 여러 투구로 세지 않았다.

자동 OCR:

- 선택 native crops와 선택 Tesseract eng를 사용한다. 한국어 label/구종/게임 의미를 자동 확인한 것이 아니다.
- crop 경계가 달라질 때 표시된113.6을973.6으로 읽는 실패를 확인했다. OCR confidence가0.67이더라도 참값을 보장하지 않았다.
- 이후 여유 crop에서는113.6/121.3 후보가 나왔지만 **모든 accepted value는null**이다.
- `source=sbo_hud_estimated`, `ocr_candidate`, `ocr_confidence`로 후보만 보관한다. `confidence=0`, `review_required=true`, `physical_velocity=null`, `event_id=null`.
- crop 단위의 입력 label/unit은 수동 지정이다. 이를 `sbo_hud_observed`나`user_confirmed` 측정값으로 자동 승격하지 않는다.

## 최소 구현과 경계

`validation/target.py`:

- WONY만 허용하는수동selection, source좌표범위 확인, 확인이 없으면 tracker/pose실행 금지.
- first_person/unknown이면 전신분석 차단.
- CSRT failure, scene change, 경계 이탈, 급격한 이동/크기/appearance 변화에서는tracking_lost. 한번 손실되면 이후프레임에서 재탐색/재초기화하지 않음. 새 사용자지정 필요.
- ROI landmark x/y/z를 기존 원본정규화 pose 계약으로 변환. 전체화면 posefallback 없음.

`validation/runner.py`:

- 최대30초의 localclip, 원본PTS 수집. 10fps 추적/pose, pose는native ROI, preview만960px.
- 기존extract_pose, analyze_role, build_visualization, build_report를 재사용. 별도 역할별/LIVE/VOD 분석 모델을 만들지 않음.
- 결과는validation_only이며일반분석목록·선수성장이력과 분리. full-frame 재선택·신원인증·auto viewpoint·bat detector·SBO 자동 HUD detector는 없음.

`source_time_mapping`:

- frame_index는10fps샘플인덱스, source_frame_index는디코딩원본프레임인덱스.
- source_time/original_pts/time_base는**이번업로드MP4**의시간이다. 이전5시간방송과의offset은제공되지않아미검증.
- clip_time은첫선택프레임부터상대시간, segment_time은수동선택source_time부터상대시간.
- 기존overlay는균일10fps displayclock이다. 원본PTS는보존하지만 완전무오차 동기화·VFR·장시간drift 검증을 완료한 것은 아니다.

기존 `/api/analyze`, LIVE/VOD에는 target lock을 전면 적용하지 않았다. 이번 검증은 **명시적 opt-in validation 경로**만 WONY ROI를 잠근다. 기존 API를 WONY 전용 검증 완료 엔진으로 간주하지 말 것.

## UI / API / 실행

서버 재시작 후 로컬 PC에서 `/demo/validation/`로 이동한다. 메인3메뉴와기존통합리포트를재사용하며새선수관리메뉴는없다.

1. 파일선택 → 원하는장면정지 → 현재장면에서WONY지정.
2. 대상아바타와움직일팔/다리가포함되게사각형드래그.
3. viewpoint선택, WONY확인checkbox. 새파일/새ROI/새장면은확인을다시해야한다.
4. 선택JSON저장또는대상ROI검증. 결과는`/demo/validation/report/{id}`.

API:

- `POST /api/validation`: multipart video와selection JSON, 선택적hud_regions JSON. 32MiB/30초 제한. 미확인selection은422.
- `GET /api/validation/{id}`: 기존리포트UI가읽는bundle.
- `GET /api/validation/{id}/analysis`, `/source`, `/assets/{filename}`, `/evidence/{filename}`: 읽기전용결과/영상/이미지.
- 결과추가필드: subject(user_provided),validation_only,target_tracking,viewpoint_segments,source_time_mapping,validation_summary,hud_observations.

프로젝트 루트에서 CLI(Windows):

```powershell
.\.venv\Scripts\python.exe backend\tools\validate_target.py .\wony-batter-001.mp4 --selection .\wony-target-selection.json --output .\data\validation
```

수동HUD영역을시험하려면선택적`--hud-config` JSON:

```json
{"hud_original_speed":[1660,0,260,53],"hud_converted_speed":[1640,40,280,96]}
```

이 좌표는이번클립용이다. 다른영상에그대로재사용하지않는다. Tesseract실행파일은선택기능으로없으면not_supported. Pythonrequirements핀변경없음. Windows실제실행은미검증.

## 테스트 / 자산

Linux Python3.12 서버195개통과(기존172+새23),기존의존성deprecation경고3개. 확인/시점gate,손실이후재선택금지,scene/appearance/경계·이동손실,ROI좌표변환,PTS,first-person에서pose호출금지,validation과production이력분리,OCR후보미승격을검증한다.

실제사용자영상브라우저테스트: 수동bbox드래그/확인 → validation API → 실제원본/2D/3D시각화,unknown/툴보류,실험적표시,모바일. 합성DEMO를대체입력으로사용하지않는다.

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests -q
cd frontend-demo
$env:WONY_REAL_CLIP = "C:\clips\wony-batter-001.mp4"
node tests/target-validation.mjs
```

기존통합리포트/5툴/LIVE-VOD/방송브라우저4종도통과했다. 테스트영상의20초상황만검증한것이며 일반화된VR정확도/실제관절각도정답/가림·교차/혼합시점/타격궤적/구종OCR/투구이벤트연결/PLAYER TOOLS 타당성은미검증이다.

생성물은Git제외`data/validation/{uuid}`에원본copy·overlay·JSON·HUDcrop을저장한다. 실제코드검증결과예:

- 기본ROI+HUD: dc36ad64-7cdf-4152-8740-96715a407b54
- 여유ROI+HUD: 32832722-fdff-4179-9ac6-6efece417799
- 사용자드래그UI검증: 625c35f1-9d17-41f2-a7e9-ce6ad39e8f5d

캡처는`/tmp/wony-real-validation`에저장했다. commit/push하지않았고WONY PHONE은수정하지않았다.

## 수정 파일과 다음 우선순위

새 파일: backend/app/validation/{__init__,target,hud,runner}.py, backend/app/api/validation.py, backend/tools/validate_target.py, backend/tests/test_target_validation.py, frontend-demo/validation/{index.html,selection.js}, frontend-demo/tests/target-validation.mjs, docs/WONY_PHASE2_VALIDATION.md.

수정: backend/app/main.py,frontend-demo/report.js,README.md,docs/HANDOFF.md,docs/CLAUDE_HANDOFF.md.

다음은실제타격동작과확인된배트잔상이포함된클립,앞/측면의손·무릎이보이는ROI,카메라전환/가림·유사아바타교차검증이다. 현재품질기준을낮춰평가를생성하지않는다. 본클립에서는 CONTACT/POWER 점수·물리속도·정확한3D·좋은/나쁜플레이하이라이트를생성하지않는다.

## 후속 개선

이 문서의 195개 테스트, unknown 역할, 201개 일부 3D, 30초 입력 한계는 초기 PHASE 2 결과입니다. 최신 개선·239개 테스트·ROI와 추적 조건·HUD voting·3D/릴리스 보류는 [WONY_PHASE2_ENGINE_IMPROVEMENTS.md](WONY_PHASE2_ENGINE_IMPROVEMENTS.md)를 읽으세요. 초기 관측을 최신 결과로 덮어쓰지 않았습니다.
