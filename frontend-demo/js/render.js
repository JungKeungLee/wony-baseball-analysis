// Canvas 렌더러. 정적 배경(레인/판정선)은 리사이즈 때만 다시 그리고, 매 프레임엔 노트 · 눌림 · 타격 효과만 그린다.
//
// 색은 리듬 바 스킨(theme)에서 받는다 (기본 = DEFAULT_RHYTHM_THEME).
// 판정 · 점수 · 시계와 무관: 노트의 세로 위치(y)는 layout.noteY(video 시각) 그대로이고,
// 원근감은 x 방향(위로 갈수록 레인이 조금 좁아짐)에만 준다 → 판정선(아래)에서는 실제 레인 · 터치 버튼과 정확히 같은 폭.
// 타격 효과(링 · 파편)는 performance.now() 기준으로만 움직인다 (게임 시계와 분리, 동작 줄이기면 그리지 않음).
import { noteY } from './layout.js';
import { DEFAULT_RHYTHM_THEME } from './skins.js';

const paletteColors = (palette, n) => Array.from({ length: n }, (_, i) => palette[i % palette.length]);
const PERSPECTIVE_TOP = 0.84;     // 화면 맨 위에서 레인 폭 비율 (판정선 = 1)
const RING_MS = 320;
const SPARK_MS = 380;
const MAX_EFFECTS = 48;
const GRADE_COLORS = { PERFECT: '#FFD166', GREAT: '#7FD8FF', GOOD: '#9BE8C9', MISS: '#FF6B81' };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** '#RRGGBB' + alpha → rgba() */
function alpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function createRenderer(canvas, theme = DEFAULT_RHYTHM_THEME) {
  const t = { ...DEFAULT_RHYTHM_THEME, ...theme };
  const ctx = canvas.getContext('2d', { alpha: false });
  const bg = document.createElement('canvas');
  const bgCtx = bg.getContext('2d', { alpha: false });
  let layout = null;
  let labels = [];
  let colors = paletteColors(t.palette, 4);
  let topFade = null;
  const effects = [];          // { lane, grade, at, sparks: [{dx, dy}] }
  const seen = [];             // 레인별 마지막으로 효과를 만든 판정 시각 (같은 판정으로 효과를 두 번 만들지 않음)

  // 원근: y(위=0 → 판정선) 에서 레인 폭 비율. 판정선 아래는 1
  const scaleAt = y => PERSPECTIVE_TOP + (1 - PERSPECTIVE_TOP) * Math.min(1, Math.max(0, y / layout.judgeY));
  const xAt = (x, y) => {
    const cx = layout.fieldX + layout.fieldW / 2;
    return cx + (x - cx) * scaleAt(y);
  };

  /** 레인 i 를 y0~y1 사이 사다리꼴로 */
  function lanePath(c, i, y0, y1) {
    const x0 = layout.laneX[i];
    const x1 = x0 + layout.laneW;
    c.beginPath();
    c.moveTo(xAt(x0, y0), y0);
    c.lineTo(xAt(x1, y0), y0);
    c.lineTo(xAt(x1, y1), y1);
    c.lineTo(xAt(x0, y1), y1);
    c.closePath();
  }

  function paintBackground() {
    const { width: w, height: h, dpr, fieldX, fieldW, laneW, judgeY, laneCount } = layout;
    bg.width = canvas.width;
    bg.height = canvas.height;
    const c = bgCtx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, t.bgTop);
    grad.addColorStop(1, t.bgBottom);
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);

    // 레인: 아래(판정선)로 갈수록 레인 색이 살짝 밝아지는 깊이감
    for (let i = 0; i < laneCount; i++) {
      lanePath(c, i, 0, h);
      c.fillStyle = i % 2 ? t.laneOdd : t.laneEven;
      c.fill();
      const lg = c.createLinearGradient(0, 0, 0, judgeY);
      lg.addColorStop(0, alpha(colors[i], 0));
      lg.addColorStop(1, alpha(colors[i], 0.12));
      lanePath(c, i, 0, judgeY);
      c.fillStyle = lg;
      c.fill();
    }
    // 레인 경계선: 위로 갈수록 흐려짐
    const lineGrad = c.createLinearGradient(0, 0, 0, h);
    lineGrad.addColorStop(0, 'rgba(255,255,255,0)');
    lineGrad.addColorStop(0.35, t.laneLine);
    lineGrad.addColorStop(1, t.laneLine);
    c.strokeStyle = lineGrad;
    c.lineWidth = 1;
    for (let i = 0; i <= laneCount; i++) {
      const x = fieldX + i * laneW;
      c.beginPath();
      c.moveTo(xAt(x, 0), 0);
      c.lineTo(xAt(x, judgeY), judgeY);
      c.lineTo(x, h);
      c.stroke();
    }
    // 판정선 glow + 선
    const glow = c.createLinearGradient(0, judgeY - 26, 0, judgeY + 26);
    glow.addColorStop(0, 'rgba(255,255,255,0)');
    glow.addColorStop(0.5, t.judgeGlow);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = glow;
    c.fillRect(fieldX - 6, judgeY - 26, fieldW + 12, 52);
    c.fillStyle = t.judgeLine;
    c.fillRect(fieldX, judgeY - 2, fieldW, 4);
    // 레인별 타격 지점 표시 (레인 색 테두리)
    const recH = Math.max(10, Math.min(18, layout.noteH * 0.9));
    for (let i = 0; i < laneCount; i++) {
      c.strokeStyle = alpha(colors[i], 0.55);
      c.lineWidth = 2;
      roundRect(c, layout.laneX[i] + layout.notePad, judgeY - recH / 2, laneW - layout.notePad * 2, recH, Math.min(8, recH / 2));
      c.stroke();
    }
    // 판정선 아래 키 표시 (현재 설정값)
    const fontSize = Math.round(Math.min(laneW * 0.32, (h - judgeY) * 0.42, 26));
    c.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let i = 0; i < laneCount; i++) {
      c.fillStyle = t.keyLabel;
      c.fillText(labels[i] || '', fieldX + (i + 0.5) * laneW, judgeY + (h - judgeY) / 2);
    }
    // 위쪽 페이드 (노트가 멀리서 나타나는 느낌) — 매 프레임 노트 위에 덮음
    topFade = ctx.createLinearGradient(0, 0, 0, h * 0.12);
    topFade.addColorStop(0, t.bgTop);
    topFade.addColorStop(1, alpha(t.bgTop, 0));
  }

  function spawn(lane, grade, at) {
    if (effects.length >= MAX_EFFECTS) effects.shift();
    const n = grade === 'MISS' ? 0 : grade === 'PERFECT' ? 8 : 5;
    const sparks = Array.from({ length: n }, (_, k) => {
      const a = -Math.PI * (0.1 + 0.8 * (k / Math.max(1, n - 1)));   // 위쪽 반원으로 퍼짐 (결정적: 매 프레임 같은 모양)
      return { dx: Math.cos(a), dy: Math.sin(a) };
    });
    effects.push({ lane, grade, at, sparks });
  }

  function drawEffects(nowPerf) {
    const { laneW, judgeY } = layout;
    let keep = 0;
    for (const e of effects) {
      const age = nowPerf - e.at;
      if (age > SPARK_MS || age < 0) continue;
      effects[keep++] = e;
      const cx = layout.laneX[e.lane] + laneW / 2;
      const color = GRADE_COLORS[e.grade] || '#fff';
      if (e.grade === 'MISS') {
        ctx.globalAlpha = 0.35 * (1 - age / RING_MS);
        if (ctx.globalAlpha > 0) {
          ctx.fillStyle = color;
          ctx.fillRect(layout.laneX[e.lane] + 2, judgeY - 10, laneW - 4, 20);
        }
        continue;
      }
      if (age < RING_MS) {
        const p = age / RING_MS;
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3 * (1 - p) + 1;
        ctx.beginPath();
        ctx.ellipse(cx, judgeY, laneW * (0.22 + 0.38 * p), laneW * (0.12 + 0.2 * p), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      const q = age / SPARK_MS;
      ctx.globalAlpha = 1 - q;
      ctx.fillStyle = color;
      const dist = laneW * (0.2 + 0.55 * q);
      const size = Math.max(2, 4 * (1 - q));
      for (const s of e.sparks) ctx.fillRect(cx + s.dx * dist - size / 2, judgeY + s.dy * dist - size / 2, size, size);
    }
    effects.length = keep;
    ctx.globalAlpha = 1;
  }

  return {
    resize(nextLayout, keyLabels) {
      layout = nextLayout;
      labels = keyLabels;
      colors = paletteColors(t.palette, layout.laneCount);
      canvas.width = Math.round(layout.width * layout.dpr);
      canvas.height = Math.round(layout.height * layout.dpr);
      seen.length = 0;
      paintBackground();
    },

    /** 터치 버튼 등 DOM 쪽도 같은 레인 색을 쓰도록 */
    laneColors: n => paletteColors(t.palette, n),

    /**
     * @param state engine 상태 (읽기만 함)
     * @param songTime 판정과 같은 곡 시간(ms)
     * @param pressed 레인별 눌림 수
     * @param flashes 레인별 마지막 판정 효과 {grade, at(performance.now)}
     */
    draw(state, songTime, scrollMs, pressed, flashes, nowPerf, reducedMotion) {
      if (!layout) return;
      const { dpr, height: h, laneW, laneX, judgeY, noteH, notePad } = layout;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(bg, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      for (let lane = 0; lane < layout.laneCount; lane++) {
        // 키 입력 순간 lane pulse: 판정선에서 위로 퍼지는 레인 색 빛
        if (pressed[lane] > 0) {
          const g = ctx.createLinearGradient(0, judgeY - h * 0.45, 0, judgeY);
          g.addColorStop(0, alpha(colors[lane], 0));
          g.addColorStop(1, alpha(colors[lane], 0.32));
          ctx.fillStyle = g;
          lanePath(ctx, lane, judgeY - h * 0.45, judgeY);
          ctx.fill();
          ctx.fillStyle = t.pressGlow;
          ctx.fillRect(laneX[lane] + 2, judgeY - 3, laneW - 4, 6);
        }
        const flash = flashes[lane];
        if (flash && flash.at !== seen[lane]) {
          seen[lane] = flash.at;
          if (!reducedMotion) spawn(lane, flash.grade, flash.at);
        }

        // 아직 판정되지 않은 노트만, 화면에 보이는 범위까지만 그린다.
        const queue = state.lanes[lane];
        if (!queue) continue; // 레인 수가 바뀌는 순간(레이아웃 재계산 전) 방어
        const color = colors[lane];
        for (let i = state.laneHead[lane]; i < queue.length; i++) {
          const note = queue[i];
          if (note.time - songTime > scrollMs * 1.05) break;
          if (note.grade) continue;
          const y = noteY(note.time, songTime, layout, scrollMs);
          if (y < -noteH || y - noteH > h) continue;
          const scale = scaleAt(y);
          const w = (laneW - notePad * 2) * scale;
          const x = xAt(laneX[lane] + notePad, y);
          const nh = noteH * (0.85 + 0.15 * scale);
          ctx.fillStyle = color;
          roundRect(ctx, x, y - nh, w, nh, Math.min(8, nh / 2));
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.38)';   // 윗면 하이라이트 (판독성: 노트 본색은 그대로)
          ctx.fillRect(x + 3, y - nh + 2, Math.max(0, w - 6), Math.max(2, nh * 0.22));
        }
      }
      if (topFade) {
        ctx.fillStyle = topFade;
        ctx.fillRect(0, 0, layout.width, h * 0.12);
      }
      if (!reducedMotion && effects.length) drawEffects(nowPerf);
    },
  };
}
