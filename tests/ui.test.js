/**
 * ui.test.js —— 纯逻辑单测（Node，无需浏览器）
 *
 *   node tests/ui.test.js
 *
 * 覆盖：字符库解析/抽取、菜单结构与手风琴、随机图片、进度条。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseTips, pickTip, FALLBACK_TIPS, loadTips } from "../js/tips.js";
import { MENUS, findTab, findItem, toggleTab } from "../js/menus.js";
import { PICTURES, pickPicture } from "../js/pictures.js";
import { STAGES, createLoader } from "../js/loading.js";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function test(name, fn) {
  if (fn && fn.constructor && fn.constructor.name === "AsyncFunction") return; // 异步用例见文末
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log("tips");

test("解析：去空行、去首尾空白、兼容 CRLF 与 BOM", () => {
  const raw = "\uFEFF第一条\r\n\r\n  第二条  \n\n第三条\n";
  assert.deepEqual(parseTips(raw), ["第一条", "第二条", "第三条"]);
});

test("解析：非字符串返回空数组", () => {
  assert.deepEqual(parseTips(null), []);
  assert.deepEqual(parseTips(undefined), []);
});

test("真实字符库 data/tips.txt 可解析且非空", () => {
  const raw = readFileSync(resolve(here, "../data/tips.txt"), "utf8");
  const tips = parseTips(raw);
  assert.ok(tips.length >= 1, "tips.txt 至少要有一条");
  assert.ok(tips.every((t) => t.length > 0));
});

test("抽取：不连续重复（多次随机）", () => {
  const tips = ["a", "b", "c", "d"];
  let last = -1;
  for (let i = 0; i < 200; i += 1) {
    const next = pickTip(tips, last);
    assert.notEqual(next.index, last, `第 ${i} 次抽到了上一条`);
    last = next.index;
  }
});

test("抽取：单条时恒定返回该条", () => {
  assert.deepEqual(pickTip(["only"], -1), { index: 0, text: "only" });
  assert.deepEqual(pickTip(["only"], 0), { index: 0, text: "only" });
});

test("抽取：空字符库返回 -1", () => {
  assert.deepEqual(pickTip([], 0), { index: -1, text: "" });
  assert.deepEqual(pickTip(null), { index: -1, text: "" });
});

test("抽取：rng 边界 0 与接近 1 都不越界", () => {
  const tips = ["a", "b", "c"];
  assert.equal(pickTip(tips, -1, () => 0).index, 0);
  assert.equal(pickTip(tips, -1, () => 0.999999).index, 2);
  assert.equal(pickTip(tips, 2, () => 0.999999).index, 1);
});

console.log("menus");

test("菜单结构符合需求：5 个标签，选项齐全", () => {
  const expected = {
    play: ["同屏", "肉鸽", "无尽", "挑战"],
    test: ["训练场"],
    design: ["编辑器"],
    mod: ["模组管理"],
    settings: ["设置"],
  };
  assert.equal(MENUS.length, 5);
  for (const [id, labels] of Object.entries(expected)) {
    const tab = findTab(id);
    assert.ok(tab, `缺少标签 ${id}`);
    assert.deepEqual(tab.items.map((it) => it.label), labels, `标签 ${id} 的选项不对`);
  }
});

test("菜单：标签 id 全局唯一", () => {
  const ids = MENUS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("菜单：选项 id 无重复，findItem 可定位", () => {
  const ids = MENUS.flatMap((t) => t.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length, "选项 id 有重复");
  const found = findItem("rogue");
  assert.equal(found.tab.id, "play");
  assert.equal(found.item.label, "肉鸽");
  assert.equal(findItem("nope"), null);
});

test("手风琴：点新标签打开、点已开标签收起", () => {
  assert.equal(toggleTab(null, "play"), "play");
  assert.equal(toggleTab("play", "design"), "design");
  assert.equal(toggleTab("design", "design"), null);
});

console.log("layout");

test("手机竖屏：侧栏品牌（大标题）不能被隐藏", () => {
  const css = readFileSync(resolve(here, "../css/menu.css"), "utf8");
  // 取所有 max-width: 680px / max-aspect-ratio 4/5 的媒体块
  const blocks = [];
  const re = /@media[^{]*\(max-width:\s*680px\)[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push(css.slice(start, i - 1));
  }
  assert.ok(blocks.length >= 1, "找不到手机竖屏媒体查询");
  for (const block of blocks) {
    assert.equal(
      /\.sidebar-brand\s*\{[^}]*display:\s*none/.test(block),
      false,
      "手机竖屏里 .sidebar-brand 被 display:none 隐藏了，首页大标题会消失"
    );
    assert.equal(
      /\.cw-title\s*\{[^}]*display:\s*none/.test(block),
      false,
      "手机竖屏里 .cw-title 不允许 display:none"
    );
  }
});

test("页面结构：主菜单里有大标题", () => {
  const html = readFileSync(resolve(here, "../index.html"), "utf8");
  assert.match(html, /class="cw-title cw-title--small"/);
  assert.match(html, /sidebar-brand/);
});

console.log("pictures");

test("图片池：castorice / hyacine 两张且路径存在", () => {
  assert.deepEqual(PICTURES.map((p) => p.id), ["castorice", "hyacine"]);
  for (const p of PICTURES) {
    const file = resolve(here, "..", p.src);
    assert.ok(readFileSync(file).length > 0, `${p.src} 读不到`);
  }
});

test("随机图片：不连抽同一张", () => {
  let last = "";
  for (let i = 0; i < 200; i += 1) {
    const next = pickPicture(PICTURES, last);
    assert.notEqual(next.id, last);
    last = next.id;
  }
});

test("随机图片：空池返回 null", () => {
  assert.equal(pickPicture([], ""), null);
});

console.log("loading");

test("进度：各阶段完成不断章，最终 100", () => {
  const loader = createLoader(STAGES);
  let prev = loader.value;
  assert.equal(prev, 0);
  STAGES.forEach((_, i) => {
    const v = loader.finish(i);
    assert.ok(v >= prev, "进度不能倒退");
    prev = v;
  });
  assert.equal(loader.value, 100);
});

test("进度：weight 总和与阶段数一致可配置", () => {
  const loader = createLoader([
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
  ]);
  assert.equal(loader.finish(0), 50);
  assert.equal(loader.finish(1), 100);
  assert.equal(loader.complete(), 100);
});

(async () => {
  try {
    const original = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
      const res = await loadTips("data/tips.txt");
      assert.equal(res.source, "fallback");
      assert.deepEqual(res.tips, FALLBACK_TIPS);
    } finally {
      globalThis.fetch = original;
    }
    passed += 1;
    console.log("  ✓ loadTips：无 fetch 环境回落兜底，同长度字符库也不抛错");
  } catch (err) {
    failed += 1;
    console.error(`  ✗ loadTips 兜底\n    ${err.message}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
