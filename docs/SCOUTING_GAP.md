# 5툴 GAP 분석 — 구현 전 코드 기준

분석 기준: `analysis/{batter,defense,catcher,pitcher,baserunning}/analyzer.py`, `analysis/shared/fielding.py`, `scouting/report.py`, `scouting/growth.py`, `frontend-demo/report.js`. 기존 다섯 역할 엔진을 유지하고 계산 가능한 관찰을 scouting layer에 연결합니다.

| 항목 | 현재 가능 여부 | 현재 근거 | 부족한 데이터 | 구현 가능성 |
|---|---|---|---|---|
| CONTACT | partial | swing 후보, 머리 이동, 손 중심 궤적 | 실제 ball/bat 접촉·헛스윙 | 관련 움직임 안정성/반복 손 궤적만 가능 |
| POWER | partial | hip/shoulder 2D 선 변화, 골반 이동 | 실제 축 회전·배트/타구 속도·힘 | 2D separation, 손 속도/가속도 proxy 가능 |
| SPEED | partial | 주루 자세·첫 이동 후보 | 거리 calibration·주자/베이스 추적 | 영상 평면 이동/보폭/주기 proxy 가능 |
| FIELDING | partial | 첫 이동, 발목 이동, 중심, 비송구 손목 | 타구 궤적·실제 포구·필드 방향 | 범위/중심 제어 관찰 요약 가능 |
| ARM | partial | 투수 arm/elbow/shoulder, 손목 릴리스 후보 | 실제 공 릴리스·구속·포구→송구 이벤트 | 손목 궤적/속도·관절 mechanics만 가능 |
| REACTION | not_supported | 첫 이동 시각은 별도 계산 | 반응 자극 시각 | 자극 검출 전 실제 반응 시간 불가 |
| BALANCE | yes/partial | 영상 평면 골반과 양발 중심 오프셋 | 카메라 이동·압력 중심 | 구간 중심 변동/관찰 가능 |
| FOOTWORK | partial | 발목 누적 이동 | 발 접촉·실제 스텝·필드 좌표 | 발목 궤적/주기 관찰 가능 |
| BASERUNNING | partial | 자세·이동 후보 | 경기 상황·베이스·타주자 | 자세/주기/영상 방향만 가능 |
| CATCHING | partial | 무릎/높이/손목 이동/일어남 | 공/미트·포구 성공·실제 프레이밍 | 포구/블로킹 자세 proxy만 가능 |
| TIMING | not_supported | 손 움직임 후보 시각 | 공 도착/접촉 시각 | 후보 timestamp와 실제 타이밍 분리 |
| SWING CONSISTENCY | unimplemented | 단일 스윙 후보 | 조건이 같은 복수 플레이 | 후보 주변 손 궤적의 반복성 비교 가능 |

## 구분

- 기존 계산 가능: 2D 관절 각도, 골반/머리 이동, 자세 폭, 첫 이동 후보, 손목 대리 미트 이동, 발목 누적 이동. UI는 일부 주요 값만 표시하고 나머지는 상세/JSON에 있다.
- 이번에 필요한 새 계산: separation/손 속도·가속도/중심 변동/범위/보폭·주기 및 복수 후보의 궤적 반복성. 5툴 상태·근거 연결·툴별 성장 비교도 기존에는 없다.
- 미구현: ball/bat contact, 실제 glove catch, stimulus reaction, 타구 추적, 베이스 접근/슬라이딩/판단, 실제 송구 전환·release consistency, 상대평가 점수 기준.
- 보정/추가 근거 없이 생성 금지: mph/kmh, exit velocity, 비거리, 60야드·베이스 주파시간, 실제 힘·발 압력. 보정된 영상의 거리/FPS/추적 또는 측정 장비/UI 실제 수치가 있으면 일부 속도를 추정할 수 있으나 현재 구현에는 없다. 힘·압력은 pose만으로 측정하지 않는다.
- VR의 2D 회전선·손/발 속도·주기·골반 이동은 아바타 애니메이션 proxy일 수 있다. 실제 신체 힘 전달로 해석하지 않는다.
- 점수/등급/BEST TOOL/PLAY STYLE은 검증된 비교 기준이 없으면 null. 상태와 단위 있는 proxy를 성과 점수로 바꾸지 않는다.

구현 후 계약과 검증 결과는 SCOUTING_TOOLS.md와 HANDOFF.md를 참고한다.
