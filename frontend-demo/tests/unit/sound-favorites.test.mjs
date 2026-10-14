// 소리 설정 · 효과음 · 즐겨찾기 · 워니 문구 · 미리듣기 시작 위치
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../js/config.js';
import {
  SFX_KINDS, applyMediaVolume, musicGain, musicVolumeLocked, playSfx, resetAudioDetection, sfxGain, sfxStats,
} from '../../js/audio.js';
import { previewStartMs } from '../../js/preview-player.js';
import {
  MEMBER_FREE_KEYS, STORAGE_KEYS, isFavorite, loadFavorites, loadSettings, saveSettings, setStorageBackend, toggleFavorite, updateSettings,
} from '../../js/storage.js';
import { WONY_IMAGE, WONY_LINES, pickLine } from '../../js/wony-lines.js';
import { MemoryStorage } from './helpers.mjs';

let store;
beforeEach(() => {
  store = new MemoryStorage();
  setStorageBackend(store);
  resetAudioDetection();
});

test('소리 기본값: 마스터 80 · 음악 100 · 효과음 60 · 음소거 꺼짐', () => {
  const s = loadSettings();
  assert.deepEqual([s.masterVolume, s.musicVolume, s.sfxVolume, s.muted], [80, 100, 60, false]);
  assert.equal(DEFAULT_SETTINGS.sfxVolume, 60);
});

test('소리 설정은 wony_rhythm_settings 에 저장 · 0~100 정수로 정리', () => {
  updateSettings({ masterVolume: 55, musicVolume: 40, sfxVolume: 0, muted: true });
  const raw = JSON.parse(store.getItem(STORAGE_KEYS.settings));
  assert.deepEqual([raw.masterVolume, raw.musicVolume, raw.sfxVolume, raw.muted], [55, 40, 0, true]);
  saveSettings({ ...loadSettings(), masterVolume: 150, musicVolume: -5, sfxVolume: 33.6 });
  const s = loadSettings();
  assert.deepEqual([s.masterVolume, s.musicVolume, s.sfxVolume], [100, 0, 34]);
  store.setItem(STORAGE_KEYS.settings, JSON.stringify({ masterVolume: 'x', musicVolume: null, sfxVolume: {}, muted: 'yes' }));
  assert.deepEqual(['masterVolume', 'musicVolume', 'sfxVolume', 'muted'].map(k => loadSettings()[k]), [80, 100, 60, false], '깨진 값은 기본값');
});

test('실제 볼륨: 음악 = 마스터 × 음악, 효과음 = 마스터 × 효과음, 음소거면 둘 다 0', () => {
  const s = { masterVolume: 80, musicVolume: 50, sfxVolume: 60, muted: false };
  assert.equal(musicGain(s), 0.4);
  assert.equal(Math.round(sfxGain(s) * 100) / 100, 0.48);
  assert.equal(musicGain({ ...s, muted: true }), 0);
  assert.equal(sfxGain({ ...s, muted: true }), 0);
  assert.equal(musicGain({ ...s, masterVolume: 0 }), 0);
});

test('미디어 요소: 볼륨 · 음소거 적용, 볼륨을 못 바꾸는 기기(iPhone)는 음소거만', () => {
  const normal = () => ({ volume: 1, muted: false });
  assert.equal(musicVolumeLocked(normal), false);
  const el = normal();
  applyMediaVolume(el, { masterVolume: 50, musicVolume: 50, muted: false });
  assert.deepEqual([el.volume, el.muted], [0.25, false]);
  applyMediaVolume(el, { masterVolume: 50, musicVolume: 50, muted: true });
  assert.deepEqual([el.volume, el.muted], [0, true]);

  resetAudioDetection();
  const ios = () => { const o = { muted: false }; Object.defineProperty(o, 'volume', { get: () => 1, set: () => {} }); return o; };
  assert.equal(musicVolumeLocked(ios), true, 'volume 을 바꿔도 1 그대로 = iPhone Safari');
  const v = ios();
  applyMediaVolume(v, { masterVolume: 30, musicVolume: 30, muted: true });
  assert.deepEqual([v.volume, v.muted], [1, true], '음소거는 동작');
});

test('효과음: 판정별 소리 4종 + 버튼음, 음소거 · 볼륨 0 이면 만들지 않음', () => {
  assert.deepEqual(SFX_KINDS, ['PERFECT', 'GREAT', 'GOOD', 'MISS', 'button']);
  const before = sfxStats.skipped;
  assert.equal(playSfx('PERFECT', { ...DEFAULT_SETTINGS, muted: true }), false);
  assert.equal(playSfx('GOOD', { ...DEFAULT_SETTINGS, sfxVolume: 0 }), false);
  assert.equal(sfxStats.skipped, before + 2);
  assert.equal(playSfx('nope', DEFAULT_SETTINGS), false);
  assert.equal(playSfx('PERFECT', DEFAULT_SETTINGS), false, 'Node 에는 AudioContext 없음 → 조용히 무시');
});

test('즐겨찾기: wony_rhythm_favorites (허용된 localStorage 항목), 켜기/끄기 · 깨진 값 정리', () => {
  assert.ok(MEMBER_FREE_KEYS.includes('wony_rhythm_favorites'));
  assert.equal(STORAGE_KEYS.favorites, 'wony_rhythm_favorites');
  assert.deepEqual(loadFavorites(), []);
  assert.equal(toggleFavorite('demo-beat'), true);
  assert.equal(toggleFavorite('wony-cover-01'), true);
  assert.deepEqual(loadFavorites(), ['wony-cover-01', 'demo-beat']);
  assert.equal(isFavorite('demo-beat'), true);
  assert.equal(toggleFavorite('demo-beat'), false);
  assert.deepEqual(loadFavorites(), ['wony-cover-01']);
  assert.equal(toggleFavorite('../bad'), false);
  store.setItem('wony_rhythm_favorites', JSON.stringify(['ok-1', 'ok-1', 5, 'BAD', null, 'ok-2']));
  assert.deepEqual(loadFavorites(), ['ok-1', 'ok-2']);
  store.setItem('wony_rhythm_favorites', '{broken');
  assert.deepEqual(loadFavorites(), []);
});

test('워니 문구는 데이터 파일 하나: 메인 · 결과 상황별, 이미지 경로 고정', () => {
  assert.equal(WONY_IMAGE, '/assets/wony/wony.png');
  assert.ok(WONY_LINES.home.length > 0);
  for (const k of ['CLEAR', 'GAME_OVER', 'NO_FAIL_CLEAR', 'autoplay', 'rankUp', 'firstRank']) assert.ok(WONY_LINES.result[k].length > 0, k);
  assert.equal(pickLine(['{name}님 안녕'], { seed: 0, name: '워니팬' }), '워니팬님 안녕');
  assert.equal(pickLine(['a', 'b'], { seed: 0.99 }), 'b');
  assert.equal(pickLine([], {}), '');
});

test('미리듣기 시작 위치: previewStartMs > 음악 시작 · 곡 길이 30%', () => {
  assert.equal(previewStartMs({ previewStartMs: 61000, durationMs: 200000 }), 61000);
  assert.equal(previewStartMs({ musicStartMs: 4000, durationMs: 228530 }), 68559);
  assert.equal(previewStartMs({ musicStartMs: 4000, durationMs: 10000 }), 4000);
});
