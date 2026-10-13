// laneCount (4 / 6 / 8) 구조. 게임 UI 는 아직 4키만 노출하지만 코드는 레인 수에 고정되지 않아야 한다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_KEYS_BY_LANE_COUNT, DEFAULT_LANE_COUNT, LANE_PALETTE, SUPPORTED_LANE_COUNTS, laneColors, normalizeLaneCount,
} from '../../js/config.js';
import { createGame, hitLane, startGame, updateGame } from '../../js/engine.js';
import { createInput } from '../../js/input.js';
import { assignKey, defaultKeys, isValidKeySet, keyLabel } from '../../js/keys.js';
import { computeLayout } from '../../js/layout.js';
import { STORAGE_KEYS, keysFor, loadSettings, saveSettings, setStorageBackend, withKeysFor } from '../../js/storage.js';
import { MemoryStorage, keyEvent, pointerEvent } from './helpers.mjs';

let store;
beforeEach(() => {
  store = new MemoryStorage();
  setStorageBackend(store);
});

test('기본 4, 지원 4/6/8, 그 외는 4로', () => {
  assert.equal(DEFAULT_LANE_COUNT, 4);
  assert.deepEqual([...SUPPORTED_LANE_COUNTS], [4, 6, 8]);
  for (const [v, expected] of [[4, 4], [6, 6], [8, 8], [5, 4], [undefined, 4], ['6', 6], [null, 4]]) {
    assert.equal(normalizeLaneCount(v), expected, String(v));
  }
});

test('모드별 기본 키: 4키 ← ↓ ↑ → (기존 유지), 6키 S D F J K L, 8키 A S D F J K L ;', () => {
  assert.deepEqual(defaultKeys().map(keyLabel), ['←', '↓', '↑', '→']);
  assert.deepEqual(defaultKeys(6).map(keyLabel), ['S', 'D', 'F', 'J', 'K', 'L']);
  assert.deepEqual(defaultKeys(8).map(keyLabel), ['A', 'S', 'D', 'F', 'J', 'K', 'L', ';']);
  for (const n of SUPPORTED_LANE_COUNTS) {
    assert.equal(DEFAULT_KEYS_BY_LANE_COUNT[n].length, n);
    assert.ok(isValidKeySet(defaultKeys(n), n));
  }
});

test('키 검증/변경은 laneCount 기준', () => {
  assert.equal(isValidKeySet(defaultKeys(6)), false, '기본 검증은 4키');
  assert.equal(isValidKeySet(defaultKeys(6), 6), true);
  assert.equal(isValidKeySet(['KeyA', 'KeyA', 'KeyD', 'KeyF', 'KeyJ', 'KeyK'], 6), false);
  const r = assignKey(defaultKeys(8), 7, 'Quote');
  assert.ok(r.ok);
  assert.equal(r.keys[7], 'Quote');
  assert.deepEqual(assignKey(defaultKeys(8), 8, 'KeyQ'), { ok: false, reason: 'lane' });
  assert.deepEqual(assignKey(defaultKeys(6), 0, 'KeyL'), { ok: false, reason: 'duplicate', lane: 5 });
});

test('설정: 모드별 키 저장, 4키는 기존 keys 와 같음', () => {
  const s = loadSettings();
  assert.deepEqual(keysFor(s, 4), defaultKeys(4));
  assert.deepEqual(keysFor(s, 6), defaultKeys(6));
  assert.deepEqual(keysFor(s, 8), defaultKeys(8));
  let next = withKeysFor(s, 6, ['KeyQ', 'KeyW', 'KeyE', 'KeyI', 'KeyO', 'KeyP']);
  next = withKeysFor(next, 4, ['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
  assert.ok(saveSettings(next));
  const raw = JSON.parse(store.getItem(STORAGE_KEYS.settings));
  assert.deepEqual(raw.keys, ['KeyD', 'KeyF', 'KeyJ', 'KeyK'], '4키는 keys 에도 (이전 버전 호환)');
  assert.deepEqual(raw.keyMaps['6'], ['KeyQ', 'KeyW', 'KeyE', 'KeyI', 'KeyO', 'KeyP']);
  const loaded = loadSettings();
  assert.deepEqual(keysFor(loaded, 4).map(keyLabel), ['D', 'F', 'J', 'K']);
  assert.deepEqual(keysFor(loaded, 6).map(keyLabel), ['Q', 'W', 'E', 'I', 'O', 'P']);
  assert.deepEqual(keysFor(loaded, 8), defaultKeys(8));
});

test('설정: 이전 버전(keys 만 있음)도 그대로 4키로 읽힘, 깨진 모드는 기본 키', () => {
  store.setItem(STORAGE_KEYS.settings, JSON.stringify({ keys: ['KeyZ', 'KeyX', 'Period', 'Slash'], keyMaps: { 6: ['KeyA'], 8: 'x' } }));
  const s = loadSettings();
  assert.deepEqual(keysFor(s, 4).map(keyLabel), ['Z', 'X', '.', '/']);
  assert.deepEqual(keysFor(s, 6), defaultKeys(6));
  assert.deepEqual(keysFor(s, 8), defaultKeys(8));
  assert.equal(saveSettings({ ...s, keyMaps: { ...s.keyMaps, 6: ['KeyA', 'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE'] } }), false, '중복 키는 어느 모드든 저장 거부');
});

test('엔진: 6키/8키 채보 (chart.laneCount)', () => {
  const chart6 = { laneCount: 6, notes: [{ time: 1000, lane: 0 }, { time: 1000, lane: 5 }, { time: 1500, lane: 3 }, { time: 2000, lane: 6 }] };
  const s = createGame(chart6);
  startGame(s);
  assert.equal(s.laneCount, 6);
  assert.equal(s.lanes.length, 6);
  assert.equal(s.total, 3, 'lane 6 은 0 <= lane < 6 밖이라 제외');
  assert.equal(hitLane(s, 5, 1000).grade, 'PERFECT');
  assert.equal(hitLane(s, 0, 1010).grade, 'PERFECT');
  assert.equal(hitLane(s, 6, 1500), null);
  assert.equal(hitLane(s, 3, 1500).grade, 'PERFECT');
  updateGame(s, s.endTime);
  assert.equal(s.status, 'ended');

  const s8 = createGame({ laneCount: 8, notes: [{ time: 1000, lane: 7 }] });
  startGame(s8);
  assert.equal(hitLane(s8, 7, 1000).grade, 'PERFECT');
});

test('엔진: laneCount 없는 채보는 4키, lane 4 이상은 제외 (기존 동작)', () => {
  const s = createGame({ notes: [{ time: 1000, lane: 3 }, { time: 1000, lane: 4 }] });
  assert.equal(s.laneCount, 4);
  assert.equal(s.total, 1);
  assert.equal(createGame({ laneCount: 5, notes: [] }).laneCount, 4, '지원 안 하는 값은 4');
  assert.equal(createGame({ laneCount: 4, notes: [] }, { laneCount: 8 }).laneCount, 8, 'options 가 우선');
});

test('입력: 8키 키보드 + 터치, 범위 밖 레인 무시', () => {
  const down = [];
  const input = createInput({ laneCount: 8, getKeys: () => defaultKeys(8), onLaneDown: lane => down.push(lane) });
  assert.equal(input.pressed.length, 8);
  input.keydown(keyEvent('Semicolon'));
  input.keydown(keyEvent('KeyA'));
  input.pointerdown(pointerEvent(1), 6);
  assert.equal(input.pointerdown(pointerEvent(2), 8), false);
  assert.deepEqual(down, [7, 0, 6]);
  const four = createInput({ getKeys: () => defaultKeys(8), onLaneDown: lane => down.push(lane) });
  assert.equal(four.keydown(keyEvent('KeyJ')), false, '4키 입력은 레인 4 이상을 받지 않음');
});

test('레이아웃: laneCount 만큼 레인, 4키는 기존 크기 그대로', () => {
  assert.deepEqual(computeLayout(390, 500, 2), computeLayout(390, 500, 2, 4));
  const before4 = computeLayout(844, 270, 2);
  assert.equal(before4.fieldW, Math.min(844 - 16, 760, Math.max(844 * 0.62, 420)));
  for (const n of [6, 8]) {
    for (const [w, h] of [[390, 500], [490, 270], [830, 830], [1440, 760]]) {
      const l = computeLayout(w, h, 2, n);
      assert.equal(l.laneCount, n);
      assert.equal(l.laneX.length, n);
      assert.ok(l.fieldX >= 0 && l.fieldX + l.fieldW <= l.width);
    }
  }
  assert.ok(computeLayout(1440, 760, 1, 8).fieldW > computeLayout(1440, 760, 1, 4).fieldW, '레인이 많으면 필드가 넓어짐');
});

test('레인 색: laneCount 개, 4키는 기존 색', () => {
  assert.deepEqual(laneColors(4), ['#5AA9FF', '#6FD6BE', '#FFD166', '#FF92B0']);
  assert.equal(laneColors(6).length, 6);
  assert.equal(new Set(laneColors(8)).size, 8);
  assert.equal(LANE_PALETTE.length, 8);
});
