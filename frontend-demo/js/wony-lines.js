// 워니 안내 말풍선 문구 · 이미지 (여기만 고치면 됨. 화면 코드 · 레이아웃은 수정 불필요)
//
// 이미지: frontend-demo/assets/wony/wony.png (지금은 임시 이미지).
//   실제 워니 이미지는 같은 이름의 PNG(투명 배경 권장, 정사각형 512×512 정도)로 파일만 바꾸면 된다.
//   화면에서는 정사각형 영역에 비율을 유지해 맞춰 넣는다.
export const WONY_IMAGE = '/assets/wony/wony.png';
export const WONY_ALT = '워니';

// 문구: 상황마다 여러 개 중 하나를 고른다. {name} = 닉네임
export const WONY_LINES = Object.freeze({
  home: [
    '{name}님, 오늘도 리듬 타러 왔어요? 🎵',
    '처음이라면 EASY 부터! LIFE 가 10개예요.',
    '10콤보마다 LIFE 가 0.5씩 회복돼요.',
    '정상 CLEAR 하면 츄르를 받을 수 있어요 🐟',
  ],
  result: {
    CLEAR: ['CLEAR! 멋졌어요 ✨', '끝까지 해냈어요! 다음 판도 가 볼까요?'],
    GAME_OVER: ['아쉬워요! 한 번 더 해봐요 💪', 'EASY 로 손을 풀어도 좋아요.'],
    NO_FAIL_CLEAR: ['NO FAIL 로 끝까지 연습했어요. 다음엔 그냥 CLEAR 도전!'],
    autoplay: ['자동 플레이로 채보를 확인했어요.'],
    rankUp: ['순위가 올랐어요! 🎉'],
    firstRank: ['랭킹에 이름을 올렸어요! 🏆'],
    newBest: ['새 최고 기록이에요!'],
  },
});

/** 문구 고르기 (seed 를 주면 항상 같은 문구 → 테스트 · 새로고침 시 흔들림 없음) */
export function pickLine(lines, { seed = Math.random(), name = '' } = {}) {
  const list = Array.isArray(lines) && lines.length ? lines : [''];
  const line = list[Math.floor(Math.abs(seed) * list.length) % list.length];
  return line.replaceAll('{name}', name || 'WONY');
}
