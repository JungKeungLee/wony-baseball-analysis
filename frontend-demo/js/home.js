import { DIFFICULTY_LABELS } from './config.js';
import { loadCatalog, findSong, pickDifficulty } from './catalog.js';
import { keyLabel } from './keys.js';
import { loadLastSelection, loadSettings } from './storage.js';
import { getOnlineStatus } from './ranking.js';
import { applyUiSkin } from './theme.js';
import { renderWalletBadge, walletView } from './wallet.js';

applyUiSkin();

document.getElementById('keysHint').textContent = loadSettings().keys.map(keyLabel).join(' ');

const last = loadLastSelection();
loadCatalog().then(catalog => {
  const song = findSong(catalog, last?.song);
  const link = document.getElementById('playLink');
  if (!song) {
    link.href = '/songs';
    document.getElementById('playHint').textContent = '곡을 먼저 추가해주세요';
    return;
  }
  const diff = pickDifficulty(song, last?.difficulty);
  link.href = `/game?song=${encodeURIComponent(song.id)}&diff=${diff}`;
  document.getElementById('playHint').textContent = `${song.title} · ${DIFFICULTY_LABELS[diff]}`;
}).catch(() => { /* 곡 목록이 없어도 /game 이 기본곡으로 처리한다 */ });

// ── WONY PHONE 회원 로그인 상태 ──
const LOGIN_MESSAGES = {
  failed: '로그인 링크가 만료되었거나 이미 사용되었어요. WONY PHONE에서 다시 열어주세요.',
  unavailable: '온라인 로그인이 아직 준비되지 않았어요.',
};
const loginResult = new URLSearchParams(location.search).get('login');
if (loginResult) history.replaceState(null, '', location.pathname); // 주소창 정리

getOnlineStatus().then(online => {
  renderWalletBadge(document.getElementById('walletBadge'), walletView(online));
  const card = document.getElementById('onlineCard');
  const text = document.getElementById('onlineText');
  if (!online.onlineEnabled && !LOGIN_MESSAGES[loginResult]) return;
  card.hidden = false;
  if (online.loggedIn) {
    text.textContent = `${online.nickname || 'WONY PHONE 회원'}님, 플레이 기록이 온라인 랭킹에 저장돼요.`;
    const out = document.getElementById('logoutBtn');
    out.hidden = false;
    out.addEventListener('click', async () => {
      await fetch('/api/rhythm/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      location.reload();
    });
    return;
  }
  text.textContent = LOGIN_MESSAGES[loginResult] || 'WONY PHONE에서 열면 온라인 랭킹에 기록돼요. 로그인 없이도 플레이와 로컬 기록은 그대로 돼요.';
  if (online.loginUrl) Object.assign(document.getElementById('loginLink'), { href: online.loginUrl, hidden: false });
});
