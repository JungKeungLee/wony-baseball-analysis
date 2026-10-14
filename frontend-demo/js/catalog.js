// 곡 목록/채보 불러오기. 게임 시작 전에 한 번만 요청하고, 플레이 중에는 서버를 부르지 않는다.
// songs.json 에 곡을 추가하면(tools/import_song.py) 자동으로 목록에 나타난다 (곡 수 고정 없음).
import { DEFAULT_LANE_COUNT, DIFFICULTIES, LANE_MODE_LABELS, SUPPORTED_LANE_COUNTS } from './config.js';

function normalize(s) {
  return {
    ...s,
    artist: s.artist || 'WONY',
    cover: s.cover || null,
    video: s.video || null,
    difficulties: DIFFICULTIES.filter(d => (s.difficulties || []).includes(d)),
    // 이 곡에 채보가 있는 KEY 모드 (songs.json laneModes, 없으면 4키만)
    laneModes: SUPPORTED_LANE_COUNTS.filter(n => n === DEFAULT_LANE_COUNT || (s.laneModes || []).includes(n)),
  };
}

export function supportsLaneMode(song, laneCount) {
  return Boolean(song?.laneModes?.includes(laneCount));
}

/** 고른 KEY 모드를 이 곡이 지원하지 않을 때 안내 (지원하면 null) */
export function laneModeProblem(song, laneCount) {
  if (!song || supportsLaneMode(song, laneCount)) return null;
  const modes = song.laneModes.map(n => LANE_MODE_LABELS[n]);
  return modes.length === 1 ? `이 곡은 현재 ${modes[0]} 채보만 지원합니다.` : `이 곡은 현재 ${modes.join(' · ')} 채보만 지원합니다.`;
}

export async function loadCatalog() {
  const res = await fetch('/songs/songs.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`곡 목록을 불러오지 못했습니다 (${res.status})`);
  const data = await res.json();
  return (data.songs || []).filter(s => s && s.id && s.title).map(normalize);
}

/** 관리자 미리보기(tools/admin_server.py)의 staging 곡 */
export async function loadPreviewSong(stageId) {
  if (!/^[0-9a-f-]+$/.test(stageId || '')) throw new Error('잘못된 미리보기 ID 입니다');
  const res = await fetch(`/staging/${stageId}/song.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error('미리보기를 찾을 수 없습니다 (이미 저장했거나 취소했을 수 있습니다)');
  return normalize(await res.json());
}

/** 4키 = {id}-{diff}.json (기존), 6/8키 = {id}-{diff}-{n}k.json (tools/song_store.py Paths.chart 와 같은 규칙) */
export function chartUrl(song, difficulty, laneCount = DEFAULT_LANE_COUNT) {
  const key = laneCount === DEFAULT_LANE_COUNT ? difficulty : `${difficulty}-${laneCount}k`;
  return song.charts?.[key] || `/songs/charts/${song.id}-${key}.json`;
}

/**
 * 채보 검증: 요청한 KEY 모드와 채보의 laneCount 가 같아야 하고, 모든 노트가 0 <= lane < laneCount.
 * @returns {string|null} 문제 (없으면 null)
 */
export function chartProblem(chart, laneCount = DEFAULT_LANE_COUNT) {
  if (!chart || !Array.isArray(chart.notes) || !chart.notes.length) return '채보 준비 중';
  const chartLanes = chart.laneCount ?? DEFAULT_LANE_COUNT;
  if (chartLanes !== laneCount) return `${LANE_MODE_LABELS[laneCount] || laneCount} 채보가 아닙니다 (채보 ${chartLanes}키).`;
  if (chart.notes.some(n => !Number.isInteger(n.lane) || n.lane < 0 || n.lane >= laneCount || !Number.isFinite(n.time))) {
    return '채보에 잘못된 노트가 있습니다.';
  }
  return null;
}

export async function loadChart(song, difficulty, laneCount = DEFAULT_LANE_COUNT) {
  if (!song.difficulties.includes(difficulty)) throw new Error('채보 준비 중');
  const modeProblem = laneModeProblem(song, laneCount);
  if (modeProblem) throw new Error(modeProblem);
  const res = await fetch(chartUrl(song, difficulty, laneCount), { cache: 'no-cache' });
  if (!res.ok) throw new Error('채보 준비 중');
  const chart = await res.json();
  const problem = chartProblem(chart, laneCount);
  if (problem) throw new Error(problem);
  return chart;
}

export function findSong(catalog, id) {
  return catalog.find(s => s.id === id) || catalog[0] || null;
}

export function pickDifficulty(song, wanted) {
  if (song?.difficulties.includes(wanted)) return wanted;
  return song?.difficulties.includes('normal') ? 'normal' : song?.difficulties[0];
}
