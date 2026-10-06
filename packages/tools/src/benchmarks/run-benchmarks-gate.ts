/**
 * 门禁:基准脚本的**编译产物**是不是真的由 `tsconfig.scripts.json` 跑出来的(根脚本 `check:bench`)。
 *
 * 用法:`node packages/tools/src/benchmarks/run-benchmarks-gate.ts`
 * 挂在全量门禁 `check` 的末尾,与 `check:drift` 同一位置纪律(产物入库的那一侧都在末尾)。
 *
 * ── 为什么产物要逐字节复现,而不是「看着像」 ─────────────────────────────────
 * 产物入库的理由是门禁的第一印象:clone 完直接能跑,不该每次先构建一遍。
 * 一旦产物可以与源码悄悄分叉,这条理由当场作废——库里的产物是旧的,门禁跑的还是绿的。
 * 所以这条门禁只问一件事:**拿入库的源码重跑同一条编译命令,必须得到逐字节相同的那份产物**。
 * 它不判「脚本好不好」,那是静态校验器与对局读数的事;它判「入库的东西是不是真的编译出来的」。
 *
 * ── 三条附带的判决,各自对应一件会被漏掉的事 ─────────────────────────────────
 * 1. **产物是裸脚本**:无 `import` / `export` / `require`。这不是排版洁癖——门禁将来拿产物
 *    直接喂沙箱,产物里多一个模块说明符就是一次加载失败。
 * 2. **入口可被调用**:在一个裸上下文里载入产物,按注入面符号表铺一层空值桩,`loop` 必须是函数
 *    且调得动。桩不是对局模拟器(不产生单位、不结算意图),它回答的是「产物能不能被加载」。
 * 3. **诊断没有第四类**:三条诊断类别之外任何一条都判红(分类见 `compile.ts`)。
 *    前两类会在报告里报数,好让「类型面还没回填」这件事在门禁输出上看得见,而不是被吞掉。
 *
 * 报告全部走标准输出,退出码 0/1(与本仓库其余门禁同形:调用方只需要知道能不能进下一步)。
 */

import { readFileSync } from "node:fs";

import {
  BENCHMARK_NAMES,
  PRODUCT_FILE,
  SOURCE_FILE,
  benchmarkFile,
  compileBenchmarkSource,
  entryOf,
  loadProduct,
  type Diagnostic,
} from "./compile.ts";

/**
 * 模块语法的三种形态;产物里一个都不许有。
 *
 * 逐条按**语句开头**匹配而不是找子串:产物里带着源码的注释,而 cell-a 那份的头注逐字写着
 * 「No imports/exports」——按子串找会在一份完全合规的产物上报红,而这种假绿/假红一旦被
 * 「改个正则糊过去」处理掉,这条判决就名存实亡了。注释里的 `imports` 不是模块语法。
 */
const MODULE_SYNTAX: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "import", pattern: /^\s*import[\s{*(]/m },
  { label: "export", pattern: /^\s*export[\s{]/m },
  { label: "require", pattern: /\brequire\s*\(/ },
];

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

const countBy = (diagnostics: readonly Diagnostic[], cls: Diagnostic["cls"]): number =>
  diagnostics.filter((diagnostic) => diagnostic.cls === cls).length;

let failed = false;

for (const name of BENCHMARK_NAMES) {
  const source = readFileSync(benchmarkFile(name, SOURCE_FILE), "utf8");
  const compiled = compileBenchmarkSource(source);

  // ① 产物可复现:重跑编译的结果必须与入库的那份逐字节相同。
  const committed = readFileSync(benchmarkFile(name, PRODUCT_FILE), "utf8");
  if (compiled.products === "") {
    console.error(`✗ ${name}:按 ${SOURCE_FILE} 重新编译没有产物(tsc 退出码 ${compiled.status})`);
    failed = true;
    continue;
  }
  if (compiled.products !== committed) {
    const at = firstDifference(compiled.products, committed);
    console.error(
      `✗ ${name}:入库的 ${PRODUCT_FILE} 与重新编译的结果不一致` +
        `(入库 ${bytes(committed)} 字节 / 重编译 ${bytes(compiled.products)} 字节,` +
        `首个差异在第 ${at} 字节)。入库的产物必须是用 tsconfig.scripts.json 跑出来的那份:` +
        "改完源码跑 `pnpm run bench:build`。",
    );
    failed = true;
    continue;
  }

  // ② 产物是裸脚本。
  const moduleSyntax = MODULE_SYNTAX.filter(({ pattern }) => pattern.test(committed)).map(
    ({ label }) => label,
  );
  if (moduleSyntax.length > 0) {
    console.error(`✗ ${name}:产物里出现了模块语法 ${moduleSyntax.join(" / ")}`);
    failed = true;
  }

  // ③ 入口可被调用:裸上下文 + 注入面空值桩。
  let callable = true;
  try {
    const entry = entryOf(loadProduct(committed));
    if (typeof entry !== "function") {
      console.error(`✗ ${name}:产物里的入口不是函数(取到的是 ${typeof entry})`);
      callable = false;
    } else {
      (entry as () => unknown)();
    }
  } catch (error) {
    console.error(`✗ ${name}:产物加载或入口调用抛了异常:${String(error)}`);
    callable = false;
  }

  // ④ 诊断只有那三类,而「名字未声明」那一项已经归零——类型面已回填(票 03),它必须一直是 0。
  for (const diagnostic of compiled.diagnostics.filter((d) => d.cls === "unexpected")) {
    console.error(`✗ ${name}:非预期诊断 ${diagnostic.line}`);
    failed = true;
  }

  console.log(
    `✓ ${name}:产物与重新编译的结果逐字节一致(${bytes(committed)} 字节),裸脚本,` +
      `入口可调用=${String(callable)};诊断 名字未声明 ` +
      `${countBy(compiled.diagnostics, "unresolved-name")} / 形参隐式 any ` +
      `${countBy(compiled.diagnostics, "implicit-any-parameter")} / 可能为 undefined ` +
      `${countBy(compiled.diagnostics, "possibly-undefined")}` +
      "(类型面已回填:第一项必须恒为 0,非 0 就是声明面与脚本对不上了)",
  );
}

console.log(
  `基准产物门禁:${failed ? "红" : "绿"}(${BENCHMARK_NAMES.length} 份;产物是入库的,门禁跑的就是它)`,
);
process.exit(failed ? 1 : 0);
