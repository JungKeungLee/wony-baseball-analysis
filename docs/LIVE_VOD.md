최신 URL/자동 역할/모델 계약: [ENGINE_INPUTS.md](ENGINE_INPUTS.md).

# LIVE / VOD 입력과 공통 분석 경로

## 설계

```
LIVE HTTP stream / file replay → temporal discovery
VOD file / direct MP4 / finite HLS URL → exact / approximate / auto discovery
                   ↓
shared SignalDetector + evidence
                   ↓
confirmed segment + role / human correction
                   ↓
segments/execution.analyze_clip
                   ↓
existing extract_pose → analyze_role → visualization → scouting_report
```

LIVE/VOD용 자세 분석기는 만들지 않습니다. 역할·각도·2D/3D·이벤트·scouting은 기존 모듈을 공유합니다. 기존 `/api/analyze`의 단일 영상 및 auto_segments/segments 요청, `/api/broadcasts`와 선수 API도 유지합니다.

새 source/base.py는 sample(timestamp)와 capture(destination,timestamp,duration) 인터페이스입니다. FileSource는 seek 가능한 업로드 파일, StreamSource는 provider 중립 HTTP(S) 스트림입니다. SOOP 등 플랫폼 API/계정/토큰 코드는 없습니다. 실제 URL은 공개 HTTP(S) 미디어/HLS 입력이어야 하며 플랫폼 웹페이지 URL을 자동 변환하지 않습니다.

## VOD

`POST /api/vod` multipart video 또는 source_url 중 하나, mode=exact|approximate|auto → HTTP 202 + 기존 broadcast job. GET `/api/broadcasts/{id}`로 단계·구간·결과를 조회합니다. 시간은 HH:MM:SS 또는 초 문자열, 반환 시간은 항상 전체 영상 시작 기준 초입니다.

```bash
curl -X POST http://localhost:8000/api/vod -F video=@vod.mp4 \
  -F mode=exact -F start=04:25:00 -F end=05:10:00 -F role=batter
curl -X POST http://localhost:8000/api/vod -F video=@vod.mp4 \
  -F mode=approximate -F start=04:20:00 -F end=05:30:00 -F buffer_minutes=10
curl -X POST http://localhost:8000/api/vod -F video=@vod.mp4 \
  -F mode=approximate -F center_time=05:00:00 -F search_window_minutes=60
curl -X POST http://localhost:8000/api/vod -F video=@vod.mp4 -F mode=auto
```

EXACT는 사람 확인 구간으로 스캔을 생략합니다. role을 지정하면 그 범위만 기존 엔진으로 넘깁니다. 기본 role=unknown 또는 auto는 확인된 클립에서 자동 역할 추정이며 실패하면 검토를 요청합니다. 예산 때문에 45분 전체를 한 번에 분석하지는 않습니다.

APPROXIMATE의 start/end+10분은 04:10~05:40만 스캔합니다. center_time=05:00/search_window_minutes=60은 전체 폭 60분인 04:30~05:30만 스캔합니다. 중심과 start/end를 동시에 지정하지 마세요. 탐색 범위는 영상 경계로 제한하며 샘플/버퍼 구간도 범위 밖으로 나가지 않습니다. AUTO는 시간 힌트를 받지 않고 전체를 저비용 스캔합니다.

직접 수정한 `segments` JSON을 `/api/vod` 또는 기존 analyze에 전달하면 범위 스캔을 생략합니다. `/api/broadcasts/{id}/segments`는 같은 원본으로 재분석합니다. 역할 전환이 있으면 역할별로 수동 구간을 나눕니다. 자동 역할은 클립마다 pose/움직임/객체 맥락을 조합합니다. VOD 수동 role 힌트는 EXACT에만 적용합니다. 자동 탐지 구간을 힌트만으로 강제 분석하지 않습니다.

설정: sample_interval(5~60초), max_scan_frames(최대10,000), max_analysis_clips(기본20/최대200), clip_seconds(기본10/최대30), player_id. 기본 업로드 한도8GiB/영상24시간. 자세한 저장·병합·버퍼·예산은 BROADCAST_SEGMENTS.md를 참고하세요.

진행: SCAN → BASEBALL_SEGMENT_DETECTION → SEGMENT_EXTRACTION → ROLE_ANALYSIS → POSE_ANALYSIS → SCOUTING_REPORT → COMPLETE. ROLE_ANALYSIS 단계에서 사용할 역할의 선택을 표시하고, 실제 자세 기반 역할 지표 계산은 pose 추출 후 기존 analyze_role이 수행합니다. EXACT는 SCAN을 건너뛰며 검토 구간은 모든 정밀 단계를 건너뜁니다. 여러 클립은 정밀 단계를 반복합니다. timestamp_origin=clip_relative이며 전체 영상 이벤트 시간은 broadcast_offset_seconds를 더합니다.

## LIVE

`POST /api/live` multipart: source_url 또는 video(file replay) 중 정확히 하나, config JSON, 선택 player_id → HTTP 202 session.

```bash
curl -X POST http://localhost:8000/api/live \
  -F source_url=https://YOUR_PUBLIC_STREAM/live.m3u8 \
  -F 'config={"sample_interval":10,"confirmation_seconds":30,"minimum_hits":3,"ending_seconds":240,"role":"unknown"}'
curl http://localhost:8000/api/live/SESSION_UUID
curl -X PATCH http://localhost:8000/api/live/SESSION_UUID/role \
  -H 'Content-Type: application/json' -d '{"role":"batter"}'
curl -X POST http://localhost:8000/api/live/SESSION_UUID/stop
curl -X DELETE http://localhost:8000/api/live/SESSION_UUID
```

파일 리플레이: source_url 대신 `-F video=@short.mp4` (최대100MiB, 실시간 경과속도로 파일을 읽음). 입력 어댑터/상태 검증용이며 실제 라이브 URL 검증과 다릅니다. URL/쿼리 토큰은 응답이나 session JSON에 저장하지 않습니다.

상태는 IDLE → WATCHING → BASEBALL_CANDIDATE → BASEBALL_ANALYZING → BASEBALL_ENDING → REPORT_GENERATING → WATCHING입니다.

- WATCHING: 기본10초(5~10설정) 간격으로 단일 축소 프레임. 장비/필드 맥락이 있을 때만 작은 프레임 pose를 희소 추출하며 최근6개 움직임을 비교합니다. 전체 clip pose/scouting은 미실행.
- CANDIDATE: 다중근거 threshold≥.8의 반복 신호. 기본30초 동안 최소3회, 연속 시퀀스 유지 필요. 한 번 감지/색상만으로 활성화하지 않습니다. 약한 신호는 후보를 리셋합니다. 디코딩 지연 때문에 실제 주기는 설정 간격보다 길 수 있습니다.
- ANALYZING: 야구 활동 확인 상태. 알려진 수동 확인된 야구 클립에서만 짧은 클립을 캡처합니다. 캡처한 실제 클립의 5초 간격+마지막 프레임을 다시 저비용 확인하며 모두 다중근거를 충족해야 기존 분석 엔진에 전달합니다. WATCHING 때의 프레임과 나중 캡처가 다른 경우 일반 방송을 분석하지 않기 위한 차단입니다. 샘플 사이의 프레임을 완벽히 검증하는 분류기는 아닙니다.
- 무신호 유예: 기본240초, 180~600설정. 짧은 화면 전환/휴식은 활동 구간을 유지하지만 무신호 동안 pose/scouting은 실행하지 않습니다. 이후 ENDING/REPORT_GENERATING을 거쳐 WATCHING 복귀합니다.
- REPORT: 실제 엔진에서 생성한 클립 보고서의 참조와 역할 목록을 묶습니다. LIVE 별도 점수 계산은 없습니다. ratings는 기존 정책대로 null입니다.

반복 야구 확인 후 unknown/auto 클립은 제한된 pose로 자동 역할을 추정하며, 근거 부족 시 평가를 보류하고 역할 선택을 요청합니다. config.role/PATCH role은 명시적 사람 힌트이지 모델 역할 추정이 아닙니다. 같은 세션 안에서 역할 힌트를 바꿀 수 있고 구간에 roles[]/analyses[]를 기록합니다. 야구가 다시 시작하면 새로운 구간을 만듭니다. 시작/끝은 세션 경과 초와 날짜 포함 UTC ISO datetime이므로 자정을 넘겨도 구분됩니다.

LIVE 종료는 stop_requested 후 현재 캡처/분석이 제한시간 안에 끝나면 stopped입니다. 파일 EOF/최대 감시시간도 종료합니다. 연속6회 입력 실패는 failed로 종료하며 기존 결과를 유지합니다. max_session_seconds 기본24시간, max_analysis_clips 기본20/최대200. 예산 소진은 partial_budgeted/review_required로 표시합니다. 전체 감시가 전체 구간 정밀 분석을 뜻하지 않습니다.

파일 리플레이 세션 종료 후 `POST /api/live/{id}/segments`에 `{"segments":[{"start":10,"end":20,"role":"batter"}]}`를 전달하면 보관한 파일을 동일 VOD 작업으로 재분석합니다. HTTP 스트림 원본 전체를 녹화하지 않으므로 과거 시간 보정은 녹화 VOD를 업로드해야 합니다. 실시간 PATCH 힌트는 이후 클립에만 적용됩니다.

## 공통 탐지와 운영 한계

SignalDetector/evidence를 공유합니다. 색상 맥락+선택 객체/장면 ONNX+최근 pose 움직임을 조합하며 단일 신호로 시작하지 않습니다. 모델 없이 색상/자세만으로는 검토 후보입니다. 자동 역할은 보수적 휴리스틱입니다. 모델 계약, URL 지원 범위, 실제 검증 한계는 [ENGINE_INPUTS.md](ENGINE_INPUTS.md)가 최신 기준입니다.

단일 worker에서 LIVE1개, VOD1개를 지원하고 정밀 엔진 lock은 공유합니다. 정밀 처리 중 WATCHING이 대기하므로 진정한 무지연 스트리밍/대규모 동시 세션 기능은 아닙니다. 외부 작업 큐/인증/멀티테넌트 보관/자동 재개는 미구현입니다. 프로세스 재시작은 interrupted로 표시합니다. source 및 detector adapter 확장으로 플랫폼/역할/모델을 추가할 수 있습니다.

HTTP(S)만 허용하고 기본 URL의 DNS가 public IP인지 검사합니다. file/local IP/내장 계정 URL은 거부합니다. HLS 내부 URL·리다이렉트·DNS 변화의 네트워크 차단을 완전히 제공하지는 않으므로 공개 배포 전에 egress 제한이 필요합니다. 모델 키나 플랫폼 토큰을 채팅/문서에 넣지 마세요.

data/live/{id}/session.json, 선택 replay source.upload가 남고 임시 active-clip은 삭제합니다. 일반 스트림은 전체 원본을 저장하지 않습니다. 파생 JSON/오버레이는 기존 data 위치에 보관하며 DELETE live는 세션/리플레이만 지웁니다. 모두 Git ignore data/ 대상입니다.

## UI와 검증

/demo/ 유지, /demo/live/ 실시간 상태/최근 confidence/시작/역할/결과 링크/종료, /demo/broadcast/ EXACT/APPROXIMATE/AUTO·범위·중심·타임라인·수정·결과 보기. 끝 슬래시 없는 주소도 StaticFiles redirect로 지원합니다. 결과 링크는 기존 Motion Lab과 Scouting Report를 엽니다.

- 백엔드 pytest **102개 통과**(기존85+새17, 의존성 경고3).
- 기존 시각화/스카우팅/긴 방송 브라우저 회귀 및 test:modes.
- mock 신호 테스트: LIVE 시간 지터/반복확인/짧은 휴식/종료유예/다중구간/weak·캡처 근거 부족 분석 금지/unknown 역할 추정 실패 시 평가 보류/예산.
- 실제 ffmpeg/MediaPipe: 생성 검은 영상의 VOD EXACT 부족 pose, APPROXIMATE 범위스캔→야구 없음→분석 없음, LIVE 파일 WATCHING→분석 없음→종료, 기존 결과 링크와 모바일.
- 화면 live.png/vod.png는 **TEST 생성 빈 영상**이며 실제 외부 라이브나 사람/VR 야구 정확도 증거가 아닙니다.

아직 필요한 실제 검증: 공개 HTTP/HLS URL별 라이브 에지/지연/EOF/장시간 재연결/타임코드 오차, 1~10시간 부하·메모리·디스크·샘플 비용, 사람/VR 야구 vs 다른 콘텐츠의 오탐/누락, 객체 모델 가중치/카메라 시점, 역할 자동 분류, 실제 선수 pose/scouting 정확도. 현재를 검증된 완전자동 서비스로 표시하면 안 됩니다.

현재 UI는 /demo/broadcast/의 LIVE/VOD 탭으로 통합했습니다. /demo/live/는 해당 LIVE 탭 redirect입니다. 결과 링크는 /demo/analysis/{id}이며 UI/최신 검증은 UNIFIED_UI.md를 참고하세요.
