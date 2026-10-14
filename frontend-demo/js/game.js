// 게임 화면 컨트롤러: video 시계 → 엔진 → 렌더러.
// - 게임 시간은 video.currentTime 하나뿐이다 (clock.js). 노트 위치·판정·진행률·종료가 모두 같은 값을 본다.
// - 게임 상태(engine)와 화면 크기(layout)는 분리: 회전/리사이즈/영상 ON·OFF 때 layout 만 다시 계산한다.
// - 플레이 중 서버 요청 없음. 영상 파일은 선택한 곡 하나만 preload="metadata" 로 준비한다.
import {
  COUNTDOWN_MS, DEFAULT_LANE_COUNT, DIFFICULTIES, DIFFICULTY_LABELS, LANE_MODE_LABELS, MIN_TOUCH_LANE_PX, RESULT_STATUS,
  RESULT_STATUS_LABELS, normalizeLaneCount,
} from './config.js';
import { findSong, loadCatalog, loadChart, loadPreviewSong, pickDifficulty } from './catalog.js';
import { VideoClock } from './clock.js';
import {
  createGame, finishGame, hitLane, isFinished, notNormalClearReason, pauseGame, resultRecord, resumeGame, startGame, updateGame,
} from './engine.js';
import { bestOf, loadMyRecords, loadRanking, submitRanking } from './ranking.js';
import { runResultOnline } from './result-online.js';
import { requireMember } from './session.js';
import { applyUiSkin, rhythmBarTheme } from './theme.js';
import { formatMs } from './chart-stats.js';
import { loadChartStats, renderStatsTable } from './preview-stats.js';
import { createInput } from './input.js';
import { keyLabel } from './keys.js';
import { approachMs, computeLayout, judgeOffsetFor, normalizeSpeed } from './layout.js';
import { createRenderer } from './render.js';
import { keysFor, loadSettings, saveLastSelection, updateSettings } from './storage.js';
import { applyMediaVolume, installButtonSound, playSfx, sfxStats, unlockSfx } from './audio.js';
import { renderWony } from './wony.js';
import { WONY_LINES, pickLine } from './wony-lines.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PREVIEW = params.get('preview') || '';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const speedText = s => `${Number(s)}x`;

// 설정은 게임 화면을 열 때 한 번만 읽는다 (게임 도중 키/배속 변경 없음).
const settings = loadSettings();
const noteSpeed = normalizeSpeed(params.get('speed') ?? settings.noteSpeed);
const approach = approachMs(noteSpeed);
let showVideo = params.has('video') ? params.get('video') !== '0' : settings.showVideo;
let autoplay = params.get('autoplay') === '1';
const noFail = params.has('nofail') ? params.get('nofail') === '1' : settings.noFail;
// KEY 모드 (4 / 6 / 8): 곡 선택 화면이 &keys= 로 넘김, 없으면 설정값. 미리보기는 4키 채보만 만든다
const laneMode = normalizeLaneCount(params.get('keys') ?? (PREVIEW ? DEFAULT_LANE_COUNT : settings.laneCount));
let chartError = '';
let touchNarrow = false;   // 터치 버튼이 최소 폭보다 좁아지는 화면 (예: 휴대폰 세로 8 KEY)

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
const hud = { seq: 0, score: -1, combo: -1, countdown: null, judgementAt: 0, progress: -1, life: -1, lifeMax: -1, healSeq: 0, healAt: 0 };
const lifeText = v => String(Math.round(v * 10) / 10);
// 화면 효과는 Web Animations(transform · opacity)만 쓰고 게임 시계와 무관 (동작 줄이기면 생략)
const pop = (el, frames, opts) => {
  if (!reducedMotion.matches && el.animate) el.animate(frames, opts);
};

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
let sfxSeq = 0;   // 효과음을 이미 낸 판정 (입력 판정은 바로, 자동 MISS 는 HUD 갱신 때)
function pressLane(lane) {
  if (phase !== 'playing') return;
  const judgement = hitLane(state, lane, gameTime());
  if (judgement) {
    flashes[lane] = { grade: judgement.grade, at: performance.now() };
    sfxSeq = judgement.seq;
    playSfx(judgement.grade, settings);   // 판정이 끝난 뒤 소리만 (판정 · 시계와 무관)
  }
}

// ---------- 화면 크기 (게임 상태와 무관) ----------
function applyLayout() {
  const rect = ui.stage.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  // 판정선은 화면 아래 기준 고정 (영상 ON/OFF · 회전과 무관하게 같은 거리)
  layout = computeLayout(rect.width, rect.height, devicePixelRatio, laneCount || DEFAULT_LANE_COUNT,
    { judgeOffset: judgeOffsetFor(stableViewportHeight()) });
  renderer.resize(layout, labels);
  draw(gameTime());
  checkTouchFit();
}

/** 터치 버튼이 너무 작아지면 시작하지 않고 가로 화면으로 안내 (플레이할 수 없는 버튼은 만들지 않음) */
function checkTouchFit() {
  const btn = ui.laneButtons[0];
  const narrow = document.body.classList.contains('show-touch') && btn ? btn.getBoundingClientRect().width < MIN_TOUCH_LANE_PX : false;
  const portrait = innerHeight > innerWidth;
  $('readyHint').hidden = !(document.body.classList.contains('show-touch') && portrait && laneCount >= 8 && !narrow);
  if (narrow === touchNarrow) return;
  touchNarrow = narrow;
  if (phase === 'ready' && song) updateReady();
}

/**
 * 판정선 거리 계산용 화면 높이. 휴대폰은 주소창이 나타나고 사라질 때 innerHeight 가 바뀌므로 기기 화면 크기(방향 기준)를 쓴다.
 * (판정선은 게임 영역 아래 끝 기준이라 영상 ON/OFF 와 무관하고, 주소창 때문에 흔들리지도 않음)
 */
function stableViewportHeight() {
  if (!matchMedia('(pointer: coarse)').matches || !screen?.width) return innerHeight;
  const portrait = innerHeight >= innerWidth;
  return Math.min(innerHeight + 200, portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height));
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
  if (state.lifeMax !== hud.lifeMax) renderHearts();
  if (state.life !== hud.life) {
    const dropped = hud.life >= 0 && state.life < hud.life;
    hud.life = state.life;
    updateHearts();
    if (dropped) pop($('lifeHearts'), [{ transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], { duration: 160 });
  }
  const heal = state.lastHeal;
  if (heal && heal.seq !== hud.healSeq) {   // 콤보 회복: "+0.5 LIFE" + 하트 pulse
    hud.healSeq = heal.seq;
    hud.healAt = performance.now();
    $('lifeHeal').textContent = `+${lifeText(heal.amount)} LIFE`;
    $('lifeHeal').hidden = false;
    $('lifeMeter').classList.add('is-healing');
    pop($('lifeHeal'), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(-4px)', offset: 0.3 }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: 900, easing: 'ease-out' });
    pop($('lifeHearts'), [{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 360, easing: 'ease-out' });
  } else if (hud.healAt && performance.now() - hud.healAt > 900) {
    hud.healAt = 0;
    $('lifeHeal').hidden = true;
    $('lifeMeter').classList.remove('is-healing');
  }
  if (state.combo !== hud.combo) {
    const up = state.combo > hud.combo;
    hud.combo = state.combo;
    ui.comboNum.textContent = state.combo;
    ui.combo.hidden = state.combo < 2;
    const milestone = state.combo > 0 && state.combo % 10 === 0;
    ui.combo.classList.toggle('is-milestone', milestone);
    if (up && !ui.combo.hidden) {
      pop(ui.comboNum, [{ transform: `scale(${milestone ? 1.4 : 1.16})` }, { transform: 'scale(1)' }], { duration: milestone ? 260 : 120, easing: 'ease-out' });
    }
  }
  const j = state.lastJudgement;
  if (j && j.seq !== hud.seq && j.seq !== sfxSeq) {   // 놓쳐서 지나간 노트(자동 MISS) 효과음
    sfxSeq = j.seq;
    playSfx(j.grade, settings);
  }
  if (j && j.seq !== hud.seq) {
    hud.seq = j.seq;
    hud.judgementAt = performance.now();
    ui.judgement.textContent = j.grade;
    ui.judgement.className = `judgement is-${j.grade.toLowerCase()}`;
    ui.judgement.hidden = false;
    if (j.grade === 'MISS') {
      pop(ui.judgement, [{ transform: 'translateY(-6px)', opacity: 0.4 }, { transform: 'translateY(4px)' }, { transform: 'none', opacity: 1 }], { duration: 180, easing: 'ease-out' });
    } else {
      pop(ui.judgement, [{ transform: `scale(${j.grade === 'PERFECT' ? 1.35 : 1.2})`, opacity: 0.6 }, { transform: 'scale(1)', opacity: 1 }], { duration: 140, easing: 'ease-out' });
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
  const total = Number.isFinite(state.endTime) ? state.endTime : (state.notes.at(-1)?.time ?? 1);
  const progress = Math.round(Math.min(1, Math.max(0, t / total)) * 500) / 500;
  if (progress !== hud.progress) {
    hud.progress = progress;
    ui.progress.style.transform = `scaleX(${progress})`;
  }
}

function resetHud() {
  Object.assign(hud, { seq: 0, score: -1, combo: -1, countdown: null, judgementAt: 0, progress: -1, life: -1, lifeMax: -1, healSeq: 0, healAt: 0 });
  ui.judgement.hidden = true;
  $('lifeHeal').hidden = true;
  $('lifeMeter').classList.remove('is-healing');
  flashes.fill(null);
}

/** LIFE 하트: 최대 LIFE 개수만큼 (난이도마다 다름) */
function renderHearts() {
  hud.lifeMax = state.lifeMax;
  hud.life = -1;
  $('lifeHearts').replaceChildren(...Array.from({ length: state.lifeMax }, () => Object.assign(document.createElement('i'), { className: 'heart' })));
  $('lifeMax').textContent = lifeText(state.lifeMax);
  $('lifeMeter').setAttribute('aria-valuemax', String(state.lifeMax));
  $('lifeMeter').dataset.max = String(state.lifeMax);
}

function updateHearts() {
  const life = state.life;
  $('lifeHearts').querySelectorAll('.heart').forEach((h, i) => {
    h.dataset.fill = life >= i + 1 ? 'full' : life >= i + 0.5 ? 'half' : 'empty';
  });
  $('lifeNum').textContent = lifeText(life);
  const ratio = life / state.lifeMax;
  $('lifeMeter').dataset.level = ratio > 0.5 ? 'high' : ratio > 0.25 ? 'mid' : 'low';
  $('lifeMeter').setAttribute('aria-valuenow', lifeText(life));
  $('lifeMeter').setAttribute('aria-valuetext', `LIFE ${lifeText(life)} / ${lifeText(state.lifeMax)}`);
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
/**
 * 게임이 정상 종료(CLEAR · NO FAIL CLEAR)되는 시각 = 실제 영상(음악)의 끝.
 * 마지막 노트 이후에도 음악이 남아 있으면 끝까지 기다린다 (채보 endMs 는 쓰지 않음: 음악 끝 감지가 이르면 곡이 남은 채로 끝났음).
 * 엔진(updateGame)은 "모든 노트 판정 && 시간 >= endTime" 일 때 끝내고, 영상 ended 이벤트(clock.ended)도 함께 본다.
 * 길이를 아직 모르면 Infinity → 영상이 실제로 끝났을 때만 종료. GAME OVER(LIFE 0)는 엔진이 즉시 종료.
 */
const MEDIA_END_TOLERANCE_MS = 120;
function mediaEndTime() {
  const duration = ui.video.duration * 1000;
  return Number.isFinite(duration) && duration > 0 ? duration - MEDIA_END_TOLERANCE_MS : Infinity;
}

/** 반드시 사용자 탭·클릭 안에서 호출 (모바일 자동재생 정책). */
function begin() {
  if (!chart || !videoReady || !memberReady()) return;   // 로그인 확인 전 · 비로그인은 시작 불가
  stopLoop();
  clock?.stop();
  input.releaseAll();
  state = createGame(chart, { difficulty, noFail, laneCount });
  state.endTime = mediaEndTime();   // 정상 종료 = 모든 노트 판정 + 영상(음악) 끝 (채보 endMs 아님)
  clock ||= new VideoClock(ui.video, { allowSeek: false });
  // 소리 설정: 음악 = 마스터 × 음악/영상 (video.volume), 음소거는 muted (iPhone 도). 효과음은 이 탭 안에서 준비
  applyMediaVolume(ui.video, settings);
  clock.muted = settings.muted;
  unlockSfx(settings);
  sfxSeq = 0;
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

const RESULT_REVEAL_MS = 900;   // 결과 패널 + 등급 등장 연출 (css #resultOverlay.is-revealing)
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
  // 기록은 이 기기에 저장하지 않는다 (로그인 필수). 서버 저장 · 최고 기록 · 랭킹 · 츄르는 result-online.js 가 1번:
  //   최고 기록 · 랭킹 · 츄르 = 정상 CLEAR 만, 최근 플레이 = AUTO/PREVIEW 제외 전부 (DB 가 같은 규칙으로 다시 확인)
  const skipped = notNormalClearReason(record, context);
  const gameOver = record.status === RESULT_STATUS.GAME_OVER;
  $('resultTitle').textContent = RESULT_TITLES[record.status] || 'CLEAR!';
  $('resultOverlay').classList.toggle('is-game-over', gameOver);
  $('resultOverlay').dataset.status = record.status;
  $('resMeta').textContent = [DIFFICULTY_LABELS[difficulty], LANE_MODE_LABELS[record.laneCount], speedText(noteSpeed), RESULT_STATUS_LABELS[record.status]].join(' · ');
  $('resGrade').textContent = record.grade;
  $('resGrade').dataset.grade = record.grade;
  $('resLife').textContent = `${lifeText(record.life)} / ${lifeText(record.lifeMax)}`;
  $('resScore').textContent = fmt(record.score);
  $('resCombo').textContent = fmt(record.maxCombo);
  $('resAccuracy').textContent = `${record.accuracy.toFixed(2)}%`;
  $('resPERFECT').textContent = fmt(record.perfect);
  $('resGREAT').textContent = fmt(record.great);
  $('resGOOD').textContent = fmt(record.good);
  $('resMISS').textContent = fmt(record.miss);
  $('resBest').textContent = '-';           // 서버 저장 결과로 채움 (result-online.js)
  $('resNewBest').hidden = true;
  $('resNoSave').textContent = BEST_SKIP_TEXT[skipped] || '';
  $('resNoSave').hidden = !skipped;
  const wonyKey = context.autoplay || context.preview ? 'autoplay' : record.status;
  renderWony($('resWony'), pickLine(WONY_LINES.result[wonyKey] || WONY_LINES.result.CLEAR));
  const rankingHref = `/ranking?song=${encodeURIComponent(song.id)}&diff=${difficulty}`;
  $('resRankingLink').href = rankingHref;
  // 1. 결과 패널 → 2. 등급 등장 (CSS transform · opacity, 동작 줄이기면 없음) → 3. 랭킹 → 4. 츄르
  const overlay = $('resultOverlay');
  overlay.classList.remove('is-revealing');
  void overlay.offsetWidth;   // 연출 다시 시작 (결과 화면에서 1번, 플레이 중 아님)
  overlay.classList.toggle('is-revealing', !reducedMotion.matches);
  showOverlay('result');
  // 결과를 먼저 보여준 뒤 온라인 랭킹 · 츄르를 비동기로 (실패해도 결과 · 로컬 기록은 그대로)
  const seq = ++resultSeq;
  runResultOnline({
    record, context, online: onlineStatus, rankingHref,
    els: {
      box: $('resOnline'), status: $('resOnlineStatus'), change: $('resRankChange'), medal: $('resRankMedal'),
      transition: $('resRankTransition'), delta: $('resRankDelta'), badges: $('resRankBadges'), ranking: $('resRanking'),
      fullRanking: $('resFullRanking'), churu: $('resChuru'), churuTitle: $('resChuruTitle'), churuAmount: $('resChuruAmount'),
      churuFrom: $('resChuruFrom'), churuTo: $('resChuruTo'), churuNote: $('resChuruNote'), login: $('resLogin'),
      best: $('resBest'), newBest: $('resNewBest'),
    },
    deps: { submitRanking, loadRanking },
    reducedMotion: reducedMotion.matches,
    ready: new Promise(r => setTimeout(r, reducedMotion.matches ? 0 : RESULT_REVEAL_MS)),
    isCurrent: () => phase === 'result' && seq === resultSeq, // 다시 하기를 누르면 표시 중단 (저장은 이미 요청됨)
  }).then(out => {
    // 순위가 오르거나 처음 랭킹에 들면 워니 말풍선도 바꿈
    const line = out?.change?.kind === 'up' ? WONY_LINES.result.rankUp : out?.change?.kind === 'first' ? WONY_LINES.result.firstRank : null;
    if (line && seq === resultSeq) renderWony($('resWony'), pickLine(line));
  }).catch(() => {
    $('resOnlineStatus').textContent = '온라인 기록을 불러오지 못했습니다.';
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
  if (!chart) problems.push(chartError || '채보 준비 중');
  else if (touchNarrow) problems.push(`${LANE_MODE_LABELS[laneCount]}는 이 화면에서 버튼이 너무 작아요. 가로 화면으로 돌려주세요.`);
  ui.problem.textContent = problems.join(' · ');
  ui.problem.hidden = !problems.length;
  ui.start.disabled = problems.length > 0 || !videoReady || !memberReady();
  ui.start.textContent = !PREVIEW && member.state === 'checking' ? '로그인 확인 중…'
    : song.video && !videoReady && !ui.video.error ? '영상 불러오는 중…' : '▶ 게임 시작';
  $('readyLogin').hidden = PREVIEW || member.state !== 'none';
  ui.videoMsg.hidden = Boolean(song.video) && !ui.video.error;
  ui.videoMsg.textContent = song.video ? '영상을 불러오지 못했습니다' : '영상 준비 중';
  $('diffBadge').textContent = DIFFICULTY_LABELS[difficulty];
  $('diffBadge').dataset.diff = difficulty;
  $('readyDiff').textContent = DIFFICULTY_LABELS[difficulty];
  $('readyDiff').dataset.diff = difficulty;
  $('readyNotes').textContent = chart ? fmt(chart.notes.length) : '-';
  $('readyKeys').textContent = LANE_MODE_LABELS[laneMode];
  const bestRec = myBest && bestOf(myBest, song.id, difficulty, state?.laneCount ?? DEFAULT_LANE_COUNT);
  $('readyBest').textContent = PREVIEW || !myBest ? '-' : `${fmt(bestRec?.bestScore ?? 0)}${bestRec?.bestGrade ? ` (${bestRec.bestGrade})` : ''}`;
  if (PREVIEW) {
    for (const btn of $('previewDiffs').querySelectorAll('button')) btn.setAttribute('aria-checked', String(btn.dataset.diff === difficulty));
  }
  if (phase === 'ready' && !ui.start.disabled && document.activeElement === document.body) ui.start.focus({ preventScroll: true });
}

async function selectDifficulty(diff) {
  difficulty = diff;
  try {
    chart = await loadChart(song, difficulty, laneMode);   // 고른 KEY 모드의 채보 (laneCount 가 다르면 거절)
    chartError = '';
  } catch (err) {
    chart = null;
    chartError = err.message || '채보 준비 중';   // 예: "이 곡은 현재 4 KEY 채보만 지원합니다."
  }
  setupLanes(chart?.laneCount ?? laneMode); // KEY 모드에 맞춰 키/터치 버튼/레이아웃 준비
  renderer.setBeatGrid(chart);   // 박자 · 마디 가이드 (표시 전용)
  state = createGame(chart || { notes: [] }, { difficulty, noFail, laneCount });
  if (!PREVIEW) saveLastSelection(song.id, difficulty);
  draw(-COUNTDOWN_MS);
  renderHearts();   // 준비 화면에서도 이 난이도의 최대 LIFE 표시
  updateHearts();
  hud.life = state.life;
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
    if (state) state.endTime = mediaEndTime();
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
  applyMediaVolume(v, settings);
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
installButtonSound(() => settings);   // 시작 · 일시정지 · 결과 버튼음 (레인 버튼은 판정음)

// 로그인 필수: 서버가 세션 없는 요청엔 이 화면 대신 로그인 안내를 보내고, 여기서 시작 전에 한 번 더 확인한다.
// 플레이 중에는 확인하지 않는다 (세션이 만료돼도 진행 중인 판은 끝까지, 만료는 결과 저장 때 안내).
// PREVIEW = 로컬 관리자 도구(tools/admin_server.py)의 채보 미리보기: 서버로 아무것도 보내지 않음.
const member = { state: PREVIEW ? 'preview' : 'checking' };
const onlineStatus = PREVIEW ? Promise.resolve({ onlineEnabled: false, loggedIn: false }) : requireMember();
let myBest = null;   // 서버의 내 최고 기록 (준비 화면 표시용)
function memberReady() {
  return PREVIEW || member.state === 'ok';
}
if (!PREVIEW) {
  onlineStatus.then(s => {
    member.state = s.loggedIn ? 'ok' : 'none';
    if (phase === 'ready') updateReady();
    if (s.loggedIn && s.onlineEnabled) {
      loadMyRecords().then(r => {
        myBest = r.ok ? r.best : null;
        if (phase === 'ready') updateReady();
      });
    }
  });
}

async function init() {
  setupTouchControls();
  setupLanes(laneMode);
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
      phase, member: member.state, playId: state?.playId, life: state?.life, gameOver: state?.gameOver, resultStatus: phase === 'result' ? $('resultOverlay').dataset.status : null, noFail, time: gameTime(), videoTime: ui.video.currentTime * 1000, videoPaused: ui.video.paused,
      playbackRate: ui.video.playbackRate, showVideo, noteSpeed, approach, difficulty,
      score: state?.score, combo: state?.combo, maxCombo: state?.maxCombo, judged: state?.judged, total: state?.total,
      counts: state && { ...state.counts }, status: state?.status, endTime: state?.endTime,
      videoDuration: ui.video.duration * 1000, videoEnded: ui.video.ended, lastNoteTime: state?.notes.at(-1)?.time,
      layout: layout && { width: layout.width, height: layout.height, landscape: layout.landscape, fieldW: layout.fieldW,
        judgeY: layout.judgeY, judgeScreenY: Math.round(ui.stage.getBoundingClientRect().top + layout.judgeY) },
      lifeMax: state?.lifeMax, healed: state?.healed, videoVolume: ui.video.volume, videoMuted: ui.video.muted, sfxPlayed: sfxStats.played, laneCount: state?.laneCount, laneMode, touchNarrow,
    }),
    pause, resume,
  };
}

init();
