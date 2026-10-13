// 게임 화면 컨트롤러: video 시계 → 엔진 → 렌더러.
// - 게임 시간은 video.currentTime 하나뿐이다 (clock.js). 노트 위치·판정·진행률·종료가 모두 같은 값을 본다.
// - 게임 상태(engine)와 화면 크기(layout)는 분리: 회전/리사이즈/영상 ON·OFF 때 layout 만 다시 계산한다.
// - 플레이 중 서버 요청 없음. 영상 파일은 선택한 곡 하나만 preload="metadata" 로 준비한다.
import {
  COUNTDOWN_MS, DEFAULT_LANE_COUNT, DIFFICULTIES, DIFFICULTY_LABELS, RESULT_STATUS, RESULT_STATUS_LABELS, normalizeLaneCount,
} from './config.js';
import { findSong, loadCatalog, loadChart, loadPreviewSong, pickDifficulty } from './catalog.js';
import { VideoClock } from './clock.js';
import {
  createGame, finishGame, hitLane, isFinished, pauseGame, resultRecord, resumeGame, startGame, updateGame,
} from './engine.js';
import { getOnlineStatus, isRankingEligible, loadRanking, submitRanking } from './ranking.js';
import { runResultOnline } from './result-online.js';
import { applyUiSkin, rhythmBarTheme } from './theme.js';
import { grantLocalReward } from './wallet.js';
import { formatMs } from './chart-stats.js';
import { loadChartStats, renderStatsTable } from './preview-stats.js';
import { createInput } from './input.js';
import { keyLabel } from './keys.js';
import { approachMs, computeLayout, normalizeSpeed } from './layout.js';
import { createRenderer } from './render.js';
import {
  keysFor, loadBestRecord, loadSettings, saveBestRecord, saveLastSelection, saveResult, updateSettings,
} from './storage.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PREVIEW = params.get('preview') || '';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const speedText = s => `${Number(s).toFixed(2).replace(/0$/, '')}x`;

// 설정은 게임 화면을 열 때 한 번만 읽는다 (게임 도중 키/배속 변경 없음).
const settings = loadSettings();
const noteSpeed = normalizeSpeed(params.get('speed') ?? settings.noteSpeed);
const approach = approachMs(noteSpeed);
let showVideo = params.has('video') ? params.get('video') !== '0' : settings.showVideo;
let autoplay = params.get('autoplay') === '1';
const noFail = params.has('nofail') ? params.get('nofail') === '1' : settings.noFail;

const ui = {
  stage: $('stage'), canvas: $('field'), video: $('video'), videoMsg: $('videoMsg'), score: $('score'),
  combo: $('combo'), comboNum: $('comboNum'), judgement: $('judgement'), countdown: $('countdown'),
  progress: $('progress'), pauseBtn: $('pauseBtn'), touch: $('touch'), laneButtons: [],
  ready: $('readyOverlay'), paused: $('pauseOverlay'), result: $('resultOverlay'), error: $('errorOverlay'),
  start: $('startBtn'), problem: $('readyProblem'),
};

let song = null;
let difficulty = null;
let chart = null;
let state = null;
let clock = null;
let phase = 'loading'; // loading | ready | playing | paused | result | error
let layout = null;
let rafId = 0;
let videoReady = false;
// 스킨은 색만 바꾼다 (판정 · 점수 · 시계와 무관). 설정과 마찬가지로 화면을 열 때 한 번만 읽는다.
applyUiSkin();
const renderer = createRenderer(ui.canvas, rhythmBarTheme());
const hud = { seq: 0, score: -1, combo: -1, countdown: null, judgementAt: 0, progress: -1, life: -1 };

// ---------- 레인 (채보의 laneCount 로 결정: 4 / 6 / 8) ----------
// 키 배열·터치 버튼·입력·그리기가 모두 이 값을 따른다. 지금 채보는 모두 4키.
let laneCount = 0;
let keys = [];
let labels = [];
let flashes = [];
let input = null;

function setupLanes(n) {
  n = normalizeLaneCount(n);
  if (n === laneCount && input) return;
  input?.releaseAll();
  laneCount = n;
  keys = keysFor(settings, n);
  labels = keys.map(keyLabel);
  flashes = new Array(n).fill(null);
  input = createInput({
    laneCount: n,
    getKeys: () => keys,
    onLaneDown: lane => pressLane(lane),
    onPause: () => (phase === 'playing' ? pause() : phase === 'paused' ? resume() : null),
    onPressedChange: (lane, on) => ui.laneButtons[lane]?.classList.toggle('is-pressed', on),
  });
  const colors = renderer.laneColors(n);
  ui.laneButtons = Array.from({ length: n }, (_, lane) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lane-btn';
    btn.dataset.lane = String(lane);
    btn.tabIndex = -1;
    btn.style.setProperty('--lane-color', colors[lane]);
    btn.setAttribute('aria-label', `${lane + 1}레인 (${labels[lane]})`);
    const key = document.createElement('span');
    key.className = 'lane-key';
    key.textContent = labels[lane];
    btn.append(key);
    btn.addEventListener('pointerdown', e => input.pointerdown(e, lane));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(type, e => input.pointerup(e));
    btn.addEventListener('contextmenu', e => e.preventDefault());
    return btn;
  });
  ui.touch.replaceChildren(...ui.laneButtons);
  ui.touch.style.setProperty('--lane-count', String(n));
  document.body.dataset.lanes = String(n);
  $('keyHint').textContent = labels.join(' ');
  applyLayout();
}

const gameTime = () => (clock ? clock.now() - settings.offsetMs : -COUNTDOWN_MS);

/** 키보드·터치·자동 플레이가 모두 이 함수 하나로 판정한다 (판정 기준 = video 시각, 배속과 무관). */
function pressLane(lane) {
  if (phase !== 'playing') return;
  const judgement = hitLane(state, lane, gameTime());
  if (judgement) flashes[lane] = { grade: judgement.grade, at: performance.now() };
}

// ---------- 화면 크기 (게임 상태와 무관) ----------
function applyLayout() {
  const rect = ui.stage.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  layout = computeLayout(rect.width, rect.height, devicePixelRatio, laneCount || DEFAULT_LANE_COUNT);
  renderer.resize(layout, labels);
  draw(gameTime());
}

function draw(t) {
  if (layout && state && input) renderer.draw(state, t, approach, input.pressed, flashes, performance.now(), reducedMotion.matches);
}

function setShowVideo(on) {
  showVideo = on;
  document.body.classList.toggle('video-off', !on); // 화면에서만 숨김: video 는 계속 재생, currentTime 도 계속 진행
  $('videoToggle').checked = on;
  $('readyVideo').textContent = on ? 'ON' : 'OFF';
}

// ---------- HUD (값이 바뀔 때만 DOM 갱신) ----------
function updateHud(t) {
  if (state.score !== hud.score) {
    hud.score = state.score;
    ui.score.textContent = fmt(state.score);
  }
  if (state.life !== hud.life) {
    hud.life = state.life;
    const life = Math.ceil(state.life);
    $('lifeNum').textContent = life;
    $('lifeBar').style.transform = `scaleX(${state.life / state.lifeMax})`;
    $('lifeMeter').dataset.level = life > 50 ? 'high' : life > 25 ? 'mid' : 'low';
    $('lifeMeter').setAttribute('aria-valuenow', String(life));
  }
  if (state.combo !== hud.combo) {
    hud.combo = state.combo;
    ui.comboNum.textContent = state.combo;
    ui.combo.hidden = state.combo < 2;
  }
  const j = state.lastJudgement;
  if (j && j.seq !== hud.seq) {
    hud.seq = j.seq;
    hud.judgementAt = performance.now();
    ui.judgement.textContent = j.grade;
    ui.judgement.className = `judgement is-${j.grade.toLowerCase()}`;
    ui.judgement.hidden = false;
    if (!reducedMotion.matches && ui.judgement.animate) {
      ui.judgement.animate([{ transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 120, easing: 'ease-out' });
    }
  } else if (!ui.judgement.hidden && performance.now() - hud.judgementAt > 700) {
    ui.judgement.hidden = true;
  }
  const countdown = t < 0 ? String(Math.min(3, Math.ceil(-t / 1000))) : t < 700 ? 'START!' : '';
  if (countdown !== hud.countdown) {
    hud.countdown = countdown;
    ui.countdown.textContent = countdown;
    ui.countdown.hidden = !countdown;
  }
  const progress = Math.round(Math.min(1, Math.max(0, t / state.endTime)) * 500) / 500;
  if (progress !== hud.progress) {
    hud.progress = progress;
    ui.progress.style.transform = `scaleX(${progress})`;
  }
}

function resetHud() {
  Object.assign(hud, { seq: 0, score: -1, combo: -1, countdown: null, judgementAt: 0, progress: -1, life: -1 });
  ui.judgement.hidden = true;
  flashes.fill(null);
}

// ---------- 게임 루프 (requestAnimationFrame: 그리기만, 시간은 video 에서) ----------
function autoplayStep(t) {
  for (let lane = 0; lane < state.laneCount; lane++) {
    const queue = state.lanes[lane];
    let i = state.laneHead[lane];
    while (i < queue.length && queue[i].grade) i++;
    if (queue[i] && queue[i].time <= t) pressLane(lane);
  }
}

// 미리보기 전용: 현재 video.currentTime / 게임 시간 / 진행 표시 (0.1초마다만 DOM 갱신)
let previewClockAt = 0;
function updatePreviewClock(t, force = false) {
  if (!PREVIEW || !state) return;
  const now = performance.now();
  if (!force && now - previewClockAt < 100) return;
  previewClockAt = now;
  const el = $('previewClock');
  el.hidden = false;
  el.textContent = `video.currentTime ${formatMs(ui.video.currentTime * 1000)}  ·  게임 ${formatMs(t)}`
    + `  ·  ${DIFFICULTY_LABELS[difficulty]} ${state.judged}/${state.total}`;
}

function frame() {
  rafId = 0;
  if (phase !== 'playing') return;
  clock.tick();
  const t = gameTime();
  updatePreviewClock(t);
  if (autoplay) autoplayStep(t);
  updateGame(state, t);
  if (clock.ended && state.status === 'playing') finishGame(state, t);
  draw(t);
  updateHud(t);
  if (isFinished(state)) { // 곡 끝 또는 GAME OVER (LIFE 0, NO FAIL 아님)
    showResult();
    return;
  }
  rafId = requestAnimationFrame(frame);
}

function loop() {
  if (!rafId) rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function showOverlay(which) {
  for (const key of ['ready', 'paused', 'result', 'error']) ui[key].hidden = key !== which;
  const target = which && ui[which].querySelector('[data-autofocus]:not([disabled])');
  if (target) target.focus({ preventScroll: true });
}

// ---------- 시작 / 일시정지 / 결과 ----------
/** 반드시 사용자 탭·클릭 안에서 호출 (모바일 자동재생 정책). */
function begin() {
  if (!chart || !videoReady) return;
  stopLoop();
  clock?.stop();
  input.releaseAll();
  state = createGame(chart, { difficulty, noFail, laneCount });
  const duration = ui.video.duration * 1000;
  if (Number.isFinite(duration) && duration > 0) state.endTime = Math.min(state.endTime, duration);
  clock ||= new VideoClock(ui.video, { allowSeek: false });
  clock.start(COUNTDOWN_MS);
  clock.unlock();
  startGame(state);
  resetHud();
  phase = 'playing';
  showOverlay(null);
  ui.pauseBtn.disabled = false;
  document.activeElement?.blur?.(); // 플레이 중 Space/Enter 가 버튼을 누르지 않게
  loop();
}

function pause() {
  if (phase !== 'playing') return;
  pauseGame(state);
  clock.pause(); // video.pause()
  stopLoop();
  input.releaseAll();
  phase = 'paused';
  draw(gameTime());
  updatePreviewClock(gameTime(), true);
  showOverlay('paused');
}

/** 다시 시작은 사용자가 [계속하기]를 눌렀을 때만 (앱 복귀 시 자동 재생 안 함). */
function resume() {
  if (phase !== 'paused') return;
  clock.resume(); // video.play(), 현재 video.currentTime 에서 이어감
  resumeGame(state);
  phase = 'playing';
  showOverlay(null);
  document.activeElement?.blur?.();
  loop();
}

const RESULT_TITLES = { CLEAR: 'CLEAR!', GAME_OVER: 'GAME OVER', NO_FAIL_CLEAR: 'NO FAIL CLEAR' };
const processedPlays = new Set();   // 같은 판(playId) 결과 처리는 1번만 (저장 · 온라인 전송 · 츄르)
let resultSeq = 0;

const BEST_SKIP_TEXT = {
  GAME_OVER: 'GAME OVER 기록은 최고 기록에 반영되지 않아요',
  NO_FAIL_CLEAR: 'NO FAIL 기록은 최고 기록에 반영되지 않아요',
  NO_FAIL: 'NO FAIL 기록은 최고 기록에 반영되지 않아요',
  AUTOPLAY: '자동 플레이 (기록 저장 안 함)',
  PREVIEW: '미리보기 (기록 저장 안 함)',
};

function showResult() {
  phase = 'result';
  stopLoop();
  clock.stop();
  ui.pauseBtn.disabled = true;
  const context = { autoplay, preview: Boolean(PREVIEW) };
  const record = {
    ...resultRecord(state, { songId: song.id, difficulty, noteSpeed }),
    ...context,
    playedAt: new Date().toISOString(),
  };
  if (processedPlays.has(record.playId)) return;
  processedPlays.add(record.playId);
  // 기록 정책은 storage.js 상단 표 참고. 각 저장 함수가 규칙을 직접 확인한다:
  //   최고 기록 = 정상 CLEAR 만, 최근 기록 = AUTO/PREVIEW 제외 전부, 랭킹 · 츄르 = 정상 CLEAR 만
  const best = saveBestRecord(record, context);
  saveResult({ ...record, ranking: { eligible: isRankingEligible(record, context), submitted: false } }, context);
  const gameOver = record.status === RESULT_STATUS.GAME_OVER;
  $('resultTitle').textContent = RESULT_TITLES[record.status] || 'CLEAR!';
  $('resultOverlay').classList.toggle('is-game-over', gameOver);
  $('resultOverlay').dataset.status = record.status;
  $('resMeta').textContent = [DIFFICULTY_LABELS[difficulty], speedText(noteSpeed), RESULT_STATUS_LABELS[record.status]].join(' · ');
  $('resGrade').textContent = record.grade;
  $('resGrade').dataset.grade = record.grade;
  $('resLife').textContent = fmt(Math.ceil(record.life));
  $('resScore').textContent = fmt(record.score);
  $('resCombo').textContent = fmt(record.maxCombo);
  $('resAccuracy').textContent = `${record.accuracy.toFixed(2)}%`;
  $('resPERFECT').textContent = fmt(record.perfect);
  $('resGREAT').textContent = fmt(record.great);
  $('resGOOD').textContent = fmt(record.good);
  $('resMISS').textContent = fmt(record.miss);
  $('resBest').textContent = fmt(best.best.bestScore);
  const improved = [['score', '점수'], ['grade', '등급'], ['accuracy', '정확도'], ['maxCombo', '콤보']]
    .filter(([k]) => best.improved[k]).map(([, label]) => label);
  $('resNewBest').textContent = `🎉 최고 ${improved.join(' · ')} 갱신!`;
  $('resNewBest').hidden = !improved.length;
  $('resNoSave').textContent = BEST_SKIP_TEXT[best.skipped] || '';
  $('resNoSave').hidden = !best.skipped;
  const rankingHref = `/ranking?song=${encodeURIComponent(song.id)}&diff=${difficulty}`;
  $('resRankingLink').href = rankingHref;
  showOverlay('result');
  // 결과를 먼저 보여준 뒤 온라인 랭킹 · 츄르를 비동기로 (실패해도 결과 · 로컬 기록은 그대로)
  const seq = ++resultSeq;
  runResultOnline({
    record, context, online: onlineStatus, rankingHref,
    els: {
      box: $('resOnline'), status: $('resOnlineStatus'), change: $('resRankChange'), medal: $('resRankMedal'),
      transition: $('resRankTransition'), delta: $('resRankDelta'), badges: $('resRankBadges'), ranking: $('resRanking'),
      fullRanking: $('resFullRanking'), churu: $('resChuru'), churuTitle: $('resChuruTitle'), churuAmount: $('resChuruAmount'),
      churuFrom: $('resChuruFrom'), churuTo: $('resChuruTo'), churuNote: $('resChuruNote'),
    },
    deps: { submitRanking, loadRanking, grantLocalReward },
    reducedMotion: reducedMotion.matches,
    isCurrent: () => phase === 'result' && seq === resultSeq, // 다시 하기를 누르면 표시 중단 (저장은 이미 요청됨)
  }).catch(() => {
    $('resOnlineStatus').textContent = '온라인 기록을 불러오지 못했습니다. 로컬 기록은 정상적으로 저장되었습니다.';
  });
}

function showError(message) {
  phase = 'error';
  $('errorMessage').textContent = message;
  showOverlay('error');
}

// ---------- 준비 화면 ----------
function updateReady() {
  const problems = [];
  if (!song.video) problems.push('영상 준비 중');
  else if (ui.video.error) problems.push('영상을 불러오지 못했습니다');
  if (!chart) problems.push('채보 준비 중');
  ui.problem.textContent = problems.join(' · ');
  ui.problem.hidden = !problems.length;
  ui.start.disabled = problems.length > 0 || !videoReady;
  ui.start.textContent = song.video && !videoReady && !ui.video.error ? '영상 불러오는 중…' : '▶ 게임 시작';
  ui.videoMsg.hidden = Boolean(song.video) && !ui.video.error;
  ui.videoMsg.textContent = song.video ? '영상을 불러오지 못했습니다' : '영상 준비 중';
  $('diffBadge').textContent = DIFFICULTY_LABELS[difficulty];
  $('diffBadge').dataset.diff = difficulty;
  $('readyDiff').textContent = DIFFICULTY_LABELS[difficulty];
  $('readyDiff').dataset.diff = difficulty;
  $('readyNotes').textContent = chart ? fmt(chart.notes.length) : '-';
  const bestRec = loadBestRecord(song.id, difficulty);
  $('readyBest').textContent = PREVIEW ? '-' : `${fmt(bestRec.bestScore)}${bestRec.bestGrade ? ` (${bestRec.bestGrade})` : ''}`;
  if (PREVIEW) {
    for (const btn of $('previewDiffs').querySelectorAll('button')) btn.setAttribute('aria-checked', String(btn.dataset.diff === difficulty));
  }
  if (phase === 'ready' && !ui.start.disabled && document.activeElement === document.body) ui.start.focus({ preventScroll: true });
}

async function selectDifficulty(diff) {
  difficulty = diff;
  try {
    chart = await loadChart(song, difficulty);
  } catch {
    chart = null;
  }
  setupLanes(chart?.laneCount ?? DEFAULT_LANE_COUNT); // 채보 모드에 맞춰 키/터치 버튼/레이아웃 준비
  state = createGame(chart || { notes: [] }, { difficulty, noFail, laneCount });
  if (!PREVIEW) saveLastSelection(song.id, difficulty);
  draw(-COUNTDOWN_MS);
  updateReady();
}

function setupPreview() {
  document.body.classList.add('preview-mode');
  $('previewTools').hidden = false;
  $('readyBack').href = '/';
  $('readyBack').textContent = '곡 추가 화면';
  for (const a of document.querySelectorAll('[data-back]')) a.href = '/';
  $('autoplayToggle').checked = autoplay;
  $('autoplayToggle').addEventListener('change', e => { autoplay = e.target.checked; });
  $('previewDiffs').replaceChildren(...DIFFICULTIES.map(d => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'diff-chip';
    btn.dataset.diff = d;
    btn.setAttribute('role', 'radio');
    btn.innerHTML = `${DIFFICULTY_LABELS[d]}<small>${song.noteCounts?.[d] ?? ''}</small>`;
    btn.addEventListener('click', () => selectDifficulty(d));
    return btn;
  }));
  // 채보 품질 확인용 통계: 분석 요약은 stage.json (자동 생성 도구가 기록), 나머지는 채보에서 계산
  Promise.all([
    fetch(`/staging/${PREVIEW}/stage.json`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
    loadChartStats(Object.fromEntries(DIFFICULTIES.map(d => [d, song.charts?.[d]]))),
  ]).then(([stage, stats]) => {
    const analysis = { ...(stage.analysis || {}), bpm: stage.analysis?.bpm ?? song.bpm, durationMs: stage.durationMs ?? song.durationMs };
    $('previewStats').replaceChildren(renderStatsTable(stats, analysis));
  });
}

function setupTouchControls() {
  const mode = settings.touchControls;
  const coarse = matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches;
  document.body.classList.toggle('show-touch', mode === 'on' || (mode === 'auto' && coarse));
  if (mode === 'auto') {
    addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') document.body.classList.add('show-touch');
    }, { passive: true });
  }
}

function setupVideo() {
  const v = ui.video;
  v.addEventListener('loadedmetadata', () => {
    videoReady = true;
    const duration = v.duration * 1000;
    if (state && Number.isFinite(duration)) state.endTime = Math.min(state.endTime, duration);
    if (phase === 'ready') updateReady();
  });
  // iOS 등은 탭 전에는 메타데이터도 안 받을 수 있다: 잠시 뒤에는 시작 버튼을 열어 두고 탭으로 로딩
  setTimeout(() => {
    if (!videoReady && !v.error) {
      videoReady = true;
      if (phase === 'ready') updateReady();
    }
  }, 2500);
  v.addEventListener('error', () => {
    videoReady = false;
    if (phase === 'ready') updateReady();
    else if (phase === 'playing' || phase === 'paused') showError('영상을 재생할 수 없습니다.');
  });
  // OS 미디어 컨트롤: 위치 이동 금지, 재생은 [계속하기] 로만
  if ('mediaSession' in navigator) {
    for (const action of ['seekto', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'play']) {
      try { navigator.mediaSession.setActionHandler(action, () => {}); } catch { /* 지원 안 하는 액션 */ }
    }
    try { navigator.mediaSession.setActionHandler('pause', () => pause()); } catch { /* noop */ }
  }
  // 곡 하나만, 메타데이터만 먼저 받는다 (곡 선택 화면에서는 영상을 받지 않음)
  v.preload = 'metadata';
  v.src = song.video;
}

// ---------- 이벤트 ----------
addEventListener('keydown', e => {
  if (phase === 'playing') input.keydown(e);
  else if (phase === 'paused' && e.code === 'Escape' && !e.repeat) {
    e.preventDefault();
    resume();
  }
});
addEventListener('keyup', e => input?.keyup(e));
addEventListener('blur', () => input?.releaseAll());
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
addEventListener('pagehide', () => pause());

ui.pauseBtn.addEventListener('click', () => (phase === 'playing' ? pause() : null));
ui.start.addEventListener('click', begin);
$('resumeBtn').addEventListener('click', resume);
for (const id of ['restartBtn', 'retryBtn']) $(id).addEventListener('click', begin);
$('videoToggle').addEventListener('change', e => {
  setShowVideo(e.target.checked);
  if (!PREVIEW) updateSettings({ showVideo: e.target.checked });
});

new ResizeObserver(applyLayout).observe(ui.stage);

// 로그인 · 온라인 상태는 시작 전에 한 번만 확인 (플레이 중에는 서버 요청 없음)
const onlineStatus = PREVIEW || autoplay ? Promise.resolve({ onlineEnabled: false }) : getOnlineStatus();

async function init() {
  setupTouchControls();
  setupLanes(DEFAULT_LANE_COUNT);
  setShowVideo(showVideo);
  $('readySpeed').textContent = speedText(noteSpeed);
  $('readyNoFail').textContent = noFail ? 'ON' : 'OFF';
  $('noFailTag').hidden = !noFail;
  try {
    if (PREVIEW) {
      song = await loadPreviewSong(PREVIEW);
    } else {
      const catalog = await loadCatalog();
      if (!catalog.length) throw new Error('등록된 곡이 없습니다.');
      song = findSong(catalog, params.get('song'));
    }
  } catch (err) {
    showError(err.message || String(err));
    return;
  }
  document.title = `${song.title} · WONY RHYTHM`;
  $('songTitle').textContent = song.title;
  $('readyTitle').textContent = song.title;
  $('readyArtist').textContent = song.artist;
  if (song.cover) Object.assign($('readyCover'), { src: song.cover, hidden: false });
  if (PREVIEW) setupPreview();
  if (song.video) setupVideo();
  phase = 'ready';
  showOverlay('ready');
  applyLayout();
  await selectDifficulty(pickDifficulty(song, params.get('diff')) || 'easy');
}

if (autoplay || PREVIEW || params.has('debug')) {
  window.__wonyRhythm = {
    snapshot: () => ({
      phase, playId: state?.playId, life: state?.life, gameOver: state?.gameOver, resultStatus: phase === 'result' ? $('resultOverlay').dataset.status : null, noFail, time: gameTime(), videoTime: ui.video.currentTime * 1000, videoPaused: ui.video.paused,
      playbackRate: ui.video.playbackRate, showVideo, noteSpeed, approach, difficulty,
      score: state?.score, combo: state?.combo, maxCombo: state?.maxCombo, judged: state?.judged, total: state?.total,
      counts: state && { ...state.counts }, status: state?.status, endTime: state?.endTime,
      layout: layout && { width: layout.width, height: layout.height, landscape: layout.landscape, fieldW: layout.fieldW },
    }),
    pause, resume,
  };
}

init();
