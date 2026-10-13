// 채보 품질 확인용 통계 (관리자 미리보기 화면에서 사용). 채보 JSON 만 읽고 아무것도 바꾸지 않는다.
// 자동 생성 규칙(tools/chart_config.py)을 조정할 때 비교하기 쉽도록 같은 기준을 함께 보여준다:
//   minGapMs  = 서로 다른 시각 사이 최소 간격 (chart_config.MIN_GAP_MS 와 비교)
//   maxNpsHits = 1초 구간 안 최대 "입력 시점" 수 (동시치기 = 1, chart_config.RULES.max_nps 와 같은 기준)
//   maxNps     = 1초 구간 안 최대 노트 수 (동시치기의 각 노트를 따로 셈)

export function chartStats(chart, windowMs = 1000) {
  const notes = Array.isArray(chart?.notes) ? chart.notes.filter(n => Number.isFinite(n?.time)) : [];
  const byTime = new Map();
  for (const n of notes) byTime.set(n.time, (byTime.get(n.time) || 0) + 1);
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const sizes = times.map(t => byTime.get(t));

  let minGapMs = null;
  let minGapAt = null;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (minGapMs === null || gap < minGapMs) {
      minGapMs = gap;
      minGapAt = times[i - 1];
    }
  }

  // [t, t + windowMs) 구간을 시각마다 시작점으로 잡아 최대값 (투 포인터)
  let maxNps = 0;
  let maxNpsHits = 0;
  let maxNpsAt = null;
  let j = 0;
  let notesInWindow = 0;
  for (let i = 0; i < times.length; i++) {
    while (j < times.length && times[j] < times[i] + windowMs) notesInWindow += sizes[j++];
    const hits = j - i;
    if (notesInWindow > maxNps) {
      maxNps = notesInWindow;
      maxNpsAt = times[i];
    }
    maxNpsHits = Math.max(maxNpsHits, hits);
    notesInWindow -= sizes[i];
  }

  return {
    notes: notes.length,
    hits: times.length,                          // 입력 시점 수
    chords: sizes.filter(s => s >= 2).length,    // 동시치기 횟수 (2키 이상인 시각)
    chordNotes: sizes.filter(s => s >= 2).reduce((a, b) => a + b, 0),
    triples: sizes.filter(s => s >= 3).length,
    minGapMs,
    minGapAt,
    maxNps,
    maxNpsHits,
    maxNpsAt,
    firstMs: times.length ? times[0] : null,
    lastMs: times.length ? times[times.length - 1] : null,
  };
}

/** 7500 → "0:07.500" */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(Math.round(ms));
  const m = Math.floor(abs / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  return `${sign}${m}:${String(s).padStart(2, '0')}.${String(abs % 1000).padStart(3, '0')}`;
}
