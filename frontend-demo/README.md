# WONY 통합 분석 UI

FastAPI의 /demo/에서 대시보드를 엽니다. 메인 메뉴는 대시보드/방송 분석/분석 기록입니다. LIVE와 VOD는 /demo/broadcast/의 탭이며 결과는 /demo/analysis/{id} 한 페이지에 모읍니다. /demo/analyses/에서 날짜별 실제/DEMO 기록을 조회합니다.

Three.js/OrbitControls는 기존 로컬 vendor를 유지합니다. frontend build/CDN은 필요 없습니다. 기존 역할·2D/3D/keyframe 엔진을 유지하고 5툴 scouting proxy/근거 집계와 촬영 조건 기반 성장 비교를 통합 리포트에 연결했습니다. 원본 미보관 결과의 원본 보기 버튼은 비활성화합니다. [현재 UI 계약](../docs/UNIFIED_UI.md)을 참고하세요.

서버 실행 후 frontend-demo에서 npm --cache /tmp/wony-npm-cache ci. Chromium 환경에서 XDG_CACHE_HOME=/tmp/wony-cache CHROMIUM_PATH=/usr/bin/chromium npm --cache /tmp/wony-npm-cache run test:browser, test:broadcast, test:modes를 실행합니다. test:scouting은 동일 통합 UI 회귀의 alias입니다. 테스트에서 생성된 분석 결과는 data에 남고 Git에서 제외됩니다. docs/screenshots/unified-report.png는 DEMO입니다.

5툴 UI 회귀는 서버 실행 후 `node tests/tools.mjs`. 새 confidence/estimated/raw proxy는 상세에 두고 근거 버튼은 기존 플레이 뷰어를 엽니다. 촬영 조건 입력은 고급 설정의 capture.js를 공유합니다. 자세한 계약은 [SCOUTING_TOOLS.md](../docs/SCOUTING_TOOLS.md).
