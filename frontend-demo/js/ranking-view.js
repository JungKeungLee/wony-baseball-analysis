// 온라인 랭킹 목록 표시 (결과 화면 · 곡 선택 화면 공통). 닉네임이 없으면(비공개 프로필) "비공개 회원".
const fmt = n => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('ko-KR') : '-');

export function renderRankingList(rows, { emptyText = '아직 기록이 없어요. 첫 기록의 주인공이 되어 보세요!' } = {}) {
  const list = document.createElement('ol');
  list.className = 'ranking-list';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'ranking-empty';
    li.textContent = emptyText;
    list.append(li);
    return list;
  }
  let prevRank = 0;
  for (const r of rows) {
    if (prevRank && r.rank > prevRank + 1) {
      const gap = document.createElement('li');
      gap.className = 'ranking-gap';
      gap.setAttribute('aria-hidden', 'true');
      gap.textContent = '⋯';
      list.append(gap);
    }
    prevRank = r.rank;
    const li = document.createElement('li');
    li.className = `ranking-row${r.isMe ? ' is-me' : ''}`;
    const rank = Object.assign(document.createElement('span'), { className: 'ranking-rank', textContent: `${r.rank}위` });
    const name = Object.assign(document.createElement('span'), { className: 'ranking-name', textContent: r.nickname || '비공개 회원' });
    if (r.isMe) name.append(Object.assign(document.createElement('small'), { textContent: ' (나)' }));
    const grade = Object.assign(document.createElement('span'), { className: 'ranking-grade', textContent: r.bestGrade || '-' });
    grade.dataset.grade = r.bestGrade || '';
    const score = Object.assign(document.createElement('span'), { className: 'ranking-score', textContent: fmt(r.bestScore) });
    li.append(rank, name, grade, score);
    list.append(li);
  }
  return list;
}

/** 랭킹을 못 불러온 이유 → 안내 문구 */
export function rankingProblemText(reason) {
  if (reason === 'login-required') return 'WONY PHONE 회원으로 로그인하면 온라인 랭킹을 볼 수 있어요.';
  if (reason === 'not-configured') return '온라인 랭킹이 아직 준비되지 않았어요.';
  return '온라인 랭킹을 불러오지 못했어요. 게임과 로컬 기록은 정상입니다.';
}
