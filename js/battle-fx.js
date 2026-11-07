/**
 * battle-fx.js —— 训练场战斗特效（canvas，纯前端）
 *
 * 坐标系：**舞台设计坐标**（与卡牌所在的 .tw-stage 同一套 px）。
 * 舞台整体用 CSS transform: scale() 适配屏幕，特效 canvas 也在舞台里，
 * 所以所有位置都按「卡牌在舞台内的位置」算，不会因为屏幕尺寸/缩放而错位。
 *
 * 特效：
 *  - 飞弹：中心色、略大的弹头，沿发射方向固定初速度 + 较慢匀加速，不衰减，命中删除；
 *          飞行中每帧生成 2~3 个同色系小拖尾，继承 30%~60% 速度 + 垂直随机小偏移，
 *          略向后（更大权重），随后匀减速、渐隐、删除。
 *  - 爆炸：15 个同色系粒子，微调色相，随机方向、随机大小初速度，匀减速 + 渐隐。
 *  - 光环：扩散双环 + 上升光点（治疗 / 增益 / 入场）。
 *  - 跳字：命中后才生成，颜色按属性上下渐变。
 */
import { ATTRIBUTE_INFO } from "../engine/index.js";

const TAU = Math.PI * 2;
const FONT = '"PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", system-ui, sans-serif';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ */
/* 颜色                                                                */
/* ------------------------------------------------------------------ */
function hexToHsl(hex) {
  let h = String(hex || "#9E9E9E").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let hue = 0;
  let sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: hue, s: sat * 100, l: l * 100 };
}

const hsl = (h, s, l, a = 1) =>
  `hsla(${((h % 360) + 360) % 360}, ${clamp(s, 0, 100)}%, ${clamp(l, 0, 100)}%, ${clamp(a, 0, 1)})`;

/** 属性 / 自定义颜色 → HSL */
function colorOf(spec) {
  if (spec && typeof spec === "object" && Number.isFinite(spec.h)) return spec;
  if (typeof spec === "string" && spec.startsWith("#")) return hexToHsl(spec);
  const info = ATTRIBUTE_INFO[spec] || ATTRIBUTE_INFO.physical;
  return hexToHsl(info.upper);
}

function attrPair(spec) {
  if (typeof spec === "string" && ATTRIBUTE_INFO[spec]) {
    // ATTRIBUTE_INFO 里是不带 # 的十六进制，canvas 需要 #rrggbb
    return { upper: `#${ATTRIBUTE_INFO[spec].upper}`, lower: `#${ATTRIBUTE_INFO[spec].lower}` };
  }
  if (typeof spec === "string" && spec.startsWith("#")) {
    const c = hexToHsl(spec);
    return { upper: spec, lower: hsl(c.h, c.s, Math.max(10, c.l - 22)) };
  }
  return { upper: ATTRIBUTE_INFO.physical.upper, lower: ATTRIBUTE_INFO.physical.lower };
}

const centerOf = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

/* ------------------------------------------------------------------ */
/* 主类                                                                */
/* ------------------------------------------------------------------ */
export class BattleFX {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.w = 0;
    this.h = 0;
    this.bullets = [];
    this.particles = [];
    this.texts = [];
    this.auras = [];
    this.raf = 0;
    this.last = 0;
    this.destroyed = false;
    this._resizeObserver = null;
  }

  /**
   * 设置画布尺寸（设计坐标）。
   * @param {number} w 设计宽
   * @param {number} h 设计高
   * @param {number} pixelRatio 设备像素 / 设计像素（= dpr × 舞台缩放）
   */
  resize(w, h, pixelRatio = 1) {
    if (!this.ctx) return;
    this.w = w;
    this.h = h;
    const ratio = clamp(pixelRatio, 0.4, 4);
    const bw = Math.max(1, Math.round(w * ratio));
    const bh = Math.max(1, Math.round(h * ratio));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ratio = ratio;
    this.ctx.setTransform(bw / w, 0, 0, bh / h, 0, 0);
  }

  clear() {
    for (const b of this.bullets) {
      if (b.settled) continue;
      b.settled = true;
      if (b.timer) clearTimeout(b.timer);
      try {
        b.resolve();
      } catch {
        /* ignore */
      }
    }
    this.bullets.length = 0;
    this.particles.length = 0;
    this.texts.length = 0;
    this.auras.length = 0;
    if (this.ctx) this.ctx.clearRect(0, 0, this.w, this.h);
  }

  destroy() {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clear();
    this._resizeObserver?.disconnect?.();
    this._resizeObserver = null;
  }

  /* ---------------- 循环 ---------------- */
  _ensureLoop() {
    if (this.raf || this.destroyed) return;
    this.last = 0;
    const tick = (ts) => {
      this.raf = 0;
      if (this.destroyed) return;
      const dt = this.last ? clamp((ts - this.last) / 1000, 0, 0.05) : 0.016;
      this.last = ts;
      try {
        this._update(dt);
        this._draw();
      } catch (err) {
        // 表现层异常不能把战斗流程卡死：清空本帧、等下次重新起循环
        console.warn("[训练场] 特效绘制出错", err);
        this.clear();
        return;
      }
      if (this.bullets.length || this.particles.length || this.texts.length || this.auras.length) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.ctx.clearRect(0, 0, this.w, this.h);
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  _update(dt) {
    // 飞弹：s(t) = v0·t + ½·a·t²（不衰减）
    for (let i = this.bullets.length - 1; i >= 0; i -= 1) {
      const b = this.bullets[i];
      b.t += dt;
      const s = b.v0 * b.t + 0.5 * b.accel * b.t * b.t;
      if (s >= b.dist) {
        this.bullets.splice(i, 1);
        this._hit(b);
        continue;
      }
      b.x = b.x0 + b.dx * s;
      b.y = b.y0 + b.dy * s;
      b.speed = b.v0 + b.accel * b.t;
      // 每帧 2~3 个小拖尾（按帧率折算，避免高刷屏翻倍）
      const count = clamp(Math.round(rand(2, 3.4) * (dt * 60)), 1, 6);
      for (let k = 0; k < count; k += 1) this._spawnTrail(b);
    }

    // 粒子：匀减速直线 + 渐隐
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.spd = Math.max(0, p.spd - p.decel * dt);
      p.x += p.dx * p.spd * dt;
      p.y += p.dy * p.spd * dt;
      if (p.gravity) p.y += p.gravity * dt;
      p.alpha -= p.fade * dt;
      p.spin += p.spinSpeed * dt;
      if (p.alpha <= 0) this.particles.splice(i, 1);
    }

    // 光环
    for (let i = this.auras.length - 1; i >= 0; i -= 1) {
      const a = this.auras[i];
      a.t += dt;
      if (a.t >= a.life) this.auras.splice(i, 1);
    }

    // 跳字
    for (let i = this.texts.length - 1; i >= 0; i -= 1) {
      const t = this.texts[i];
      t.t += dt;
      if (t.t >= t.life) this.texts.splice(i, 1);
    }
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);

    // 光环在底层
    for (const a of this.auras) this._drawAura(a);
    // 粒子
    ctx.globalCompositeOperation = "source-over";
    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.alpha, 0, 1);
      ctx.fillStyle = hsl(p.h, p.s, p.l);
      if (p.shape === "square") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // 飞弹
    for (const b of this.bullets) this._drawBullet(b);

    // 跳字
    for (const t of this.texts) this._drawText(t);
  }

  /* ---------------- 飞弹 ---------------- */
  /**
   * @param {{x:number,y:number,w:number,h:number}} from 发射者卡牌矩形（舞台坐标）
   * @param {{x:number,y:number,w:number,h:number}} to 目标卡牌矩形
   * @param {{attribute?:string,color?:string,onHit?:Function}} [opts]
   * @returns {Promise<void>} 命中时 resolve
   */
  launch(from, to, opts = {}) {
    return new Promise((resolve) => {
      if (this.destroyed || !this.ctx) {
        resolve();
        return;
      }
      // 后台标签页不跑动画（rAF 会被暂停），直接结算，别把战斗流程卡住
      if (this.hidden) {
        resolve();
        return;
      }
      const a = centerOf(from);
      const b = centerOf(to);
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      dx /= dist;
      dy /= dist;
      // 从卡牌边缘附近出发，别从卡面正中间冒出来
      const startPad = Math.min(from.w, from.h) * 0.28;
      const x0 = a.x + dx * startPad;
      const y0 = a.y + dy * startPad;
      const color = colorOf(opts.color || opts.attribute);
      const v0 = clamp(dist * 3.4, 620, 1500);
      const accel = clamp(dist * 1.1, 140, 520);
      // 命中时刻：v0 t + ½ a t² = dist
      const tHit = (-v0 + Math.sqrt(v0 * v0 + 2 * accel * dist)) / accel;
      const bullet = {
        x0,
        y0,
        x: x0,
        y: y0,
        dx,
        dy,
        dist: dist - startPad,
        v0,
        accel,
        t: 0,
        tHit,
        speed: v0,
        color,
        size: 7,
        trailTimer: 0,
        settled: false,
        resolve,
        onHit: opts.onHit || null,
        timer: 0,
      };
      // 兜底：即使动画循环被意外中断，也不能让战斗流程永远等下去
      bullet.timer = setTimeout(() => {
        if (bullet.settled) return;
        bullet.settled = true;
        this.bullets = this.bullets.filter((b) => b !== bullet);
        resolve();
      }, tHit * 1000 + 1200);
      this.bullets.push(bullet);
      this._ensureLoop();
    });
  }

  _spawnTrail(b) {
    const base = b.color;
    const h = base.h + rand(-12, 12);
    const s = clamp(base.s + rand(-6, 8), 10, 100);
    const l = clamp(base.l + rand(-10, 8), 18, 82);
    // 继承 30%~60% 速度，叠加垂直随机小偏移，再给一个略大的向后权重
    const inherit = b.speed * rand(0.3, 0.6);
    const back = b.speed * rand(0.08, 0.2);
    const perp = rand(-0.09, 0.09) * b.speed;
    const vx = b.dx * inherit - b.dx * back + -b.dy * perp;
    const vy = b.dy * inherit - b.dy * back + b.dx * perp;
    const spd = Math.hypot(vx, vy) || 1;
    this.particles.push({
      x: b.x + rand(-1.5, 1.5),
      y: b.y + rand(-1.5, 1.5),
      dx: vx / spd,
      dy: vy / spd,
      spd,
      decel: rand(220, 380),
      alpha: rand(0.55, 0.9),
      fade: rand(1.4, 2.4),
      size: rand(1.4, 3.1),
      h,
      s,
      l,
      spin: rand(0, TAU),
      spinSpeed: rand(-6, 6),
      shape: "dot",
    });
  }

  _hit(b) {
    if (b.settled) return;
    b.settled = true;
    if (b.timer) clearTimeout(b.timer);
    const color = b.color;
    this._spawnExplosion(b.x, b.y, color, { count: 15, power: 1 });
    if (typeof b.onHit === "function") {
      try {
        b.onHit();
      } catch {
        /* 表现层错误不影响战斗 */
      }
    }
    b.resolve();
  }

  _drawBullet(b) {
    const ctx = this.ctx;
    const c = b.color;
    ctx.save();
    ctx.shadowColor = hsl(c.h, c.s, Math.max(15, c.l - 18), 0.85);
    ctx.shadowBlur = 10;
    const g = ctx.createRadialGradient(b.x - b.dx * 1.5, b.y - b.dy * 1.5, 0.5, b.x, b.y, b.size * 1.9);
    g.addColorStop(0, hsl(c.h, Math.min(100, c.s + 8), Math.min(96, c.l + 26), 1));
    g.addColorStop(0.55, hsl(c.h, c.s, c.l, 0.98));
    g.addColorStop(1, hsl(c.h, c.s, Math.max(18, c.l - 24), 0.15));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.size * 1.9, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /* ---------------- 爆炸 / 光环 ---------------- */
  explode(rectOrPoint, opts = {}) {
    if (this.destroyed || this.hidden) return;
    const p = "x" in rectOrPoint ? centerOf(rectOrPoint) : rectOrPoint;
    const color = colorOf(opts.color || opts.attribute);
    this._spawnExplosion(p.x, p.y, color, {
      count: opts.count ?? 15,
      power: opts.power ?? 1,
    });
    this._ensureLoop();
  }

  _spawnExplosion(x, y, color, { count = 15, power = 1 } = {}) {
    for (let i = 0; i < count; i += 1) {
      const dir = rand(0, TAU);
      const spd = rand(60, 330) * power;
      this.particles.push({
        x,
        y,
        dx: Math.cos(dir),
        dy: Math.sin(dir),
        spd,
        decel: rand(140, 260),
        alpha: rand(0.85, 1),
        fade: rand(1.1, 1.9),
        size: rand(2, 4.6) * Math.min(1.4, power),
        h: color.h + rand(-16, 16),
        s: clamp(color.s + rand(-10, 12), 15, 100),
        l: clamp(color.l + rand(-14, 16), 16, 88),
        spin: rand(0, TAU),
        spinSpeed: rand(-8, 8),
        shape: Math.random() < 0.22 ? "square" : "dot",
      });
    }
    // 命中冲击环（少量粒子构成的环更快，增加“爆开”的感觉）
    for (let i = 0; i < 10; i += 1) {
      const dir = (i / 10) * TAU + rand(-0.1, 0.1);
      this.particles.push({
        x,
        y,
        dx: Math.cos(dir),
        dy: Math.sin(dir),
        spd: rand(260, 420),
        decel: rand(420, 620),
        alpha: 0.7,
        fade: rand(2.2, 3),
        size: rand(1.2, 2.2),
        h: color.h,
        s: color.s,
        l: Math.min(88, color.l + 18),
        spin: 0,
        spinSpeed: 0,
        shape: "dot",
      });
    }
  }

  /**
   * 光环（治疗 / 增益 / 入场）：扩散双环 + 上升光点。
   * @param {{x:number,y:number,w:number,h:number}} rect
   * @param {{attribute?:string,color?:string,kind?:string,size?:number}} [opts]
   */
  aura(rect, opts = {}) {
    if (this.destroyed || this.hidden) return;
    const c =
      opts.kind === "heal"
        ? colorOf(opts.color || "#59C98A")
        : colorOf(opts.color || opts.attribute || "#FFB020");
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const base = opts.size || Math.max(rect.w, rect.h);
    this.auras.push({
      x: cx,
      y: cy,
      w: rect.w,
      h: rect.h,
      color: c,
      t: 0,
      life: opts.life || 0.72,
      size: base,
      kind: opts.kind || "buff",
    });
    // 上升光点
    const motes = opts.kind === "enter" ? 10 : 8;
    for (let i = 0; i < motes; i += 1) {
      this.particles.push({
        x: cx + rand(-rect.w * 0.42, rect.w * 0.42),
        y: rect.y + rect.h * rand(0.35, 0.95),
        dx: rand(-0.22, 0.22),
        dy: -1,
        spd: rand(28, 78),
        decel: 20,
        alpha: rand(0.5, 0.95),
        fade: rand(0.6, 1.1),
        size: rand(1.6, 3.2),
        h: c.h + rand(-10, 10),
        s: c.s,
        l: Math.min(88, c.l + 10),
        spin: rand(0, TAU),
        spinSpeed: rand(-3, 3),
        shape: "dot",
      });
    }
    this._ensureLoop();
  }

  _drawAura(a) {
    const ctx = this.ctx;
    const p = clamp(a.t / a.life, 0, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    const alpha = (1 - p) * 0.75;
    const c = a.color;
    const cx = a.x;
    const cy = a.y;
    const r0 = a.size * 0.28;
    const r1 = a.size * (0.45 + ease * 0.55);

    // 中心柔光
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, a.size * 0.7);
    glow.addColorStop(0, hsl(c.h, c.s, c.l, alpha * 0.34));
    glow.addColorStop(0.6, hsl(c.h, c.s, c.l, alpha * 0.12));
    glow.addColorStop(1, hsl(c.h, c.s, c.l, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, a.size * 0.7, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = hsl(c.h, c.s, Math.min(90, c.l + 10), alpha);
    ctx.lineWidth = Math.max(1.2, 4 * (1 - p));
    ctx.beginPath();
    ctx.ellipse(cx, cy, r0 + (r1 - r0) * 0.6, (r0 + (r1 - r0) * 0.6) * 1.28, 0, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, r1, r1 * 1.28, 0, 0, TAU);
    ctx.strokeStyle = hsl(c.h, c.s, Math.min(92, c.l + 16), alpha * 0.7);
    ctx.lineWidth = 2.2 * (1 - p) + 0.6;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- 跳字 ---------------- */
  /**
   * @param {{x:number,y:number,w?:number,h?:number}} at 卡牌矩形或点
   * @param {string|number} text
   * @param {{attribute?:string,color?:string,kind?:string,crit?:boolean,size?:number,life?:number}} [opts]
   */
  floatText(at, text, opts = {}) {
    if (this.destroyed || this.hidden) return;
    const p = "x" in at && "y" in at ? { x: at.x + (at.w || 0) / 2, y: at.y + (at.h || 0) * 0.36 } : at;
    const pair = attrPair(opts.color || opts.attribute);
    const kind = opts.kind || "damage";
    this.texts.push({
      x: p.x + rand(-8, 8),
      y: p.y,
      text: String(text),
      upper: kind === "heal" ? "#8CF0B4" : kind === "mute" ? "#A9C2C3" : pair.upper,
      lower: kind === "heal" ? "#2E9E5B" : kind === "mute" ? "#7D9FA1" : pair.lower,
      crit: Boolean(opts.crit),
      size: opts.size || (opts.crit ? 30 : 23),
      t: 0,
      life: opts.life || 0.9,
      drift: rand(-10, 10),
    });
    this._ensureLoop();
  }

  _drawText(t) {
    const ctx = this.ctx;
    const p = clamp(t.t / t.life, 0, 1);
    const inP = clamp(t.t / 0.12, 0, 1);
    const outP = clamp((p - 0.55) / 0.45, 0, 1);
    const alpha = inP * (1 - outP);
    const rise = 10 + p * 42;
    const scale = (0.7 + inP * 0.3) * (t.crit ? 1.12 : 1);
    const x = t.x + t.drift * p;
    const y = t.y - rise;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${t.size}px ${FONT}`;

    // 描边（浅底上保证可读）
    ctx.lineJoin = "round";
    ctx.lineWidth = t.crit ? 6 : 4.5;
    ctx.strokeStyle = "rgba(247, 255, 255, 0.95)";
    ctx.strokeText(t.text, 0, 0);

    const g = ctx.createLinearGradient(0, -t.size * 0.62, 0, t.size * 0.62);
    g.addColorStop(0, t.upper);
    g.addColorStop(1, t.lower);
    ctx.fillStyle = g;
    ctx.fillText(t.text, 0, 0);

    if (t.crit) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.font = `700 11px ${FONT}`;
      ctx.fillStyle = t.lower;
      ctx.fillText("暴击", 0, -t.size * 0.78);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** 页面在后台：不跑 rAF，也不阻塞战斗 */
  get hidden() {
    return typeof document !== "undefined" && document.hidden;
  }

  /** 画面上还有一个飞弹/跳字/粒子（给外部判断节奏用） */
  get busy() {
    return Boolean(this.bullets.length || this.particles.length || this.texts.length || this.auras.length);
  }
}
