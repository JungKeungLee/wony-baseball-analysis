# VOD URL·자동 역할·LIVE 복합 탐지

최신 단순화 UI와 LIVE/VOD 공통 `segments/execution.py → analysis/engine.py`를 유지합니다. 학습·보정된 정확도나 실제 야구/VR 검증 완료를 의미하지 않습니다.

## VOD URL

`POST /api/vod` multipart에서 `video` 또는 `source_url` 중 정확히 하나를 보냅니다. 기존 파일 요청과 결과 조회/수정 API를 유지하며 시작 응답은 HTTP 202입니다.

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/vod `
  -F "source_url=https://MEDIA_HOST/archive.mp4" `
  -F "mode=approximate" -F "center_time=05:00:00" `
  -F "search_window_minutes=60" -F "role=auto"
```

이 예시는 04:30~05:30만 샘플링합니다. start/end+buffer_minutes와 EXACT/AUTO도 파일과 동일합니다. 탐지된 확인 구간의 core 안에서만 최대 클립 예산에 따라 정밀 분석합니다.

지원: 공개 HTTP(S) 직접 `.mp4`, 종료된 `.m3u8` HLS VOD, 쿼리 토큰, 검증 가능한 리다이렉트·상대 playlist/segment/key URI. HLS master playlist도 하위 URI를 재작성하며 최종 media playlist에는 ENDLIST가 필요합니다. 정상 byte-range를 지원하는 MP4 호스트와 faststart 파일을 권장합니다. HTTP/네트워크 timeout 및 1요청 기본128MiB 제한을 초과하면 실패할 수 있습니다. `WONY_REMOTE_REQUEST_MAX_BYTES`로 상한을 설정합니다. 각 sample은 최대25초, capture는 최대90초, probe는 최대30초입니다.

미지원: SOOP/YouTube 등 플랫폼 시청 페이지, DRM, 로그인 쿠키/임의 인증 헤더가 필요한 영상, 종료되지 않은 HLS의 VOD 처리, 확장자 없는 직접 URL. 해당 페이지를 HTML 영상으로 오인하지 않고 422를 반환합니다. `source/providers/base.py`의 supports/resolve를 구현하는 adapter를 등록할 수 있으나 SOOP adapter는 아직 없습니다.

`direct_video.py`/`hls.py`는 같은 검증 HTTP gateway와 FileSource의 seek/capture를 재사용합니다. 전체 VOD를 내려받아 정밀 분석하지 않습니다. HLS 재생목록·MP4 메타데이터·키프레임 접근으로 선택 범위 밖의 네트워크 바이트 일부를 읽을 수는 있습니다. MP4 서버가 Range를 무시하면 장시간 파일을 순차 다운로드하는 대신 seek를 거부/예산 제한합니다. 서버의 인덱스/세그먼트 길이 때문에 네트워크 전송량과 정확한 프레임 탐색 비용은 실제 CDN에서 검증해야 합니다.

리다이렉트와 HLS URI는 매번 public IP 여부를 검사하고 연결 IP를 고정합니다. TLS 인증서 검사와 원래 hostname/SNI를 유지합니다. 내부 주소·자격증명 포함 URL·비HTTP 프로토콜은 거부합니다. URL/토큰은 응답에 노출하지 않고 작업 폴더의 `remote.json`에 보관합니다. 작업 디렉터리에 OS 접근 제한을 적용하고 보관 기간을 관리하세요. 운영 egress 제한도 권장합니다. 기존 API에는 사용자 인증/격리가 없으므로 그대로 공개 서비스에 노출하지 마세요.

URL 작업은 전체 원본을 저장하지 않습니다. 실제 처리한 클립만 H.264 `original.mp4`로 결과 assets에 저장하여 통합 리포트 원본/2D/3D를 유지합니다. `source_start=0`과 방송 기준 start를 구분합니다. 구간 수정 시 URL을 다시 사용하므로 만료된 URL은 재업로드/새 작업이 필요합니다. 작업 DELETE는 기존처럼 파생 결과까지 삭제하지 않습니다.

## 자동 역할

`analysis/shared/role_classifier.py`를 모든 입력에서 재사용합니다. 단일 분석은 `role=auto`, LIVE/VOD는 `role=auto` 또는 기존 `unknown`이 자동 역할 힌트입니다. 수동 역할은 유지됩니다. 수동 segments에서도 auto를 unknown으로 정규화합니다.

유효 pose 최소5개·0.4초 이상의 시퀀스에서 손 사이 거리, 손목 궤적, 머리 위 손 위치, 무릎 굽힘, 좌우 다리 높이, 골반 이동, 발목 교대 움직임을 조합합니다. 클립의 배트/글러브 장면 근거는 가설 confidence를 보완합니다. 후보는 batter/defense/catcher/pitcher/baserunning이며 confidence≥0.70, 1·2위 차이≥0.15, 충분한 visibility를 만족해야 선택합니다. 그 외 unknown이며 scouting 평가를 만들지 않습니다. 모두 estimated=true이며 role_estimate와 role_candidates를 제공합니다. confidence는 휴리스틱이지 보정된 확률이 아닙니다.

카메라 이동, 다중 인물, 가려짐, 운동/댄스와 유사한 동작, VR 애니메이션에서 오탐·누락 가능성이 있습니다. 내야/외야 자동 판별, 실제 접촉/성공 여부는 여전히 지원하지 않습니다. 역할은 클립별로 추정하고 role_segments로 반환합니다. 구간 내 여러 역할이면 대표 role은 unknown을 유지할 수 있으나 실패를 뜻하지 않습니다. UI는 실제 역할 추정 실패의 role_selection_required일 때만 선택창을 표시합니다.

## LIVE 탐지

WATCHING에서는 5~10초 간격 작은 프레임만 봅니다. 객체/필드 맥락이 있을 때만 작은 이미지 한 장의 MediaPipe pose를 수행하고 최근6개를 비교합니다. 설치에 포함된 pose 모델을 재사용하며 런타임 모델 다운로드는 하지 않습니다. 전체 clip pose/시각화/scouting은 이 단계에서 실행하지 않습니다.

선택 모델 설정:

- `WONY_SEGMENT_ONNX`: 로컬 YOLOv8 COCO raw ONNX `[1,84,N]`, RGB letterbox640, 4 box + 80 class confidence. bat34, glove35, sports ball32. 공은 야구공으로 확정하지 않습니다.
- `WONY_SCENE_ONNX`: 별도로 학습/검증한 YOLO 형식 `[1,7,N]`, RGB letterbox640, 4 box + field/baseball_ui/scoreboard 세 class. 일반 COCO 모델을 이 변수에 넣지 마세요.

모델 가중치는 저장소에 포함하지 않으며 자동 다운로드하지 않습니다. Windows 예시: `$env:WONY_SEGMENT_ONNX = "C:\models\yolov8n-coco.onnx"` 설정 후 서버를 재시작합니다. 객체·장면 모델 모두 없으면 색상/자세만으로 야구를 확정하지 않고 검토 후보로 남깁니다. 따라서 기본 설치만으로 실제 방송 완전자동 탐지가 검증된 상태는 아닙니다.

허용 조합: 기존 bat+glove+field, 또는 temporal baseball posture/motion+bat/glove+field/UI, 또는 학습된 field+baseball UI/scoreboard+temporal motion. 객체≥0.8, 동작≥0.7, 색상 맥락≥0.25 또는 UI≥0.8 조건을 사용합니다. 최종 confidence도 config.threshold(기본0.8)를 넘어야 합니다. 색상·공·자세·스코어보드 하나로 시작하지 않습니다.

시작은 기본30초 반복 감지/최소3hit, 종료는 기본240초 무신호(설정180~600초)입니다. 휴식 중에는 상세 분석하지 않습니다. 확인 후 캡처한 클립도 재검사합니다. 자동 역할 실패는 검토 요청으로 남기고 획득/역할 추정 시도도 클립 예산에 포함합니다. LIVE/VOD는 같은 역할 엔진·시각화·scouting을 사용합니다.

## 검증 범위

생성 MP4/HLS HTTP fixture로 ffprobe, 범위 스캔, seek/capture, URL→분석→리포트→원본/2D/3D 자산, 재조회·시간 보정 재분석을 검증합니다. 합성 pose/모델 출력으로 다섯 역할·단일 신호 차단·복합 신호·DNS pinning·private redirect 차단을 검증합니다. 합성 fixture는 실제 정확도 증거가 아닙니다.

실제 SOOP 입력 해석, signed CDN URL 만료, master playlist/fMP4/AES 키 조합, 다중 카메라·다중 인물·VR pose, 오탐/누락 및 1~10시간 부하는 별도 실제 영상 검증이 필요합니다.

현재 Codex 환경에서 공개 HTTPS MP4의 외부 접속도 시도했지만 대상 호스트 DNS 해석이 실패했습니다. 따라서 외부 CDN/TLS 종단 간 성공을 주장하지 않습니다. 생성 HTTP fixture의 실제 ffmpeg/API 흐름과 IP pinning/SNI 구성 검증이 통과한 범위입니다.
