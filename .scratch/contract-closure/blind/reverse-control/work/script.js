// 反向对照：故意写坏的脚本。用同一条 freeze 命令（run-validate-script.ts）与复用的一次性
// 校验器（static-check.ts）都要判红，确认门禁没被放宽。这份脚本不编译、不入交付目录。
import { readFileSync } from "node:fs";
export const marker = 1.5;
const fn = new Function("return 1");
require("node:fs");

function loop() {
  const now = Date.now();
  const roll = Math.random();
  const perf = performance.now();
  const q = queueMicrotask;
  const bridge = __bridge_getSnapshot;
  const kind = typeof now;
  const average = now / roll;
  console.log(process.pid);
  eval("1");
  return fn + readFileSync + kind + average + perf + q + bridge;
}
