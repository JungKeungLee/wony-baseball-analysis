// 스킨: 카탈로그 · 보유 · 장착 · 구매 인터페이스.
//
// 스킨은 화면 모양만 바꾼다. 판정 · 점수 · LIFE · 콤보 · 채보 · 타이밍 · video.currentTime(게임 시계)와 무관하다
// (engine.js / judge.js / clock.js 는 이 파일을 읽지 않는다).
//   UI 스킨        (uiSkinId)        : 메뉴 · 결과 화면 등 페이지 색 (CSS 변수)
//   리듬 바 스킨   (rhythmBarSkinId) : 플레이 화면 레인 · 노트 · 판정선 색 (render.js)
// 두 종류는 서로 독립적으로 장착한다.
//
// [현재] 기본 스킨 2개만 있음: 항상 보유 · 기본 장착 · 언제나 선택 가능. 상점은 "준비 중"(SHOP_OPEN=false).
// [향후] 보유 · 장착 · 구매의 기준은 서버(Supabase rhythm_user_skins · rhythm_user_settings · 구매 함수)다.
//        이 기기(localStorage)에는 "어떤 스킨을 장착해 쓸지" 화면 설정만 남기고 보유 목록은 저장하지 않는다
//        (보유 스킨은 로그인 회원 기준 온라인 자산).
import { DEFAULT_RHYTHM_BAR_SKIN_ID, DEFAULT_UI_SKIN_ID, LANE_PALETTE, SHOP_OPEN } from './config.js';

export const SKIN_TYPES = Object.freeze({ UI: 'ui', RHYTHM_BAR: 'rhythm-bar' });

// 기본 리듬 바 (render.js 기본값). 레인 색 = config.LANE_PALETTE (터치 버튼과 같은 색)
export const DEFAULT_RHYTHM_THEME = Object.freeze({
  bgTop: '#101A33',
  bgBottom: '#17284D',
  laneEven: 'rgba(255,255,255,0.06)',
  laneOdd: 'rgba(255,255,255,0.035)',
  laneLine: 'rgba(255,255,255,0.12)',
  judgeLine: 'rgba(255,255,255,0.9)',
  keyLabel: 'rgba(255,255,255,0.55)',
  pressGlow: 'rgba(255,255,255,0.55)',
  judgeGlow: 'rgba(255,209,102,0.45)',
  laneNeon: '#7FB8FF',                       // 레인 경계 neon
  beatLine: 'rgba(255,255,255,0.06)',        // 박자 가이드
  measureLine: 'rgba(255,255,255,0.16)',     // 마디(강박) 가이드
  palette: LANE_PALETTE,
});

/**
 * 스킨 카탈로그 (화면 표시용). 가격은 표시용이며 실제 가격은 서버 카탈로그(rhythm_skin_catalog)가 정한다.
 * theme: UI 스킨 = CSS 변수 { '--name': value } (비어 있으면 css/app.css 기본값 그대로)
 *        리듬 바 스킨 = render.js 색 (DEFAULT_RHYTHM_THEME 와 같은 키)
 */
export const SKIN_CATALOG = Object.freeze([
  Object.freeze({
    id: DEFAULT_UI_SKIN_ID, type: SKIN_TYPES.UI, name: '기본 UI', description: 'WONY RHYTHM 기본 화면',
    price: 0, isDefault: true, enabled: true, theme: Object.freeze({}),
  }),
  Object.freeze({
    id: DEFAULT_RHYTHM_BAR_SKIN_ID, type: SKIN_TYPES.RHYTHM_BAR, name: '기본 리듬 바', description: '기본 레인 · 노트 색',
    price: 0, isDefault: true, enabled: true, theme: DEFAULT_RHYTHM_THEME,
  }),
]);

const DEFAULT_BY_TYPE = Object.freeze({ [SKIN_TYPES.UI]: DEFAULT_UI_SKIN_ID, [SKIN_TYPES.RHYTHM_BAR]: DEFAULT_RHYTHM_BAR_SKIN_ID });
const FIELD_BY_TYPE = Object.freeze({ [SKIN_TYPES.UI]: 'uiSkinId', [SKIN_TYPES.RHYTHM_BAR]: 'rhythmBarSkinId' });

export function getSkin(id, catalog = SKIN_CATALOG) {
  return catalog.find(s => s.id === id) || null;
}

export function skinsOfType(type, catalog = SKIN_CATALOG) {
  return catalog.filter(s => s.type === type);
}

export function defaultSkinIds() {
  return { uiSkinId: DEFAULT_UI_SKIN_ID, rhythmBarSkinId: DEFAULT_RHYTHM_BAR_SKIN_ID };
}

// ── 저장소 (로컬 보조값). 향후 서버 저장소도 같은 모양 { loadOwned, loadEquipped, saveEquipped } ──────────
export const SKIN_STORAGE_KEY = 'wonyRhythm.skins.v1';

export function createLocalSkinRepository(storage = globalThis.localStorage) {
  const read = () => {
    try {
      const v = JSON.parse(storage?.getItem(SKIN_STORAGE_KEY) || 'null');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  };
  const write = data => {
    try {
      storage?.setItem(SKIN_STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  };
  return {
    /** 보유 스킨은 로컬에 두지 않음 (서버 저장소가 생기면 그쪽 목록). 기본 스킨은 ownedSkinIds 가 항상 더함 */
    loadOwned: () => [],
    loadEquipped: () => {
      const { uiSkinId, rhythmBarSkinId } = read();
      return { uiSkinId, rhythmBarSkinId };
    },
    saveEquipped: equipped => write({ uiSkinId: equipped.uiSkinId, rhythmBarSkinId: equipped.rhythmBarSkinId }),
  };
}

/** 보유 스킨: 기본 스킨은 항상 보유. 저장소 값 중 카탈로그에 없는 id 는 무시 */
export function ownedSkinIds(repo, catalog = SKIN_CATALOG) {
  const stored = new Set(repo?.loadOwned?.() || []);
  return catalog.filter(s => s.isDefault || stored.has(s.id)).map(s => s.id);
}

export function isOwned(id, repo, catalog = SKIN_CATALOG) {
  return ownedSkinIds(repo, catalog).includes(id);
}

/** 장착 스킨 (잘못된 값 · 보유하지 않은 값 · 판매 중지 · 종류가 다른 값은 기본 스킨으로) */
export function equippedSkins(repo, catalog = SKIN_CATALOG) {
  const saved = repo?.loadEquipped?.() || {};
  const owned = ownedSkinIds(repo, catalog);
  const pick = type => {
    const id = saved[FIELD_BY_TYPE[type]];
    const skin = getSkin(id, catalog);
    return skin && skin.type === type && skin.enabled && owned.includes(id) ? id : DEFAULT_BY_TYPE[type];
  };
  return { uiSkinId: pick(SKIN_TYPES.UI), rhythmBarSkinId: pick(SKIN_TYPES.RHYTHM_BAR) };
}

export const EQUIP_ERRORS = Object.freeze({
  UNKNOWN_SKIN: '없는 스킨입니다.',
  WRONG_TYPE: '이 자리에 장착할 수 없는 스킨입니다.',
  NOT_OWNED: '보유하지 않은 스킨입니다.',
  SKIN_DISABLED: '지금은 사용할 수 없는 스킨입니다.',
  SAVE_FAILED: '장착 정보를 저장하지 못했습니다.',
});

/** 장착 (UI 스킨과 리듬 바 스킨은 서로 영향 없음) → { ok, equipped } | { ok: false, error } */
export function equipSkin(type, id, repo, catalog = SKIN_CATALOG) {
  const skin = getSkin(id, catalog);
  if (!skin) return { ok: false, error: 'UNKNOWN_SKIN' };
  if (skin.type !== type || !FIELD_BY_TYPE[type]) return { ok: false, error: 'WRONG_TYPE' };
  if (!skin.enabled) return { ok: false, error: 'SKIN_DISABLED' };
  if (!isOwned(id, repo, catalog)) return { ok: false, error: 'NOT_OWNED' };
  const equipped = { ...equippedSkins(repo, catalog), [FIELD_BY_TYPE[type]]: id };
  if (!repo.saveEquipped(equipped)) return { ok: false, error: 'SAVE_FAILED' };
  return { ok: true, equipped };
}

// ── 구매 (인터페이스만. 상점이 열리기 전에는 항상 SHOP_CLOSED) ───────────────────
// 실제 구매는 서버 한 트랜잭션에서만: 로그인 회원 확인 → 판매 중인 스킨인지 → 이미 보유했는지 → DB 가격 →
// 잔액 확인 → 츄르 차감 → 보유 추가 → 커밋 (실패 시 전체 롤백). 브라우저는 skinId 만 보낸다
// (가격 · 잔액 · 보유 여부를 보내지 않으며, 보내더라도 서버가 무시해야 한다).
export const PURCHASE_ERRORS = Object.freeze({
  SHOP_CLOSED: '스킨 상점은 준비 중입니다.',
  LOGIN_REQUIRED: 'WONY PHONE 회원으로 로그인해야 구매할 수 있습니다.',
  UNKNOWN_SKIN: '없는 스킨입니다.',
  SKIN_DISABLED: '지금은 판매하지 않는 스킨입니다.',
  ALREADY_OWNED: '이미 보유한 스킨입니다.',
  INSUFFICIENT_CHURU: '츄르가 부족합니다.',
  NETWORK: '서버에 연결하지 못했습니다. 츄르는 차감되지 않았습니다.',
  SERVER: '구매를 처리하지 못했습니다. 츄르는 차감되지 않았습니다.',
});

/**
 * @param {string} skinId
 * @param {{ shopOpen?: boolean, api?: { purchase(skinId): Promise<{ok: boolean, error?: string, balance?: number, owned?: string[]}> } }} [opts]
 *   api = 향후 서버 구매 함수 호출 (POST /api/rhythm/skins/purchase → Supabase 구매 함수). 지금은 없음
 */
export async function purchaseSkin(skinId, { shopOpen = SHOP_OPEN, api = null, catalog = SKIN_CATALOG } = {}) {
  if (!shopOpen || !api) return { ok: false, error: 'SHOP_CLOSED' };
  const skin = getSkin(skinId, catalog);
  if (!skin) return { ok: false, error: 'UNKNOWN_SKIN' };
  if (!skin.enabled) return { ok: false, error: 'SKIN_DISABLED' };
  try {
    const out = await api.purchase(skinId);
    if (out?.ok) return { ok: true, balance: out.balance, owned: out.owned };
    return { ok: false, error: PURCHASE_ERRORS[out?.error] ? out.error : 'SERVER' };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}
