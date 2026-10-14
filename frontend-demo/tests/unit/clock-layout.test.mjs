import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_SPEEDS } from '../../js/config.js';
import { VideoClock } from '../../js/clock.js';
import { createGame, hitLane, resultRecord, startGame, updateGame } from '../../js/engine.js';
import { approachMs, computeLayout, noteY } from '../../js/layout.js';
import { simpleChart } from './helpers.mjs';

function fakeTime(start = 0) {
  const t = { now: start };
  return { t, fn: () => t.now };
}

/** HTMLVideoElement 흉내: currentTime 은 테스트가 직접 움직인다 (실제 브라우저에서는 재생이 움직임). */
function fakeVideo() {
  const listeners = {};
  return {
    currentTime: 0, paused: true, ended: false, muted: false, seeking: false, readyState: 4,
    playbackRate: 1, defaultPlaybackRate: 1, plays: 0, pauses: 0,
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; this.pauses++; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of listeners[type] || []) fn(); },
  };
}

test('VideoClock: 카운트다운(음수) 후 video.play(), 이후 시간 = video.currentTime', () => {
  const { t, fn } = fakeTime(0);
  const v = fakeVideo();
  const c = new VideoClock(v, { nowFn: fn });
  c.start(3000);
  assert.equal(c.now(), -3000);
  t.now = 1500;
  assert.equal(c.now(), -1500);
  assert.equal(v.plays, 0, '카운트다운 중에는 영상 정지');
  t.now = 3000;
  assert.equal(c.now(), 0);
  assert.equal(v.paused, false);
  v.currentTime = 7.5;
  t.now = 10500;
  assert.equal(c.now(), 7500, 'video.currentTime 이 게임 시계');
});

test('VideoClock: currentTime 갱신이 늦을 때 최대 50ms 만 보간, 버퍼링 중에는 멈춤', () => {
  const { t, fn } = fakeTime(0);
  const v = fakeVideo();
  const c = new VideoClock(v, { nowFn: fn });
  c.start(0);
  c.now();
  v.currentTime = 2;
  t.now = 2000;
  assert.equal(c.now(), 2000);
  t.now = 2030;
  assert.equal(c.now(), 2030);
  t.now = 2400;
  assert.equal(c.now(), 2050);
  v.readyState = 2; // waiting (버퍼링)
  v.currentTime = 2.06;
  t.now = 3000;
  assert.equal(c.now(), 2060, '영상이 멈추면 노트도 멈춤');
});

test('VideoClock: pause → video.pause(), 시간 고정 / resume → video.play(), 실제 위치에서 이어감', () => {
  const { t, fn } = fakeTime(0);
  const v = fakeVideo();
  const c = new VideoClock(v, { nowFn: fn });
  c.start(0);
  c.now();
  v.currentTime = 12.4;
  t.now = 12400;
  assert.equal(c.now(), 12400);
  c.pause();
  assert.equal(v.paused, true);
  t.now = 99999;
  assert.equal(c.now(), 12400);
  c.resume();
  assert.equal(v.paused, false);
  assert.equal(c.now(), 12400);
});

test('VideoClock: 카운트다운 중 일시정지/재개', () => {
  const { t, fn } = fakeTime(0);
  const v = fakeVideo();
  const c = new VideoClock(v, { nowFn: fn });
  c.start(3000);
  t.now = 1000;
  c.pause();
  t.now = 50000;
  assert.equal(c.now(), -2000);
  c.resume();
  t.now = 51000;
  assert.equal(c.now(), -1000);
  assert.equal(v.plays, 0);
});

test('VideoClock: playbackRate 는 항상 1.0', () => {
  const v = fakeVideo();
  const c = new VideoClock(v);
  v.playbackRate = 1.5;
  v.fire('ratechange');
  assert.equal(v.playbackRate, 1);
  v.playbackRate = 2;
  c.tick();
  assert.equal(v.playbackRate, 1);
});

test('VideoClock: 플레이 중 외부 seek 는 되돌린다 (CHART EDIT MODE 용 allowSeek 는 허용)', () => {
  const { t, fn } = fakeTime(0);
  const v = fakeVideo();
  const c = new VideoClock(v, { nowFn: fn });
  c.start(0);
  c.now();
  v.currentTime = 10;
  t.now = 10000;
  c.now();
  v.currentTime = 60; // 사용자가 시크바/미디어 키로 이동
  v.fire('seeking');
  assert.equal(v.currentTime, 10);
  v.fire('seeking'); // 되돌린 내부 seek 이벤트는 다시 막지 않음
  assert.equal(v.currentTime, 10);

  const v2 = fakeVideo();
  const edit = new VideoClock(v2, { allowSeek: true, nowFn: fn });
  edit.start(0);
  edit.now();
  v2.currentTime = 60;
  v2.fire('seeking');
  assert.equal(v2.currentTime, 60);
});

test('VideoClock: seek 직후 seeking 이벤트 전에 프레임이 돌아도 되돌린다 (경쟁 상태)', () => {
  const { t, fn } = fakeTime(0);
  const v = fakeVideo();
  const c = new VideoClock(v, { nowFn: fn });
  c.start(0);
  c.now();
  v.currentTime = 8;
  t.now = 8000;
  assert.equal(c.now(), 8000);
  // 브라우저: currentTime 을 바꾸면 seeking=true 는 즉시, 'seeking' 이벤트는 나중에 (그 사이 rAF 가 돌 수 있음)
  v.currentTime = 23;
  v.seeking = true;
  t.now = 8016;
  assert.equal(c.now(), 8000, 'seek 처리 전에는 이전 위치 유지 (새 위치를 받아들이지 않음)');
  v.fire('seeking');
  assert.equal(v.currentTime, 8, '이전 위치로 되돌림');
  v.seeking = false;
  v.fire('seeking'); // 되돌린 내부 seek
  t.now = 8100;
  assert.ok(Math.abs(c.now() - 8000) <= 50);
});

test('VideoClock: 영상이 끝나면 ended', () => {
  const v = fakeVideo();
  const { t, fn } = fakeTime(0);
  const c = new VideoClock(v, { nowFn: fn });
  c.start(0);
  assert.equal(c.ended, false);
  c.now();
  v.ended = true;
  assert.equal(c.ended, true);
});

test('배속 → 노트 접근 시간', () => {
  assert.deepEqual([...NOTE_SPEEDS], [1, 1.5, 2, 3, 4, 6]);
  const expected = { 1: 2000, 1.5: 1333, 2: 1000, 3: 667, 4: 500, 6: 333 };
  for (const s of NOTE_SPEEDS) assert.equal(Math.round(approachMs(s)), expected[s], `${s}x`);
  assert.equal(approachMs(99), 2000 / 6);
  assert.equal(approachMs(NaN), 2000);
});

test('배속과 무관하게 판정 시점은 같다 (판정은 note.time vs video 시각만)', () => {
  const layout = computeLayout(390, 600, 2);
  const outcomes = NOTE_SPEEDS.map(speed => {
    const state = createGame(simpleChart(4));
    startGame(state);
    const approach = approachMs(speed);
    // 노트가 판정선에 닿는 시각은 모든 배속에서 note.time
    assert.equal(noteY(1000, 1000, layout, approach), layout.judgeY);
    // 낮은 배속은 더 일찍 나타나고(화면 위쪽에 있음) 높은 배속은 늦게 나타난다
    const y = noteY(2000, 1000, layout, approach);
    const grades = [hitLane(state, 0, 1065), hitLane(state, 1, 1620), hitLane(state, 2, 1830)].map(j => j.grade);
    updateGame(state, 3000);
    return { speed, y, grades, record: resultRecord(state, { songId: 's', difficulty: 'hard', noteSpeed: speed }) };
  });
  for (const o of outcomes) {
    assert.deepEqual(o.grades, ['PERFECT', 'GREAT', 'GOOD']);
    assert.equal(o.record.score, outcomes[0].record.score);
    assert.equal(o.record.noteSpeed, o.speed);
  }
  const ys = outcomes.map(o => o.y);
  assert.deepEqual([...ys].sort((a, b) => b - a), ys, '배속이 높을수록 1초 뒤 노트는 화면 위쪽(더 늦게 등장)');
});

test('layout: 세로/가로/태블릿/PC 크기별 계산', () => {
  const portrait = computeLayout(390, 500, 3);
  const landscape = computeLayout(490, 270, 3);
  const tablet = computeLayout(768, 700, 2);
  const desktop = computeLayout(830, 830, 1);
  assert.equal(portrait.landscape, false);
  assert.equal(landscape.landscape, true);
  assert.ok(landscape.fieldW > portrait.fieldW, '가로 화면은 레인을 더 넓게');
  assert.equal(portrait.dpr, 2);
  for (const l of [portrait, landscape, tablet, desktop]) {
    assert.ok(l.fieldX >= 0 && l.fieldX + l.fieldW <= l.width);
    assert.ok(l.judgeY > l.height / 2 && l.judgeY < l.height);
    assert.ok(l.laneW >= 80);
  }
});

test('리사이즈/회전은 게임 상태를 바꾸지 않는다', () => {
  const state = createGame(simpleChart(8));
  startGame(state);
  hitLane(state, 0, 1000);
  hitLane(state, 1, 1500);
  const before = JSON.stringify(state);
  for (const [w, h] of [[390, 500], [490, 270], [768, 700], [830, 830]]) {
    const layout = computeLayout(w, h, 2);
    assert.equal(noteY(2000, 2000, layout, approachMs(1)), layout.judgeY);
  }
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.combo, 2);
});

test('채보 endMs 로 결과 화면 시각 결정', () => {
  const s = createGame({ notes: [{ time: 7500, lane: 0 }], endMs: 30000 });
  assert.equal(s.endTime, 30000);
  assert.equal(createGame({ notes: [{ time: 7500, lane: 0 }] }).endTime, 9500);
});
