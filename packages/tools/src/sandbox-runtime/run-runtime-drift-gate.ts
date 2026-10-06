/**
 * 门禁:沙箱 runtime bundle 的**入库产物**是不是真的由构建脚本产出的(根脚本 `check:runtime`)。
 *
 * 用法:`node packages/tools/src/sandbox-runtime/run-runtime-drift-gate.ts`
 * 挂在全量门禁 `check` 的末尾,与 `check:drift` / `check:bench` 同一位置纪律。
 *
 * ── 为什么产物要逐字节复现,而不是「看着像」 ──
 * 产物入库的理由是回放 meta 那一栏 `sandboxRuntimeHash` 必须能被**第三方凭存档复算**,
 * 而复算的前提是「版本库里那串确切字节」——不能在 CI 或构建缓存里随环境漂移。所以这条门禁只问
 * 一件事:**拿入库的源码重跑同一条构建命令,必须得到逐字节相同的那份产物**;并且入库产物的
 * sha256 必须等于真源包里那份常量。判据锚定确切字节,依据见 ADR 0007。
 *
 * ── 为什么与 `check:drift` / `check:bench` 分作三条 ──
 * `check:drift` 管「名单类数据 → 生成物」那张登记表,`check:bench` 管 tsc 编译产物,
 * 本条管 esbuild 构建产物。三者产出方式不同,合表会让一道门禁同时判两套不变量、判定段也会分叉。
 *
 * ── 三段判定 ──
 * ① 现打一次得到的字节 == 入库产物(逐字节);② 入库产物 sha256 == `SANDBOX_RUNTIME_HASH` 常量;
 * ③ 产物**不含模块语法**——带 `import` / `export` 的产物在 QuickJS 的载入期就是 `SyntaxError`。
 * 报告走标准输出,退出码 0/1(与本仓库其余门禁同形:调用方只需要知道能不能进下一步)。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { SANDBOX_RUNTIME_ARTIFACT_PATH, SANDBOX_RUNTIME_HASH } from "@model-war/schema";

import { buildRuntimeCode, runtimeArtifactFile } from "./build-runtime.ts";

/**
 * 模块语法的形态;产物里一个都不许有。动态 `import()` 单列一条,与静态 `import` 分开报。
 *
 * 逐条按**语句开头**匹配而不是找子串:产物里带着源码注释,而注释里可能逐字写着
 * 「不 import 任何模块」(`sandbox-runtime/index.ts` 的头注正是如此)——按子串找会在
 * 一份完全合规的产物上报红。理由与实现同 `run-benchmarks-gate.ts:46-50`。
 */
const MODULE_SYNTAX: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "静态 import", pattern: /^\s*import[\s{*(]/m },
  { label: "静态 export", pattern: /^\s*export[\s{]/m },
  { label: "动态 import()", pattern: /^\s*import\s*\(/m },
  { label: "require(", pattern: /\brequire\s*\(/ },
];

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const bytes = (text: string): number => Buffer.byteLength(text);

/** 首个不同的字节位置;完全相同报 -1。只给人看,不参与判定。 */
const firstDifference = (left: string, right: string): number => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : Math.min(a.length, b.length);
};

let failed = false;

const committed = readFileSync(runtimeArtifactFile(SANDBOX_RUNTIME_ARTIFACT_PATH), "utf8");
const fresh = await buildRuntimeCode();

// ① 产物可复现:重跑构建的结果必须与入库的那份逐字节相同。
if (fresh !== committed) {
  const at = firstDifference(fresh, committed);
  console.error(
    `✗ runtime bundle:入库的 ${SANDBOX_RUNTIME_ARTIFACT_PATH} 与重新构建的结果不一致` +
      `(入库 ${String(bytes(committed))} 字节 / 重构建 ${String(bytes(fresh))} 字节,` +
      `首个差异在第 ${String(at)} 字节)。入库的产物必须是用 esbuild 构建出来的那份:` +
      "改完源码跑 `pnpm run runtime:build`。",
  );
  failed = true;
}

// ② 入库产物的 sha256 必须等于真源包常量(match 装载期与回放 meta 用的正是它)。
const digest = sha256(committed);
if (digest !== SANDBOX_RUNTIME_HASH) {
  console.error(
    `✗ runtime bundle:入库产物的 sha256 是 ${digest},` +
      `而 \`@model-war/schema\` 的 SANDBOX_RUNTIME_HASH 是 ${SANDBOX_RUNTIME_HASH}。` +
      "改完产物后请重算并手写那个常量(它是回放 meta 那一栏哈希的唯一真源)。",
  );
  failed = true;
}

// ③ 产物是裸脚本:无 `import` / `export` / 动态 `import()` / `require(`。
const moduleSyntax = MODULE_SYNTAX.filter(({ pattern }) => pattern.test(committed)).map(
  ({ label }) => label,
);
if (moduleSyntax.length > 0) {
  console.error(`✗ runtime bundle:产物里出现了模块语法 ${moduleSyntax.join(" / ")}`);
  failed = true;
}

console.log(
  `✓ runtime bundle:入库的 ${SANDBOX_RUNTIME_ARTIFACT_PATH}(${String(bytes(committed))} 字节)` +
    `与重新构建的结果逐字节一致;sha256 与常量相符;不含模块语法。`,
);
console.log(`runtime bundle 门禁:${failed ? "红" : "绿"}(产物是入库的,门禁跑的就是它)`);
process.exit(failed ? 1 : 0);
