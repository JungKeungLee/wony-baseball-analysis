// 결과 화면 순위 변화 문구 · 연출. describeRankChange 는 DOM 없는 순수 함수 (테스트 대상).
export const RANK_ANIMATION_MS = 1100;   // 0.8~1.5초 사이
export const CHURU_ANIMATION_MS = 900;
const MEDALS = Object.freeze({ 1: '🥇', 2: '🥈', 3: '🥉' });

const isRank = v => Number.isInteger(v) && v > 0;

/**
 * @param {{rankBefore?: number|null, rankAfter?: number|null, totalRanked?: number|null, improvedScore?: boolean, duplicate?: boolean}} r
 * @returns {null | {kind: 'first'|'up'|'same'|'down'|'recorded', from: number|null, to: number, delta: number,
 *                   transition: string, change: string, medal: string, badges: string[]}}
 *   kind: first = 첫 랭킹 진입, up = 상승, same = 유지, down = 하락(동시 저장 등 드문 경우), recorded = 이미 반영된 판(재전송)
 */
export function describeRankChange({ rankBefore = null, rankAfter = null, totalRanked = null, improvedScore = false, duplicate = false } = {}) {
  if (!isRank(rankAfter)) return null;
  const from = isRank(rankBefore) ? rankBefore : null;
  const to = rankAfter;
  const medal = MEDALS[to] || '';
  const of = isRank(totalRanked) ? ` / ${totalRanked}명` : '';
  if (duplicate) {
    return { kind: 'recorded', from: null, to, delta: 0, transition: `${to}위${of}`, change: '이미 반영된 기록입니다', medal, badges: [] };
  }
  const badges = [];
  if (from === null) badges.push('첫 랭킹 진입!');
  if (to <= 10 && (from === null || from > 10)) badges.push('🎉 TOP 10 진입!');
  if (to === 1 && from !== 1) badges.push('👑 1위 달성!');
  if (from === null) {
    return { kind: 'first', from, to, delta: 0, transition: `${to}위${of}`, change: '', medal, badges };
  }
  const delta = from - to;
  if (delta > 0) {
    return { kind: 'up', from, to, delta, transition: `${from}위 → ${to}위`, change: `▲ ${delta}단계 상승!`, medal, badges };
  }
  if (delta === 0) {
    if (improvedScore) badges.unshift('새 최고 점수!');
    return { kind: 'same', from, to, delta, transition: `${to}위`, change: '순위 유지', medal, badges };
  }
  return { kind: 'down', from, to, delta, transition: `${from}위 → ${to}위`, change: `▼ ${-delta}단계`, medal, badges };
}

const easeOut = x => 1 - (1 - x) ** 3;

/**
 * 숫자를 from → to 로 바꾸며 보여줌. 동작 줄이기(reduced motion)면 바로 최종값.
 * @returns {Promise<void>} 끝나면 resolve (취소 신호 isCancelled() 가 true 면 바로 최종값)
 */
export function animateNumber(el, from, to, { duration = RANK_ANIMATION_MS, reducedMotion = false, format = String, isCancelled = () => false } = {}) {
  if (reducedMotion || from === to || !Number.isFinite(from) || typeof requestAnimationFrame !== 'function') {
    el.textContent = format(to);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const start = performance.now();
    const step = now => {
      const p = Math.min(1, (now - start) / duration);
      if (isCancelled() || p >= 1) {
        el.textContent = format(to);
        resolve();
        return;
      }
      el.textContent = format(Math.round(from + (to - from) * easeOut(p)));
      requestAnimationFrame(step);
    };
    el.textContent = format(from);
    requestAnimationFrame(step);
  });
}
