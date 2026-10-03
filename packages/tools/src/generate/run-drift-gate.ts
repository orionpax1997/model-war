/**
 * 生成物漂移检查的入口:按注册表逐件判定「入库的生成物 = 真源现在会产出的东西」,
 * 打印结果,按结果设退出码。
 *
 * 用 `node packages/tools/src/generate/run-drift-gate.ts` 直接跑(同 `gate/run-no-float-gate.ts`:
 * 本包以源码形式由 Node 的类型擦除执行,不产出可执行 JS,因此内部相对 import 一律写 `.ts` 扩展名)。
 *
 * **为什么它需要一次构建、所以只挂在全量门禁末尾而不在快门禁里**:它 import 注册表,注册表
 * import 真源包,生产函数拿到的名字来自 `packages/schema/dist`。`check:types` 里已经有 `tsc -b`,
 * 这道检查搭它的车、自己不再构建;`check:quick` 因此保持零构建(hld §3.2、ADR-0003)。
 *
 * ── 三段判定:前一段管内容,后两刀管版本库 ──
 *
 * ① **一致性**:`produce()` 的输出与工作树里那个文件逐字节比。抓「改了真源没重跑」(文件停在
 *    上一版)与「生成物被手改 / 被删」(文件不再是真源现在会产出的东西)。
 * ② **第一刀(差异)**:`git diff --quiet HEAD -- <生成物路径>`。抓「生成了但没提交」。
 *    **限定在生成物路径上**,是为了不误报:开发者工作树里别的未提交内容与这道检查无关,
 *    而裸的 `git diff --exit-code` 会把它们一并报出来,于是报错指向错误的地方。
 *    取 `HEAD` 而不是索引,是为了把「已 `git add` 但没提交」也算进去。
 * ③ **第二刀(状态)**:`git ls-files -- <生成物路径>`,**没被索引跟踪就算失败**。抓
 *    「新增生成物没进版本库」——① 与 ② 都看不见未跟踪文件,而本 feature 的第一件生成物正是新增的,
 *    它若没被提交,两刀差异检查依然全绿。被 `.gitignore` 命中的生成物同样按失败处理:
 *    它在 `status` 与 `ls-files` 里连痕迹都不留,却同样进不了干净克隆。
 *
 * 路径清单来自 `GENERATED_ARTIFACTS` 本身、**不另存一份**:注册表加一件生成物,三段判定自动跟着覆盖。
 * 反过来,这也是为什么 ② 的路径限定不能写成「仓库根」——限定一旦放宽,误报防护就没了。
 *
 * 退出码是这道检查对外的全部契约:0 = 无漂移,1 = 有漂移(或检查自身失效)。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { GENERATED_ARTIFACTS } from "./registry.ts";

/** 本文件在 `<repo>/packages/tools/src/generate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

type GitResult = { readonly status: number; readonly output: string };

/**
 * 跑一条 git 命令,工作目录钉在仓库根。
 *
 * git 自己出错(不是「有差异」)时按**检查失效**处理:折算成「干净」是一条会一直绿的假门禁,
 * 折算成「有漂移」则是把工具故障报成代码问题。两者都白费,所以调用方看到非 0 非 1 就走失败。
 */
const git = (args: readonly string[]): GitResult => {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
};

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const main = (): number => {
  const findings: string[] = [];

  if (GENERATED_ARTIFACTS.length === 0) {
    // 注册表空 = 没有任何一件生成物要查。此时报「无漂移」是一条永远全绿、什么也没断言的门禁,
    // 与 `run-no-float-gate.ts` 里「一个文件都没读到按失败处理」同一条纪律。
    process.stderr.write("生成物漂移检查:注册表是空的,没有可检查的生成物,按失败处理。\n");
    return 1;
  }

  const paths = GENERATED_ARTIFACTS.map((artifact) => artifact.path);

  // ① 一致性:真源现在会产出的东西,与工作树里那个文件是不是同一份。
  for (const artifact of GENERATED_ARTIFACTS) {
    const expected = artifact.produce();
    let actual: string;
    try {
      actual = readFileSync(resolve(repoRoot, artifact.path), "utf8");
    } catch {
      findings.push(
        `${artifact.id}:生成物不存在(${artifact.path})。跑 \`pnpm run generate\` 并提交。`,
      );
      continue;
    }
    if (actual !== expected) {
      findings.push(
        `${artifact.id}:生成物与真源不一致(${artifact.path})——真源改了没重跑,或生成物被手改。` +
          `跑 \`pnpm run generate\` 后提交。`,
      );
    }
  }

  // ② 第一刀:对 HEAD 的差异,只限定在生成物路径上。
  const diff = git(["diff", "--quiet", "HEAD", "--", ...paths]);
  if (diff.status === 1) {
    const detail = git(["diff", "--no-color", "HEAD", "--", ...paths]);
    findings.push(`生成物已生成但未提交,对 HEAD 的差异如下。\n${detail.output.trimEnd()}`);
  } else if (diff.status !== 0) {
    process.stderr.write(
      `生成物漂移检查:git diff 失败(退出码 ${diff.status}),检查失效。\n${diff.output}`,
    );
    return 1;
  }

  // ③ 第二刀:生成物在不在版本库里(以索引为准)。未跟踪、被 rm --cached、被忽略,都在这里现形。
  const listed = git(["ls-files", "--", ...paths]);
  if (listed.status !== 0) {
    process.stderr.write(
      `生成物漂移检查:git ls-files 失败(退出码 ${listed.status}),检查失效。\n${listed.output}`,
    );
    return 1;
  }
  const tracked = new Set(lines(listed.output));
  const untracked = paths.filter((path) => !tracked.has(path));

  if (untracked.length > 0) {
    const ignored = git(["check-ignore", "--no-index", "--", ...untracked]);
    if (ignored.status > 1) {
      process.stderr.write(
        `生成物漂移检查:git check-ignore 失败(退出码 ${ignored.status}),检查失效。\n${ignored.output}`,
      );
      return 1;
    }
    // `--no-index`:断言的是忽略规则本身,而不是索引里的状态——否则一个已被跟踪的生成物
    // 永远「看起来没被忽略」,这条分支就成了永远走不到的死代码。
    const ignoredPaths = new Set(lines(ignored.output));
    for (const path of untracked) {
      const reason = ignoredPaths.has(path)
        ? "被 .gitignore 命中,干净克隆里不会有它"
        : "未被 git 跟踪(跑过生成器但没 git add)";
      findings.push(`${path}:生成物不在版本库里——${reason}。`);
    }
  }

  for (const finding of findings) {
    process.stdout.write(`生成物漂移检查:${finding}\n`);
  }
  const summary =
    findings.length === 0
      ? `生成物漂移检查:注册 ${GENERATED_ARTIFACTS.length} 件,无漂移。`
      : `生成物漂移检查:注册 ${GENERATED_ARTIFACTS.length} 件,${findings.length} 处漂移。`;
  process.stdout.write(`${summary}\n`);
  return findings.length === 0 ? 0 : 1;
};

process.exitCode = main();
