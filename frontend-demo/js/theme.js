// 장착 스킨을 화면에 적용 (모양만: 게임 규칙 · 시계와 무관).
import { DEFAULT_RHYTHM_THEME, createLocalSkinRepository, equippedSkins, getSkin } from './skins.js';

/** 페이지(UI 스킨) 색: CSS 변수만 바꾼다. 기본 UI 스킨은 변수가 없어 css/app.css 그대로 */
export function applyUiSkin(root = document.documentElement, repo = createLocalSkinRepository()) {
  const { uiSkinId } = equippedSkins(repo);
  const skin = getSkin(uiSkinId);
  for (const [name, value] of Object.entries(skin?.theme || {})) {
    if (name.startsWith('--')) root.style.setProperty(name, String(value));
  }
  root.dataset.uiSkin = uiSkinId;
  return uiSkinId;
}

/** 플레이 화면(리듬 바 스킨) 색 → render.js. 빠진 값은 기본 리듬 바 색 */
export function rhythmBarTheme(repo = createLocalSkinRepository()) {
  const { rhythmBarSkinId } = equippedSkins(repo);
  return { id: rhythmBarSkinId, ...DEFAULT_RHYTHM_THEME, ...(getSkin(rhythmBarSkinId)?.theme || {}) };
}
