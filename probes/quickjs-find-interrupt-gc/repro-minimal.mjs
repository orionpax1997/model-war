/**
 * 上游缺陷最小复现:quickjs-ng `Array.prototype.find` 在中断点上二次释放元素(issue #1792)。
 *
 * 不 import 引擎、不读网络 / 凭证:直接驱动 quickjs-wasi 的 VM。它把查找谓词设为恒假,在
 * 中断处理器**总是**返回真时反复调 `find`——终有一次中断落在 find 每轮顶部的检查处,异常出口
 * 把上一轮已释放的元素再释放一次;随后的 `runGC()` 命中 GC 断言、WASM trap。
 *
 * 用法:
 *   node probes/quickjs-find-interrupt-gc/repro-minimal.mjs            # 原生 find → 崩
 *   node probes/quickjs-find-interrupt-gc/repro-minimal.mjs --shim     # 等价 JS 实现 → 通过
 *
 * 退出码:0 = 本实现下未触发崩溃;非 0 = 崩溃(原生 find 下的预期结果)。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { QuickJS } from "quickjs-wasi";

const wasmPath = fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"));
const wasm = readFileSync(wasmPath);
const useShim = process.argv.includes("--shim");

let armed = false;
const vm = await QuickJS.create({ wasm, interruptHandler: () => armed });
try {
  vm.evalCode(
    "var items = []; for (var i = 0; i < 20000; i += 1) { items.push({ v: i }); }",
  ).dispose();
  if (useShim) {
    // 与引擎侧规避同形:换一份等价的 JS 实现(这里直接转调原生,证明"换实现"这个动作本身
    // 不足以定位问题;真正的规避是不再走那段 C 实现)。见 ../README.md 的说明。
    vm.evalCode(
      [
        "(function () {",
        "  function find(predicate, thisArg) {",
        "    if (this === null || this === undefined) { throw new TypeError('find on null'); }",
        "    var o = Object(this);",
        "    var len = o.length >>> 0;",
        "    for (var k = 0; k < len; k += 1) {",
        "      if (k in o && predicate.call(thisArg, o[k], k, o)) { return o[k]; }",
        "    }",
        "    return undefined;",
        "  }",
        "  Array.prototype.find = find;",
        "})();",
      ].join("\n"),
    ).dispose();
  }

  armed = true;
  let interrupted = 0;
  for (let i = 0; i < 60; i += 1) {
    try {
      vm.evalCode("items.find(function (x) { return false; })").consume((h) => vm.dump(h));
    } catch {
      interrupted += 1;
    }
  }
  armed = false;

  vm.evalCode("var s = 0; for (var i = 0; i < items.length; i += 1) { s += items[i].v; }").dispose();
  vm.runGC();
  process.stdout.write(
    JSON.stringify({ useShim, interrupted, outcome: "no-crash" }) + "\n",
  );
  process.exitCode = 0;
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      useShim,
      outcome: "gc-assert",
      error: error instanceof Error ? error.message.split("\n")[0] : String(error),
    }) + "\n",
  );
  process.exitCode = 2;
} finally {
  vm.dispose();
}
