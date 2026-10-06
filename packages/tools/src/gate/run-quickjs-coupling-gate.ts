/**
 * 工具版本耦合断言:`quickjs-wasi` 的根级精确钉版必须与冻结常量模块一致(根脚本 `coupling:quickjs`)。
 *
 * ── 为什么要有这条断言 ──
 * hld §5.0 那五条沙箱行为结论只对某一个 `quickjs-wasi` 版本成立,而「**没有任何机器会提醒后来者
 * 它们已经过期**」(§5.0「升级条款」段,§12 #8)。本仓库没有常驻 CI(门禁是命名脚本、手工触发),
 * 所以提醒只能挂在默认的快速链上:版本一升,这条断言立刻红,报错信息直接说明该去跑哪个脚本、
 * 该把数字写回哪一节。它只比对两个字符串,几乎零成本——这正是它配得上 `check:quick` 的理由。
 *
 * ── 与探针为什么分开 ──
 * 探针要真装 VM、真跑行为(见 `sandbox-probes/run-probes.ts`),不能塞进每次编辑都跑的快速链;
 * 本条只读 `package.json` 与冻结常量模块,不装 VM、不 import 引擎,零构建。
 *
 * ── 形态抄 `toolchain-coupling.ts` ──
 * 顶层副作用的脚本,唯一对外接口是退出码(配套 0 / 错位 1);判据抽成导出的**纯函数**
 * `findQuickjsMisalignments`,并接受**反例形式参数**(两个假版本号),这样测试不必改动
 * `package.json` 就能现做现验「改版本号会红」。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { PROBED_QUICKJS_WASI_VERSION } from "../sandbox-probes/constants.ts";

const require = createRequire(import.meta.url);

const rootPackageJsonPath = fileURLToPath(new URL("../../../../package.json", import.meta.url));

const PROBES_SCRIPT = "pnpm run probes:sandbox";
const HLD_SECTION = "docs/hld.md §5.0";

type Manifest = {
  readonly devDependencies?: Record<string, string>;
};

/** 一条已经查清原因的不通过。 */
type Misalignment = { readonly check: string; readonly detail: string };

/** 精确锁版:spec 里不许出现任何范围运算符。 */
const isExactPin = (spec: string): boolean => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec);

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;

/** node_modules 里实际装着的版本,用来抓「manifest 改了但没重装」。 */
const installedVersion = (packageName: string): string => {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = readJson(manifestPath) as { readonly version?: string };
  if (manifest.version === undefined) {
    throw new Error(`${packageName} 的 package.json 没有 version 字段:${manifestPath}`);
  }
  return manifest.version;
};

/**
 * 跑一次断言,收集全部不通过项;空数组即配套。
 *
 * 三个判据依次是「根依赖精确锁版」「根依赖与冻结常量一致」「安装与 manifest 一致」;
 * 第二条是这条断言存在的**全部理由**——它红了,人该做的是重跑复验、把新数字写回,而不是把数字改到跟
 * `package.json` 一样来让门禁闭嘴。
 */
export const findQuickjsMisalignments = (
  rootSpec: string,
  frozenVersion: string,
  installed: string | null,
): readonly Misalignment[] => {
  const found: Misalignment[] = [];

  if (!isExactPin(rootSpec)) {
    found.push({
      check: "精确锁版",
      detail: `根 package.json 的 devDependencies["quickjs-wasi"] = ${JSON.stringify(rootSpec)},含范围运算符;本仓要求精确钉版`,
    });
  }

  if (rootSpec !== frozenVersion) {
    found.push({
      check: "根依赖与冻结常量一致",
      detail:
        `根 package.json 钉的是 ${rootSpec},而冻结常量记的是 ${frozenVersion}。` +
        `升级 quickjs-wasi 必须按新版本组合重跑复验:跑 \`${PROBES_SCRIPT}\`,` +
        `把五条沙箱行为的新数字与版本写回 ${HLD_SECTION},` +
        `并更新 packages/tools/src/sandbox-probes/constants.ts。`,
    });
  }

  if (installed !== null && installed !== frozenVersion) {
    found.push({
      check: "安装与 manifest 一致",
      detail: `node_modules 里装的是 ${installed},冻结常量记的是 ${frozenVersion}(改了 manifest 需要重装)`,
    });
  }

  return found;
};

const readRootSpec = (): string => {
  const manifest = readJson(rootPackageJsonPath) as Manifest;
  const deps = manifest.devDependencies;
  if (deps === undefined) {
    throw new Error(`根 package.json 没有 devDependencies:${rootPackageJsonPath}`);
  }
  const spec = deps["quickjs-wasi"];
  if (spec === undefined) {
    throw new Error("根 package.json 的 devDependencies 必须声明 quickjs-wasi");
  }
  return spec;
};

const main = (): number => {
  const argv = process.argv.slice(2);
  const rootSpec =
    argv.length === 0
      ? readRootSpec()
      : argv.length === 1
        ? (argv[0] as string)
        : (() => {
            throw new Error(
              "用法:node packages/tools/src/gate/run-quickjs-coupling-gate.ts [根依赖版本号]",
            );
          })();

  // 反例形式(显式传版本号)不查 node_modules:它断言的是「根依赖 ⇄ 冻结常量」的配对关系本身。
  const installed = argv.length === 0 ? installedVersion("quickjs-wasi") : null;

  const misalignments = findQuickjsMisalignments(rootSpec, PROBED_QUICKJS_WASI_VERSION, installed);
  if (misalignments.length === 0) {
    process.stdout.write(
      `quickjs-wasi 版本耦合 ok:根依赖 ${rootSpec} ⇄ 冻结常量 ${PROBED_QUICKJS_WASI_VERSION}\n`,
    );
    return 0;
  }
  for (const { check, detail } of misalignments) {
    process.stderr.write(`quickjs-wasi 版本耦合断言不通过 [${check}]:${detail}\n`);
  }
  return 1;
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  process.exitCode = main();
}
