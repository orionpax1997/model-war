/**
 * `verify:scoped --since=<ref>`:按**改动半径**选出该跑哪些命名脚本,然后按顺序跑。
 *
 * 与 `verify` 的分工:`verify` 是**收口**(一次要对,所以跑全);本脚本是**按改动选范围**
 * (改散文的人不该付 VM 整场的账)。两者的判据关系是「`verify` ⊇ `verify:scoped`」——
 * 选出来的永远是全量的子集,合并前仍然要跑全量。
 *
 * ── 三条不能让步的性质 ──
 *
 * 1. **未登记的路径是红,不是跳过。** 静默跳过等于给一个假绿,那比没有更坏。
 * 2. **只调命名脚本**(`node --run <name>`),不内联命令:链路里出现的每一个东西仍然能在
 *    `package.json` 里找到、能单独跑、能被 `test-layers.test.ts` 盯住。
 * 3. **顺序稳定**:`ALWAYS` 先跑(便宜、失败快),其余按 `SUITES` 的固定顺序,于是同样的改动
 *    每次得到同样的序列,日志可比。
 *
 * 用法:
 *
 * ```
 * pnpm run verify:scoped                    # 对比 main(main 上就是工作区改动)
 * pnpm run verify:scoped -- --since=HEAD~3  # 对比某个提交
 * pnpm run verify:scoped -- --print         # 只打印计划,不跑
 * ```
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UnregisteredPathError, planFor } from "./change-radius.ts";

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

  let scripts: readonly string[];
  try {
    scripts = planFor(files).scripts;
  } catch (error) {
    if (error instanceof UnregisteredPathError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const manifest = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };
  // 名字先验一遍:拼错的名字在这里红,而不是等 spawn 时报「Unknown script」。
  for (const script of scripts) {
    if (manifest.scripts[script] === undefined) {
      process.stderr.write(`change-radius 指向了不存在的脚本:${script}\n`);
      return 1;
    }
  }

  process.stdout.write(
    `改动半径(对比 ${options.since},${String(files.length)} 个文件):\n` +
      scripts.map((script) => `  → ${script}\n`).join(""),
  );
  if (options.print) return 0;

  for (const script of scripts) {
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
  process.stdout.write(`\n按改动半径要跑的都绿了:${scripts.join(" → ")}\n`);
  process.stdout.write("合并前仍要跑全量:`pnpm run verify`。\n");
  return 0;
};

process.exitCode = main();
