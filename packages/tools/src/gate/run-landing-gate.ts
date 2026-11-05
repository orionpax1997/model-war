/**
 * 验收落点门禁(`check:landings`)的入口:读文档与真源投影,跑纯函数,打印违规,按结果设退出码。
 *
 * 用 `node packages/tools/src/gate/run-landing-gate.ts` 直接跑——本包以源码形式由 Node 的类型擦除
 * 执行,不产出 dist、也不设 bin(hld §3.2),因此本包内部的相对 import 一律写 `.ts` 扩展名。
 *
 * **零构建**:只 import node 内置模块与同包的纯模块(`landing-gate.ts` / `vacuous.ts`),
 * 不 import `@model-war/schema`,更不 import `apps/cli`(包图方向禁)——判据要的四处真源
 * (落点表、脚本清单、子命令登记、版本库跟踪状态)全部按**文本 / git** 读:
 *
 * - `docs/hld.md` 是落点表的家(spec 明文否决把它变成生成物);
 * - `package.json` 的 `scripts` 是命名脚本清单;
 * - `apps/cli/src/commands.ts` 的**源码文本**是子命令登记表(跨包 import 不合法,读文本是唯一的路);
 * - `git ls-files -- <path>` 是「这个路径进没进版本库」的唯一判据。
 *
 * **防假绿**:§11 抽到 0 行、落点里认出 0 个 token、子命令抽出 0 个名字、文档扫到 0 份、
 * 脚本清单读成 0 条——五条都按失败处理。此时报「干净」什么也没断言(空转检测的共享件
 * 在 `gate/vacuous.ts`)。
 *
 * 退出码是这个门禁对外的全部契约:0 = 干净,1 = 有违规(或门禁本身失效)。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LANDING_DOC,
  checkLandings,
  commandNamesFrom,
  type LandingDoc,
  type LandingWorld,
  type TrackedResult,
} from "./landing-gate.ts";
import { vacuousReason } from "./vacuous.ts";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const MANIFEST = "package.json";

/** 子命令登记表的真源文件:读它的源码文本,不跨包 import(hld §3.2)。 */
const COMMANDS_SOURCE = "apps/cli/src/commands.ts";

/**
 * 文档扫描面:`docs/**` 与三份根文档。
 *
 * **`.pi/skills` 不在范围里**:那是外部技能文档,它引用的命令属于它自己的仓库,
 * 拿本仓的脚本清单去判它只会误报(实测:那里有一条 `pnpm run exercise`)。
 */
const DOC_ROOTS = ["docs", "CONTEXT.md", "README.md", "AGENTS.md"] as const;

const read = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

/**
 * 递归收文档。根层的 `CONTEXT.md` 一类是文件、`docs` 是目录,两者都收——
 * 少收一种的后果是「文档里错指脚本名」在那半边永久失明。
 */
const collectDocs = (): readonly LandingDoc[] => {
  const paths: string[] = [];
  const visit = (relative: string): void => {
    const absolute = join(repoRoot, relative);
    if (!existsSync(absolute)) {
      return;
    }
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        visit(`${relative}/${entry.name}`);
      }
      return;
    }
    if (relative.endsWith(".md")) {
      paths.push(relative);
    }
  };
  for (const root of DOC_ROOTS) {
    visit(root);
  }
  return paths.map((path) => ({ path, text: read(path) }));
};

type GitResult = { readonly status: number; readonly output: string };

/**
 * 跑一条 git 命令,工作目录钉在仓库根。
 *
 * 与 `generate/run-drift-gate.ts` 同一个原语:git 自己出错不是「路径不存在」,
 * 调用方会把非 0 退出码单独报成「检查失效」。
 */
const git = (args: readonly string[]): GitResult => {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
};

/** 路径的版本库跟踪状态:有输出 = 被跟踪;git 非零退出 = 检查失效,不是「不存在」。 */
const trackedState = (path: string): TrackedResult => {
  const result = git(["ls-files", "--", path]);
  if (result.status !== 0) {
    return { kind: "git-error", detail: `退出码 ${String(result.status)}:${result.output.trim()}` };
  }
  return result.output.split("\n").some((line) => line.trim() !== "")
    ? { kind: "tracked" }
    : { kind: "untracked" };
};

const entryCount = (path: string): number => {
  try {
    return readdirSync(join(repoRoot, path)).length;
  } catch {
    // 不存在 / 不是目录:按「空的」判。存在性由 `fileExists` 那一支单独报,这里不重复措辞。
    return 0;
  }
};

const main = (): number => {
  const manifest = JSON.parse(read(MANIFEST)) as { scripts?: Record<string, string> };
  const scripts = Object.keys(manifest.scripts ?? {});
  const cliNames = commandNamesFrom(read(COMMANDS_SOURCE));
  const docs = collectDocs();

  const world: LandingWorld = {
    scripts,
    cliNames,
    fileExists: (path) => existsSync(join(repoRoot, path)),
    dirEntryCount: entryCount,
    trackedState,
  };

  const report = checkLandings({ hldText: read(LANDING_DOC), docs, world });

  // 五条计数口各自来自共享的空转检测:`0 行`、`0 个 token`、`0 个子命令名`、`0 份文档`、
  // `0 条脚本`里任何一条成立时,「无违规」都不再是「干净」,而是「什么也没查」。
  const vacuous = [
    vacuousReason(report.stats.rows, { subject: "验收落点行", scope: `${LANDING_DOC} §11` }),
    vacuousReason(report.stats.tokens, {
      subject: "可执行落点 token",
      scope: `${LANDING_DOC} §11`,
    }),
    vacuousReason(report.stats.cliNames, {
      subject: "子命令名",
      scope: `${COMMANDS_SOURCE} 的 COMMANDS[].name`,
    }),
    vacuousReason(report.stats.docs, { subject: "被扫的文档", scope: DOC_ROOTS.join("、") }),
    vacuousReason(scripts.length, { subject: "命名脚本", scope: `${MANIFEST} 的 scripts` }),
  ].filter((reason) => reason !== "");
  if (vacuous.length > 0) {
    process.stderr.write(`验收落点门禁:${vacuous.join("")}\n`);
    return 1;
  }

  for (const finding of report.findings) {
    process.stdout.write(`验收落点门禁不通过 [${finding.where}]:${finding.detail}\n`);
  }
  const scale =
    `${String(report.stats.rows)} 行落点、${String(report.stats.tokens)} 个可执行 token、` +
    `${String(report.stats.docs)} 份文档、${String(report.stats.cliNames)} 个 CLI 子命令、` +
    `${String(scripts.length)} 个命名脚本`;
  process.stdout.write(
    report.findings.length === 0
      ? `验收落点门禁:检查 ${scale},无违规。\n`
      : `验收落点门禁:检查 ${scale},${String(report.findings.length)} 处违规。\n`,
  );
  return report.findings.length === 0 ? 0 : 1;
};

process.exitCode = main();
