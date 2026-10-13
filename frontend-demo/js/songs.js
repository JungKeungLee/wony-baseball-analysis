// 곡 선택: 곡 → 난이도 → 배속 → 영상 ON/OFF → 게임 시작
// 이 화면은 cover 이미지만 불러온다 (MP4 는 게임 화면에서 고른 곡 하나만 preload="metadata").
import { DIFFICULTIES, DIFFICULTY_LABELS, NOTE_SPEEDS } from './config.js';
import { loadCatalog, pickDifficulty } from './catalog.js';
import { loadBestRecord, loadLastSelection, loadSettings, saveLastSelection, updateSettings } from './storage.js';
import { getOnlineStatus, loadRanking } from './ranking.js';
import { rankingProblemText, renderRankingList } from './ranking-view.js';

const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const settings = loadSettings();
const last = loadLastSelection();
let catalog = [];
let selected = null;
let difficulty = null;

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

function songCard(song) {
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
  const card = el('button', { type: 'button', class: 'song-card', 'aria-pressed': 'false', 'data-song': song.id }, coverEl(song), info);
  card.addEventListener('click', () => select(song, true));
  return card;
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
getOnlineStatus().then(online => {
  $('rankingPanel').hidden = !online.onlineEnabled;
  refreshRanking();
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
    play.href = `/game?song=${encodeURIComponent(selected.id)}&diff=${difficulty}`;
    play.removeAttribute('aria-disabled');
    play.classList.remove('is-disabled');
  }
}

function select(song, scroll) {
  selected = song;
  difficulty = pickDifficulty(song, last?.song === song.id ? last.difficulty : 'normal') || null;
  for (const card of document.querySelectorAll('.song-card')) card.setAttribute('aria-pressed', String(card.dataset.song === song.id));
  $('setupTitle').textContent = `${song.title} · ${song.artist}`;
  $('diffGroup').replaceChildren(...DIFFICULTIES.map(d => {
    const ok = song.difficulties.includes(d);
    const best = ok ? loadBestRecord(song.id, d) : null;
    return radio('diff', d, DIFFICULTY_LABELS[d], {
      checked: d === difficulty, disabled: !ok, diff: d,
      sub: ok ? (best.bestScore ? `${best.bestGrade || ''} ${fmt(best.bestScore)}`.trim() : '기록 없음') : '채보 준비 중',
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
  saveLastSelection(selected.id, difficulty);
});

loadCatalog().then(c => {
  catalog = c;
  $('status').textContent = catalog.length ? '' : '등록된 곡이 없습니다. (tools/import_song.py 또는 곡 추가 화면으로 추가)';
  $('songList').append(...catalog.map(songCard));
  const initial = catalog.find(s => s.id === last?.song) || catalog[0];
  if (initial) select(initial, false);
}).catch(err => {
  $('status').textContent = err.message;
  $('status').classList.add('is-error');
});
