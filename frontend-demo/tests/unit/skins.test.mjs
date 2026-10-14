// 스킨: 기본 스킨 · 보유 · 장착 · 구매 인터페이스 · 화면 전용(게임 규칙과 무관)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_RHYTHM_BAR_SKIN_ID, DEFAULT_UI_SKIN_ID, LANE_PALETTE, SHOP_OPEN, laneColors } from '../../js/config.js';
import {
  DEFAULT_RHYTHM_THEME, PURCHASE_ERRORS, SKIN_CATALOG, SKIN_STORAGE_KEY, SKIN_TYPES, createLocalSkinRepository,
  equipSkin, equippedSkins, getSkin, ownedSkinIds, purchaseSkin, skinsOfType,
} from '../../js/skins.js';
import { rhythmBarTheme } from '../../js/theme.js';
import { MemoryStorage } from './helpers.mjs';

const src = f => readFileSync(new URL(`../../js/${f}`, import.meta.url), 'utf-8');

test('기본 스킨 2개만: default-ui · default-rhythm, 가격 0 · 판매 중 · 기본', () => {
  assert.deepEqual(SKIN_CATALOG.map(s => s.id), ['default-ui', 'default-rhythm']);
  assert.equal(DEFAULT_UI_SKIN_ID, 'default-ui');
  assert.equal(DEFAULT_RHYTHM_BAR_SKIN_ID, 'default-rhythm');
  for (const s of SKIN_CATALOG) assert.deepEqual([s.price, s.isDefault, s.enabled], [0, true, true]);
  assert.deepEqual(skinsOfType(SKIN_TYPES.UI).map(s => s.id), ['default-ui']);
  assert.deepEqual(skinsOfType(SKIN_TYPES.RHYTHM_BAR).map(s => s.id), ['default-rhythm']);
});

test('기본 스킨은 항상 보유 · 기본 장착 (저장소가 비었거나 깨져도)', () => {
  const storage = new MemoryStorage();
  const repo = createLocalSkinRepository(storage);
  assert.deepEqual(ownedSkinIds(repo), ['default-ui', 'default-rhythm']);
  assert.deepEqual(equippedSkins(repo), { uiSkinId: 'default-ui', rhythmBarSkinId: 'default-rhythm' });
  storage.setItem(SKIN_STORAGE_KEY, '{broken');
  assert.deepEqual(equippedSkins(repo), { uiSkinId: 'default-ui', rhythmBarSkinId: 'default-rhythm' });
  assert.deepEqual(equippedSkins(createLocalSkinRepository(null)), { uiSkinId: 'default-ui', rhythmBarSkinId: 'default-rhythm' });
});

test('로컬 값으로 보유/장착을 위조해도 카탈로그 · 보유 확인을 통과해야만 적용', () => {
  const storage = new MemoryStorage();
  storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({ owned: ['gold-ui', 'default-ui'], uiSkinId: 'gold-ui', rhythmBarSkinId: 'default-ui' }));
  const repo = createLocalSkinRepository(storage);
  assert.deepEqual(ownedSkinIds(repo), ['default-ui', 'default-rhythm'], '카탈로그에 없는 스킨은 무시');
  assert.deepEqual(equippedSkins(repo), { uiSkinId: 'default-ui', rhythmBarSkinId: 'default-rhythm' }, '종류가 다른 스킨도 무시');
});

test('장착: UI 스킨과 리듬 바 스킨은 서로 독립, 잘못된 요청은 오류 코드', () => {
  const extra = [...SKIN_CATALOG,
    { id: 'blue-ui', type: 'ui', name: '파랑', price: 10, isDefault: false, enabled: true, theme: { '--accent': '#00f' } },
    { id: 'neon-bar', type: 'rhythm-bar', name: '네온', price: 10, isDefault: false, enabled: true, theme: { bgTop: '#000' } },
    { id: 'old-bar', type: 'rhythm-bar', name: '판매 종료', price: 10, isDefault: false, enabled: false, theme: {} }];
  // 보유 목록은 서버 저장소가 줌 (여기서는 같은 모양의 가짜 저장소)
  const storage = new MemoryStorage();
  const local = createLocalSkinRepository(storage);
  let owned = ['blue-ui', 'neon-bar', 'old-bar'];
  const repo = { ...local, loadOwned: () => owned };
  assert.deepEqual(equipSkin('ui', 'blue-ui', repo, extra), { ok: true, equipped: { uiSkinId: 'blue-ui', rhythmBarSkinId: 'default-rhythm' } });
  assert.deepEqual(equipSkin('rhythm-bar', 'neon-bar', repo, extra).equipped, { uiSkinId: 'blue-ui', rhythmBarSkinId: 'neon-bar' });
  assert.deepEqual(equipSkin('ui', 'default-ui', repo, extra).equipped, { uiSkinId: 'default-ui', rhythmBarSkinId: 'neon-bar' }, '기본 스킨은 언제나 선택 가능');
  assert.equal(equipSkin('ui', 'neon-bar', repo, extra).error, 'WRONG_TYPE');
  assert.equal(equipSkin('ui', 'nope', repo, extra).error, 'UNKNOWN_SKIN');
  assert.equal(equipSkin('rhythm-bar', 'old-bar', repo, extra).error, 'SKIN_DISABLED');
  owned = [];
  assert.equal(equipSkin('ui', 'blue-ui', repo, extra).error, 'NOT_OWNED');
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(SKIN_STORAGE_KEY))).sort(), ['rhythmBarSkinId', 'uiSkinId'], '로컬에는 장착 선택만');
  // 현재 카탈로그: 기본 스킨 장착
  assert.equal(equipSkin('rhythm-bar', 'default-rhythm', repo).ok, true);
});

test('구매: 상점 준비 중이면 항상 SHOP_CLOSED (서버 호출 없음)', async () => {
  assert.equal(SHOP_OPEN, false);
  let called = 0;
  const api = { purchase: async () => { called++; return { ok: true }; } };
  assert.deepEqual(await purchaseSkin('default-ui'), { ok: false, error: 'SHOP_CLOSED' });
  assert.deepEqual(await purchaseSkin('default-ui', { api }), { ok: false, error: 'SHOP_CLOSED' });
  assert.equal(called, 0);
  assert.equal(PURCHASE_ERRORS.SHOP_CLOSED, '스킨 상점은 준비 중입니다.');
});

test('구매 인터페이스 (향후): skinId 만 서버로, 오류 코드 구분, 예외는 NETWORK', async () => {
  const seen = [];
  const api = out => ({ purchase: async (...args) => { seen.push(args); if (out instanceof Error) throw out; return out; } });
  assert.deepEqual(await purchaseSkin('default-ui', { shopOpen: true, api: api({ ok: true, balance: 20, owned: ['default-ui'] }) }),
    { ok: true, balance: 20, owned: ['default-ui'] });
  assert.deepEqual(seen[0], ['default-ui'], '가격 · 잔액은 보내지 않음');
  for (const code of ['LOGIN_REQUIRED', 'ALREADY_OWNED', 'INSUFFICIENT_CHURU', 'SKIN_DISABLED']) {
    assert.equal((await purchaseSkin('default-ui', { shopOpen: true, api: api({ ok: false, error: code }) })).error, code);
  }
  assert.equal((await purchaseSkin('default-ui', { shopOpen: true, api: api({ ok: false, error: 'WEIRD' }) })).error, 'SERVER');
  assert.equal((await purchaseSkin('default-ui', { shopOpen: true, api: api(new Error('offline')) })).error, 'NETWORK');
  assert.equal((await purchaseSkin('nope', { shopOpen: true, api: api({ ok: true }) })).error, 'UNKNOWN_SKIN');
});

test('기본 리듬 바: 배경 · 레인 색은 이전 그대로 + 판정선 glow', () => {
  assert.deepEqual({ ...DEFAULT_RHYTHM_THEME, palette: [...DEFAULT_RHYTHM_THEME.palette] }, {
    bgTop: '#101A33', bgBottom: '#17284D', laneEven: 'rgba(255,255,255,0.06)', laneOdd: 'rgba(255,255,255,0.035)',
    laneLine: 'rgba(255,255,255,0.12)', judgeLine: 'rgba(255,255,255,0.9)', keyLabel: 'rgba(255,255,255,0.55)',
    pressGlow: 'rgba(255,255,255,0.55)', judgeGlow: 'rgba(255,209,102,0.45)', laneNeon: '#7FB8FF',
    beatLine: 'rgba(255,255,255,0.06)', measureLine: 'rgba(255,255,255,0.16)', palette: [...LANE_PALETTE],
  });
  const theme = rhythmBarTheme(createLocalSkinRepository(new MemoryStorage()));
  assert.equal(theme.id, 'default-rhythm');
  for (const n of [4, 6, 8]) {
    assert.deepEqual(Array.from({ length: n }, (_, i) => theme.palette[i % theme.palette.length]), laneColors(n));
  }
  assert.equal(getSkin('default-rhythm').theme, DEFAULT_RHYTHM_THEME);
});

test('스킨은 화면 전용: 판정 · 점수 · LIFE · 채보 · 시계 코드는 스킨을 읽지 않음', () => {
  const imports = f => [...src(f).matchAll(/^import[^;]+from '([^']+)'/gm)].map(m => m[1]);
  for (const f of ['engine.js', 'judge.js', 'clock.js', 'layout.js', 'input.js', 'storage.js']) {
    assert.ok(!imports(f).some(m => /skins|theme/.test(m)), f);
    assert.ok(!/SkinId|rhythmBarTheme|applyUiSkin/.test(src(f)), f);
  }
  // 스킨 코드는 설정 값만 읽고 엔진 · 시계를 부르지 않음
  assert.deepEqual(imports('skins.js'), ['./config.js']);
  assert.deepEqual(imports('theme.js'), ['./skins.js']);
});
