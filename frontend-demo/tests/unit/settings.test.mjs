import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KEYS } from '../../js/config.js';
import { assignKey, isTypingTarget, keyLabel } from '../../js/keys.js';
import {
  STORAGE_KEYS, loadSettings, resetSettings, saveSettings, setStorageBackend, updateSettings,
  loadBestScore, saveBestScore, loadAllBestScores, clearBestScores, saveResult, loadResults,
} from '../../js/storage.js';
import { MemoryStorage } from './helpers.mjs';

let store;
beforeEach(() => {
  store = new MemoryStorage();
  setStorageBackend(store);
});

test('기본 설정: ← ↓ ↑ →, 배속 1.0, 영상 ON', () => {
  const s = loadSettings();
  assert.deepEqual(s.keys, ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight']);
  assert.deepEqual(s.keys.map(keyLabel), ['←', '↓', '↑', '→']);
  assert.equal(s.noteSpeed, 1);
  assert.equal(s.showVideo, true);
  assert.equal(s.offsetMs, 0);
});

test('wony_rhythm_settings 에 keys / noteSpeed / showVideo 저장', () => {
  let keys = loadSettings().keys;
  for (const [lane, code] of ['KeyD', 'KeyF', 'KeyJ', 'KeyK'].entries()) {
    const r = assignKey(keys, lane, code);
    assert.ok(r.ok);
    keys = r.keys;
  }
  assert.ok(saveSettings({ ...loadSettings(), keys, noteSpeed: 1.75, showVideo: false }));
  const raw = JSON.parse(store.getItem('wony_rhythm_settings'));
  assert.deepEqual(raw.keys, ['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
  assert.equal(raw.noteSpeed, 1.75);
  assert.equal(raw.showVideo, false);
  assert.deepEqual(loadSettings().keys.map(keyLabel), ['D', 'F', 'J', 'K']);
  assert.deepEqual(['KeyZ', 'KeyX', 'Period', 'Slash'].map(keyLabel), ['Z', 'X', '.', '/']);
});

test('배속은 0.75 / 1.0 / 1.25 / 1.5 / 1.75 / 2.0 중 하나로 저장', () => {
  for (const [input, expected] of [[0.75, 0.75], [1.3, 1.25], [9, 2], [0.1, 0.75], ['x', 1]]) {
    saveSettings({ ...loadSettings(), noteSpeed: input });
    assert.equal(loadSettings().noteSpeed, expected, `${input}`);
  }
});

test('updateSettings: 일부만 바꾸기 (곡 선택 화면)', () => {
  saveSettings({ ...loadSettings(), keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF'] });
  updateSettings({ noteSpeed: 1.5 });
  updateSettings({ showVideo: false });
  const s = loadSettings();
  assert.deepEqual([s.keys[0], s.noteSpeed, s.showVideo], ['KeyA', 1.5, false]);
});

test('이전 버전 키 저장값(wony_rhythm_keys)도 읽고, 저장하면 새 위치로 옮긴다', () => {
  store.setItem(STORAGE_KEYS.legacyKeys, JSON.stringify(['KeyD', 'KeyF', 'KeyJ', 'KeyK']));
  store.setItem(STORAGE_KEYS.settings, JSON.stringify({ speed: 2 }));
  const s = loadSettings();
  assert.deepEqual(s.keys, ['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
  assert.equal(s.noteSpeed, 2);
  saveSettings(s);
  assert.equal(store.getItem(STORAGE_KEYS.legacyKeys), null);
  assert.deepEqual(loadSettings().keys, ['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
});

test('같은 키를 두 레인에 설정할 수 없다', () => {
  const r = assignKey(DEFAULT_KEYS, 0, 'ArrowDown');
  assert.deepEqual(r, { ok: false, reason: 'duplicate', lane: 1 });
  assert.ok(assignKey(DEFAULT_KEYS, 1, 'ArrowDown').ok);
  assert.equal(saveSettings({ ...loadSettings(), keys: ['KeyA', 'KeyA', 'KeyS', 'KeyD'] }), false);
  assert.equal(store.getItem(STORAGE_KEYS.settings), null);
});

test('Escape/Tab 등 예약 키는 지정할 수 없다', () => {
  for (const code of ['Escape', 'Tab', 'F5', 'MetaLeft']) {
    assert.equal(assignKey(DEFAULT_KEYS, 0, code).reason, 'reserved');
  }
});

test('assignKey 는 원본 배열을 바꾸지 않는다', () => {
  const keys = [...DEFAULT_KEYS];
  assignKey(keys, 0, 'KeyA');
  assert.deepEqual(keys, [...DEFAULT_KEYS]);
});

test('기본값 초기화', () => {
  saveSettings({ keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], noteSpeed: 2, showVideo: false, offsetMs: 50, touchControls: 'on' });
  assert.equal(loadSettings().noteSpeed, 2);
  const s = resetSettings();
  assert.deepEqual(s.keys, [...DEFAULT_KEYS]);
  assert.equal(s.noteSpeed, 1);
  assert.equal(s.showVideo, true);
  assert.equal(s.touchControls, 'auto');
});

test('저장값이 깨져 있으면 기본값으로 돌아간다', () => {
  store.setItem(STORAGE_KEYS.settings, '{not json');
  assert.deepEqual(loadSettings().keys, [...DEFAULT_KEYS]);
  store.setItem(STORAGE_KEYS.settings, JSON.stringify({ keys: ['KeyA', 'KeyA', 'KeyB', 'KeyC'], noteSpeed: 'fast', offsetMs: 99999, showVideo: 'yes' }));
  const s = loadSettings();
  assert.deepEqual(s.keys, [...DEFAULT_KEYS]);
  assert.equal(s.noteSpeed, 1);
  assert.equal(s.offsetMs, 200);
  assert.equal(s.showVideo, true);
});

test('localStorage 를 쓸 수 없어도 오류 없이 기본값', () => {
  setStorageBackend({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} });
  assert.deepEqual(loadSettings().keys, [...DEFAULT_KEYS]);
  assert.equal(saveSettings(loadSettings()), false);
  assert.deepEqual(saveBestScore('demo-beat', 'easy', 100), { best: 0, isNewBest: false, previous: 0 });
});

test('입력창에 포커스가 있으면 게임 키로 보지 않는다', () => {
  assert.ok(isTypingTarget({ tagName: 'INPUT', type: 'text' }));
  assert.ok(isTypingTarget({ tagName: 'TEXTAREA' }));
  assert.ok(isTypingTarget({ tagName: 'DIV', isContentEditable: true }));
  assert.ok(!isTypingTarget({ tagName: 'BUTTON' }));
  assert.ok(!isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }));
  assert.ok(!isTypingTarget(null));
});

test('최고 점수는 songId + difficulty 별 (HELL 포함), 더 높을 때만 저장', () => {
  assert.equal(loadBestScore('wony-cover-01', 'easy'), 0);
  assert.deepEqual(saveBestScore('wony-cover-01', 'easy', 135000), { best: 135000, isNewBest: true, previous: 0 });
  assert.deepEqual(saveBestScore('wony-cover-01', 'easy', 9000), { best: 135000, isNewBest: false, previous: 135000 });
  assert.equal(saveBestScore('wony-cover-01', 'easy', 135000).isNewBest, false);
  for (const [d, v] of [['normal', 102000], ['hard', 85000], ['hell', 52000]]) saveBestScore('wony-cover-01', d, v);
  const stored = JSON.parse(store.getItem('wony_rhythm_scores'))['wony-cover-01'];
  assert.deepEqual(Object.fromEntries(Object.entries(stored).map(([d, r]) => [d, r.bestScore])),
    { easy: 135000, normal: 102000, hard: 85000, hell: 52000 });
  assert.deepEqual(loadAllBestScores()['wony-cover-01'].hell, 52000);
  assert.equal(saveBestScore('wony-cover-01', 'hard', NaN).isNewBest, false);
});

test('플레이 결과에는 실제 배속을 기록 (최근 50건)', () => {
  const r = { songId: 'wony-cover-01', difficulty: 'hard', noteSpeed: 1.75, score: 185000, maxCombo: 213, perfect: 180, great: 21, good: 8, miss: 4, accuracy: 96.2 };
  saveResult(r);
  assert.deepEqual(loadResults()[0], { ...r, status: 'CLEAR' }, 'status 없는 기록은 CLEAR 로 채워 읽음');
  for (let i = 0; i < 60; i++) saveResult({ ...r, score: i });
  assert.equal(loadResults().length, 50);
  assert.equal(loadResults()[0].score, 59);
  clearBestScores();
  assert.deepEqual(loadResults(), []);
});
