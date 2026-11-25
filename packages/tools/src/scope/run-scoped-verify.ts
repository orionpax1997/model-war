/**
 * `verify:scoped --since=<ref> [--print]`:按**改动半径**选出该跑什么,然后按顺序跑。
 *
 * 与 `verify` 的分工:`verify` 是**收口**(一次要对,所以跑全);本脚本回答「这次改动该付多少」。
 * 两者的关系是「`verify` ⊇ `verify:scoped`」——选出来的永远是全量的子集,合并前仍要跑全量。
 *
 * 三件事由 ADR-0038 定下:
 *
 * 1. **代码改动交给依赖图**(`vitest related`),并对每条改动打印依据行。图比人写的表更准,
 *    但前提是拿**产物路径**去问:跨包边指向 `dist/`,而 `git diff` 给的是 `src/`。
 * 2. **图看不见的交给表**(数据文件、仓库事实、`gates` project),表只在这个范围内是判据。
 * 3. **说不清就红**:既映射不到产物也没有表规则的路径直接红;产物不在盘上也红(退回全量)。
 *
 * 用法:
 *
 * ```
 * pnpm run verify:scoped                    # 对比 main
 * pnpm run verify:scoped -- --since=HEAD~3  # 对比某个提交
 * pnpm run verify:scoped -- --print         # 只打印计划,不跑
 * ```
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOutputsOf, workspacesOf } from "./build-outputs.ts";
import { UnregisteredPathError, decide } from "./change-radius.ts";
import { invert, loadInputsMap } from "./test-inputs.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

interface Options {
  readonly since: string;
  readonly print: boolean;
}

const parseArgs = (argv: readonly string[]): Options => {
  const since = argv.find((arg) => arg.startsWith("--since="))?.slice("--since=".length);
  return {
    since: since === undefined || since === "" ? "main" : since,
    print: argv.includes("--print"),
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

const main = (): number => {
  const options = parseArgs(process.argv.slice(2));
  const files = changedFiles(options.since);
  const workspaces = workspacesOf(repoRoot);

  let decision: ReturnType<typeof decide>;
  try {
    decision = decide({
      paths: files,
      workspaces,
      exists: (path) => existsSync(join(repoRoot, path)),
    });
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

  const manifest = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  // 名字先验一遍:拼错的名字在这里红,而不是等 spawn 时报「Unknown script」。
  for (const script of [...decision.scripts, "test:related"]) {
    if (manifest.scripts[script] === undefined) {
      process.stderr.write(`改动半径指向了不存在的脚本:${script}\n`);
      return 1;
    }
  }

  // 依据行:每个改动一条,说明它走的是图的半边还是表的半边。
  const evidence = files.map((path) => {
    const outputs = buildOutputsOf(path, workspaces);
    if (outputs.length > 0) {
      return `  ${path}\n    → 依赖图(源码 + ${String(outputs.length)} 个产物)`;
    }
    const rule = decision.hits.find((hit) => path === hit.area || path.startsWith(`${hit.area}/`));
    const suites = rule?.suites ?? [];
    return `  ${path}\n    → ${suites.length === 0 ? "无测试依赖(静态门禁覆盖)" : suites.join(", ")}`;
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
  if (decision.graphFiles.length > 0 && !decision.scripts.includes("test:all")) {
    process.stdout.write(
      `  ⇒ test:related(${String(decision.graphFiles.length)} 个文件交给依赖图)\n`,
    );
  }
  if (options.print) return 0;

  for (const script of decision.scripts) {
    process.stdout.write(`\n=== ${script} ===\n`);
    const result = spawnSync(process.execPath, ["--run", script], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.stderr.write(`\n${script} 失败(退出码 ${String(result.status)})\n`);
      return result.status ?? 1;
    }
  }

  // 全量已经跑过时不再问图:那是它的子集。
  if (runGraph && graphArgs.length > 0) {
    process.stdout.write(`\n=== test:related ===\n`);
    const result = spawnSync(process.execPath, ["--run", "test:related", "--", ...graphArgs], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.stderr.write(
        `\n依赖图没有选中任何测试,或选中的测试红了(退出码 ${String(result.status)})。\n` +
          "「没有测试观测到这些改动」与「测试红了」不是一回事:前者说明这块代码没有判据,\n" +
          "要么补用例,要么在 coverage-debt.txt 里登记一行并写清为什么现在不测。\n",
      );
      return result.status ?? 1;
    }
  }

  process.stdout.write(`\n按改动半径要跑的都绿了。合并前仍要跑全量:\`pnpm run verify\`。\n`);
  return 0;
};

process.exitCode = main();
