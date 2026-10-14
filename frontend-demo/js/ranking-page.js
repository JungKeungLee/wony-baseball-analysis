// 전체 랭킹 화면: 곡 + 난이도 (배속 구분 없음). 상위 50 + 내 앞뒤 순위. 로그인 회원만 조회 가능.
import { DIFFICULTIES, DIFFICULTY_LABELS } from './config.js';
import { findSong, loadCatalog, pickDifficulty } from './catalog.js';
import { loadRanking } from './ranking.js';
import { rankingProblemText, renderRankingList } from './ranking-view.js';
import { requireMember } from './session.js';
import { loadLastSelection } from './storage.js';
import { applyUiSkin } from './theme.js';
import { renderWalletBadge, walletView } from './wallet.js';

applyUiSkin();
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let catalog = [];
let seq = 0;
const online = requireMember();   // 로그인 필수

const option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });

async function show() {
  const song = findSong(catalog, $('songSelect').value);
  const diff = $('diffSelect').value;
  if (!song || !diff) return;
  history.replaceState(null, '', `/ranking?song=${encodeURIComponent(song.id)}&diff=${diff}`);
  const mine = ++seq;
  $('rankingStatus').textContent = `${song.title} · ${DIFFICULTY_LABELS[diff]} 랭킹을 불러오는 중…`;
  $('rankingBody').replaceChildren();
  const status = await online;
  if (mine !== seq) return;
  if (!status.onlineEnabled || !status.loggedIn) {   // 로그인 전에는 서버에 묻지 않음
    $('rankingStatus').textContent = rankingProblemText(status.onlineEnabled ? 'login-required' : 'not-configured');
    return;
  }
  const board = await loadRanking(song.id, diff, { laneCount: song.laneCount, limit: 50, around: 2 });
  if (mine !== seq) return;
  $('rankingStatus').textContent = board.ok ? `${song.title} · ${DIFFICULTY_LABELS[diff]}` : rankingProblemText(board.reason);
  if (board.ok) $('rankingBody').replaceChildren(renderRankingList(board.rows));
}

function fillDifficulties(song, wanted) {
  const diffs = DIFFICULTIES.filter(d => song.difficulties.includes(d));
  $('diffSelect').replaceChildren(...diffs.map(d => option(d, DIFFICULTY_LABELS[d])));
  $('diffSelect').value = pickDifficulty(song, wanted) || diffs[0] || '';
}

async function init() {
  online.then(status => renderWalletBadge($('walletBadge'), walletView(status)));
  try {
    catalog = await loadCatalog();
  } catch {
    catalog = [];
  }
  if (!catalog.length) {
    $('rankingStatus').textContent = '등록된 곡이 없습니다.';
    return;
  }
  const last = loadLastSelection();
  const song = findSong(catalog, params.get('song') || last?.song);
  $('songSelect').replaceChildren(...catalog.map(s => option(s.id, s.title)));
  $('songSelect').value = song.id;
  fillDifficulties(song, params.get('diff') || last?.difficulty);
  $('songSelect').addEventListener('change', () => {
    fillDifficulties(findSong(catalog, $('songSelect').value), $('diffSelect').value);
    show();
  });
  $('diffSelect').addEventListener('change', show);
  show();
}

init();
