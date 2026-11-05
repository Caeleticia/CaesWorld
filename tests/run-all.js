/**
 * run-all.js —— 依次跑界面（纯逻辑部分）与战斗引擎测试
 *
 *   node tests/run-all.js
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const NODE_BIN = process.env.NODE_BIN || "node";
const files = ["ui.test.js", "ui-dom.js", "engine.test.js", "flow.test.js"];
let failed = 0;

// 注意：部分移动端 Node（如 Termux/Android 打包版）的 process.execPath 是动态链接器，
// 不能拿来开子进程；这里改用 shell 找 node，并给出绝对脚本路径。
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const r = spawnSync(NODE_BIN, [resolve(here, file)], { stdio: "inherit", cwd: resolve(here, "..") });
  if (r.status !== 0) failed += 1;
}

if (failed) {
  console.error(`\n${failed} 个测试文件失败`);
  process.exit(1);
}
console.log("\n全部测试通过");
