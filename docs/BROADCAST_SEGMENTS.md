최신 VOD URL/자동 역할/복합 탐지는 [ENGINE_INPUTS.md](ENGINE_INPUTS.md)를 먼저 읽으세요.

# 긴 방송의 야구 구간 탐지 레이어

기존 60초 단일 영상 API/다섯 역할/2D·3D·scouting은 유지합니다. 새 기능은 원본을 저비용 스캔하고 구간만 추출해서 기존 엔진에 전달합니다. 방송 전체의 콘텐츠나 출연자를 평가하지 않습니다.

## 실행 및 API

기존 설치/단일-worker FastAPI 실행 방법이 같습니다. 새 필수 의존성은 없습니다.

```bash
# 비동기 구간 스캔: HTTP 202 + job id
curl -X POST http://localhost:8000/api/analyze \
  -F video=@broadcast.mp4 -F mode=auto_segments
# 스캔 설정: 별도 endpoint
curl -X POST http://localhost:8000/api/broadcasts \
  -F video=@broadcast.mp4 -F sample_interval=10 -F merge_gap=20 -F buffer=10 \
  -F threshold=0.8 -F max_scan_frames=10000 -F max_analysis_clips=20 -F clip_seconds=10
# 결과/진행 조회
curl http://localhost:8000/api/broadcasts/JOB_UUID
# 사람 확인 후 구간을 역할별로 나눠 수정/재분석
curl -X POST http://localhost:8000/api/broadcasts/JOB_UUID/segments \
  -H 'Content-Type: application/json' \
  -d '{"segments":[{"start":"03:05:00","end":"03:15:00","role":"batter"},{"start":"03:15:00","end":"03:25:00","role":"defense"}]}'
# 처음부터 수동 구간을 지정하면 스캔을 생략
curl -X POST http://localhost:8000/api/analyze \
  -F video=@broadcast.mp4 \
  -F 'segments=[{"start":"03:05:00","end":"04:02:00","role":"batter"}]'
# 원본/작업 삭제 (파생 분석 JSON/자산은 별도 보관)
curl -X DELETE http://localhost:8000/api/broadcasts/JOB_UUID
```

분/시간 문자열은 HH:MM:SS, 숫자는 초입니다. 음수·NaN·범위 밖·겹치는 수동 구간은 거부합니다. 수동 역할은 batter/defense/catcher/pitcher/baserunning/unknown. 시작 API는 기존 player_id/analysis_date/comparison_context/hand/position을 전달할 수 있습니다. `/broadcasts` 설정 API는 현재 선수 메타데이터를 받지 않습니다.

상태: queued/running/completed/failed/interrupted. 단계: SCAN → BASEBALL_SEGMENT_DETECTION → SEGMENT_EXTRACTION → ROLE_ANALYSIS → POSE_ANALYSIS → SCOUTING_REPORT → COMPLETE. 분석 대상이 없으면 정밀 단계는 실행하지 않고 건너뜁니다. current/total은 현재 단계의 샘플/클립 개수이며 전체 처리 시간 예측이 아닙니다. 여러 클립은 추출~리포트 단계를 반복합니다. 실패하면 이미 생성된 결과는 유지하고 일반 방송에 평가를 추가하지 않습니다.

## 탐지 근거와 현재 한계

SignalDetector/evidence는 LIVE/VOD 공통입니다. 축소 프레임의 색상 맥락, 선택 COCO 객체 모델, 선택 field/UI/scoreboard 장면 모델, 최근6개의 희소 pose 움직임을 조합합니다. 색상·자세·공·스코어보드 한 가지로 야구를 확정하지 않습니다.

객체 모델 `WONY_SEGMENT_ONNX`는 YOLOv8 COCO raw `[1,84,N]`이며 RGB letterbox640, bat34/glove35/sports-ball32 형식입니다. 장면 모델 `WONY_SCENE_ONNX`는 field/baseball_ui/scoreboard 세 class의 raw `[1,7,N]`입니다. 가중치는 포함하거나 런타임 다운로드하지 않으며 별도 준비·검증해야 합니다. 두 모델이 없으면 색상/자세는 confidence≤0.49의 검토 후보입니다.

기존 bat+glove+field 외에 temporal motion+장비+field/UI, 학습된 field+UI+motion 조합을 허용합니다. 상세 임계값/보안/지원 범위는 [ENGINE_INPUTS.md](ENGINE_INPUTS.md). 실제 홈플레이트·베이스·접촉·VR 정확도는 검증하지 않았습니다.

야구 confidence가 충분한 구간의 unknown/auto 역할은 짧은 클립 pose로 자동 추정합니다. 역할 근거가 부족하면 평가를 보류하고 role_selection_required를 반환합니다. role_segments는 클립별 자동 역할을 기록하며 여러 역할이 섞인 구간의 대표 role은 unknown일 수 있습니다. 수동 선언은 source=manual/confidence=null이며 모델 탐지 성공으로 표시하지 않습니다.

## 비용, 경계, 정밀 분석

- 기본 샘플 간격 10초 (5~60 설정), 각 샘플 ffmpeg 입력 seek→단일 프레임→최대 320px. 원본 모든 프레임의 pose/정밀 디코딩을 하지 않습니다. ffmpeg 입력 seek는 코덱/keyframe 구조에 따라 추가 디코딩이 필요합니다.
- 기본 스캔 예산 최대 10,000 프레임. 길이에 따라 간격을 자동 늘리고 effective_interval을 반환합니다. 최대 24시간, 업로드 기본 8 GiB (`WONY_BROADCAST_MAX_BYTES`로 변경 가능). 고비트레이트 10시간 영상은 재인코딩/한도 조정이 필요합니다. 실제 10시간 성능/디스크 용량은 검증하지 않았습니다.
- 샘플 반간격을 경계로 추정하여 merge_gap 기본 20초 이내 후보를 병합합니다. accepted/review 후보는 서로 섞지 않습니다. confidence는 병합 구성값 최솟값입니다. 구간 경계는 추정이며 짧은 플레이를 놓칠 수 있습니다. 후보 주변 추가 정밀 스캔은 아직 미구현입니다.
- 기본 앞뒤 10초 buffer는 0~영상 끝으로 제한합니다. core_start/core_end가 근거 구간, start/end는 미리보기 버퍼 포함 범위입니다. 버퍼 구간의 일반 방송 내용은 정밀 분석에 전달하지 않습니다. 버퍼 때문에 미리보기 후보끼리 겹칠 수 있습니다.
- 기본 정밀 분석은 10초 클립 최대 20개 (설정 1~30초, 최대 200클립). 전체 선택 구간을 전부 분석한다는 뜻이 아닙니다. 예산 초과 시 coverage=partial_budgeted/review_required=true. analyses[]의 start/end가 실제 처리 범위입니다. 예산을 올리거나 수동 구간을 줄여 다시 분석하세요.
- clip 결과의 pose/events/keyframes timestamp는 클립 상대시간입니다. 방송 시간은 broadcast_offset_seconds를 더합니다. analysis_url이 기존 2D/3D/리포트 결과를 참조합니다. 수동 정밀 클립은 일반 구간을 자동 포함하지 않습니다.
- 기존 엔진은 한 명/한 동작 권장입니다. 다중 인물 선택, 자동 개별 플레이 분리, 가려진 선수의 분석 정확도는 해결하지 않았습니다. 한 선수/한 동작으로 수동 구간을 좁히는 것을 권장합니다.

## 저장과 복구

업로드는 data/broadcasts/{job_uuid}/source.upload와 job.json, URL VOD는 비공개 remote.json과 job.json을 보관합니다. 업로드 전체 원본은 수정용으로 남고 URL 전체는 저장하지 않으며 처리 클립만 original.mp4 자산으로 남습니다. 모두 `.gitignore`의 data/로 제외됩니다. 정밀 분석의 임시 clip은 완료/실패 후 삭제합니다. 인증·사용자별 접근/디스크 총량 제한·외부 작업 큐는 미구현이므로 공개 배포용 기능은 아닙니다.

단일 프로세스의 background thread, 방송 작업 하나와 단일 pose 처리 lock을 사용합니다. 프로세스 재시작 후 미완료 작업은 interrupted로 표시하고 원본을 유지합니다. 자동 재개는 없으며 수동 구간 수정으로 재분석할 수 있습니다. 재분석은 기존 파생 분석을 삭제하지 않습니다. DELETE job은 원본/작업만 지우며 기존 분석 JSON/영상 자산은 별도 보관 정책이 필요합니다.

## 데모와 검증

/demo/ 하단 **긴 방송 분석**에서 전체 영상 선택, 샘플 간격/버퍼, 구간 타임라인, 구간 보기, 분석 결과, JSON 수정/재분석을 제공합니다. 원본 재생은 브라우저가 지원하는 코덱이어야 합니다. 일반 방송 영역은 '미분석'이며 토크/노래/게임 종류를 임의로 분류하지 않습니다.

DEMO 타임라인의 10시간·91% 예시는 임의 데이터이며 실제 탐지 결과가 아닙니다. source와 정밀 분석은 없습니다. [화면 캡처](screenshots/broadcast.png)도 DEMO입니다.

최신 pytest129개 통과(기존105+입력/역할/복합 탐지24). 다중신호, 병합/버퍼, 타임코드/잘못된 구간, 스캔 예산, review 분석 금지/unknown 자동 역할 추정 실패 시 평가 보류, 수동 core 구간/클립 예산/시간 오프셋, 수정/삭제/실패를 검증합니다. `frontend-demo`에서 `npm run test:broadcast`: 실제 ffmpeg 검은 영상 스캔→야구 없음→분석 없음, 수동 지정→MediaPipe 부족 pose→기존 결과 화면, 타임라인/수정/모바일 확인. 합성 테스트/사람 없는 영상은 실제 방송 탐지 정확도의 증거가 아닙니다.

LIVE/VOD 입력 확장 및 최신 테스트는 [LIVE_VOD.md](LIVE_VOD.md)를 참고하세요. 공통 source adapter와 execution bridge를 재사용합니다.
