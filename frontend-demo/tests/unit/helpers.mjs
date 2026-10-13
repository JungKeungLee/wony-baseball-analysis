export class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

export function keyEvent(code, extra = {}) {
  const e = { code, repeat: false, target: null, prevented: false, ...extra };
  e.preventDefault = () => { e.prevented = true; };
  return e;
}

export function pointerEvent(pointerId, extra = {}) {
  const captured = [];
  const e = {
    pointerId, pointerType: 'touch', button: 0, prevented: false, captured,
    currentTarget: { setPointerCapture: id => captured.push(id) }, ...extra,
  };
  e.preventDefault = () => { e.prevented = true; };
  return e;
}

/** 4레인에 하나씩, 500ms 간격 노트 */
export function simpleChart(count = 8, start = 1000, gap = 500) {
  return { notes: Array.from({ length: count }, (_, i) => ({ time: start + i * gap, lane: i % 4 })) };
}
