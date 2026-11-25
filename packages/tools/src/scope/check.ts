/**
 * `check [--full] [--since=<ref>] [--print]`:agent 面前**唯一**的入口。
 *
 * 没有档位,没有「这次算哪一档」的判断留给人或模型:
 *
 * ```
 * pnpm run check            # 改完就跑:按改动半径选,只跑与这次改动有关的东西
 * pnpm run check -- --full  # 收口:与 CI 同一条定义(`FULL_CHAIN`)
 * ```
 *
 * 三源合流由 ADR-0038 定下,优先级从硬到软:
 *
 * 1. **代码改动交给依赖图**(`vitest related`)。前提是拿**产物路径**去问:跨包边指向 `dist/`,
 *    而 `git diff` 给的是 `src/`。
 * 2. **读盘类输入交给观测 map**(`test-inputs/inputs.json`):`rulesets/`、`maps/`、wasm、入库
 *    的 runtime 产物被读,不被 import,图对它们没有边。
 * 3. **仓库事实交给表**(`RADIUS`),表只在这个范围内是判据。
 *
 * 三条红得方向明确,都是「错要红,不能沉默」的形状:
 *
 * - 说不清:既映射不到产物也没有表规则的路径 → 红(它的默认表现是少跑)。
 * - 少跑:选择了 `test:all` 就不再单独跑它的子集;产物不在盘上则退回全量。
 * - 无人观测:改完没有任何测试被选中、观测也为空 → 红,并给出两条出路(补用例,或登记
 *   `coverage-debt.txt`)。这是 agent 最大的盲区,而原来的系统在它改完之后什么都不说。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOutputsOf, isSourceFile, workspacesOf } from "./build-outputs.ts";
import { UnregisteredPathError, decide, mustObserve } from "./change-radius.ts";
import { invert, loadInputsMap } from "./test-inputs.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 收口的定义。CI 与本地跑的是同一串名字,不各写一份。 */
export const FULL_CHAIN: readonly string[] = ["verify", "gate:types"];

/** 未覆盖登记的落点。路径相对仓库根,`#` 之后写为什么现在不测。 */
export const DEBT_PATH = "coverage-debt.txt";

const JSON_REPORT = ".vitest/json/output.json";

interface Options {
  readonly since: string;
  readonly print: boolean;
  readonly full: boolean;
}

const parseArgs = (argv: readonly string[]): Options => {
  const since = argv.find((arg) => arg.startsWith("--since="))?.slice("--since=".length);
  return {
    since: since === undefined || since === "" ? "main" : since,
    print: argv.includes("--print"),
    full: argv.includes("--full"),
  };
};

const git = (args: readonly string[]): string => {
  const result = spawnSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败:\n${result.stderr}`);
  }
  return result.stdout;
};

/**
 * 改动的文件:已提交的差异 + 工作区差异 + **未跟踪**的文件。
 *
 * 未跟踪也要算:新加一个文件落在没登记的目录里,正是这张表最该红的那种情况。
 */
const changedFiles = (since: string): readonly string[] => {
  const tracked = git(["diff", "--name-only", "--no-renames", since]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const all = `${tracked}\n${untracked}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return [...new Set(all)];
};

/**
 * 未覆盖登记。格式:`<路径>  # <为什么现在不测>`,空行与 `#` 开头为注释。
 *
 * 它是**负债表**,不是清零目标(ADR-0038):能做到的是让债务可见,做不到的是让债务为零。
 * 登记不校验"理由是假的"——那要人判断;校验的是路径真实存在,否则这张表自己会腐烂。
 */
const loadDebt = (): ReadonlyMap<string, string> => {
  const path = join(repoRoot, DEBT_PATH);
  if (!existsSync(path)) return new Map();
  const debt = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const [file, ...rest] = text.split("#");
    const target = (file ?? "").trim();
    const why = rest.join("#").trim();
    if (target !== "") debt.set(target, why);
  }
  return debt;
};

/** 本次 `test:related` 真的跑了多少条用例。读不到就当未知,不拿未知当绿。 */
const relatedTestCount = (): number | undefined => {
  try {
    const report = JSON.parse(readFileSync(join(repoRoot, JSON_REPORT), "utf8")) as {
      numTotalTests?: number;
    };
    return report.numTotalTests;
  } catch {
    return undefined;
  }
};

/** 把改动递给依赖图;失败的两种含义不同,红的时候要分开说。 */
const runRelated = (args: readonly string[]): number => {
  rmSync(join(repoRoot, JSON_REPORT), { force: true });
  process.stdout.write(`\n=== test:related ===\n`);
  const result = spawnSync(process.execPath, ["--run", "test:related", "--", ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status === 0) return 0;
  process.stderr.write(
    `\n依赖图没有选中任何测试,或选中的测试红了(退出码 ${String(result.status)})。\n` +
      "「没有测试观测到这些改动」与「测试红了」不是一回事:前者说明这块代码没有判据。\n",
  );
  return result.status ?? 1;
};

/** 构建那一步的输出只关心成败,成功时不刷屏(它平时是静默的)。 */
const runScriptVerbose = (script: string): number => {
  const result = spawnSync(process.execPath, ["--run", script], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if ((result.status ?? 1) !== 0) return result.status ?? 1;
  return 0;
};

const runScript = (script: string): number => {
  process.stdout.write(`\n=== ${script} ===\n`);
  const result = spawnSync(process.execPath, ["--run", script], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return result.status ?? 1;
};

const main = (argv: readonly string[]): number => {
  const options = parseArgs(argv);
  const manifest = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };

  // ── 收口:一条命令,与 CI 同一条定义 ──
  if (options.full) {
    process.stdout.write(`收口(与 CI 同一条定义):${FULL_CHAIN.join(" + ")}\n`);
    for (const script of FULL_CHAIN) {
      if (manifest.scripts[script] === undefined) {
        process.stderr.write(`收口链里有不存在的脚本:${script}\n`);
        return 1;
      }
      const status = runScript(script);
      if (status !== 0) {
        process.stderr.write(`\n${script} 失败(退出码 ${String(status)})\n`);
        return status;
      }
    }
    return 0;
  }

  const files = changedFiles(options.since);
  const workspaces = workspacesOf(repoRoot);

  const decideNow = (): ReturnType<typeof decide> =>
    decide({
      paths: files,
      workspaces,
      exists: (path) => existsSync(join(repoRoot, path)),
    });

  let decision: ReturnType<typeof decide>;
  try {
    decision = decideNow();
    /**
     * 产物不在盘上时**先增量构建再问一次**,而不是直接退回全量。
     *
     * 新建一个文件永远"没构建过",若把这种情况判成"静态映射失效"并退回全量,那么每加一个文件
     * 就要跑 70 秒——分层就废了。`tsc -b` 增量是半秒级(`vitest.global-setup.ts` 反正也要跑
     * 一次),先构建能把"新文件"变回"可映射"。
     */
    if (decision.notBuilt.length > 0) {
      process.stdout.write(
        `产物不在盘上(${String(decision.notBuilt.length)} 个),先增量构建再算:pnpm run build\n`,
      );
      const status = runScriptVerbose("build");
      if (status !== 0) return status;
      decision = decideNow();
    }
  } catch (error) {
    if (error instanceof UnregisteredPathError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  /**
   * 观测量到的那一半:某个改动被哪些测试文件**读到**过。
   *
   * 这是依赖图看不见的那一类——`rulesets/*.json`、`maps/*.yaml`、wasm、入库的 runtime 产物。
   * 它们由图的话,改一条规则取值只会选中"import 了这个 JSON 的模块",而那通常是零个测试。
   */
  const observedByInput = invert(loadInputsMap(repoRoot));
  const observedTests = new Set<string>();
  for (const path of files) {
    for (const test of observedByInput.get(path) ?? []) observedTests.add(test);
  }

  // 名字先验一遍:拼错的名字在这里红,而不是等 spawn 时报「Unknown script」。
  for (const script of [...decision.scripts, "test:related"]) {
    if (manifest.scripts[script] === undefined) {
      process.stderr.write(`改动半径指向了不存在的脚本:${script}\n`);
      return 1;
    }
  }

  // 依据行:每个改动一条,**算出来的**与**看出来的**分开写(ADR-0038 §四)。
  const evidence = files.map((path) => {
    const observed = observedByInput.get(path)?.size ?? 0;
    const observedText = observed === 0 ? "" : `,观测命中 ${String(observed)} 个测试文件`;
    const outputs = buildOutputsOf(path, workspaces);
    if (outputs.length > 0 || isSourceFile(path, workspaces)) {
      return `  ${path}\n    → 依赖图(computed: 源码 + ${String(outputs.length)} 个产物${observedText})`;
    }
    const rule = decision.hits.find((hit) => path === hit.area || path.startsWith(`${hit.area}/`));
    const suites = rule?.suites ?? [];
    const tail =
      suites.length === 0 ? "无测试依赖(static: 门禁覆盖)" : `suites: ${suites.join(", ")}`;
    return `  ${path}\n    → ${tail}${observedText}`;
  });

  const runGraph = !decision.scripts.includes("test:all");
  const graphArgs = [...decision.graphFiles, ...[...observedTests].sort()];
  const total = decision.scripts.length + (runGraph && graphArgs.length > 0 ? 1 : 0);
  process.stdout.write(
    `改动半径(对比 ${options.since},${String(files.length)} 个文件,${String(total)} 步):\n` +
      `${evidence.join("\n")}\n` +
      decision.scripts.map((script) => `  ⇒ ${script}\n`).join(""),
  );
  if (decision.notBuilt.length > 0) {
    process.stdout.write(
      `  ! 产物不在盘上(${decision.notBuilt.slice(0, 3).join(", ")}${decision.notBuilt.length > 3 ? " …" : ""}),` +
        "静态映射失效,已退回全量\n",
    );
  }
  if (runGraph && graphArgs.length > 0) {
    process.stdout.write(
      `  ⇒ test:related(computed: ${String(decision.graphFiles.length)} 个文件交给依赖图 + ` +
        `observed: ${String(observedTests.size)} 个测试文件)\n`,
    );
    process.stdout.write(`  (产物路径交给图是为了跨包的边;源码路径交给图是为了包内)\n`);
  }
  if (options.print) return 0;

  const debt = loadDebt();
  /**
   * 改了、但没有任何东西在看着它的路径。
   *
   * 代码的答案要等图跑完才知道(有没有测试 import 它),行为输入的答案现在就有(没有任何测试
   * 读过它)。两者共用一张债务表,理由相同:能看见的债好过看不见的零。
   */
  const unobserved = files.filter(
    (path) =>
      observedByInput.get(path) === undefined &&
      !debt.has(path) &&
      mustObserve({ path, workspaces }),
  );
  const unobservedInputs = unobserved.filter((path) => !isSourceFile(path, workspaces));

  for (const script of decision.scripts) {
    const status = runScript(script);
    if (status !== 0) {
      process.stderr.write(`\n${script} 失败(退出码 ${String(status)})\n`);
      return status;
    }
  }

  // 行为输入没有 import 边,图对它是瞎的:观测为空就是没有判据,不必等图。
  if (unobservedInputs.length > 0) return reportUnobserved(unobservedInputs, "input");

  if (runGraph && graphArgs.length > 0) {
    const status = runRelated(graphArgs);
    if (status !== 0) return status;
  }

  /**
   * 代码的答案必须**逐个问**,不能拿整条链的结论代答。
   *
   * 「`test:all` 跑过了」不等于「有人看着这个文件」:全量跑的是既有用例,一个没人 import 的新
   * 模块在它里面照样是零覆盖。这一步就是 ADR-0038 §六 那条红线的落点,代价是每个未观测文件
   * 一次 `test:related`(约 2 秒),而"未观测文件"本来就该是少数。
   */
  const blindCode = unobserved.filter((path) => isSourceFile(path, workspaces));
  const gaps: string[] = [];
  for (const path of blindCode) {
    const outputs = buildOutputsOf(path, workspaces);
    rmSync(join(repoRoot, JSON_REPORT), { force: true });
    const result = spawnSync(
      process.execPath,
      [
        "--run",
        "test:related",
        "--",
        path,
        ...outputs.filter((output) => existsSync(join(repoRoot, output))),
      ],
      { cwd: repoRoot, stdio: "ignore" },
    );
    const ran = relatedTestCount();
    // 读不到报告时不判红:未知既不是绿也不是红,而这条判据只负责"确知为零"。
    if (ran === 0) gaps.push(path);
    else if (ran === undefined && result.status !== 0) gaps.push(path);
  }
  if (gaps.length > 0) return reportUnobserved(gaps, "code");

  process.stdout.write(`\n按改动半径要跑的都绿了。收口用 \`pnpm run check -- --full\`。\n`);
  return 0;
};

const reportUnobserved = (paths: readonly string[], kind: "code" | "input"): number => {
  const tail =
    kind === "code"
      ? `这是 agent 最大的盲区:代码改了、判据没动。`
      : `这是行为输入,没有 import 边可问——观测为空就是真的没有测试读过它。\n` +
        `（若它其实被读到了,说明 map 过期:重录一遍比对,pnpm run observe:inputs。）`;
  process.stderr.write(
    `\n改动没有被任何测试观测到(computed 与 observed 都是空的):\n` +
      `${paths.map((path) => `  ${path}`).join("\n")}\n\n` +
      `${tail}\n两条出路,选一条:\n` +
      `  1. 补一个用例,让它真的执行到这块;\n` +
      `  2. 在 ${DEBT_PATH} 里登记一行并写清为什么现在不测:\n` +
      `     ${paths[0] ?? "<路径>"}  # 为什么现在不测\n`,
  );
  return 1;
};

/**
 * 薄壳:只有「自己被当成命令跑」时才执行,被 import 时**无副作用**(ADR-0038 长期约束一)。
 *
 * 这条守卫不是形式主义:`ci.test.ts` 会 `import` 本文件去读 `FULL_CHAIN`,没有它,一次 import
 * 就等于在这个进程里跑一遍整条链——而那条链里又有 import 本文件的测试,于是无限递归。
 * 用 `argv[1]` 比路径,不用 `import.meta.main`(Node 22 上是 `undefined`,CI 用的是 22)。
 */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
