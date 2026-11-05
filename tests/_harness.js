/**
 * _harness.js —— 极简测试工具（Node，无依赖）
 *
 *   const t = createHarness("damage");
 *   t.test("名字", () => { assert.equal(1, 1); });
 *   t.test("异步", async () => { … });
 *   process.exitCode = await t.done();
 */
import assert from "node:assert/strict";

export { assert };

export function createHarness(title) {
  let passed = 0;
  let failed = 0;
  const queue = [];

  function test(name, fn) {
    queue.push({ name, fn });
  }

  function suite(name, fn) {
    queue.push({ name: `— ${name} —`, suite: true });
    fn();
  }

  async function done() {
    if (title) console.log(title);
    for (const item of queue) {
      if (item.suite) {
        console.log(item.name);
        continue;
      }
      try {
        await item.fn();
        passed += 1;
        console.log(`  ✓ ${item.name}`);
      } catch (err) {
        failed += 1;
        console.error(`  ✗ ${item.name}\n    ${String(err && err.message || err).split("\n").join("\n    ")}`);
      }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    return failed ? 1 : 0;
  }

  return { test, suite, done, assert, get passed() { return passed; }, get failed() { return failed; } };
}

/** 近似相等断言 */
export function closeTo(actual, expected, eps = 1e-9, msg = "") {
  if (!(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)))) {
    assert.fail(`${msg} 期望 ≈${expected}，实际 ${actual}`);
  }
}

/** 读一个 JSON 文件（相对项目根） */
export const ROOT = new URL("../", import.meta.url);
