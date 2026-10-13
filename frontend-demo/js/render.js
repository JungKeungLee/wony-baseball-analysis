// Canvas 렌더러. 정적 배경(레인/판정선)은 리사이즈 때만 다시 그리고, 매 프레임엔 노트와 눌림 효과만 그린다.
// 색은 리듬 바 스킨(theme)에서 받는다 (기본 = DEFAULT_RHYTHM_THEME, 이전과 같은 색). 위치 · 시간 계산은 스킨과 무관.
import { noteY } from './layout.js';
import { DEFAULT_RHYTHM_THEME } from './skins.js';

const paletteColors = (palette, n) => Array.from({ length: n }, (_, i) => palette[i % palette.length]);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function createRenderer(canvas, theme = DEFAULT_RHYTHM_THEME) {
  const t = { ...DEFAULT_RHYTHM_THEME, ...theme };
  const ctx = canvas.getContext('2d', { alpha: false });
  const bg = document.createElement('canvas');
  const bgCtx = bg.getContext('2d', { alpha: false });
  let layout = null;
  let labels = [];
  let colors = paletteColors(t.palette, 4);

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
    for (let i = 0; i < laneCount; i++) {
      c.fillStyle = i % 2 ? t.laneOdd : t.laneEven;
      c.fillRect(fieldX + i * laneW, 0, laneW, h);
    }
    c.strokeStyle = t.laneLine;
    c.lineWidth = 1;
    for (let i = 0; i <= laneCount; i++) {
      const x = Math.round(fieldX + i * laneW) + 0.5;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
    // 판정선
    c.fillStyle = t.judgeLine;
    c.fillRect(fieldX, judgeY - 2, fieldW, 4);
    // 판정선 아래 키 표시 (현재 설정값)
    const fontSize = Math.round(Math.min(laneW * 0.32, (h - judgeY) * 0.42, 26));
    c.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let i = 0; i < laneCount; i++) {
      c.fillStyle = t.keyLabel;
      c.fillText(labels[i] || '', fieldX + (i + 0.5) * laneW, judgeY + (h - judgeY) / 2);
    }
  }

  return {
    resize(nextLayout, keyLabels) {
      layout = nextLayout;
      labels = keyLabels;
      colors = paletteColors(t.palette, layout.laneCount);
      canvas.width = Math.round(layout.width * layout.dpr);
      canvas.height = Math.round(layout.height * layout.dpr);
      paintBackground();
    },

    /**
     * @param state engine 상태 (읽기만 함)
     * @param songTime 판정과 같은 곡 시간(ms)
     * @param pressed 레인별 눌림 수
     * @param flashes 레인별 마지막 판정 효과 {grade, at(performance.now)}
     */
    /** 터치 버튼 등 DOM 쪽도 같은 레인 색을 쓰도록 */
    laneColors: n => paletteColors(t.palette, n),

    draw(state, songTime, scrollMs, pressed, flashes, nowPerf, reducedMotion) {
      if (!layout) return;
      const { dpr, height: h, laneW, laneX, judgeY, noteH, notePad } = layout;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(bg, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      for (let lane = 0; lane < layout.laneCount; lane++) {
        const x = laneX[lane];
        if (pressed[lane] > 0) {
          const g = ctx.createLinearGradient(0, judgeY - h * 0.35, 0, judgeY);
          g.addColorStop(0, 'rgba(255,255,255,0)');
          g.addColorStop(1, t.pressGlow);
          ctx.fillStyle = g;
          ctx.fillRect(x, judgeY - h * 0.35, laneW, h * 0.35);
        }
        const flash = flashes[lane];
        if (flash && !reducedMotion) {
          const age = nowPerf - flash.at;
          if (age < 180 && flash.grade !== 'MISS') {
            ctx.globalAlpha = 1 - age / 180;
            ctx.fillStyle = colors[lane];
            ctx.fillRect(x + 2, judgeY - 6, laneW - 4, 12);
            ctx.globalAlpha = 1;
          }
        }

        // 아직 판정되지 않은 노트만, 화면에 보이는 범위까지만 그린다.
        const queue = state.lanes[lane];
        if (!queue) continue; // 레인 수가 바뀌는 순간(레이아웃 재계산 전) 방어
        ctx.fillStyle = colors[lane];
        for (let i = state.laneHead[lane]; i < queue.length; i++) {
          const note = queue[i];
          if (note.time - songTime > scrollMs * 1.05) break;
          if (note.grade) continue;
          const y = noteY(note.time, songTime, layout, scrollMs);
          if (y < -noteH || y - noteH > h) continue;
          roundRect(ctx, x + notePad, y - noteH, laneW - notePad * 2, noteH, Math.min(8, noteH / 2));
          ctx.fill();
        }
      }
    },
  };
}
