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

const HEX_RE = /^#[0-9a-f]{6}$/i;
const hexList = (spec) => (Array.isArray(spec) ? spec.filter((x) => typeof x === "string" && HEX_RE.test(x)) : []);

function hexToRgb(hex) {
  const h = String(hex || "#9E9E9E").replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

/** 多级渐变：按 t（0..1）在颜色停靠点之间做 RGB 插值 */
function hexAt(stops, t) {
  const list = stops && stops.length ? stops : ["#9E9E9E"];
  if (list.length === 1) return list[0];
  const x = clamp(Number(t) || 0, 0, 1) * (list.length - 1);
  const i = Math.min(list.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(list[i]);
  const b = hexToRgb(list[i + 1]);
  const c = (k) => Math.round(a[k] + (b[k] - a[k]) * f);
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(c("r"))}${hex(c("g"))}${hex(c("b"))}`;
}

/** 属性 / 自定义颜色 / 多级渐变 → HSL（带 stops 时粒子会按 t 取样） */
function colorOf(spec) {
  if (spec && typeof spec === "object" && Number.isFinite(spec.h)) return spec;
  const stops = hexList(spec);
  if (stops.length) {
    const base = hexToHsl(hexAt(stops, 0.5));
    return { ...base, stops };
  }
  if (typeof spec === "string" && spec.startsWith("#")) return hexToHsl(spec);
  const info = ATTRIBUTE_INFO[spec] || ATTRIBUTE_INFO.physical;
  return hexToHsl(info.upper);
}

/** 粒子 / 爆炸按渐变位置取一个颜色；单色时原样返回 */
function sampleColor(color, t) {
  if (color && Array.isArray(color.stops) && color.stops.length > 1) {
    return hexToHsl(hexAt(color.stops, t));
  }
  return color;
}

/** 跳字用的上下两色（多级渐变时取首尾；绘制时仍按完整 stops 渐变） */
function attrPair(spec) {
  const stops = hexList(spec);
  if (stops.length) {
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (stops.length === 1) {
      const c = hexToHsl(first);
      return { upper: first, lower: hsl(c.h, c.s, Math.max(10, c.l - 22)), stops };
    }
    return { upper: first, lower: last, stops };
  }
  if (typeof spec === "string" && ATTRIBUTE_INFO[spec]) {
    // ATTRIBUTE_INFO 里是不带 # 的十六进制，canvas 需要 #rrggbb
    return { upper: `#${ATTRIBUTE_INFO[spec].upper}`, lower: `#${ATTRIBUTE_INFO[spec].lower}` };
  }
  if (typeof spec === "string" && spec.startsWith("#")) {
    const c = hexToHsl(spec);
    return { upper: spec, lower: hsl(c.h, c.s, Math.max(10, c.l - 22)) };
  }
  return { upper: `#${ATTRIBUTE_INFO.physical.upper}`, lower: `#${ATTRIBUTE_INFO.physical.lower}` };
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
    /** 底图缓存：url → { img, loaded, failed } */
    this.textures = new Map();
    /** canvas pattern 缓存：url|fixed|尺寸 → CanvasPattern */
    this.patterns = new Map();
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
    this.patterns.clear();
  }

  /* ---------------- 底图纹理 ---------------- */
  _textureRecord(url) {
    if (!url || typeof Image === "undefined") return null;
    let rec = this.textures.get(url);
    if (!rec) {
      const img = new Image();
      rec = { img, loaded: false, failed: false };
      img.onload = () => {
        rec.loaded = true;
        this._ensureLoop();
      };
      img.onerror = () => {
        rec.failed = true;
      };
      img.src = url;
      this.textures.set(url, rec);
    }
    return rec.loaded ? rec : null;
  }

  /**
   * 取一张底图对应的 pattern。
   *  fixed=true：图片铺满整个舞台并固定在画面坐标（不随特效移动）；
   *  fixed=false：图片跟着每个特效走，由调用方按特效位置设置 pattern 偏移。
   */
  _texturePattern(url, fixed) {
    const rec = this._textureRecord(url);
    if (!rec || !this.ctx) return null;
    const key = `${url}\u0000${fixed ? "fixed" : "local"}\u0000${fixed ? `${this.w}x${this.h}` : "raw"}`;
    let pattern = this.patterns.get(key);
    if (!pattern) {
      let source = rec.img;
      if (fixed) {
        // 固定底图铺满舞台：把图片拉伸到设计尺寸，pattern 原点固定在 (0,0)
        const off = document.createElement("canvas");
        off.width = Math.max(1, Math.round(this.w));
        off.height = Math.max(1, Math.round(this.h));
        const octx = off.getContext("2d");
        octx.drawImage(rec.img, 0, 0, off.width, off.height);
        source = off;
      }
      pattern = this.ctx.createPattern(source, "no-repeat");
      if (!pattern) return null;
      this.patterns.set(key, pattern);
    }
    return { pattern, rec, fixed };
  }

  /** 局部底图：把 pattern 平移到特效中心（固定底图不移动） */
  _placePattern(tex, x, y) {
    if (!tex || tex.fixed || typeof tex.pattern.setTransform !== "function") return tex?.pattern || null;
    const w = tex.rec.img.naturalWidth || tex.rec.img.width || 1;
    const h = tex.rec.img.naturalHeight || tex.rec.img.height || 1;
    try {
      tex.pattern.setTransform({ a: 1, b: 0, c: 0, d: 1, e: x - w / 2, f: y - h / 2 });
    } catch {
      // 老浏览器不支持 pattern.setTransform 时退化为固定图案，不让绘制中断
    }
    return tex.pattern;
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
      const tex = p.texture ? this._texturePattern(p.texture, p.fixedTexture) : null;
      ctx.fillStyle = tex ? this._placePattern(tex, p.x, p.y) : hsl(p.h, p.s, p.l);
      if (p.shape === "square") {
        if (tex) {
          // 底图已经按画布坐标定位，方形不能再叠加自身旋转 / 平移
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        } else {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.spin);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
        }
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
   * @param {{attribute?:string,color?:string|string[],texture?:string,fixedTexture?:boolean,onHit?:Function,arriveIn?:number}} [opts]
   *   color: #rrggbb 单色，或颜色数组（多级渐变）；
   *   texture / fixedTexture: 底图与固定底图；
   *   arriveIn: 统一的命中时间（秒）。群攻用它让多枚飞弹同时到达；不传则按距离算。
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
      const texture = typeof opts.texture === "string" ? opts.texture : "";
      const fixedTexture = Boolean(opts.fixedTexture);
      const travel = Math.max(1, dist - startPad);
      const accel = clamp(dist * 1.1, 140, 520);
      const syncIn = Number(opts.arriveIn);
      const sync = Number.isFinite(syncIn) && syncIn > 0;
      // 普通飞弹按距离算初速；群攻传入 arriveIn 时反推初速，让所有飞弹同时命中
      const v0 = sync
        ? Math.max(1, (travel - 0.5 * accel * syncIn * syncIn) / syncIn)
        : clamp(dist * 3.4, 620, 1500);
      // 命中时刻：v0 t + ½ a t² = dist
      const tHit = sync ? syncIn : (-v0 + Math.sqrt(v0 * v0 + 2 * accel * dist)) / accel;
      const bullet = {
        x0,
        y0,
        x: x0,
        y: y0,
        dx,
        dy,
        dist: travel,
        v0,
        accel,
        t: 0,
        tHit,
        speed: v0,
        color,
        texture,
        fixedTexture,
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
    const base = sampleColor(b.color, Math.random());
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
      texture: b.texture,
      fixedTexture: b.fixedTexture,
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
    this._spawnExplosion(b.x, b.y, color, {
      count: 15,
      power: 1,
      texture: b.texture,
      fixedTexture: b.fixedTexture,
    });
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
    const radius = b.size * 1.9;
    ctx.save();
    const tex = b.texture ? this._texturePattern(b.texture, b.fixedTexture) : null;
    if (tex) {
      // 底图模式：用飞弹圆形当遮罩，显示底图在当前位置的像素；固定底图时图案不动
      ctx.beginPath();
      ctx.arc(b.x, b.y, radius, 0, TAU);
      ctx.clip();
      ctx.fillStyle = this._placePattern(tex, b.x, b.y);
      ctx.fillRect(b.x - radius, b.y - radius, radius * 2, radius * 2);
      ctx.restore();
      return;
    }
    ctx.shadowColor = hsl(c.h, c.s, Math.max(15, c.l - 18), 0.85);
    ctx.shadowBlur = 10;
    let g;
    if (Array.isArray(c.stops) && c.stops.length > 1) {
      // 多级渐变：按停靠点整条铺开
      g = ctx.createRadialGradient(b.x - b.dx * 1.5, b.y - b.dy * 1.5, 0.5, b.x, b.y, radius);
      c.stops.forEach((stop, i) => g.addColorStop(i / (c.stops.length - 1), stop));
    } else {
      g = ctx.createRadialGradient(b.x - b.dx * 1.5, b.y - b.dy * 1.5, 0.5, b.x, b.y, radius);
      g.addColorStop(0, hsl(c.h, Math.min(100, c.s + 8), Math.min(96, c.l + 26), 1));
      g.addColorStop(0.55, hsl(c.h, c.s, c.l, 0.98));
      g.addColorStop(1, hsl(c.h, c.s, Math.max(18, c.l - 24), 0.15));
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, radius, 0, TAU);
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
      texture: typeof opts.texture === "string" ? opts.texture : "",
      fixedTexture: Boolean(opts.fixedTexture),
    });
    this._ensureLoop();
  }

  _spawnExplosion(x, y, color, { count = 15, power = 1, texture = "", fixedTexture = false } = {}) {
    for (let i = 0; i < count; i += 1) {
      const dir = rand(0, TAU);
      const spd = rand(60, 330) * power;
      const c = sampleColor(color, Math.random());
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
        h: c.h + rand(-16, 16),
        s: clamp(c.s + rand(-10, 12), 15, 100),
        l: clamp(c.l + rand(-14, 16), 16, 88),
        texture,
        fixedTexture,
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
        texture,
        fixedTexture,
        spin: 0,
        spinSpeed: 0,
        shape: "dot",
      });
    }
  }

  /**
   * 瞬时命中（附加伤害 / 反噬这类「不视为攻击」的伤害）。
   * 没有飞弹：卡面上直接收拢一圈碎屑 + 一次冲击环，读起来像「侵蚀」而不是「打一拳」，
   * 这样和普通攻击的飞弹/爆开在画面上分得开。
   * @param {{x:number,y:number,w:number,h:number}} rect 目标卡牌矩形
   * @param {{attribute?:string,color?:string|string[],texture?:string,fixedTexture?:boolean}} [opts]
   */
  impact(rect, opts = {}) {
    if (this.destroyed || this.hidden || !rect) return;
    const baseColor = colorOf(opts.color || opts.attribute);
    const texture = typeof opts.texture === "string" ? opts.texture : "";
    const fixedTexture = Boolean(opts.fixedTexture);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const radius = Math.max(rect.w, rect.h) * 0.5;
    // 向内收拢的碎屑：从卡牌外缘飞向中心
    for (let i = 0; i < 14; i += 1) {
      const ang = rand(0, TAU);
      const start = radius * rand(0.85, 1.25);
      const life = rand(0.26, 0.42);
      const spd = start / life;
      const c = sampleColor(baseColor, Math.random());
      this.particles.push({
        x: cx + Math.cos(ang) * start,
        y: cy + Math.sin(ang) * start,
        dx: -Math.cos(ang),
        dy: -Math.sin(ang),
        spd,
        decel: spd * 0.7,
        alpha: rand(0.7, 1),
        fade: rand(1.5, 2.2),
        size: rand(1.4, 2.9),
        h: c.h + rand(-8, 8),
        s: clamp(c.s + rand(-6, 6), 20, 100),
        l: Math.min(90, c.l + 12),
        texture,
        fixedTexture,
        spin: rand(0, TAU),
        spinSpeed: rand(-6, 6),
        shape: Math.random() < 0.3 ? "square" : "dot",
      });
    }
    // 一次短促的冲击环（比 aura 小、比 explode 轻）
    this.auras.push({
      x: cx,
      y: cy,
      w: rect.w,
      h: rect.h,
      color: sampleColor(baseColor, 0.5),
      texture,
      fixedTexture,
      t: 0,
      life: 0.46,
      size: Math.max(rect.w, rect.h) * 0.92,
      kind: "impact",
    });
    this._ensureLoop();
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
   * @param {{attribute?:string,color?:string,kind?:string,crit?:boolean,size?:number,life?:number,tag?:string}} [opts]
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
      stops:
        (kind === "damage" || kind === "energy") && Array.isArray(pair.stops) && pair.stops.length > 1
          ? pair.stops
          : null,
      crit: Boolean(opts.crit),
      size: opts.size || (opts.crit ? 30 : 23),
      /** 数字下方的小标签（如「附加」），用来区分伤害类型 */
      tag: opts.tag ? String(opts.tag) : "",
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
    if (Array.isArray(t.stops) && t.stops.length > 1) {
      t.stops.forEach((stop, i) => g.addColorStop(i / (t.stops.length - 1), stop));
    } else {
      g.addColorStop(0, t.upper);
      g.addColorStop(1, t.lower);
    }
    ctx.fillStyle = g;
    ctx.fillText(t.text, 0, 0);

    if (t.crit) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.font = `700 11px ${FONT}`;
      ctx.fillStyle = t.lower;
      ctx.fillText("暴击", 0, -t.size * 0.78);
    }

    // 类型标签（附加 / 本源等）：压在数字下方，白描边保证在浅底上读得清
    if (t.tag) {
      ctx.globalAlpha = alpha;
      ctx.font = `800 11px ${FONT}`;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(247, 255, 255, 0.95)";
      ctx.strokeText(t.tag, 0, t.size * 0.84);
      ctx.fillStyle = "#14616B";
      ctx.fillText(t.tag, 0, t.size * 0.84);
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
