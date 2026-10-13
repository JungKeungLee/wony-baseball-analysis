// 곡 목록/채보 불러오기. 게임 시작 전에 한 번만 요청하고, 플레이 중에는 서버를 부르지 않는다.
// songs.json 에 곡을 추가하면(tools/import_song.py) 자동으로 목록에 나타난다 (곡 수 고정 없음).
import { DIFFICULTIES } from './config.js';

function normalize(s) {
  return {
    ...s,
    artist: s.artist || 'WONY',
    cover: s.cover || null,
    video: s.video || null,
    difficulties: DIFFICULTIES.filter(d => (s.difficulties || []).includes(d)),
  };
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

export function chartUrl(song, difficulty) {
  return song.charts?.[difficulty] || `/songs/charts/${song.id}-${difficulty}.json`;
}

export async function loadChart(song, difficulty) {
  if (!song.difficulties.includes(difficulty)) throw new Error('채보 준비 중');
  const res = await fetch(chartUrl(song, difficulty), { cache: 'no-cache' });
  if (!res.ok) throw new Error('채보 준비 중');
  const chart = await res.json();
  if (!Array.isArray(chart.notes) || !chart.notes.length) throw new Error('채보 준비 중');
  return chart;
}

export function findSong(catalog, id) {
  return catalog.find(s => s.id === id) || catalog[0] || null;
}

export function pickDifficulty(song, wanted) {
  if (song?.difficulties.includes(wanted)) return wanted;
  return song?.difficulties.includes('normal') ? 'normal' : song?.difficulties[0];
}
