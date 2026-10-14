// 워니 안내 UI: 이미지 + 짧은 말풍선. 화면 흐름 안에 자리 잡는 요소라 게임 UI · 버튼 위에 겹치지 않는다
// (떠 있는 오버레이가 아님). 좁은 화면에서는 CSS 가 크기를 줄이거나 이미지를 숨긴다. 문구 · 이미지는 wony-lines.js.
import { WONY_ALT, WONY_IMAGE } from './wony-lines.js';

/** el(.wony) 안에 이미지 + 말풍선을 채운다 */
export function renderWony(el, text) {
  if (!el) return;
  let img = el.querySelector('.wony-img');
  if (!img) {
    img = Object.assign(document.createElement('img'), { className: 'wony-img', src: WONY_IMAGE, alt: WONY_ALT, decoding: 'async', width: 96, height: 96 });
    img.addEventListener('error', () => img.remove(), { once: true });   // 이미지가 없어도 말풍선만으로 동작
    const bubble = Object.assign(document.createElement('p'), { className: 'wony-bubble' });
    el.replaceChildren(img, bubble);
  }
  el.querySelector('.wony-bubble').textContent = text;
  el.hidden = !text;
}
