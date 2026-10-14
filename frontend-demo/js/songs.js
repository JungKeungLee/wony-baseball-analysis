// 곡 선택: 곡 → 난이도 → KEY 모드 → 배속 → 영상 ON/OFF → 게임 시작
// 이 화면은 cover 이미지만 불러온다 (MP4 는 게임 화면에서 고른 곡 하나만 preload="metadata").
// 예외: ▶ 미리듣기를 누르면 그 곡 영상의 일부만 받는다 (preview-player.js, 한 번에 한 곡).
// 즐겨찾기(★)는 이 기기에만 (localStorage wony_rhythm_favorites), 즐겨찾기 곡이 위로.
import { DIFFICULTIES, DIFFICULTY_LABELS, LANE_MODE_LABELS, NOTE_SPEEDS, SUPPORTED_LANE_COUNTS } from './config.js';
import { laneModeProblem, loadCatalog, pickDifficulty, supportsLaneMode } from './catalog.js';
import { loadFavorites, loadLastSelection, loadSettings, saveLastSelection, toggleFavorite, updateSettings } from './storage.js';
import { installButtonSound } from './audio.js';
import { createPreviewPlayer } from './preview-player.js';
import { bestOf, loadMyRecords, loadRanking } from './ranking.js';
import { requireMember } from './session.js';
import { rankingProblemText, renderRankingList } from './ranking-view.js';

const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const settings = loadSettings();
const last = loadLastSelection();
let catalog = [];
let selected = null;
let difficulty = null;
let myBest = [];   // 서버의 내 최고 기록 (로그인 회원)
const NO_BEST = Object.freeze({ bestScore: 0, bestGrade: null, bestAccuracy: null });
let favorites = new Set(loadFavorites());
const player = createPreviewPlayer({ getSettings: () => settings, onChange: renderPreviewButtons });
installButtonSound(() => settings);
let keyMode = settings.laneCount;   // 고른 KEY 모드 (곡이 지원하지 않으면 4)
const loadBestRecord = (songId, d) => bestOf(myBest, songId, d, keyMode) || NO_BEST;
const online = requireMember();   // 로그인 필수 (세션이 만료됐으면 로그인 안내로)

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
}

function coverEl(song) {
  const placeholder = () => el('div', { class: 'cover', 'aria-hidden': 'true', text: '♪' });
  if (!song.cover) return placeholder();
  const img = el('img', { class: 'cover', src: song.cover, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  return img;
}

function songItem(song) {
  const chips = el('div', { class: 'diff-chips' }, ...DIFFICULTIES.map(d => {
    const ok = song.difficulties.includes(d);
    const best = ok ? loadBestRecord(song.id, d) : null;
    const label = best?.bestScore ? ` ${best.bestGrade ? `${best.bestGrade} ` : ''}${fmt(best.bestScore)}` : '';
    return el('span', { class: `badge${ok ? '' : ' is-missing'}`, 'data-diff': d,
      text: `${DIFFICULTY_LABELS[d]}${ok ? label : ' 준비 중'}` });
  }));
  const info = el('span', { class: 'song-info' },
    el('strong', { class: 'song-title', text: song.title }),
    el('span', { class: 'song-meta', text: song.artist }),
    chips);
  if (!song.video) info.append(el('span', { class: 'song-warn', text: '영상 준비 중' }));
  const card = el('button', { type: 'button', class: 'song-card', 'aria-pressed': String(selected?.id === song.id), 'data-song': song.id }, coverEl(song), info);
  card.addEventListener('click', () => select(song, true));
  const fav = favorites.has(song.id);
  const favBtn = el('button', { type: 'button', class: `song-action fav-btn${fav ? ' is-on' : ''}`, 'aria-pressed': String(fav),
    'aria-label': `${song.title} 즐겨찾기`, 'data-fav': song.id, text: fav ? '★' : '☆' });
  favBtn.addEventListener('click', () => {
    if (toggleFavorite(song.id)) favorites.add(song.id); else favorites.delete(song.id);
    renderList();
  });
  const previewBtn = el('button', { type: 'button', class: 'song-action preview-btn', 'aria-pressed': 'false',
    'aria-label': `${song.title} 미리듣기`, 'data-preview': song.id, text: '▶', disabled: !song.video });
  previewBtn.addEventListener('click', () => {
    const r = player.toggle(song);
    $('previewNote').textContent = r === 'muted' ? '🔇 음소거 상태예요. 설정에서 음소거를 끄면 미리 들을 수 있어요.'
      : r === 'playing' ? `♪ ${song.title} 미리듣기 (약 15초)` : '';
  });
  return el('div', { class: 'song-item', 'data-item': song.id }, card, el('div', { class: 'song-actions' }, favBtn, previewBtn));
}

/** 즐겨찾기 곡을 위로 (같으면 원래 순서), "즐겨찾기만"이면 거르기 */
function renderList() {
  const favOnly = $('favOnly').checked;
  const list = catalog
    .map((song, i) => ({ song, i, fav: favorites.has(song.id) }))
    .filter(x => !favOnly || x.fav)
    .sort((a, b) => (b.fav - a.fav) || (a.i - b.i))
    .map(x => songItem(x.song));
  $('songList').replaceChildren(...list);
  if (favOnly && !list.length) $('songList').append(el('p', { class: 'muted', text: '즐겨찾기한 곡이 없어요. 곡의 ☆ 를 눌러 추가하세요.' }));
  renderPreviewButtons(player.current);
}

function renderPreviewButtons(current) {
  for (const btn of document.querySelectorAll('[data-preview]')) {
    const on = current?.id === btn.dataset.preview;
    btn.textContent = on ? '■' : '▶';
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
  }
  if (!current) $('previewNote').textContent = $('previewNote').textContent.startsWith('♪') ? '' : $('previewNote').textContent;
}

function radio(name, value, label, { checked, disabled, sub, diff } = {}) {
  const input = el('input', { type: 'radio', name, value, checked, disabled });
  input.checked = Boolean(checked);
  return el('label', { class: 'diff-option', 'data-diff': diff }, input,
    el('span', {}, label, sub ? el('small', { text: sub }) : ''));
}

// ── 온라인 랭킹 (선택한 곡 · 난이도) ──
let rankingSeq = 0;
async function refreshRanking() {
  const panel = $('rankingPanel');
  if (panel.hidden || !selected) return;
  $('rankingLabel').textContent = difficulty ? `· ${DIFFICULTY_LABELS[difficulty]}` : '';
  if (!panel.open || !difficulty) return;
  const seq = ++rankingSeq;
  $('rankingBody').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: '불러오는 중…' }));
  const board = await loadRanking(selected.id, difficulty, { limit: 50 });
  if (seq !== rankingSeq) return; // 그 사이 곡/난이도를 바꿈
  $('rankingBody').replaceChildren(board.ok
    ? renderRankingList(board.rows)
    : Object.assign(document.createElement('p'), { className: 'muted', textContent: rankingProblemText(board.reason) }));
}
$('rankingPanel').addEventListener('toggle', refreshRanking);
online.then(status => {
  $('rankingPanel').hidden = !status.onlineEnabled;
  refreshRanking();
  if (!status.loggedIn || !status.onlineEnabled) return;
  loadMyRecords().then(r => {
    if (!r.ok) return;
    myBest = r.best;
    renderList();   // 난이도별 최고 기록 표시
    if (selected) select(selected, false);
  });
});

function updatePlay() {
  const problems = [];
  if (!selected.video) problems.push('영상 준비 중');
  if (!difficulty) problems.push('채보 준비 중');
  $('setupProblem').textContent = problems.join(' · ');
  $('setupProblem').hidden = !problems.length;
  const play = $('playBtn');
  if (problems.length) {
    play.removeAttribute('href');
    play.setAttribute('aria-disabled', 'true');
    play.classList.add('is-disabled');
  } else {
    play.href = `/game?song=${encodeURIComponent(selected.id)}&diff=${difficulty}&keys=${keyMode}`;
    play.removeAttribute('aria-disabled');
    play.classList.remove('is-disabled');
  }
}

/** KEY 모드: 이 곡에 채보가 있는 모드만 선택 가능 (4키 채보를 6/8키로 바꾸지 않음) */
function renderKeyModes() {
  if (!supportsLaneMode(selected, keyMode)) keyMode = 4;
  $('keyGroup').replaceChildren(...SUPPORTED_LANE_COUNTS.map(n => radio('keys', String(n), LANE_MODE_LABELS[n], {
    checked: n === keyMode, disabled: !supportsLaneMode(selected, n), sub: supportsLaneMode(selected, n) ? null : '채보 없음',
  })));
  const only = selected.laneModes.length < SUPPORTED_LANE_COUNTS.length ? laneModeProblem(selected, SUPPORTED_LANE_COUNTS.find(n => !supportsLaneMode(selected, n))) : null;
  $('keyNote').textContent = only || '';
  $('keyNote').hidden = !only;
}

function select(song, scroll) {
  selected = song;
  keyMode = supportsLaneMode(song, settings.laneCount) ? settings.laneCount : 4;
  renderKeyModes();
  difficulty = pickDifficulty(song, last?.song === song.id ? last.difficulty : 'normal') || null;
  for (const card of document.querySelectorAll('.song-card')) card.setAttribute('aria-pressed', String(card.dataset.song === song.id));
  $('setupTitle').textContent = `${song.title} · ${song.artist}`;
  $('diffGroup').replaceChildren(...DIFFICULTIES.map(d => {
    const ok = song.difficulties.includes(d);
    const best = ok ? loadBestRecord(song.id, d) : null;
    return radio('diff', d, DIFFICULTY_LABELS[d], {
      checked: d === difficulty, disabled: !ok, diff: d,
      // 개인 BEST (이 곡 · 난이도 · KEY 모드): 등급 · 점수 · 정확도
      sub: ok ? (best.bestScore ? `${best.bestGrade || ''} ${fmt(best.bestScore)}${Number.isFinite(Number(best.bestAccuracy)) ? ` · ${Number(best.bestAccuracy).toFixed(1)}%` : ''}`.trim() : '기록 없음') : '채보 준비 중',
    });
  }));
  $('setup').hidden = false;
  updatePlay();
  refreshRanking();
  if (scroll) $('setup').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

$('diffGroup').addEventListener('change', e => {
  difficulty = e.target.value;
  saveLastSelection(selected.id, difficulty);
  updatePlay();
  refreshRanking();
});

$('keyGroup').addEventListener('change', e => {
  keyMode = Number(e.target.value);
  settings.laneCount = keyMode;
  updateSettings({ laneCount: keyMode });
  select(selected, false);   // 난이도별 최고 기록도 이 모드 기준으로
});

$('speedGroup').replaceChildren(...NOTE_SPEEDS.map(s => radio('speed', String(s), `${s}x`, { checked: s === settings.noteSpeed })));
$('speedGroup').addEventListener('change', e => updateSettings({ noteSpeed: Number(e.target.value) }));
$('videoOn').checked = settings.showVideo;
$('videoOn').addEventListener('change', e => updateSettings({ showVideo: e.target.checked }));
$('noFail').checked = settings.noFail;
$('noFail').addEventListener('change', e => updateSettings({ noFail: e.target.checked }));
$('playBtn').addEventListener('click', e => {
  if ($('playBtn').getAttribute('aria-disabled') === 'true') {
    e.preventDefault();
    return;
  }
  player.stop();   // 게임으로 가기 전에 미리듣기 정지
  saveLastSelection(selected.id, difficulty);
});

loadCatalog().then(c => {
  catalog = c;
  $('status').textContent = catalog.length ? '' : '등록된 곡이 없습니다. (tools/import_song.py 또는 곡 추가 화면으로 추가)';
  renderList();
  $('favOnly').addEventListener('change', renderList);
  const initial = catalog.find(s => s.id === last?.song) || catalog[0];
  if (initial) select(initial, false);
}).catch(err => {
  $('status').textContent = err.message;
  $('status').classList.add('is-error');
});
