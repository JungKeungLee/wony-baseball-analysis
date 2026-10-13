import { DIFFICULTIES, DIFFICULTY_LABELS, RESULT_STATUS, RESULT_STATUS_LABELS } from './config.js';
import { loadCatalog } from './catalog.js';
import { clearBestScores, loadAllBestRecords, loadResults } from './storage.js';

const list = document.getElementById('scoreList');
const recent = document.getElementById('recentList');
const status = document.getElementById('status');
let catalog = [];

function badge(diff) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.dataset.diff = diff;
  b.textContent = DIFFICULTY_LABELS[diff] || diff;
  return b;
}

function render() {
  const scores = loadAllBestRecords();
  const fmt = n => (n == null ? '—' : Number(n).toLocaleString('ko-KR'));
  list.replaceChildren(...catalog.map(song => {
    const card = document.createElement('section');
    card.className = 'card';
    const title = document.createElement('h2');
    title.className = 'song-title';
    title.textContent = song.title;
    const table = document.createElement('table');
    table.className = 'score-table';
    table.innerHTML = '<thead><tr><th scope="col">난이도</th><th scope="col">등급</th><th scope="col">정확도</th>'
      + '<th scope="col">콤보</th><th scope="col">최고 점수</th></tr></thead>';
    const body = table.createTBody();
    for (const diff of DIFFICULTIES) {
      const row = body.insertRow();
      row.insertCell().append(badge(diff));
      const best = scores[song.id]?.[diff];
      if (!song.difficulties.includes(diff)) {
        const cell = row.insertCell();
        cell.colSpan = 4;
        cell.textContent = '채보 준비 중';
        continue;
      }
      const grade = row.insertCell();
      grade.className = 'best-grade';
      grade.textContent = best?.bestGrade || '—';
      if (best?.bestGrade) grade.dataset.grade = best.bestGrade;
      row.insertCell().textContent = best?.bestAccuracy == null ? '—' : `${best.bestAccuracy.toFixed(2)}%`;
      row.insertCell().textContent = fmt(best?.bestMaxCombo);
      row.insertCell().textContent = best?.bestScore ? fmt(best.bestScore) : '—';
    }
    card.append(title, table);
    return card;
  }));

  const results = loadResults().slice(0, 10);
  const titles = Object.fromEntries(catalog.map(s => [s.id, s.title]));
  recent.replaceChildren(...(results.length ? results.map(r => {
    const row = document.createElement('li');
    row.className = 'recent-row';
    const name = document.createElement('span');
    name.textContent = titles[r.songId] || r.songId;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${r.noteSpeed}x${r.noFail ? ' · NO FAIL' : ''} · ${Number(r.accuracy).toFixed(1)}% · ${Number(r.score).toLocaleString('ko-KR')}`;
    const grade = document.createElement('strong');
    grade.className = 'recent-grade';
    grade.textContent = `${r.grade || '-'} · ${RESULT_STATUS_LABELS[r.status] || RESULT_STATUS_LABELS[RESULT_STATUS.CLEAR]}`;
    grade.dataset.status = r.status;
    row.append(badge(r.difficulty), name, grade, meta);
    return row;
  }) : [Object.assign(document.createElement('li'), { className: 'muted', textContent: '아직 플레이 기록이 없어요.' })]));
}

document.getElementById('clearBtn').addEventListener('click', () => {
  if (!confirm('이 기기에 저장된 최고 점수와 기록을 모두 지울까요?')) return;
  clearBestScores();
  render();
  status.textContent = '기록을 지웠어요.';
});

loadCatalog().then(c => { catalog = c; render(); }).catch(err => {
  status.textContent = err.message;
  status.classList.add('is-error');
});
