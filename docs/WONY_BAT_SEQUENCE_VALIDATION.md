# WONY SBO bat trail / rendered bat / swing 검증

2026-10-13 (Asia/Seoul). 실제 영상 결과이며 DEMO 점수나 임의 좌표를 선수 결과로 생성하지 않았다. 사용자에게 기존 흰옷 WONY와 새 검은옷 WONY를 각각 확인받았다. WONY 한 명만 잠금 대상으로 사용한다. 이 단계는 저수준 입력과 실패 조건 검증이며 타자 분석 완성/정확도 인증이 아니다.

## 입력 / 중복

| 파일 | 길이 / 해상도 / FPS | 독립성 / 실제 장면 |
|---|---|---|
| wony-batter-002.mp4 | 32.034667초 / 1920×1080 / 60 | 기존 흰옷 WONY 타격, 목재형 배트 mesh가 보임 |
| wony-pitcher-001.mp4 | 11.046615초 / 720×1280 / 60 | 실제로는 검은옷 WONY 타격, game content에 letterbox 있음 |
| wony-pitcher-002.mp4 | 10.035416초 / 720×1280 / 60 | 실제로는 검은옷 WONY 타격 |
| wony-pitcher-003.mp4 | 위002와 동일 | SHA-256까지 동일한 중복 파일; 독립 검증으로 세지 않음 |

001 SHA=50731eefe7bd5f1d92badff7e37d86e81430bbe3ee0c57d4812fbccdb8fccaa2.
002/003 SHA=ab12015c112ca662d952c6281bad3f29f7e34038364206c37b7649073fc15be2.
기존 타격 SHA=0ccb9ae946d8ffbe4dc8d56aeb736f4d7e389218250b2a2a326f8003feb89b7b.

파일명 때문에 투수로 분류하지 않았다. 추가 독립 클립은 2개이며, 그중 하나는 WONY 추적 손실 전까지만 분석한다.

## 요청 항목 판정

| 항목 | 판정 | 근거 / 보류 |
|---|---|---|
| 1. SBO trail 후보 영역 탐지 | 부분 가능 | 포화도/밝기/늘어난 contour로 비녹색 효과 후보 bbox 반환. bat trail의 의미를 판정한 것이 아님 |
| 2. 실제 배트 잔상 의미 검증 | 미검증 | 물체와 별개로 오래 남는 다색 line/curve를 확인. 저장된 과거 bat path, ball path, HUD/debug 효과를 현재 영상만으로 확정 구분하지 못함 |
| 3. rendered bat object tracking | 부분 가능 | 목재형 배트에 5개 수동 appearance seed,430프레임 잠정 좌표. 빠른 swing에서 특징점/형상/외관 gate 실패. 자동 bat detector/완전 추적 아님 |
| 4. 오른손목 경로와 분리 | 가능 | 배트 tracker는 영상 특징점만 사용. wrist 입력/보간/fallback 없음. path 함수가 right_wrist source를 거부 |
| 5. 자동 swing start/end | 현재 불가 | 실제 영상에서 완전한 자동 후보0, onset/end=null. 정지→움직임→정지 hysteresis의 DEMO 테스트만 통과 |
| 6. swing path | 부분 가능 | 수동 seed 이후의 물체2D 좌표는 일부 제공. 빠른 스윙 전체의 검증된 경로는0. 손목/효과로 잃은 부분을 채우지 않음 |
| 7. downswing/level/uppercut | 현재 불가 | 검증된 complete bat path/보정된 측면 view 부족. 실제 결과null. 선언된 side view의 projected 방향 함수만 DEMO 테스트 |
| 8. 여러 path consistency | 현재 불가 | 독립 검토된 완전 경로3개 미확보. 비교 함수는 reviewed object/camera 조건과 중복 배제 뒤만 계산. 실제null |
| 9. CONTACT proxy 연결 | 부분 가능 | scouting_inputs.contact에 object 근거용 schema. 실제 contact/score=null. 이번엔 complete event ref도없음 |
| 10. POWER mechanics proxy 연결 | 부분 가능 | source-pixel object 입력용 schema. 실제 force/bat speed/POWER score=null, 원래 영상 전신usable0이라 하체 추론 보류 |

"부분 가능"은 입력/구조 또는 일부 프레임에 한정한다. PLAYER TOOLS 점수 생성이나 서비스 완료를 의미하지 않는다.

## 실제 결과 / 실패 범위

색상 후보는 물리적 배트 mesh와 다른 처리 경로다. 수동 search ROI는 game field/effect 영역을 포함하고 주요 우측 HUD를 피하도록 설정했으나, 색만으로 효과 종류/선수 귀속을 알 수는 없다. 흰옷 영상 region=[280,180,950,620], letterbox 영상 region=[280,440,320,440].

| 독립 영상 | 후보 존재/효과 샘플 | Object 잠정 좌표 | 완전 swing 후보 | 처리 범위 |
|---|---:|---:|---:|---|
| 기존 타격002 | 319/320 | 430 | 0 | 전체32초, WONY lock 유지 |
| 첨부001 | 104/110 | 0 | 0 | 전체11초, lock 유지. 명확한 실제 bat seed 없음 |
| 첨부002 (=003) | 15/15 | 0 | 0 | 1.509375초 WONY loss 직전 중단 |

이 비율은 후보가 보인 빈도이며 bat trail 정확도가 아니다. 추가 영상에서도 유사한 색상 component는 재현되지만, 실제 bat tracking/swing path의 재현성은 입증하지 못했다. 002의 손실 후 프레임을 WONY 결과로 포함하지 않았고003을 중복 카운트하지 않았다.

기존 영상의5개 object seed는 operator가 source frame을 보고 **영상 시작/4.6/11.6/19.2/26.2초**에 각각 지정했다. 자동 재식별이나 손실 후 자동 재초기화가 아니다. 축의 barrel/shaft reference와 폭은 native source-pixel 수동 annotation이다. 실제 손 위치·실물 배트 길이나 물리 좌표가 아니다.

| 수동 epoch 시작 | tracking 프레임 | 마지막 추적 시각 | 첫 중단 시각 / 이유 |
|---:|---:|---:|---|
| 0 | 61 | 1.034 | 1.050 / rigid fit 부족 |
| 4.6 | 1 | 4.600 | 4.617 / forward-back/texture 부족 |
| 11.6 | 1 | 11.600 | 11.617 / rigid fit 부족 |
| 19.2 | 192 | 22.384 | 22.400 / seed appearance 부족 |
| 26.2 | 175 | 29.100 | 29.117 / seed appearance 부족 |

총430에는5개 seed 초기화 프레임이 포함된다. 이 중 다수는 배트를 들고 기다리는 상태이다. 몇백 개 좌표가 있다고 complete swing을 얻었다고 보고하지 않는다. 1초 evidence에서 green polygon이 목재형 배트에 정렬되는 것을 직접 검토했지만 모든430개 프레임의 정답 annotation/정확도를 검증한 것은 아니다.

10Hz 효과 mask의 이전 mask 대비 IoU>0.9가262회 관찰됐다. 효과가 오래 유지되는 특징은 확인했지만, 과거 스윙 잔상이 원래 지속되는 기능일 수도 있으므로 이것만으로 bat trail을 부정하거나 확정하지 않는다. 빠른 물체 추적이 끊겨 효과와 실제 bat-tip의 동시 대응 검증을 확보하지 못했다.

## 추적 / 품질 조건

- 실제 source pixels/PTS에서 object는 native60fps로 처리, 효과는약10fps로 샘플링한다. 기본120초 metadata 한계 재사용.
- 수동 배트 polygon 안의 goodFeatures 8개 이상, forward-backward 오차≤1.5px, feature support≥70%, RANSAC rigid inlier≥75%/8개, median residual≤2px, 프레임 scale0.85~1.15, HSV appearance distance≤0.4를 요구한다.
- 추적이 끊기면 tip/shaft/polygon=null이고 해당 epoch는 terminal. 새 feature search, 손목 대체, 경로 보간 없음.
- 정확히 같은 영상임을 SHA로 target report의 보관 source와 확인한다. 수동 shaft anchor는 WONY bbox 안에 있어야 하고 tracked shaft는 해당 target neighborhood를 벗어나면 중단한다.
- WONY target loss면 effects/object 전체 처리를 멈춘다. low_confidence에서도 object gate를 멈추고 자동 이어 붙이지 않는다.
- confirmed third_person target 없이 seeded actor object 분석을 허용하지 않는다. first_person body나 3D를 생성하지 않는다. 익명 effect-only는 점수/선수 귀속 없음.
- 낮은 기준으로 성공률을 높이지 않았다. 새 layer는 raw image tracking이며 기존 pose/역할 기준을 건드리지 않았다.

조건은 보수적 실험 규칙이고 보정된 정확도/확률이 아니다. record confidence≤0.6, effect/event confidence0.25, estimated=true, accuracy_verified=false. HDR 밝기·occlusion·shader·가림에서 실패할 수 있으며 실제로 빠른 스윙 구간에서 실패했다.

## 이벤트 / 분류 / 비교 / Scouting 입력

swing 후보는 추적된 물체의 image angular motion과 tip displacement로만 만든다. 3프레임 이상 높은 움직임, 0.15초 이상 정지 유지가 있어야 end 후보가 가능하다. 샘플 공백/물체 loss/clip 끝에서 end를 꾸며내지 않는다. None과 incomplete 상태를 유지한다. 실제 영상에서는 후보 생성 조건을 통과하지 못했다. 기준을 낮추지 않았다.

path 방향은 reviewed bat path + 명시적인 calibrated_side_view에서만 projected 방향을 계산한다. 실제3D swing plane/물리 swing type을 검증한 함수가 아니다. 실제 입력에 view 보정을 선언하지 않아null이다. consistency는 최소3개 reviewed object paths, camera_context, 수동 reference length를 요구한다. object tip을 시간 정규화한 image RMS 참고값으로서 ability score가 아니다. 같은(source SHA,epoch,start,end)를 중복 카운트하지 않는다. 실제 결과에 검토 완료 flag를 임의로 넣지 않았고 consistency도null이다.

scouting_inputs는 미래 CONTACT/POWER 입력을 받을 준비된 **근거 schema**이다. 기존 PLAYER TOOLS/성장 이력으로 자동 합산하지 않는다. 실제 contact, bat speed, POWER score/힘, 원래 전신0인 영상의 하체 power는null. 추가001에는 general pose45/111,002에는15/101(손실 전)이 있었지만 정렬된 swing/힘/성공 근거를 확보한 것이 아니므로 이 단계에서도 하체 POWER 평가를 생성하지 않았다.

role_hint=batter와 automatic_role은 별도 필드이다. 기존 흰옷 영상은 hint=batter/user_provided, auto=unknown. 추가2개의auto도unknown이다. 피칭 HUD/역할 template는 이 영상들에 맞춰 다시 학습/완화하지 않았다.

## 실행 / 결과

새 CLI는 opt-in 실험이다. LIVE/VOD/분석 엔진을 복제하지 않고 기존 metadata/target report/role 결과를 재사용한다. 새 메인 UI/API 메뉴를 만들지 않았다. 기존2D/3D/scouting 경로는 유지한다.

```powershell
.\.venv\Scripts\python.exe backend\tools\validate_bat_sequence.py C:\clips\wony-batter-002.mp4 --config C:\clips\bat-config.json --target-report data\validation\<id>\analysis.json --output data\bat-validation
.\.venv\Scripts\python.exe -m pytest backend\tests -q
```

config 예 (실제 source-resolution 수동 seed/region이며 다른 영상에 그대로 적용하지 않음):

```json
{"effect_region":[280,180,950,620],"seeds":[{"source_time":0,"tip":[378,130],"shaft":[590,335],"width":32}]}
```

실제 실행 JSON/이미지(Git 제외):

- main: data/bat-validation/362d5041-46ca-4b87-9994-d2dfe5b5c476/analysis.json
- 추가001: data/bat-validation/a6c13556-72e2-4145-9300-65e94d987a4a/analysis.json
- 추가002: data/bat-validation/4e5d2dcd-ece1-4e49-8e3d-91881f19a3b8/analysis.json
- target reports: f4d78678-553e-4759-88cd-2d3a78dd3129,887cb673-b02b-4adf-b761-1da7c91808da.
- 기존 overlay evidence: main의evidence-00060.jpg. Green=수동 seed 기반 물체 polygon, blue=의미 미확정 색상 후보 bbox. 색 경고/폼 평가가 아니다.
- 추가 contact sheet: /tmp/wony-bat-phase/extras.jpg.

## 후속 hybrid 추적 검토

단일 frame-by-frame tracker의 빠른 스윙 손실 원인을 texture 부족, motion blur, 큰 프레임 간 변위, 가림과 배트/배경의 비슷한 색으로 분리했다. 원본 60fps에서 확장 ROI를 사용하고 **영상 검출 → 한 프레임 LK optical flow → 이전/다음 후보 temporal association** 순서의 실험 경로를 추가했다. 프레임별 tip/handle/orientation/path point/confidence/source를 기록한다. 손목은 영상에서 검출된 endpoint 후보 중 하나를 고르는 보조 constraint로만 사용할 수 있고, 검출이 없는 프레임을 손목으로 채우지 않는다.

합성 fixture에서는 빠른 이동과 색 변화, 멀리 떨어진 같은 색 물체 거부가 재현됐다. 실제 검토에서는 일부 연속 좌표를 얻었지만 흰옷 클립에서 목재형 배트가 화면 효과로 바뀌어 연결될 위험을 확인했다. 검은옷 클립도 같은 색 UI/그래프와의 귀속을 독립 정답 annotation으로 확인하지 못했다. 따라서 실제 결과의 `reviewed_object_track`은 false이고, **검토 완료된 실제 start→path→end는 0건**이다. 완전 경로·swing plane·downswing/level/uppercut은 계속 null이다.

이 후속 구현은 성공률을 보이기 위해 기존 gate를 낮춘 것이 아니다. candidate center가 seed 길이의 70%보다 크게 점프하는 같은 색 물체를 차단하며, WONY target이 `tracking_lost`/`reidentification_required`가 되면 즉시 끝난다. `low_confidence`에서는 seed-associated 영상 근거만 낮은 confidence로 유지할 수 있지만 손실 구간을 보간하지 않는다. 실제 bat speed, CONTACT, POWER는 계속 null이다.

## 테스트 / 수정 파일

290 backend tests passed, 기존 의존성 경고3개. 앞선284개에 hybrid object geometry, wrist fallback 금지, missing object, 멀리 있는 같은 색 물체 전환 거부, visible-edge 색 변화, 확장 ROI/path evidence 테스트6개를 추가했다. DEMO 합성 fixture 성공을 실제 fast-swing 정확도 검증으로 해석하지 않는다.

추가: backend/app/validation/{bat_tracking,bat_sequence,bat_path,bat_hybrid}.py,backend/tools/validate_bat_sequence.py,backend/tests/test_bat_sequence.py,본 문서. README/HANDOFF/CLAUDE_HANDOFF의 현재 테스트와 전달 사항을 갱신한다. 기존 frontend-demo/역할 휴리스틱은 이번 단계에 변경하지 않았다. 영상·원본JSON·스크린샷은Git에 넣지 않는다.

WONY PHONE은 수정하지 않았다. 다음 핵심은 빠른 swing에서의 실제 bat segmentation/occlusion-aware 추적, 게임 효과의 의미/종류 확인, 배트/공 frame 정답과 독립 camera/clip 검증이다. 현재 후보 탐지를 bat trail 완성으로 표시하지 않는다.
