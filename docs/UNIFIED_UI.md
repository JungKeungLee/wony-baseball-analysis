# 통합 분석 리포트 UI

메인 내비게이션은 대시보드 / 방송 분석 / 분석 기록 세 항목입니다. 역할 분석·스카우팅·2D/3D를 별도 메인 메뉴로 노출하지 않습니다.

| 주소 | 기능 |
| --- | --- |
| /demo/ | 대시보드, 최근 분석, 짧은 영상/DEMO 생성 후 통합 리포트 이동 |
| /demo/broadcast/ | LIVE/VOD 탭, 기존 입력/구간 탐색/수정 기능 |
| /demo/analyses/ | 날짜별 기록, 실제/DEMO 분리, 리포트 링크 |
| /demo/analysis/{id} | 종합/타격/수비/포수/투수/주루 탭 및 플레이별 원본/2D/3D |

끝 슬래시 없는 static 페이지는 자동 redirect합니다. 이전 /demo/live는 방송 분석의 LIVE 탭으로, /demo/?analysis_id=...는 통합 리포트로 이동합니다. 이전 Motion Lab/Scouting Report 탭을 제거했으며 과거 설명 문서와 PNG는 당시 버전 기록입니다.

## 결과 구성

분석 엔진/metrics/scouting/pose/keyframe/event/성장 비교 계산은 변경하지 않습니다. 새 api/reports.py는 저장 결과를 읽는 UI용 adapter입니다. 단일 analysis UUID뿐 아니라 VOD job/LIVE session UUID도 리포트로 조회합니다. 세션에 여러 역할의 분석 클립이 있으면 한 리포트에서 보여줍니다. 구성원 원본 결과는 기존 /api/analysis/{id}로 그대로 조회합니다.

- 종합: 날짜, 야구 후보 구간, 실제 처리한 클립 시간/개수, 포함 역할, 요약, 주요 강점/개선점, 이전 분석 대비 관찰값, 플레이 목록.
- 역할: 해당 역할 클립의 summary, 주요 관찰 지표 최대8개, 나머지 지표 펼치기, 강점/약점/코칭, confidence, 플레이 목록. 데이터 없는 탭은 disabled + 분석 기록 없음 설명.
- 플레이: 후보 시각 + 해당 클립의 원본/2D/3D 전환, 재생/프레임/회전/시점/키프레임/각도/국소 코칭/신뢰도. 영상 전체 장단점을 플레이 장단점으로 복제하지 않습니다. 이벤트가 없으면 '클립 관찰'이며 새로운 이벤트를 만들지 않습니다.
- 성장: 현재 리포트 구성원의 선수 이력과 연결해 이전 비교 조건/보류 이유를 표시합니다. 실제/DEMO source는 분리하며 기존 confidence/조건 비교 정책을 유지합니다. 공식 점수는 계속 null입니다.

타임라인의 방송 구간은 근거 후보이고 모든 구간이 정밀 분석된 것은 아닙니다. 기록 목록 시간은 **실제 처리 클립** 합계이며 48분 후보를 48분 분석했다고 표시하지 않습니다. LIVE 시각은 기존 세션 경과 초, VOD는 전체 영상 초이며 표시 HH:MM:SS를 사용합니다.

원본은 VOD 작업 또는 파일 리플레이에 source.upload가 남아 있을 때만 제공합니다. 단일 업로드 분석은 기존 처리 후 원본 삭제 정책을 유지하므로 원본 버튼을 비활성화합니다. overlay를 원본이라고 표시하지 않습니다. 외부 LIVE URL의 원본 전체도 보관하지 않습니다. 3D는 여전히 미보정 추정, 경고색과 평가에 대한 기존 confidence 제한을 유지합니다.

## 읽기 전용 API

- GET /api/reports?source=real|demo&offset=0&limit=30: 목록/총개수/페이지. 기본 실제 source. 같은 방송에 포함된 클립을 목록에 중복 노출하지 않음.
- GET /api/reports/{uuid}: kind/date/entries(원본 analysis+start/end/source URL)/segments.
- GET /api/reports/{uuid}/source: 보관한 방송/리플레이 원본, 없으면404.

분석 결과가 없는 방송 작업은 기록 목록에 리포트로 포함하지 않습니다. 저장된 JSON을 읽는 로컬 MVP 방식이며 대규모 목록에는 DB/index가 필요합니다. 인증/보관 정책은 기존 한계를 유지합니다.

## 파일과 검증

추가: backend/app/api/reports.py, backend/tests/test_reports.py; frontend-demo/analysis.html/report.js/dashboard.js/records.js/broadcast-tabs.js/analyses/index.html/tests/unified.mjs.
수정: app/main.py의 UI route, 대시보드 index, 방송 페이지와 결과 링크, CSS, 기존 브라우저 테스트/문서. 기존 app.js의 별도 Motion Lab/Scouting Report 화면 구현은 제거하고 report.js 안의 한 플레이 시각화로 재사용했습니다. 분석 엔진 모듈에는 이번 UI 변경을 하지 않았습니다.

백엔드105개 통과(기존102+조회/그룹/route3). test:browser는 통합 페이지/다섯 역할/없는 역할 disabled/재생/3D/camera/keyframe/성장/기록/메뉴3개/legacy redirect/모바일을 확인합니다. test:scouting은 같은 통합 회귀의 alias입니다. test:broadcast/test:modes는 실제 ffmpeg 빈 영상 입력과 통합 리포트 링크/원본 보기/수정 재분석/LIVE·VOD를 확인합니다. 기존 분석 정확도나 실제 방송 탐지 정확도가 새로 검증된 것은 아닙니다.

unified-report.png는 DEMO 합성 관절이며 실제 선수 분석이 아닙니다. 대시보드/기록 캡처는 로컬 저장된 테스트 데이터를 포함할 수 있습니다.
