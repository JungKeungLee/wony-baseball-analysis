// 소리: 음악(영상 · 미리듣기) 볼륨, 효과음(판정음 · 버튼음), 음소거.
//
//   음악   = 마스터 × 음악/영상 → <video>/<audio>.volume  (음악은 영상 MP4 의 오디오 그대로, Web Audio 로 우회하지 않음)
//   효과음 = 마스터 × 효과음    → 짧은 합성음 (Web Audio, 파일 없음)
//   음소거 = 음악 · 미리듣기 · 효과음 모두 무음 (요소는 muted, 효과음은 아예 만들지 않음)
//
// iPhone/iPad Safari 는 미디어 요소의 volume 을 바꿀 수 없다(항상 1). 이때는 음악 볼륨 슬라이더를 숨기고
// "기기 볼륨 버튼" 안내만 한다 (musicVolumeLocked). 음소거(muted)는 iPhone 에서도 동작한다.
// 효과음은 판정이 끝난 뒤 소리만 낸다: 판정 · 점수 · 게임 시계(video.currentTime)와 무관.
import { DEFAULT_SETTINGS } from './config.js';

const pct = v => Math.min(100, Math.max(0, Number(v) || 0)) / 100;

/** 실제 음악 볼륨 0~1 */
export function musicGain(s = DEFAULT_SETTINGS) {
  return s.muted ? 0 : pct(s.masterVolume) * pct(s.musicVolume);
}

/** 실제 효과음 볼륨 0~1 */
export function sfxGain(s = DEFAULT_SETTINGS) {
  return s.muted ? 0 : pct(s.masterVolume) * pct(s.sfxVolume);
}

let locked = null;
/** 이 브라우저가 미디어 요소 볼륨을 무시하는지 (iPhone Safari 등). 실제로 바꿔 보고 확인 */
export function musicVolumeLocked(make = () => document.createElement('audio')) {
  if (locked !== null) return locked;
  try {
    const el = make();
    el.volume = 0.5;
    locked = Math.abs(el.volume - 0.5) > 0.01;
  } catch {
    locked = true;
  }
  return locked;
}

/** 테스트용 */
export function resetAudioDetection() {
  locked = null;
}

/** <video>/<audio> 에 소리 설정 적용 (음소거는 muted, 볼륨을 못 바꾸는 기기는 volume 생략) */
export function applyMediaVolume(el, s = DEFAULT_SETTINGS) {
  if (!el) return;
  el.muted = s.muted === true;
  if (!musicVolumeLocked()) {
    try { el.volume = musicGain(s); } catch { /* 읽기 전용 */ }
  }
}

// ── 효과음 ───────────────────────────────────────────────────────────────────
// 판정별로 구분되는 부드러운 짧은 음 (높을수록 좋은 판정, MISS 는 낮고 둔한 소리). base = 기준 음량
const SFX = Object.freeze({
  PERFECT: { type: 'sine', freq: 1320, to: 1480, ms: 70, base: 0.16 },
  GREAT: { type: 'sine', freq: 990, to: 1050, ms: 65, base: 0.14 },
  GOOD: { type: 'triangle', freq: 700, to: 680, ms: 60, base: 0.12 },
  MISS: { type: 'triangle', freq: 190, to: 120, ms: 110, base: 0.14 },
  button: { type: 'sine', freq: 880, to: 880, ms: 35, base: 0.08 },
});
export const SFX_KINDS = Object.freeze(Object.keys(SFX));

let ctx = null;
const lastAt = {};
export const sfxStats = { played: 0, skipped: 0 };   // 테스트 · 디버그용

function audioContext() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

/** 사용자 탭/클릭 안에서 호출: 모바일에서 효과음이 나도록 준비 (무음이면 아무것도 만들지 않음) */
export function unlockSfx(s = DEFAULT_SETTINGS) {
  if (sfxGain(s) <= 0) return;
  const c = audioContext();
  if (c?.state === 'suspended') c.resume().catch(() => {});
}

/**
 * 효과음 1번. 음소거 · 볼륨 0 이면 소리를 만들지 않는다.
 * 동시치기 등으로 같은 소리가 아주 짧은 간격(20ms)에 겹치면 1번만 (성능 · 귀 보호).
 */
export function playSfx(kind, s = DEFAULT_SETTINGS) {
  const def = SFX[kind];
  const gain = sfxGain(s);
  if (!def || gain <= 0) {
    sfxStats.skipped++;
    return false;
  }
  const c = audioContext();
  if (!c) return false;
  const now = c.currentTime;
  if (lastAt[kind] !== undefined && now - lastAt[kind] < 0.02) return false;
  lastAt[kind] = now;
  try {
    if (c.state === 'suspended') c.resume().catch(() => {});
    const osc = c.createOscillator();
    const amp = c.createGain();
    const end = now + def.ms / 1000;
    osc.type = def.type;
    osc.frequency.setValueAtTime(def.freq, now);
    osc.frequency.linearRampToValueAtTime(def.to, end);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, def.base * gain), now + 0.006);   // 아주 짧게 올리고
    amp.gain.exponentialRampToValueAtTime(0.0001, end);                                     // 부드럽게 줄임 (딸깍 소리 방지)
    osc.connect(amp).connect(c.destination);
    osc.start(now);
    osc.stop(end + 0.02);
    sfxStats.played++;
    return true;
  } catch {
    return false;
  }
}

/** 페이지 공통 버튼음: 버튼 · 링크 버튼 · 메뉴 · 선택지를 누를 때 (레인 버튼은 판정음이 대신) */
export function installButtonSound(getSettings) {
  document.addEventListener('pointerdown', e => {
    const target = e.target.closest?.('button, a.btn, a.menu-item, .diff-option, .song-card, .icon-link');
    if (!target || target.classList.contains('lane-btn') || target.disabled) return;
    const s = getSettings();
    unlockSfx(s);
    playSfx('button', s);
  }, { passive: true, capture: true });
}
