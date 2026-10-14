// 곡 미리듣기: 화면 전체에서 <audio> 하나만 쓴다 → 동시에 두 곡이 나오지 않음.
// 누를 때만 영상 MP4 의 일부를 받는다 (곡 선택 화면에 들어왔다고 영상을 미리 받지 않음).
// 소리 설정(마스터 × 음악, 음소거) 그대로. 음소거면 받지도 재생하지도 않는다.
import { applyMediaVolume, musicGain, musicVolumeLocked } from './audio.js';

export const PREVIEW_MS = 15000;
const FADE_MS = 600;

/** 미리듣기 시작 위치: songs.json previewStartMs > 음악 시작 + 곡 길이의 30% 지점 */
export function previewStartMs(song) {
  if (Number.isFinite(song?.previewStartMs)) return song.previewStartMs;
  const start = Number(song?.musicStartMs) || 0;
  const duration = Number(song?.durationMs) || 0;
  return Math.max(start, Math.round(duration * 0.3));
}

export function createPreviewPlayer({ getSettings, onChange = () => {} } = {}) {
  const audio = document.createElement('audio');
  audio.preload = 'none';
  audio.id = 'previewAudio';
  audio.hidden = true;
  document.body.append(audio);
  let current = null;
  let timer = 0;
  let fade = 0;

  const notify = () => onChange(current);

  function clearTimers() {
    clearTimeout(timer);
    clearInterval(fade);
    timer = 0;
    fade = 0;
  }

  function stop() {
    clearTimers();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    current = null;
    notify();
  }

  /** 볼륨을 줄이며 끝 (볼륨을 못 바꾸는 기기는 바로 정지) */
  function fadeOutAndStop() {
    const s = getSettings();
    if (musicVolumeLocked()) return stop();
    const target = musicGain(s);
    const steps = Math.max(1, Math.round(FADE_MS / 50));
    let i = 0;
    clearInterval(fade);
    fade = setInterval(() => {
      i++;
      audio.volume = Math.max(0, target * (1 - i / steps));
      if (i >= steps) stop();
    }, 50);
  }

  /**
   * @returns {'playing'|'stopped'|'muted'|'no-media'}
   */
  function toggle(song) {
    if (current?.id === song.id) {
      stop();
      return 'stopped';
    }
    const s = getSettings();
    if (s.muted) return 'muted';
    if (!song.video) return 'no-media';
    stop();
    current = song;
    applyMediaVolume(audio, s);
    audio.src = song.preview || song.video;
    const begin = () => {
      try { audio.currentTime = previewStartMs(song) / 1000; } catch { /* 일부 브라우저: 메타데이터 전 */ }
    };
    audio.addEventListener('loadedmetadata', begin, { once: true });
    audio.play().catch(() => {
      if (current?.id === song.id) stop();
    });
    timer = setTimeout(fadeOutAndStop, PREVIEW_MS - FADE_MS);
    notify();
    return 'playing';
  }

  audio.addEventListener('ended', stop);
  addEventListener('pagehide', stop);
  return { toggle, stop, get current() { return current; }, audio };
}
