# 시각화 화면 캡처

모든 PNG는 Chromium에서 독립 `/demo/` 화면을 실제 렌더링해 캡처했습니다.

- batter-front.png: 타자 합성 샘플, 정면 3D 시점과 스윙 시작 후보
- batter-side.png: 동일 샘플의 측면 3D 시점
- pitcher.png: 투수 합성 샘플과 릴리스 후보
- defense.png: 수비 합성 샘플과 동작 후보
- catcher.png: 포수 합성 샘플과 동작 후보

**합성 데모이며 실제 야구/VR 영상 분석 결과가 아닙니다.** Three.js·2D 영상·프레임 이동 화면 확인 용도입니다. `frontend-demo/tests/browser.mjs`로 다시 생성할 수 있습니다.

- scouting-report.png: Scouting Report 탭, 점수 보류, 플레이 프레임 연결, DEMO 성장 예시. `tests/scouting.mjs`로 생성했습니다. 실제 선수 평가가 아닙니다.

- broadcast.png: 긴 방송 분석 타임라인 DEMO. 10시간/91%는 임의 예시이며 실제 방송 탐지 결과가 아닙니다.

- live.png / vod.png: LIVE/VOD 대시보드 TEST. 생성 검은 영상으로 검증했으며 실제 방송 또는 야구 탐지 정확도 증거가 아닙니다.

- unified-report.png: 현재 통합 리포트·역할 탭·플레이 내 3D 전환. DEMO 합성 관절이며 실제 선수 평가가 아닙니다. 이전 Motion Lab/Scouting Report PNG는 과거 UI 기록입니다.
