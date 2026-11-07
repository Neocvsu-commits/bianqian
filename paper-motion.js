/* Paper coordinates stay 360 × 390. The drawing surface fills the viewport. */
(() => {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = t => 1 - Math.pow(1 - t, 3);
  const idlePhases = new Set(['idle', 'hover', 'hover-return', 'destroyed']);

  function mix(hex, amount, toward = 255) {
    const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#f5df8f';
    const rgb = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
    return `rgb(${rgb.map(v => Math.round(v + (toward - v) * amount)).join(',')})`;
  }

  // Analytic damped spring: consistent at 60, 120, or 144 Hz.
  function spring(position, velocity, target, dt, frequency, damping) {
    const decay = damping * frequency;
    const oscillation = frequency * Math.sqrt(1 - damping * damping);
    const offset = position - target;
    const b = (velocity + decay * offset) / oscillation;
    const sine = Math.sin(oscillation * dt);
    const cosine = Math.cos(oscillation * dt);
    const attenuation = Math.exp(-decay * dt);
    const wave = offset * cosine + b * sine;
    return [target + attenuation * wave,
      attenuation * (-decay * wave - offset * oscillation * sine + b * oscillation * cosine)];
  }

  function clip(poly, nx, ny, offset, lower) {
    if (!poly.length) return [];
    const result = [];
    let a = poly[poly.length - 1];
    let da = a[0] * nx + a[1] * ny - offset;
    for (const b of poly) {
      const db = b[0] * nx + b[1] * ny - offset;
      const ain = lower ? da >= 0 : da <= 0;
      const bin = lower ? db >= 0 : db <= 0;
      if (ain !== bin) {
        const t = da / (da - db);
        result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
      if (bin) result.push(b);
      a = b;
      da = db;
    }
    return result;
  }

  function path(ctx, poly) {
    ctx.beginPath();
    poly.forEach((point, i) => i ? ctx.lineTo(...point) : ctx.moveTo(...point));
    ctx.closePath();
  }

  class PaperMotion {
    constructor({canvas, color = '#f5df8f', lines = [], title = '', date = '', number = '01',
      wordCount = 0, scrollOffset = 0, onDetach, onSettle, onHold, onProgress}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', {alpha: true});
      this.appearance = {color, lines, title, date, number, wordCount, scrollOffset};
      this.onDetach = onDetach;
      this.onSettle = onSettle;
      this.onHold = onHold;
      this.onProgress = onProgress;
      this.lastProgress = -1;
      this.stage = canvas.closest('.paper-stage') || canvas.parentElement;
      this.phase = 'idle';
      this._side = 'right';
      this.direction = -1;
      this.frame = 0;
      this.x = this.y = this.vx = this.vy = this.tx = this.ty = 0;
      this.gripY = 195;
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.surface = document.createElement('canvas');
      this.front = document.createElement('canvas');
      this.back = document.createElement('canvas');
      this.tick = this.tick.bind(this);
      this.resize();
      this.draw();
    }

    get active() { return !idlePhases.has(this.phase); }
    get side() { return this.pendingGrip?.side || this._side; }
    get progress() { return clamp(this.direction * this.x / this.w, 0, 1); }

    selectSide(side) {
      const next = side === 'left' ? 'left' : 'right';
      this._side = next;
      this.direction = next === 'left' ? 1 : -1;
    }

    resize() {
      const w = Number(this.canvas.dataset.paperWidth) || 360;
      const h = Number(this.canvas.dataset.paperHeight) || 390;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (w !== this.w || h !== this.h || dpr !== this.dpr) {
        this.w = w;
        this.h = h;
        this.dpr = dpr;
        this.rectangle = [[0, 0], [w, 0], [w, h], [0, h]];
        this.makeTextures();
      }
      this.resizeViewport(false);
    }

    resizeViewport(repaint = true) {
      if (this.phase === 'destroyed') return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (dpr !== this.dpr) {
        this.dpr = dpr;
        this.makeTextures();
      }
      const bounds = this.stage.getBoundingClientRect();
      this.viewportX = bounds.left;
      this.viewportY = bounds.top;
      this.viewportWidth = Math.max(1, window.innerWidth);
      this.viewportHeight = Math.max(1, window.innerHeight);
      Object.assign(this.canvas.style, {
        left: `${-bounds.left}px`, top: `${-bounds.top}px`, right: 'auto', bottom: 'auto',
        width: `${this.viewportWidth}px`, height: `${this.viewportHeight}px`
      });
      const width = Math.round(this.viewportWidth * dpr);
      const height = Math.round(this.viewportHeight * dpr);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.dirtyBounds = null;
      }
      if (repaint) this.draw();
    }

    setAppearance(next) {
      if (this.phase === 'destroyed') return;
      const appearance = {...this.appearance, ...next};
      if (JSON.stringify(appearance) === this.appearanceKey) return;
      this.appearance = appearance;
      this.resize();
      this.makeTextures();
      this.draw();
    }

    // Only the physical paper, without writing or an external shadow.
    getSurfaceDataURL() {
      if (!this.surfaceURL) this.surfaceURL = this.surface.toDataURL('image/png');
      return this.surfaceURL;
    }

    paintSurface(canvas) {
      canvas.width = this.surface.width;
      canvas.height = this.surface.height;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(this.surface, 0, 0);
    }

    makeSurface() {
      const {w, h, dpr} = this;
      const {color} = this.appearance;
      const key = `${w}/${h}/${dpr}/${color}`;
      if (key === this.surfaceKey) return;
      this.surfaceKey = key;
      this.surfaceURL = null;
      this.surface.width = Math.round(w * dpr);
      this.surface.height = Math.round(h * dpr);
      const ctx = this.surface.getContext('2d');
      ctx.scale(dpr, dpr);
      const light = ctx.createLinearGradient(0, 0, w * .85, h);
      light.addColorStop(0, mix(color, .14));
      light.addColorStop(.18, mix(color, .065));
      light.addColorStop(.68, color);
      light.addColorStop(1, mix(color, .035, 0));
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(w * .22, h * .24, 12, w * .32, h * .35, w * .95);
      glow.addColorStop(0, 'rgba(255,253,226,.10)');
      glow.addColorStop(1, 'rgba(225,170,49,.015)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // Fixed-seed fibres and grain never crawl while text is being edited.
      let seed = 812329;
      const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const grain = document.createElement('canvas');
      grain.width = grain.height = 160;
      const grainContext = grain.getContext('2d');
      const pixels = grainContext.createImageData(160, 160);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const white = random() > .49;
        pixels.data[i] = white ? 255 : 89;
        pixels.data[i + 1] = white ? 252 : 66;
        pixels.data[i + 2] = white ? 229 : 22;
        pixels.data[i + 3] = Math.round(random() * (white ? 28 : 12));
      }
      grainContext.putImageData(pixels, 0, 0);
      ctx.fillStyle = ctx.createPattern(grain, 'repeat');
      ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = .34;
      for (let i = 0; i < 1500; i++) {
        const x = random() * w;
        const y = random() * h;
        const length = .6 + random() * 3.6;
        ctx.strokeStyle = i % 3 ? 'rgba(105,79,27,.045)' : 'rgba(255,255,235,.20)';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + length, y + (random() - .5) * 1.2);
        ctx.stroke();
      }
      const glue = ctx.createLinearGradient(0, 0, 0, 29);
      glue.addColorStop(0, 'rgba(111,83,25,.10)');
      glue.addColorStop(.25, 'rgba(119,92,34,.045)');
      glue.addColorStop(.86, 'rgba(119,92,34,.025)');
      glue.addColorStop(1, 'rgba(119,92,34,0)');
      ctx.fillStyle = glue;
      ctx.fillRect(0, 0, w, 29);
      ctx.fillStyle = 'rgba(109,82,24,.045)';
      ctx.fillRect(0, 24, w, .6);
      ctx.fillStyle = 'rgba(255,253,227,.32)';
      ctx.fillRect(0, 24.8, w, .7);
      ctx.fillStyle = 'rgba(255,255,236,.40)';
      ctx.fillRect(.5, .5, w - 1, .7);
      ctx.fillRect(.5, .5, .6, h - 1);
      ctx.fillStyle = 'rgba(115,82,25,.17)';
      ctx.fillRect(w - .7, .7, .7, h - .7);
      ctx.fillRect(.7, h - .7, w - .7, .7);
    }

    makeTextures() {
      const {w, h, dpr} = this;
      const appearanceKey = JSON.stringify(this.appearance);
      const textureKey = `${w}/${h}/${dpr}/${appearanceKey}`;
      if (textureKey === this.textureKey) return;
      this.textureKey = textureKey;
      this.appearanceKey = appearanceKey;
      const {color, title, date, lines, number = '01', wordCount = 0, scrollOffset = 0} = this.appearance;
      this.makeSurface();
      for (const canvas of [this.front, this.back]) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const front = this.front.getContext('2d');
      const textTools = window.PaperText;
      front.scale(dpr, dpr);
      front.drawImage(this.surface, 0, 0, w, h);
      front.textBaseline = 'alphabetic';
      front.fillStyle = title ? '#444638' : 'rgba(101,92,58,.412)';
      front.font = '500 25px "SiyeLatin", "KaiTi", "STKaiti", "Microsoft YaHei", serif';
      const titleMetrics = front.measureText('国Ag');
      const titleBaseline = Number.isFinite(titleMetrics.fontBoundingBoxAscent) && Number.isFinite(titleMetrics.fontBoundingBoxDescent)
        ? 76 + (38 - titleMetrics.fontBoundingBoxAscent - titleMetrics.fontBoundingBoxDescent) / 2 + titleMetrics.fontBoundingBoxAscent
        : 104;
      front.save();
      front.beginPath();
      front.rect(29, 76, w - 58, 39);
      front.clip();
      textTools.drawLineRun(front, String(title || '起个标题…'), 29, titleBaseline);
      front.restore();
      front.fillStyle = 'rgba(98,92,62,.49)';
      front.font = '10px "Segoe UI", sans-serif';
      if ('letterSpacing' in front) front.letterSpacing = '1.1px';
      front.textAlign = 'right';
      front.fillText(String(date || ''), w - 29, 45);
      front.textAlign = 'left';
      front.strokeStyle = 'rgba(116,99,46,.22)';
      front.lineWidth = 1;
      front.beginPath();
      front.roundRect(29.5, 33.5, 23, 19, 3);
      front.stroke();
      front.font = '9px "Segoe UI", sans-serif';
      front.fillText(String(number), 34, 46);
      if ('letterSpacing' in front) front.letterSpacing = '0px';
      const sourceLines = Array.isArray(lines) ? lines : String(lines).split('\n');
      const lineText = line => typeof line === 'string' ? line : String(line?.text ?? '');
      const emptyBody = !sourceLines.length || (sourceLines.length === 1 && lineText(sourceLines[0]) === '');
      front.fillStyle = emptyBody ? 'rgba(101,92,58,.412)' : '#50513f';
      front.font = '20px "SiyeLatin", "KaiTi", "STKaiti", "Microsoft YaHei", serif';
      const bodyMetrics = front.measureText('国Ag');
      const bodyBaseline = Number.isFinite(bodyMetrics.fontBoundingBoxAscent) && Number.isFinite(bodyMetrics.fontBoundingBoxDescent)
        ? 128 + (36 - bodyMetrics.fontBoundingBoxAscent - bodyMetrics.fontBoundingBoxDescent) / 2 + bodyMetrics.fontBoundingBoxAscent
        : 151;
      const wrapped = [];
      const formatFields = ['strikes', 'underlines', 'highlights', 'bolds'];
      for (const line of emptyBody ? ['想到什么，就写下来…'] : sourceLines) {
        const text = lineText(line);
        const formatRanges = Object.fromEntries(formatFields.map(field =>
          [field, typeof line === 'object' && Array.isArray(line?.[field]) ? line[field] : []]));
        const todo = typeof line === 'object' ? line?.todo : /^[○●] /.test(text)
          ? {offset: 0, done: text[0] === '●'} : null;
        if (todo?.done && typeof line === 'string' && text.length > 2) {
          formatRanges.strikes = [...formatRanges.strikes, {start: 2, end: text.length}];
        }
        const pushLine = (fragment, start) => {
          const row = {text: fragment, start: (Number(line?.start) || 0) + start};
          for (const field of formatFields) {
            row[field] = formatRanges[field].map(range => ({
              start: Math.max(0, Math.trunc(Number(range.start)) - start),
              end: Math.min(fragment.length, Math.trunc(Number(range.end)) - start)
            })).filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
          }
          if (todo && start === 0) row.todo = {...todo};
          wrapped.push(row);
        };
        let paragraphStart = 0;
        for (const paragraph of text.split('\n')) {
          let current = '';
          let currentStart = paragraphStart;
          let utf16Offset = paragraphStart;
          for (const char of paragraph) {
            if (current && textTools.measureLine(front, current + char) > w - 66) {
              pushLine(current, currentStart);
              current = '';
              currentStart = utf16Offset;
            }
            current += char;
            utf16Offset += char.length;
          }
          pushLine(current, currentStart);
          paragraphStart += paragraph.length + 1;
        }
      }
      front.save();
      front.beginPath();
      front.rect(29, 128, w - 58, 214);
      front.clip();
      const offset = Math.max(0, Number(scrollOffset) || 0);
      for (let i = Math.max(0, Math.floor(offset / 36) - 1); i < wrapped.length; i++) {
        const y = bodyBaseline + i * 36 - offset;
        if (y > 365) break;
        const line = wrapped[i];
        const ink = front.fillStyle;
        const position = index => 29 + textTools.measureLine(front, line.text.slice(0, index));
        const markerLength = line.todo && /^[○●]/.test(line.text) ? 1 : 0;
        front.save();
        front.fillStyle = 'rgba(152,125,42,.18)';
        for (const range of line.highlights) {
          const x1 = position(range.start), x2 = position(range.end);
          if (x2 <= x1) continue;
          front.beginPath();
          front.roundRect(x1 - .3, y - 17, x2 - x1 + .6, 21, 2);
          front.fill();
        }
        front.fillStyle = ink;
        textTools.drawLineRun(front, line.text, 29, y, {start: markerLength});
        // Stroke thickens the original glyphs without changing their advances.
        front.strokeStyle = ink;
        front.lineWidth = .45;
        front.lineJoin = 'round';
        for (const range of line.bolds) {
          const start = Math.max(markerLength, range.start);
          if (range.end > start) textTools.drawLineRun(front, line.text, 29, y, {start, end: range.end, stroke: true});
        }
        if (markerLength) {
          const cx = 29 + front.measureText(line.text[0]).width * .5;
          const cy = y - 7;
          front.beginPath();
          front.arc(cx, cy, 5.5, 0, Math.PI * 2);
          front.lineWidth = 1;
          front.strokeStyle = ink;
          front.fillStyle = ink;
          if (line.todo.done) front.fill();
          front.stroke();
          if (line.todo.done) {
            front.strokeStyle = '#fffdf4';
            front.lineWidth = 1.2;
            front.lineCap = 'round';
            front.beginPath();
            front.moveTo(cx - 2.8, cy);
            front.lineTo(cx - .7, cy + 2.1);
            front.lineTo(cx + 3, cy - 2.2);
            front.stroke();
          }
        }
        front.strokeStyle = ink;
        front.lineWidth = .9;
        front.lineCap = 'round';
        for (const range of line.underlines) {
          const start = Math.max(markerLength, range.start);
          if (range.end <= start) continue;
          front.beginPath();
          front.moveTo(position(start), y + 2);
          front.lineTo(position(range.end), y + 2);
          front.stroke();
        }
        front.globalAlpha = .78;
        front.lineWidth = .95;
        front.lineCap = 'round';
        for (const range of line.strikes) {
          const start = Math.max(markerLength, range.start);
          if (range.end <= start) continue;
          const x1 = position(start);
          const x2 = position(range.end);
          const length = x2 - x1;
          front.beginPath();
          front.moveTo(x1, y - 7.1);
          front.bezierCurveTo(x1 + length * .32, y - 7.9, x1 + length * .72, y - 6.7, x2, y - 7.3);
          front.stroke();
        }
        front.restore();
      }
      front.restore();
      front.font = '9px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      front.fillStyle = 'rgba(106,100,62,.46)';
      front.fillText(`${wordCount} 字`, 29, h - 25);
      front.strokeStyle = 'rgba(107,91,45,.125)';
      front.beginPath();
      front.moveTo(70, h - 28);
      front.lineTo(w - 47, h - 28);
      front.stroke();
      const back = this.back.getContext('2d');
      back.scale(dpr, dpr);
      back.drawImage(this.surface, 0, 0, w, h);
      back.fillStyle = mix(color, .28);
      back.globalAlpha = .64;
      back.fillRect(0, 0, w, h);
      back.globalAlpha = .04;
      back.drawImage(this.front, 0, 0, w, h);
      back.globalAlpha = 1;
    }

    wake() {
      if (this.frame || this.phase === 'destroyed') return;
      this.lastTime = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }

    hover(x, y, side = 'right') {
      if (this.active || this.phase === 'destroyed') return false;
      side = side === 'left' ? 'left' : 'right';
      if (side !== this._side && Math.hypot(this.x, this.y) > .15) {
        this.pendingHover = {x, y, side};
        this.phase = 'hover-return';
        this.tx = this.ty = 0;
        this.wake();
        return true;
      }
      this.pendingHover = null;
      this.selectSide(side);
      this.phase = 'hover';
      this.gripY = clamp(y, 3, this.h - 3);
      const edgeDistance = this._side === 'left' ? x : this.w - x;
      const proximity = 1 - clamp(edgeDistance / 42, 0, 1);
      const lift = this.motionQuery.matches ? 5 : 7 + proximity * 11;
      this.tx = this.direction * lift;
      this.ty = ((this.gripY / this.h) - .5) * lift * .50;
      this.wake();
      return true;
    }

    leave() {
      this.pendingHover = null;
      if (this.phase !== 'hover') return;
      this.phase = 'hover-return';
      this.tx = this.ty = 0;
      this.wake();
    }

    begin(x, y, side = 'right') {
      if (this.phase !== 'idle' && this.phase !== 'hover' && this.phase !== 'hover-return') return false;
      this.resize();
      side = side === 'left' ? 'left' : 'right';
      this.pendingHover = null;
      if (side !== this._side && Math.hypot(this.x, this.y) > .15) {
        this.pendingGrip = {originX: x, originY: y, x, y, side};
        this.phase = 'switching-drag';
        this.tx = this.ty = this.vx = this.vy = 0;
        this.wake();
        return true;
      }
      this.selectSide(side);
      this.originX = x;
      this.originY = y;
      if (Math.hypot(this.x, this.y) <= .15) this.gripY = clamp(y, 0, this.h);
      this.dragOffsetX = this.direction * Math.max(0, this.direction * this.x);
      this.dragOffsetY = this.y;
      this.phase = 'dragging';
      this.pointerSpeed = 0;
      this.lastMove = performance.now();
      this.tx = this.dragOffsetX;
      this.ty = this.dragOffsetY;
      this.x = this.tx;
      this.y = this.ty;
      this.vx = this.vy = 0;
      this.emitProgress(this.progress, true);
      this.draw();
      this.wake();
      return true;
    }

    move(x, y) {
      if (this.phase === 'switching-drag') {
        this.pendingGrip.x = x;
        this.pendingGrip.y = y;
        return;
      }
      if (this.phase !== 'dragging') return;
      const now = performance.now();
      const dt = Math.max(.004, (now - this.lastMove) / 1000);
      const pull = Math.max(0, (x - this.originX + this.dragOffsetX) * this.direction);
      const dx = this.direction * pull;
      // The visible edge follows the exact pointer delta; no spring or
      // distance-dependent vertical gain is applied while it is held.
      const rawY = y - this.originY + this.dragOffsetY;
      const dy = rawY;
      const speed = (pull - this.direction * this.tx) / dt;
      this.pointerSpeed = this.pointerSpeed * .30 + speed * .70;
      this.tx = dx;
      this.ty = dy;
      this.x = dx;
      this.y = dy;
      this.vx = this.vy = 0;
      this.lastMove = now;
      this.wake();
    }

    release(action = null) {
      if (this.phase === 'switching-drag') {
        this.pendingGrip = null;
        this.phase = 'settling';
        this.tx = this.ty = 0;
        this.wake();
        return false;
      }
      if (this.phase !== 'dragging') return false;
      const progress = this.direction * this.tx / this.w;
      const detached = progress >= .35 && ['archive', 'delete', 'detach'].includes(action);
      if (detached) {
        this.detach();
      } else {
        this.phase = 'settling';
        this.tx = this.ty = 0;
        this.vx *= .28;
        this.vy *= .28;
      }
      this.wake();
      return detached;
    }

    hold() {
      if (this.phase !== 'dragging' && this.phase !== 'demo') return false;
      this.phase = 'held';
      this.vx *= .12;
      this.vy *= .12;
      this.emitProgress(clamp(this.direction * this.tx / this.w, 0, 1), true);
      this.onHold?.();
      return true;
    }

    commit() {
      if (this.phase !== 'held') return false;
      this.detach();
      this.wake();
      return true;
    }

    emitProgress(progress, force = false) {
      if (!force && Math.abs(progress - this.lastProgress) < .002) return;
      this.lastProgress = progress;
      this.onProgress?.(progress);
    }

    cancel() {
      if (this.phase === 'idle' || this.phase === 'destroyed' || this.phase === 'detaching' || this.phase === 'detached') return;
      this.pendingGrip = this.pendingHover = null;
      this.phase = this.active ? 'settling' : 'hover-return';
      this.tx = this.ty = 0;
      this.vx *= .25;
      this.vy *= .25;
      this.wake();
    }

    demo() {
      if (this.active || this.phase === 'destroyed') return false;
      if (!this.begin(this._side === 'left' ? 4 : this.w - 4, this.h * .64, this._side)) return false;
      this.phase = 'demo';
      this.demoStart = performance.now();
      this.demoFromX = this.x;
      this.demoFromY = this.y;
      this.wake();
      return true;
    }

    detach() {
      this.phase = 'detaching';
      this.flightStart = performance.now();
      this.flightProgress = 0;
      this.flightFromX = this.x;
      this.flightFromY = this.y;
      this.flightDirection = clamp(this.y / Math.max(20, this.direction * this.x), -.48, .48);
      const distance = Math.max(.001, Math.hypot(this.x, this.y));
      const nx = -this.x / distance;
      const ny = -this.y / distance;
      const gripX = this._side === 'left' ? 0 : this.w;
      const farthest = nx * gripX + ny * this.gripY - Math.min(...this.rectangle.map(([x, y]) => nx * x + ny * y));
      // Finish with every point past the curved section, preserving the pull
      // direction. No whole-page translation is needed to fake detachment.
      const finishDistance = Math.max(distance, 2 * (farthest + 54));
      this.flightToX = -nx * finishDistance;
      this.flightToY = -ny * finishDistance;
    }

    resetAfterDetach() {
      if (this.phase !== 'detached') return false;
      this.phase = 'idle';
      this.x = this.y = this.vx = this.vy = this.tx = this.ty = 0;
      this.draw();
      return true;
    }

    tick(now) {
      this.frame = 0;
      if (this.phase === 'idle' || this.phase === 'destroyed' || this.phase === 'detached') return;
      const dt = Math.min(.04, Math.max(.001, (now - this.lastTime) / 1000));
      this.lastTime = now;
      if (this.phase === 'demo') {
        const progress = clamp((now - this.demoStart) / (this.motionQuery.matches ? 220 : 850), 0, 1);
        const pull = progress * progress * (3 - 2 * progress);
        this.tx = this.demoFromX + (this.direction * this.w * .54 - this.demoFromX) * pull;
        this.ty = this.demoFromY + (-this.h * .11 - this.demoFromY) * pull;
        if (progress === 1) this.hold();
      }
      if (this.phase === 'detaching') {
        this.flightProgress = clamp((now - this.flightStart) / (this.motionQuery.matches ? 180 : 680), 0, 1);
        const t = clamp(this.flightProgress / .78, 0, 1);
        const peel = t * t * (3 - 2 * t);
        this.tx = this.flightFromX + (this.flightToX - this.flightFromX) * peel;
        this.ty = this.flightFromY + (this.flightToY - this.flightFromY) * peel;
        if (this.flightProgress === 1) {
          this.phase = 'detached';
          this.x = this.y = this.vx = this.vy = this.tx = this.ty = 0;
          this.clearDirty();
          this.emitProgress(0, true);
          this.onDetach?.();
          return;
        }
      }
      const returning = ['settling', 'hover-return', 'switching-drag'].includes(this.phase);
      if (returning || this.phase === 'hover') {
        const frequency = this.phase === 'switching-drag' ? 70 : returning ? 24 : 35;
        const damping = returning ? .90 : .92;
        [this.x, this.vx] = spring(this.x, this.vx, this.tx, dt, frequency, damping);
        [this.y, this.vy] = spring(this.y, this.vy, this.ty, dt, frequency, damping);
      } else {
        this.x = this.tx;
        this.y = this.ty;
        this.vx = this.vy = 0;
      }
      const quiet = Math.hypot(this.x - this.tx, this.y - this.ty) < .06 && Math.hypot(this.vx, this.vy) < 1.2;
      if (returning && quiet) {
        this.x = this.y = this.vx = this.vy = 0;
        if (this.phase === 'switching-drag' && this.pendingGrip) {
          const grip = this.pendingGrip;
          this.pendingGrip = null;
          this.phase = 'idle';
          this.begin(grip.originX, grip.originY, grip.side);
          this.move(grip.x, grip.y);
          this.draw();
          return;
        }
        if (this.phase === 'hover-return' && this.pendingHover) {
          const hover = this.pendingHover;
          this.pendingHover = null;
          this.phase = 'idle';
          this.hover(hover.x, hover.y, hover.side);
          return;
        }
        this.phase = 'idle';
        this.draw();
        this.emitProgress(0, true);
        this.onSettle?.();
        return;
      }
      this.draw();
      if (['dragging', 'demo', 'held', 'settling'].includes(this.phase)) {
        this.emitProgress(clamp(this.direction * (this.phase === 'held' ? this.tx : this.x) / this.w, 0, 1));
      }
      if (quiet && (this.phase === 'hover' || this.phase === 'dragging' || this.phase === 'held')) return;
      if (!this.frame) this.frame = requestAnimationFrame(this.tick);
    }

    contactShadow(poly, strength = 1) {
      if (!poly.length) return;
      const ctx = this.ctx;
      ctx.save();
      path(ctx, poly);
      ctx.shadowColor = `rgba(66,44,16,${.15 * strength})`;
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = 'rgba(63,44,17,.12)';
      ctx.fill();
      ctx.shadowBlur = 1.6;
      ctx.shadowOffsetY = 1;
      ctx.shadowColor = `rgba(67,47,19,${.28 * strength})`;
      ctx.fill();
      ctx.restore();
    }

    geometry() {
      const pull = Math.max(0, this.direction * this.x);
      const dx = this.direction * pull;
      const dy = this.y;
      const distance = Math.hypot(dx, dy);
      if (distance < .22 || this.phase === 'idle') return null;
      const nx = -dx / distance;
      const ny = -dy / distance;
      const gripX = this._side === 'left' ? 0 : this.w;
      const origin = nx * (gripX + dx * .5) + ny * (this.gripY + dy * .5);
      // The grabbed point has s=distance/2. Keep it on the exactly reflected
      // flat back, so its projection is precisely grip + pointer delta.
      const radius = Math.max(.0001, Math.min(distance * .98 / Math.PI,
        6 * (1 - Math.exp(-distance / 24)) + distance * .09, 32));
      const halfArc = radius * Math.PI * .5;
      return {pull, dx, dy, distance, nx, ny, gripX, origin, radius, halfArc};
    }

    clearDirty(next = null) {
      const previous = this.dirtyBounds;
      if (previous || next) {
        const boxes = [previous, next].filter(Boolean);
        const left = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.left)) * this.dpr));
        const top = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.top)) * this.dpr));
        const right = Math.min(this.canvas.width, Math.ceil(Math.max(...boxes.map(box => box.right)) * this.dpr));
        const bottom = Math.min(this.canvas.height, Math.ceil(Math.max(...boxes.map(box => box.bottom)) * this.dpr));
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (right > left && bottom > top) this.ctx.clearRect(left, top, right - left, bottom - top);
      }
      this.dirtyBounds = next;
    }

    projectedBounds(geometry) {
      const points = [...this.rectangle];
      if (geometry) {
        const {nx, ny, origin, radius, halfArc} = geometry;
        for (let edge = 0; edge < 4; edge++) {
          const a = this.rectangle[edge];
          const b = this.rectangle[(edge + 1) % 4];
          for (let i = 0; i <= 12; i++) {
            const x = a[0] + (b[0] - a[0]) * i / 12;
            const y = a[1] + (b[1] - a[1]) * i / 12;
            const s = nx * x + ny * y - origin;
            const f = s < -halfArc ? s : s > halfArc ? -s : -halfArc + radius * Math.cos(s / radius);
            points.push([x + nx * (f - s), y + ny * (f - s)]);
          }
        }
      }
      // Covers the curve extrema between samples, contact shadows, and blur.
      const margin = 64;
      return {
        left: this.viewportX + Math.min(...points.map(point => point[0])) - margin,
        top: this.viewportY + Math.min(...points.map(point => point[1])) - margin,
        right: this.viewportX + Math.max(...points.map(point => point[0])) + margin,
        bottom: this.viewportY + Math.max(...points.map(point => point[1])) + margin
      };
    }

    draw() {
      if (this.phase === 'detached') {
        this.clearDirty();
        return;
      }
      const {ctx, w, h, dpr} = this;
      const geometry = this.geometry();
      this.clearDirty(this.projectedBounds(geometry));
      ctx.setTransform(dpr, 0, 0, dpr, this.viewportX * dpr, this.viewportY * dpr);
      ctx.save();
      if (this.phase === 'detaching') {
        const t = this.flightProgress;
        ctx.globalAlpha = 1 - Math.pow(clamp((t - .78) / .22, 0, 1), 1.7);
      }
      if (!geometry) {
        this.contactShadow(this.rectangle);
        ctx.drawImage(this.phase === 'idle' ? this.surface : this.front, 0, 0, w, h);
        ctx.restore();
        return;
      }
      const {nx, ny, gripX, origin, radius, halfArc} = geometry;
      const projections = this.rectangle.map(([x, y]) => nx * x + ny * y - origin);
      const minS = Math.min(...projections);
      const maxS = Math.max(...projections);
      const flat = clip(this.rectangle, nx, ny, origin - halfArc, false);
      if (flat.length) {
        this.contactShadow(flat);
        ctx.save();
        path(ctx, flat);
        ctx.clip();
        ctx.drawImage(this.front, 0, 0, w, h);
        ctx.restore();
      }
      // Height affects light and shadow only; XY lift would move the held point
      // away from the pointer by an amount that changes with the curl radius.
      const liftX = 0;
      const liftY = 0;
      const folded = clip(this.rectangle, nx, ny, origin - halfArc * .35, true);
      if (folded.length) {
        const shadow = folded.map(([x, y]) => {
          const s = nx * x + ny * y - origin;
          const projected = s > halfArc ? -s : -halfArc + radius * Math.cos(clamp(s / radius, -Math.PI / 2, Math.PI / 2));
          return [x + nx * (projected - s) + radius * .17,
            y + ny * (projected - s) + radius * .25 + 1];
        });
        ctx.save();
        ctx.shadowColor = 'rgba(77,50,15,.25)';
        ctx.shadowBlur = 1.5 + radius * .6;
        ctx.shadowOffsetY = 1 + radius * .12;
        ctx.fillStyle = 'rgba(82,57,17,.14)';
        path(ctx, shadow);
        ctx.fill();
        ctx.restore();
      }

      const renderBand = (low, high, f, slope, z, zSlope, backside, shade, overlap = .55) => {
        let poly = clip(this.rectangle, nx, ny, origin + low - overlap, true);
        poly = clip(poly, nx, ny, origin + high + overlap, false);
        if (!poly.length) return;
        const s = (low + high) * .5;
        const factor = slope - 1;
        const offset = f - slope * s - factor * origin;
        const liftOffset = z - zSlope * (s + origin);
        // Include the slope of height, not just the horizontal curl. Adjacent
        // strips otherwise jump vertically and expose their antialiased seams.
        if (Math.abs(slope + (liftX * nx + liftY * ny) * zSlope) < .001) return;
        ctx.save();
        ctx.transform(1 + factor * nx * nx + liftX * zSlope * nx,
          factor * nx * ny + liftY * zSlope * nx,
          factor * nx * ny + liftX * zSlope * ny,
          1 + factor * ny * ny + liftY * zSlope * ny,
          nx * offset + liftX * liftOffset, ny * offset + liftY * liftOffset);
        path(ctx, poly);
        ctx.clip();
        ctx.drawImage(backside ? this.back : this.front, 0, 0, w, h);
        if (shade) {
          ctx.fillStyle = shade > 0 ? `rgba(79,48,9,${shade})` : `rgba(255,255,235,${-shade})`;
          ctx.fillRect(0, 0, w, h);
        }
        ctx.restore();
      };
      const curveStart = Math.max(minS, -halfArc);
      const curveEnd = Math.min(maxS, halfArc);
      const count = clamp(Math.ceil((curveEnd - curveStart) / 2.3), 12, 48);
      const step = (curveEnd - curveStart) / count;
      for (let i = 0; i < count && step > 0; i++) {
        const low = curveStart + i * step;
        const high = low + step;
        const s = (low + high) * .5;
        const angle = s / radius;
        // Shared endpoints make each band's full projected boundary coincide.
        const fLow = -halfArc + radius * Math.cos(low / radius);
        const fHigh = -halfArc + radius * Math.cos(high / radius);
        const zLow = radius * (1 + Math.sin(low / radius));
        const zHigh = radius * (1 + Math.sin(high / radius));
        const f = (fLow + fHigh) * .5;
        const slope = (fHigh - fLow) / step;
        const z = (zLow + zHigh) * .5;
        const zSlope = (zHigh - zLow) / step;
        const shade = s < 0 ? .19 * Math.pow(Math.cos(angle), 1.4) : -.22 * Math.cos(angle) + .018;
        renderBand(low, high, f, slope, z, zSlope, s > 0, shade);
      }
      if (maxS > halfArc) {
        const low = halfArc;
        const high = maxS;
        renderBand(low, high, -(low + high) * .5, -1, radius * 2, 0, true, .008);
      }
      // Fine edge thickness, sampled along the grabbed side of the paper.
      const edge = [];
      for (let i = 0; i <= 20; i++) {
        const x = gripX;
        const y = h * i / 20;
        const s = nx * x + ny * y - origin;
        if (s <= -halfArc) continue;
        const a = clamp(s / radius, -Math.PI / 2, Math.PI / 2);
        const f = s >= halfArc ? -s : -halfArc + radius * Math.cos(a);
        const z = s >= halfArc ? radius * 2 : radius * (1 + Math.sin(a));
        edge.push([x + nx * (f - s) + liftX * z, y + ny * (f - s) + liftY * z]);
      }
      if (edge.length > 1) {
        ctx.beginPath();
        edge.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        ctx.strokeStyle = 'rgba(112,81,27,.21)';
        ctx.lineWidth = 1.1;
        ctx.stroke();
        ctx.beginPath();
        edge.forEach(([x, y], i) => i ? ctx.lineTo(x - .3, y - .25) : ctx.moveTo(x - .3, y - .25));
        ctx.strokeStyle = 'rgba(255,255,232,.65)';
        ctx.lineWidth = .55;
        ctx.stroke();
      }
      ctx.restore();
    }

    destroy() {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.phase = 'destroyed';
      this.onDetach = this.onSettle = this.onHold = this.onProgress = null;
    }
  }

  window.PaperMotion = PaperMotion;
})();
