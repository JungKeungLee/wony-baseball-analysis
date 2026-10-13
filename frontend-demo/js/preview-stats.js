// 관리자 미리보기용 채보 통계 표 (곡 추가 화면 + 게임 미리보기 화면에서 같이 사용)
import { DIFFICULTIES, DIFFICULTY_LABELS } from './config.js';
import { chartStats, formatMs } from './chart-stats.js';

/** 곡 하나의 4개 난이도 채보를 불러와 통계 계산. 없는 난이도는 null. */
export async function loadChartStats(chartUrls) {
  const entries = await Promise.all(DIFFICULTIES.map(async d => {
    if (!chartUrls[d]) return [d, null];
    try {
      const res = await fetch(chartUrls[d], { cache: 'no-store' });
      return [d, res.ok ? chartStats(await res.json()) : null];
    } catch {
      return [d, null];
    }
  }));
  return Object.fromEntries(entries);
}

const ROWS = [
  ['총 노트 수', s => s.notes.toLocaleString('ko-KR')],
  ['동시치기 수', s => `${s.chords}${s.triples ? ` (3키 ${s.triples})` : ''}`],
  ['가장 짧은 간격', s => (s.minGapMs == null ? '-' : `${s.minGapMs}ms`), s => (s.minGapAt == null ? '' : `@ ${formatMs(s.minGapAt)}`)],
  ['초당 최대 노트', s => `${s.maxNps} (입력 ${s.maxNpsHits})`, s => (s.maxNpsAt == null ? '' : `@ ${formatMs(s.maxNpsAt)}`)],
  ['첫 노트', s => formatMs(s.firstMs)],
  ['마지막 노트', s => formatMs(s.lastMs)],
];

/**
 * @param {Record<string, object|null>} stats  loadChartStats 결과
 * @param {{bpm?, musicStartMs?, musicEndMs?, durationMs?}} analysis  stage.json 의 분석 요약
 */
export function renderStatsTable(stats, analysis = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-stats';
  const summary = document.createElement('dl');
  summary.className = 'chart-stats-summary';
  for (const [label, value] of [
    ['감지 BPM', analysis.bpm ?? '-'],
    ['음악 시작', formatMs(analysis.musicStartMs)],
    ['음악 종료', formatMs(analysis.musicEndMs)],
    ['영상 길이', formatMs(analysis.durationMs)],
  ]) {
    const item = document.createElement('div');
    item.innerHTML = '<dt></dt><dd></dd>';
    item.querySelector('dt').textContent = label;
    item.querySelector('dd').textContent = String(value);
    summary.append(item);
  }

  const scroller = document.createElement('div');
  scroller.className = 'chart-stats-scroll';
  const table = document.createElement('table');
  table.className = 'chart-stats-table';
  const head = table.createTHead().insertRow();
  head.append(Object.assign(document.createElement('th'), { scope: 'col', textContent: '' }));
  for (const d of DIFFICULTIES) {
    const th = document.createElement('th');
    th.scope = 'col';
    const badge = Object.assign(document.createElement('span'), { className: 'badge', textContent: DIFFICULTY_LABELS[d] });
    badge.dataset.diff = d;
    th.append(badge);
    head.append(th);
  }
  const body = table.createTBody();
  for (const [label, value, sub] of ROWS) {
    const row = body.insertRow();
    row.append(Object.assign(document.createElement('th'), { scope: 'row', textContent: label }));
    for (const d of DIFFICULTIES) {
      const cell = row.insertCell();
      const s = stats[d];
      cell.textContent = s ? value(s) : '없음';
      if (s && sub && sub(s)) cell.append(Object.assign(document.createElement('small'), { textContent: sub(s) }));
    }
  }
  scroller.append(table);
  const note = document.createElement('p');
  note.className = 'chart-stats-note';
  note.textContent = '간격·초당 최대 입력은 tools/chart_config.py 의 MIN_GAP_MS / max_nps 와 같은 기준 (동시치기 = 1회 입력)';
  wrap.append(summary, scroller, note);
  return wrap;
}
