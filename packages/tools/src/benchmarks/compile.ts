/**
 * 基准脚本的**编译面与执行面**:产物怎么来、编译诊断怎么读、入口怎么调。
 *
 * ── 为什么这三件事在同一个文件里 ───────────────────────────────────────────────
 * 它们共用同一条流水线,而且每一步都必须与入库的那份产物对齐:编译用的是
 * `tsconfig.scripts.json`(仓库根那份基座),诊断的分类决定「这份编译到底算不算数」,
 * 入口能不能调决定产物是不是一份可加载的裸脚本。拆成三份就得让三份各自持有一份
 * 「怎么派生运行配置」,而那份派生正是最容易与基座悄悄分叉的地方。
 *
 * ── 编译在系统临时目录里做 ───────────────────────────────────────────────────
 * 与 `script-compile-config.test.ts` / `api-example-compile.test.ts` 同一理由:
 * 临时目录在仓库之外,模块解析一路向上也够不到本仓库的 `node_modules`,于是
 * 「模块解析面被清空」在这里是真的,而不是被测试环境偷偷兜住。
 * 运行配置由基座派生、**只覆盖 `files` 与 `outDir`**(`tsc -p` 不能与源文件同命令行出现,TS5042)——
 * 与将来的生成管线同形,这也是票 06 要求的用法。
 *
 * ── 类型面未回填,于是编译**必然非零退出**,而产物照样落盘 ──────────────────────
 * 脚本 API 的类型声明面家已定在真源包,内容由对局内核与沙箱执行器回填(hld §6.2「API 误用」),
 * `tsconfig.scripts.json` 的 `types` 因此是空的。于是每个用到 API 的脚本编译后必然报
 * 「找不到名字」,而本配置**刻意不设 `noEmitOnError`**:`tsc` 在这种情形下照常 emit,
 * 那份产物就是门禁与生成管线将来真正加载的东西。
 *
 * 于是「产物是真跑出来的」这件事的机器形态是**逐字节可复现**:拿入库的源码重跑同一条命令,
 * 必须得到与入库产物逐字节相同的结果(`run-benchmarks-gate.ts` 判它)。
 * 本文件只提供那次编译与它的诊断,判决在门禁里。
 *
 * 诊断分三类,三类之外任何一条都判红(理由逐条在 `DiagnosticClass` 上):
 * 「名字未声明」是类型面未回填的账,类型面回填那天它必须归零,那是回填那一格的验收信号;
 * 另两类是三份脚本**自身**在 `strict` 下的写法账,与类型面无关,回填之后依然在——
 * 把它们混进第一类,等于替回填那一格把账赖掉。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import {
  SANDBOX_INJECTED_API_SYMBOL_CATALOG,
  type InjectedApiSymbolEntry,
} from "@model-war/schema";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** 仓库根。`packages/tools/src/benchmarks/` 往上四层。 */
export const repoRoot = here("../../../../");

/** 全仓库唯一那份参赛脚本编译配置;基准脚本的产物就是按它编译出来的。 */
export const SCRIPT_CONFIG = `${repoRoot}tsconfig.scripts.json`;

/** `node_modules` 里那份 tsc(与 `script-compile-config.test.ts` 同一份,不 spawn `pnpm exec`)。 */
const TSC = `${repoRoot}node_modules/.bin/tsc`;

/** 基准目录。 */
export const BENCHMARK_ROOT = `${repoRoot}benchmarks`;

/**
 * 基准脚本的**登记册**:目录名逐字列出。它们不在任何 vitest project 的拾取范围里
 * (测试文件必须落在某个包 `src` 下的 `*.test.ts` 才会被 `unit` 拾取,理由见 `vitest.config.ts`)。
 *
 * 刻意写字面清单而不是「读目录再数」:数出来是 3 拦不住「有人往基准目录里放了第四份而清单没跟上」。
 * 两个方向都有断言(`benchmarks.test.ts`):清单里的每个目录存在且逐字是 `script.ts` + `script.js` 两份,
 * 目录里多出任何文件即红——含标定环的采集探针与某模型的零产出存档,它们按既有先例不进基准目录。
 */
export const BENCHMARK_NAMES = [
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
] as const;

export type BenchmarkName = (typeof BENCHMARK_NAMES)[number];

/** 基准目录里那两份文件的角色:源码一份、编译产物一份。 */
export const SOURCE_FILE = "script.ts";
export const PRODUCT_FILE = "script.js";

/** 一份基准脚本的绝对路径。 */
export const benchmarkFile = (name: BenchmarkName, file: string): string =>
  `${BENCHMARK_ROOT}/${name}/${file}`;

/**
 * 一条编译诊断归到哪一类。
 *
 * - `unresolved-name`:**类型面未回填的账**。名字逐条都该在 `SANDBOX_INJECTED_API_SYMBOLS` 里
 *   ——不在表里的名字落到这一类,是脚本用了运行时不存在的 API(或者踩了某个非注入的名字),
 *   那与类型面无关,当场红。
 * - `implicit-any-parameter`:脚本自己的形参没标注,在 `strict` 下报 TS7006。与类型面无关:
 *   形参属于脚本自己的函数,回填类型面不会动它。
 * - `possibly-undefined`:`noUncheckedIndexedAccess` 下 `xs[i]` 报 TS18048。同样与类型面无关。
 * - `unexpected`:**不在上面三类里的任何一条诊断**。它是兜底档,正常编译一份基准脚本时为空;
 *   它一非空就说明基座或脚本出了这三条之外的事(比如真的语法错、真的类型不兼容),
 *   那时继续拿产物说事就是不负责任,所以门禁与测试都判红。
 */
export type DiagnosticClass =
  | "unresolved-name"
  | "implicit-any-parameter"
  | "possibly-undefined"
  | "unexpected";

export type Diagnostic = {
  readonly cls: DiagnosticClass;
  /** 诊断原文的一行(去掉文件名前缀)。`unresolved-name` 另有 `name`。 */
  readonly line: string;
  /** 仅 `unresolved-name` 有:那个还没被声明的名字。 */
  readonly name?: string;
};

/** 「找不到名字」这一类:TS2304 与 TS2552(后者带一句 did you mean)。 */
const UNRESOLVED_NAME = /error TS(?:2304|2552): Cannot find name '([^']+)'/;

/** 形参隐式 `any`。 */
const IMPLICIT_ANY = /error TS7006: Parameter '[^']+' implicitly has an 'any' type/;

/** 下标取值在 `noUncheckedIndexedAccess` 下可能为 `undefined`。 */
const POSSIBLY_UNDEFINED = /error TS18048: '[^']+' is possibly 'undefined'/;

/**
 * 把 `tsc` 的诊断全文分类。
 *
 * 只看含 `error TS` 的行——警告行不是判决的一部分,而 `tsc` 的退出码只由 error 决定。
 * 逐行独立分类(不做跨行归并),所以同一条诊断被拆成两行这种排版事故会立刻露出来:
 * 那时其中一行落进 `unexpected`。
 */
export const classifyDiagnostics = (output: string): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("error TS")) {
      continue;
    }
    const unresolved = UNRESOLVED_NAME.exec(line);
    if (unresolved !== null) {
      diagnostics.push({ cls: "unresolved-name", line, name: unresolved[1] ?? "" });
      continue;
    }
    if (IMPLICIT_ANY.test(line)) {
      diagnostics.push({ cls: "implicit-any-parameter", line });
      continue;
    }
    if (POSSIBLY_UNDEFINED.test(line)) {
      diagnostics.push({ cls: "possibly-undefined", line });
      continue;
    }
    diagnostics.push({ cls: "unexpected", line });
  }
  return diagnostics;
};

export type Compilation = {
  /** `tsc` 的退出码。类型面未回填时它必然非零,见本文件头注。 */
  readonly status: number;
  /** 诊断全文(标准输出与标准错误合并)。 */
  readonly output: string;
  /** 产物的内容;`tsc` 没 emit 时是空串(不区分「没产物」与「空产物」,由 `status` 负责)。 */
  readonly products: string;
  readonly diagnostics: readonly Diagnostic[];
};

/**
 * 把一段源码当基准脚本编译一遍,返回退出码、诊断、产物与分类后的诊断。
 *
 * 派生运行配置只覆盖 `files` 与 `outDir`,其余全继承 `tsconfig.scripts.json`——派生面越宽,
 * 「产物是基座跑出来的」这句话就越可疑。
 */
export const compileBenchmarkSource = (source: string): Compilation => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-benchmark-"));
  try {
    writeFileSync(join(dir, SOURCE_FILE), source, "utf8");
    writeFileSync(
      join(dir, "run.json"),
      `${JSON.stringify(
        { extends: SCRIPT_CONFIG, compilerOptions: { outDir: "out" }, files: [SOURCE_FILE] },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = spawnSync(TSC, ["-p", join(dir, "run.json"), "--pretty", "false"], {
      cwd: dir,
      encoding: "utf8",
    });
    if (result.error !== undefined) {
      throw result.error;
    }

    const output = `${result.stdout}${result.stderr}`;
    const product = join(dir, "out", PRODUCT_FILE);
    return {
      status: result.status ?? -1,
      output,
      products: existsSync(product) ? readFileSync(product, "utf8") : "",
      diagnostics: classifyDiagnostics(output),
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/**
 * 返回类型 → **空值**的对照。这是「注入面桩」的全部知识:桩不模拟对局,只让入口调得动。
 *
 * 取值全部由 `SANDBOX_INJECTED_API_SYMBOL_CATALOG` 的 `signature` 推导,本文件**一个 API 名字都不写**——
 * 名字只有一处可改(真源包那张目录),而这张表多抄一份就等于多一处会悄悄过期的名单。
 * 连「取不到错误码时的兜底值」那个位置也不写名字:错误码同样只从目录投影,推不出来就抛错。
 * 抛错而不是塞个兜底值:那种情况说明目录里一个错误码都没有,塞个名字糊过去会让本文件
 * 自己的纪律(「一个名字都不写」)当场失效,而失效的形式恰好是最难发现的那种。
 */
const EMPTY_VALUE_OF = (signature: string, errorCodes: readonly string[]): unknown => {
  // 签名形如 `名字(参数): 返回值`,可能折行;返回值从最后一个 `): ` 之后取。
  const at = signature.replace(/\s+/g, " ").lastIndexOf("): ");
  if (at < 0) {
    throw new Error(`注入面签名解析不出返回值: ${signature}`);
  }
  const returns = signature.replace(/\s+/g, " ").slice(at + 3);
  if (returns.endsWith("[]")) return [];
  if (returns.includes("null")) return null;
  if (returns === "boolean") return false;
  if (returns === "ErrCode") {
    // 错误码目录为空时非零退出而不是给一个写死的兜底码:那个码名只能有一处家(真源包目录)。
    const anyCode = errorCodes[0];
    if (anyCode === undefined) {
      throw new Error("注入面目录里一个错误码都没有,桩给不出 `ErrCode` 的空值。");
    }
    return anyCode;
  }
  // 字符串字面量联合(地形的 `'plain' | 'wall' | 'out'`):取第一个候选,当作「最普通的那种」。
  const literal = /^'([a-z]+)'(\s*\|\s*'[a-z]+')*$/.exec(returns);
  if (literal !== null) return literal[1] ?? "";
  if (returns === "void | ErrResult" || returns === "void") return null;
  // `number` 与 `0|1|2|3` 都是数值;位运算型座位自认(`getMyIndex`)也落在这里。
  if (/^[0-9|\s]+$/.test(returns) || returns === "number") return 0;
  throw new Error(`注入面签名有一个本文件不会给桩的返回类型 \`${returns}\`: ${signature}`);
};

/**
 * 一份**注入面桩**:按符号表把每个注入的 API 铺成一个返回空值的函数(错误码铺成那个字符串本身)。
 *
 * 名字、类别、签名全部取自真源包那张目录(`SANDBOX_INJECTED_API_SYMBOL_CATALOG`),这里只决定
 * 「空值是什么」。它不是对局模拟器:它不产生单位、不结算意图、不推进 tick。
 * 它要回答的问题只有一个——**这份产物在裸上下文里能不能被加载、入口能不能被调**。
 */
export const emptyInjectedSurface = (): Record<string, unknown> => {
  const errorCodes = SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter(
    (entry) => entry.kind === "error-code",
  ).map((entry) => entry.symbol);

  const surface: Record<string, unknown> = {};
  for (const entry of SANDBOX_INJECTED_API_SYMBOL_CATALOG) {
    surface[entry.symbol] = stubFor(entry, errorCodes);
  }
  return surface;
};

const stubFor = (entry: InjectedApiSymbolEntry, errorCodes: readonly string[]): unknown => {
  if (entry.kind === "error-code") return entry.symbol;
  return () => EMPTY_VALUE_OF(entry.signature, errorCodes);
};

/**
 * 在一个**裸**上下文里载入产物,返回那个上下文。
 *
 * 与沙箱载入编译产物是同一形态:上下文里只有 `surface` 上那些注入面成员(每个返回空值),
 * 没有 `require`、没有 `process`、没有任何宿主全局——所以「产物自带模块语义」这件事在这里无处藏。
 */
export const loadProduct = (
  products: string,
  surface: Record<string, unknown> = emptyInjectedSurface(),
): Record<string, unknown> => {
  const context: Record<string, unknown> = { ...surface };
  runInContext(products, createContext(context));
  return context;
};

/** 产物里的入口。类型面上它必须是函数;取不到就是产物不可加载。 */
export const entryOf = (context: Record<string, unknown>): unknown => context["loop"];
