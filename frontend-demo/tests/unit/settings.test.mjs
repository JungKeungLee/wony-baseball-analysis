import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KEYS } from '../../js/config.js';
import { assignKey, isTypingTarget, keyLabel } from '../../js/keys.js';
import {
  LEGACY_MEMBER_KEYS, MEMBER_FREE_KEYS, STORAGE_KEYS, loadSettings, purgeMemberData, resetSettings, saveLastSelection,
  saveSettings, setStorageBackend, updateSettings,
} from '../../js/storage.js';
import * as storage from '../../js/storage.js';
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
  assert.ok(saveSettings({ ...loadSettings(), keys, noteSpeed: 3, showVideo: false }));
  const raw = JSON.parse(store.getItem('wony_rhythm_settings'));
  assert.deepEqual(raw.keys, ['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
  assert.equal(raw.noteSpeed, 3);
  assert.equal(raw.showVideo, false);
  assert.deepEqual(loadSettings().keys.map(keyLabel), ['D', 'F', 'J', 'K']);
  assert.deepEqual(['KeyZ', 'KeyX', 'Period', 'Slash'].map(keyLabel), ['Z', 'X', '.', '/']);
});

test('배속은 1 / 1.5 / 2 / 3 / 4 / 6 중 하나로 저장, 이전 버전 값은 가장 가까운 값으로', () => {
  for (const [input, expected] of [[6, 6], [3, 3], [9, 6], [0.1, 1], ['x', 1],
    [0.75, 1], [1.25, 1], [1.75, 1.5], [2.5, 2], [5, 4]]) {
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
  assert.doesNotThrow(() => purgeMemberData());
});

test('입력창에 포커스가 있으면 게임 키로 보지 않는다', () => {
  assert.ok(isTypingTarget({ tagName: 'INPUT', type: 'text' }));
  assert.ok(isTypingTarget({ tagName: 'TEXTAREA' }));
  assert.ok(isTypingTarget({ tagName: 'DIV', isContentEditable: true }));
  assert.ok(!isTypingTarget({ tagName: 'BUTTON' }));
  assert.ok(!isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }));
  assert.ok(!isTypingTarget(null));
});

test('localStorage 에는 게임 설정만 (기록 · 츄르 저장 함수 없음)', () => {
  saveSettings({ ...loadSettings(), noteSpeed: 1.5, showVideo: false });
  updateSettings({ offsetMs: 20 });
  saveLastSelection('wony-cover-01', 'hard');
  assert.deepEqual([...store.map.keys()].sort(), ['wony_rhythm_last', 'wony_rhythm_settings']);
  for (const k of store.map.keys()) assert.ok(MEMBER_FREE_KEYS.includes(k), k);
  const exported = Object.keys(storage).join(' ');
  assert.ok(!/BestRecord|BestScore|saveResult|loadResults|Churu|Wallet/i.test(exported), exported);
});

test('이전 버전의 로컬 기록 · 비로그인 츄르는 지우고 설정은 남긴다', () => {
  saveSettings({ ...loadSettings(), noteSpeed: 4 });
  store.setItem('wony_rhythm_scores', '{"wony-cover-01":{"hard":{"bestScore":1}}}');
  store.setItem('wony_rhythm_results', '[{"score":1}]');
  store.setItem('wonyRhythm.wallet.v1', '{"balance":30,"plays":["x"]}');
  purgeMemberData();
  for (const k of LEGACY_MEMBER_KEYS) assert.equal(store.getItem(k), null, k);
  assert.equal(loadSettings().noteSpeed, 4);
  assert.ok(STORAGE_KEYS.settings);
});

test('저장된 이전 배속(0.75 / 1.25 / 1.75)도 읽을 때 안전하게 바뀜 · KEY 모드 기본 4', () => {
  store.setItem('wony_rhythm_settings', JSON.stringify({ noteSpeed: 1.75 }));
  assert.equal(loadSettings().noteSpeed, 1.5);
  store.setItem('wony_rhythm_settings', JSON.stringify({ noteSpeed: 0.75, laneCount: 7 }));
  assert.equal(loadSettings().noteSpeed, 1);
  assert.equal(loadSettings().laneCount, 4, '모르는 KEY 모드는 4');
  updateSettings({ laneCount: 8 });
  assert.equal(loadSettings().laneCount, 8);
});
