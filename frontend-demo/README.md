# WONY Motion Lab — 독립 시각화 데모

FastAPI 서버를 실행하고 같은 서버의 `/demo/` 화면을 여세요. 별도 프론트 빌드는 필요 없습니다. Three.js 0.174.0과 OrbitControls를 `vendor/`에 포함했으며 CDN 연결 없이 실행됩니다. 라이선스는 `vendor/THREE-LICENSE.txt`에 있습니다.

1. 타자/수비/포수/투수/주루 역할을 선택합니다.
2. 영상 선택 → 영상 분석 또는 합성 데모 보기를 누릅니다.
3. 2D 오버레이와 3D 상대 포즈를 같은 프레임에서 확인합니다.
4. 재생/일시 정지, 슬라이더, 단계별 썸네일, front/side/rear, 드래그 회전을 사용합니다.
5. 결과 JSON 링크로 분석과 visualization 데이터를 내려받습니다.

합성 데모는 사람이 아닌 생성한 도형/관절 시퀀스이며 MediaPipe를 실행하지 않습니다. 화면 캡처는 실제 야구/VR 영상의 정확도 증거가 아닙니다. 영상 업로드 경로에서는 ffmpeg/OpenCV/MediaPipe를 실제 실행합니다. 포즈가 없으면 2D 영상만 보이고 3D/단계는 미검출로 표시됩니다.

앞발 착지와 임팩트는 실제 검출하지 않습니다. 미확인 참고 프레임으로 표시하고 confidence=0을 유지합니다. 나머지 동작 단계도 휴리스틱 후보입니다. 3D는 미보정 상대 z를 시각화하며 confidence≤0.35, estimated=true입니다. WebGL이 없는 환경에서는 2D와 JSON을 사용할 수 있습니다.

## 브라우저 검증과 캡처

서버 실행 상태에서 Node.js와 Chromium이 필요합니다:

```bash
cd /workspace/wony-baseball-analysis/frontend-demo
npm --cache /tmp/wony-npm-cache ci
XDG_CACHE_HOME=/tmp/wony-cache CHROMIUM_PATH=/usr/bin/chromium \
  npm --cache /tmp/wony-npm-cache run test:browser
```

다른 서버 주소는 `WONY_BASE_URL`로 지정할 수 있습니다. 브라우저 테스트는 4개 역할의 합성 데모, Three.js 렌더링, 시점 변경/회전, 재생/일시정지, 슬라이더/키프레임, 참고 프레임 라벨, 실제 빈 영상 업로드, 반응형 레이아웃과 JS 오류를 검사합니다. 화면 캡처를 `docs/screenshots/`에 저장합니다. 테스트 과정에서 생성한 분석 결과와 시각화 파일은 backend/data에 남으므로 필요에 따라 삭제하세요.

캐릭터형 3D 모델, WONY PHONE 연동은 구현하지 않았습니다.


## Scouting Report

선수 ID·분석 날짜·동일 촬영 조건을 입력하고 분석한 뒤 Scouting Report 탭을 선택하세요. 역할별 관찰 지표, 점수 보류 사유, 플레이별 2D/3D 이동, 선수 최신 역할별 종합 및 과거 기록 조회를 지원합니다. 검증된 채점 기준이 없어 점수는 null입니다. 성장 추적은 조건이 맞는 관찰값의 차이이며 기량 향상 판정이 아닙니다. DEMO 성장 예시는 임의 점수로 실제 기록과 분리합니다.

신규 브라우저 검증: 위 설치 후 `XDG_CACHE_HOME=/tmp/wony-cache CHROMIUM_PATH=/usr/bin/chromium npm --cache /tmp/wony-npm-cache run test:scouting`. 리포트 탭/플레이 점프/선수 기록/주루/DEMO 구분과 모바일 레이아웃을 확인하고 scouting-report.png를 저장합니다.
