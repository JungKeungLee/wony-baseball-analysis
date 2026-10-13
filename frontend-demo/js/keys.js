// 키 설정 규칙. KeyboardEvent.code 를 저장한다 (한글 IME/Shift 상태와 무관하게 같은 물리 키).
import { DEFAULT_KEYS_BY_LANE_COUNT, DEFAULT_LANE_COUNT, normalizeLaneCount } from './config.js';

const ARROWS = { ArrowLeft: '←', ArrowDown: '↓', ArrowUp: '↑', ArrowRight: '→' };
const NAMED = {
  Space: 'Space', Enter: 'Enter', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt', Backspace: '⌫', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-',
  Equal: '=', Backquote: '`', CapsLock: 'Caps', IntlRo: 'ろ', IntlYen: '¥', Lang1: '한/영', Lang2: '한자',
};
// 게임 조작에 쓸 수 없는 키: Escape(일시정지/취소), Tab(포커스 이동), 시스템 키
const RESERVED = new Set(['Escape', 'Tab', 'MetaLeft', 'MetaRight', 'ContextMenu', 'OSLeft', 'OSRight']);

export function keyLabel(code) {
  if (!code) return '?';
  if (ARROWS[code]) return ARROWS[code];
  if (NAMED[code]) return NAMED[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'Num ' + code.slice(6).replace('Decimal', '.').replace('Add', '+')
    .replace('Subtract', '-').replace('Multiply', '*').replace('Divide', '/');
  return code;
}

export function isReservedKey(code) {
  return RESERVED.has(code) || /^F\d{1,2}$/.test(code);
}

/** laneCount 개의 서로 다른, 쓸 수 있는 키인지 */
export function isValidKeySet(keys, laneCount = DEFAULT_LANE_COUNT) {
  return Array.isArray(keys) && keys.length === laneCount
    && keys.every(k => typeof k === 'string' && k && !isReservedKey(k))
    && new Set(keys).size === laneCount;
}

/** 모드별 기본 키 (4키 ← ↓ ↑ →, 6키 S D F J K L, 8키 A S D F J K L ;) */
export function defaultKeys(laneCount = DEFAULT_LANE_COUNT) {
  return [...DEFAULT_KEYS_BY_LANE_COUNT[normalizeLaneCount(laneCount)]];
}

/**
 * 한 레인의 키를 바꾼 새 배열을 돌려준다. 원본은 바꾸지 않는다. 레인 수는 keys.length (4/6/8).
 * @returns {{ok: true, keys: string[]} | {ok: false, reason: 'reserved'|'duplicate'|'lane', lane?: number}}
 */
export function assignKey(keys, lane, code) {
  if (!Number.isInteger(lane) || lane < 0 || lane >= keys.length) return { ok: false, reason: 'lane' };
  if (isReservedKey(code)) return { ok: false, reason: 'reserved' };
  const owner = keys.indexOf(code);
  if (owner !== -1 && owner !== lane) return { ok: false, reason: 'duplicate', lane: owner };
  const next = [...keys];
  next[lane] = code;
  return { ok: true, keys: next };
}

/** 입력창/편집 가능한 요소에 포커스가 있으면 게임 키를 처리하지 않는다. */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(type);
}
