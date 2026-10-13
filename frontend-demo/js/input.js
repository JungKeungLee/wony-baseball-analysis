// 키보드 + 터치(pointer) 입력. 둘 다 같은 onLaneDown(lane) → engine.hitLane() 경로로 들어간다.
import { DEFAULT_LANE_COUNT } from './config.js';
import { isTypingTarget } from './keys.js';

/**
 * @param {{laneCount?: number, getKeys: () => string[], onLaneDown: (lane: number, source: string) => void,
 *          onLaneUp?: (lane: number) => void, onPause?: () => void,
 *          onPressedChange?: (lane: number, pressed: boolean) => void}} opts
 */
export function createInput(opts) {
  const laneCount = opts.laneCount ?? DEFAULT_LANE_COUNT;
  const pressed = new Array(laneCount).fill(0); // 레인별로 누르고 있는 손가락/키 수
  const heldKeys = new Map();               // code → lane (키 반복 방지)
  const pointers = new Map();               // pointerId → lane (멀티터치를 손가락별로 독립 처리)

  function press(lane, source) {
    pressed[lane]++;
    if (pressed[lane] === 1) opts.onPressedChange?.(lane, true);
    opts.onLaneDown(lane, source);
  }

  function release(lane) {
    pressed[lane] = Math.max(0, pressed[lane] - 1);
    if (pressed[lane] === 0) opts.onPressedChange?.(lane, false);
    opts.onLaneUp?.(lane);
  }

  return {
    laneCount,
    pressed,

    keydown(e) {
      if (isTypingTarget(e.target) || e.metaKey) return false;
      if (e.ctrlKey && !String(e.code).startsWith('Control')) return false; // Ctrl+R 등 브라우저 단축키는 그대로
      if (e.code === 'Escape') {
        if (!e.repeat) opts.onPause?.();
        e.preventDefault?.();
        return false;
      }
      const lane = opts.getKeys().indexOf(e.code);
      if (lane === -1 || lane >= laneCount) return false;
      e.preventDefault?.(); // 방향키/스페이스로 페이지가 스크롤되거나 버튼이 눌리지 않게
      if (e.repeat || heldKeys.has(e.code)) return false; // 누르고 있는 동안 반복 판정 금지
      heldKeys.set(e.code, lane);
      press(lane, 'key');
      return true;
    },

    keyup(e) {
      if (!heldKeys.has(e.code)) return;
      const lane = heldKeys.get(e.code);
      heldKeys.delete(e.code);
      release(lane);
    },

    pointerdown(e, lane) {
      if (!Number.isInteger(lane) || lane < 0 || lane >= laneCount) return false;
      if (e.pointerType === 'mouse' && e.button !== 0) return false;
      e.preventDefault?.();
      if (pointers.has(e.pointerId)) return false;
      pointers.set(e.pointerId, lane);
      try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch { /* 이미 해제된 포인터 */ }
      press(lane, 'pointer');
      return true;
    },

    pointerup(e) {
      if (!pointers.has(e.pointerId)) return;
      const lane = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      release(lane);
    },

    /** 창이 포커스를 잃으면 keyup 이 안 올 수 있으므로 눌림 상태를 모두 푼다. */
    releaseAll() {
      for (const lane of heldKeys.values()) release(lane);
      for (const lane of pointers.values()) release(lane);
      heldKeys.clear();
      pointers.clear();
    },
  };
}
