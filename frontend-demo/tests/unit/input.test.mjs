import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KEYS } from '../../js/config.js';
import { createGame, hitLane, startGame } from '../../js/engine.js';
import { createInput } from '../../js/input.js';
import { keyEvent, pointerEvent } from './helpers.mjs';

function setup(keys = [...DEFAULT_KEYS]) {
  const log = { down: [], up: [], pause: 0, pressed: [] };
  const input = createInput({
    getKeys: () => keys,
    onLaneDown: (lane, source) => log.down.push([lane, source]),
    onLaneUp: lane => log.up.push(lane),
    onPause: () => log.pause++,
    onPressedChange: (lane, on) => log.pressed.push([lane, on]),
  });
  return { input, log };
}

test('키 입력 → 레인, 방향키 기본 동작(스크롤) 막기', () => {
  const { input, log } = setup();
  const e = keyEvent('ArrowUp');
  assert.ok(input.keydown(e));
  assert.ok(e.prevented);
  assert.deepEqual(log.down, [[2, 'key']]);
  assert.equal(input.keydown(keyEvent('KeyQ')), false);
});

test('키를 누르고 있어도 반복 판정되지 않는다 (event.repeat + 눌림 상태)', () => {
  const { input, log } = setup();
  input.keydown(keyEvent('ArrowLeft'));
  assert.equal(input.keydown(keyEvent('ArrowLeft', { repeat: true })), false);
  assert.equal(input.keydown(keyEvent('ArrowLeft')), false); // repeat 플래그가 없는 중복 keydown 도 무시
  assert.equal(log.down.length, 1);
  input.keyup(keyEvent('ArrowLeft'));
  assert.ok(input.keydown(keyEvent('ArrowLeft')));
  assert.equal(log.down.length, 2);
});

test('repeat 키가 실제 노트를 여러 번 판정하지 않는다', () => {
  const state = createGame({ notes: [{ time: 1000, lane: 0 }, { time: 1050, lane: 0 }] });
  startGame(state);
  const input = createInput({ getKeys: () => [...DEFAULT_KEYS], onLaneDown: lane => hitLane(state, lane, 1000) });
  input.keydown(keyEvent('ArrowLeft'));
  input.keydown(keyEvent('ArrowLeft', { repeat: true }));
  input.keydown(keyEvent('ArrowLeft', { repeat: true }));
  assert.equal(state.judged, 1);
});

test('사용자 키 설정을 그대로 따른다', () => {
  const { input, log } = setup(['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
  assert.equal(input.keydown(keyEvent('ArrowLeft')), false);
  input.keydown(keyEvent('KeyK'));
  assert.deepEqual(log.down, [[3, 'key']]);
});

test('입력창 포커스 중에는 게임 키 무시, Escape 는 일시정지', () => {
  const { input, log } = setup();
  assert.equal(input.keydown(keyEvent('ArrowLeft', { target: { tagName: 'INPUT', type: 'text' } })), false);
  assert.equal(log.down.length, 0);
  input.keydown(keyEvent('Escape'));
  input.keydown(keyEvent('Escape', { repeat: true }));
  assert.equal(log.pause, 1);
});

test('멀티터치: 1+4 레인, 2+3 레인 동시 입력', () => {
  const { input, log } = setup();
  input.pointerdown(pointerEvent(1), 0);
  input.pointerdown(pointerEvent(2), 3);
  assert.deepEqual(log.down, [[0, 'pointer'], [3, 'pointer']]);
  assert.deepEqual([...input.pressed], [1, 0, 0, 1]);
  input.pointerdown(pointerEvent(3), 1);
  input.pointerdown(pointerEvent(4), 2);
  assert.deepEqual([...input.pressed], [1, 1, 1, 1]);
});

test('한 손가락을 떼도 다른 손가락은 유지된다', () => {
  const { input } = setup();
  input.pointerdown(pointerEvent(10), 0);
  input.pointerdown(pointerEvent(11), 3);
  input.pointerup(pointerEvent(10));
  assert.deepEqual([...input.pressed], [0, 0, 0, 1]);
  input.pointerup(pointerEvent(10)); // 중복 up 무시
  assert.deepEqual([...input.pressed], [0, 0, 0, 1]);
  input.pointerup(pointerEvent(11));
  assert.deepEqual([...input.pressed], [0, 0, 0, 0]);
});

test('pointerdown: 기본 동작 막고 pointer capture, 같은 pointerId 중복 무시', () => {
  const { input, log } = setup();
  const e = pointerEvent(5);
  assert.ok(input.pointerdown(e, 1));
  assert.ok(e.prevented);
  assert.deepEqual(e.captured, [5]);
  assert.equal(input.pointerdown(pointerEvent(5), 1), false);
  assert.equal(log.down.length, 1);
  assert.equal(input.pointerdown(pointerEvent(6, { pointerType: 'mouse', button: 2 }), 1), false); // 우클릭
});

test('같은 레인 두 손가락 → 두 번 입력, 시각 효과는 마지막 손가락이 뗄 때 해제', () => {
  const { input, log } = setup();
  input.pointerdown(pointerEvent(1), 2);
  input.pointerdown(pointerEvent(2), 2);
  assert.equal(log.down.length, 2);
  input.pointerup(pointerEvent(1));
  assert.deepEqual(log.pressed, [[2, true]]);
  input.pointerup(pointerEvent(2));
  assert.deepEqual(log.pressed, [[2, true], [2, false]]);
});

test('키보드와 터치는 같은 판정 함수(onLaneDown → hitLane)를 쓴다', () => {
  const state = createGame({ notes: [{ time: 1000, lane: 0 }, { time: 1000, lane: 3 }] });
  startGame(state);
  const input = createInput({ getKeys: () => [...DEFAULT_KEYS], onLaneDown: lane => hitLane(state, lane, 1010) });
  input.keydown(keyEvent('ArrowLeft'));
  input.pointerdown(pointerEvent(1), 3);
  assert.deepEqual(state.counts, { PERFECT: 2, GREAT: 0, GOOD: 0, MISS: 0 });
});

test('releaseAll: 창 포커스를 잃으면 눌림 상태 해제', () => {
  const { input } = setup();
  input.keydown(keyEvent('ArrowLeft'));
  input.pointerdown(pointerEvent(1), 3);
  input.releaseAll();
  assert.deepEqual([...input.pressed], [0, 0, 0, 0]);
  assert.ok(input.keydown(keyEvent('ArrowLeft'))); // 다시 누를 수 있다
});
