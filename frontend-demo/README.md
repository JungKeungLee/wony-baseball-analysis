# WONY 통합 분석 UI

FastAPI의 /demo/에서 대시보드를 엽니다. 메인 메뉴는 대시보드/방송 분석/분석 기록입니다. LIVE와 VOD는 /demo/broadcast/의 탭이며 결과는 /demo/analysis/{id} 한 페이지에 모읍니다. /demo/analyses/에서 날짜별 실제/DEMO 기록을 조회합니다.

Three.js/OrbitControls는 기존 로컬 vendor를 유지합니다. frontend build/CDN은 필요 없습니다. 역할·scouting·2D/3D/keyframe/성장 비교의 계산은 기존 엔진 그대로입니다. 원본 미보관 결과의 원본 보기 버튼은 비활성화합니다. [현재 UI 계약](../docs/UNIFIED_UI.md)을 참고하세요.

서버 실행 후 frontend-demo에서 npm --cache /tmp/wony-npm-cache ci. Chromium 환경에서 XDG_CACHE_HOME=/tmp/wony-cache CHROMIUM_PATH=/usr/bin/chromium npm --cache /tmp/wony-npm-cache run test:browser, test:broadcast, test:modes를 실행합니다. test:scouting은 동일 통합 UI 회귀의 alias입니다. 테스트에서 생성된 분석 결과는 data에 남고 Git에서 제외됩니다. docs/screenshots/unified-report.png는 DEMO입니다.
