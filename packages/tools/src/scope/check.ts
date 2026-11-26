/**
 * `check [--full] [--since=<ref>] [--print]`:agent 面前**唯一**的入口。
 *
 * 没有档位,没有「这次算哪一档」的判断留给人或模型:
 *
 * ```
 * pnpm run check            # 改完就跑:按改动半径选,只跑与这次改动有关的东西
 * pnpm run check -- --full  # 收口:与 CI 同一条定义(`FULL_CHAIN`),再补齐默认计划里链没覆盖的部分
 * ```
 *
 * ── 基准默认是**工作区**(`--since=HEAD`),不是 `main` ──
 *
 * 这条命令在编辑循环里被反复跑,所以默认回答的是“我刚改的这几行要不要跑东西”。拿分叉点当
 * 基准的代价是**整条变更流**都在里面:实测一条 66 个文件的流把 `test:gates` / `test:all` 拖进来,
 * 四分钟;同一棵树上只比工作区是五秒。
 *
 * 分支级的口径没丢,它只是变显式:本地 `--since=main`,CI 用 `--since=origin/<base>`
 * (`.github/workflows/fast.yml`)。**代价也得说清:已提交的改动不在默认判定里**,所以改动集为
 * 空时会把“什么都没判定”与“改完了”分开报——两者在输出上是两回事。
 *
 * 探针并发跑(`PROBE_CONCURRENCY`),但结论按文件顺序重放:红的处方指向具体文件,
 * “先报哪个”不能靠完成次序。
 *
 * 三源合流由 ADR-0038 定下,优先级从硬到软:
 *
 * 1. **代码改动交给依赖图**(`vitest related`)。前提是拿**产物路径**去问:跨包边指向 `dist/`,
 *    而 `git diff` 给的是 `src/`。
 * 2. **读盘类输入交给观测 map**(`test-inputs/inputs.json`):`rulesets/`、`maps/`、wasm、入库
 *    的 runtime 产物被读,不被 import,图对它们没有边。
 * 3. **仓库事实交给表**(`RADIUS`),表只在这个范围内是判据。
 *
 * 五条红得方向明确,都是「错要红,不能沉默」的形状:
 *
 * - 说不清:既映射不到产物也没有表规则的路径 → 红(它的默认表现是少跑)。
 * - 少跑:`test:all` 被选中就不再单独跑它的子集;产物不在盘上则先增量构建,仍缺才退回全量。
 * - 无人观测:改完没有任何**能证明这块行为的测试候选**(零候选 / 只有结构测试 / 全 skip /
 *   观测为空)→ 红,并给出两条出路(补用例,或登记 `coverage-debt.txt`)。这是 agent 最大的
 *   盲区,而原来的系统在它改完之后什么都不说。
 * - 问不出用例数:探针报告缺失 / 不可解析 → 红。**未知不是绿**,而且本仓库的 vitest 配置带
 *   `passWithNoTests: true`,只看退出码会把"一条没选中"读成"通过"。
 * - 判据本身过期:入库观测快照的内容指纹(`WATCHED_FILES` 的内容)与现在对不上 → 红,并在
 *   消息里给两个指纹与两条重录命令。旧的 map 不再被当成判据:它的失效方向是少记,
 *   而少记与“没人读”在输出上是同一句话。
 *
 * 有一处口径例外,它只对**删除**开:状态 `D` 的路径不探。`vitest related` 问的是一个已不存在的
 * 文件,答不出任何东西;而探针这一层只承认"确知为零"与"确知跑过",于是每一次删文件都会拿到
 * 一条假红。删除要保的性质是"没带走没人发现的依赖",它由 `tsc -b` 与全量测试兜。判据收在
 * `probeTargets` 一个纯函数里:只放行 `D`(`M`/`A`/`R` 的未观测仍然红),而且**打印说明**,
 * 不静默跳过。
 *
 * ── 计划只有一处构造 ──
 *
 * `runsFor({scripts, decision})` 是**唯一**的计划构造函数,`main` 只负责执行与打印。好处不是
 * 好看:计划于是可以在测试里对真实改动(`decide()`)算出来,再断言"收口计划收下了默认计划的
 * 每一步"——也就是 `D ⊆ F`。`--full` 不用另写一条链,它跑 `fullPlan({chain: FULL_CHAIN, runs})`:
 * 先跑链,再补链没覆盖的 extras,并打印哪些因去重被跳过(`plan.ts` 的头注说明了判据)。
 *
 * 门禁自测那一条带不带 `-t` 也是算出来的:改动落在哪几个门禁实现文件上,由 `GATES_CASES`
 * 翻成 `-t` 模式;映射不出就是整族(`runsFor` 只是把 `decision.gatesPatterns` 搬进 `RunItem`,
 * `runItem` 负责把它变成命令行上的 `-t`)。
 *
 * 一句话:**这里算的是"该跑什么",不是"行为已经被验证"**。选中的是测试候选;它断言了什么,
 * 只有它自己的失败/通过能说。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOutputsOf, isSourceFile, workspacesOf, type Workspace } from "./build-outputs.ts";
import {
  ALWAYS,
  UnregisteredPathError,
  decide,
  mustObserve,
  inRelatedPool,
  probeApplies,
  ruleFor,
  suitesFor,
  type Decision,
} from "./change-radius.ts";
import {
  GitError,
  MergeBaseError,
  computeChangeSet,
  describeChangeSet,
  gitRunIn,
  type ChangeEntry,
} from "./change-set.ts";
import { chainProjects, fullPlan, scriptProjects, type RunItem, type Scripts } from "./plan.ts";
import { probeRelatedAsync, type ProbeOutcome } from "./related-probe.ts";
import { currentFingerprint, invert, loadInputsMap, snapshotStaleMessage } from "./test-inputs.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 收口的定义。CI 与本地跑的是同一串名字,不各写一份。 */
export const FULL_CHAIN: readonly string[] = ["verify", "gate:types"];

/** 未覆盖登记的落点。路径相对仓库根,`#` 之后写为什么现在不测。 */
export const DEBT_PATH = "coverage-debt.txt";

export interface Options {
  readonly since: string;
  readonly print: boolean;
  readonly full: boolean;
}

/**
 * 探针的并发路数。
 *
 * 并发有收益,但**远不是线性**:每个探针是一个真的 vitest 进程,而「相关集合」那一步本来就是
 * CPU 活。关键是同时压住**两层**并行:这里限路数,每路自己那层由 `vitestArgs` 的
 * `--maxWorkers=2` 压住。不压第二层的时候,4 路 × 每路按核数起 worker 会在 8 核机器上把机器
 * 挠穿:慢倒还在其次,最先塌的是带超时的子进程用例——实测 7 个盲文件跑出过两次**假红**
 * (候选接 30s 超时,单跑全绿)。
 *
 * 实测(8 核,同 7 个盲文件):4 路不设上限 ~371s 且有假红 · **4 路 × 每路 2 worker 137.9s
 * 全绿** · 7 个轻文件(6 个 `src/scope` 下的)上 2 路 29.1s / 4 路 22.8s / 8 路 24.0s。
 *
 * 所以是一个常数而不是 `availableParallelism()`:两层相乘接近核数才是对的,而机器换了
 * (CI 上核更少)该变的量是每路的 worker,不是“再开几个 vitest” ——两条一起改才会出现
 * 「越快越假」的坏形状。
 */
export const PROBE_CONCURRENCY = 4;

/**
 * 探针红了要不要再问一遍:**要,且只再问一次**。
 *
 * 原因不是“怕自己错”,是并发本身会造出**假红**:`check` 同时跑 4 路探针,而每路自己还会起
 * worker;带超时的子进程用例在这种机器上最先抳不住(实测:`grid-selection.ts` 的 13 条里一条
 * 30s 超时的用例在4 路下红过一次,单跑与重跑均全绿,两轮 4 路重试也没再复现)。
 *
 * 假红比慢坏:它输出的是「先修它」,而那东西没坏。真红不会被这一下放走——红的结论要求**两
 * 次都红**;且重跑后变绿的事实不埋起来,交由调用方打印。
 *
 * 与 vitest 的 `retry` 方向相反:那个是在**同一次**运行里重试,把偶发藏进绿里;这里是先记账
 * (第一次红了),再给一次机会,并把“它红过”说出来。
 */
export const probeOnceThenRetry = async (
  probe: () => Promise<ProbeOutcome>,
): Promise<{ readonly outcome: ProbeOutcome; readonly flaky: boolean }> => {
  const first = await probe();
  if (first.kind !== "failed") return { outcome: first, flaky: false };
  const second = await probe();
  return { outcome: second, flaky: second.kind !== "failed" };
};

/** 限并发地跑完每一项。结果按**输入顺序**返回——调用方靠这个顺序决定先报哪一个红。 */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length }, () => undefined as R);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
};

/**
 * 命令行 → 选项。**纯函数,导出的唯一目的是被断言**:这里的每一条口径都红过。
 *
 * - `--` 是 `pnpm run check -- …` 的分隔符,**它自己也会进 argv**;它不是参数,不参与解析。
 * - `--since=` **最后一个赢**。写成 `find` 时第一个命中就定局,于是 `package.json` 脚本里那个
 *   写死的 `--since=main` 会永远压住命令行传进来的值——CI 上实测:PR 对着 `main` 比了 41 个提交。
 * - 空 `--since=` 退回 `main`,不解析成空串。**默认值只住这里一处**:脚本里再写一份就是第二
 *   个真源,而两份真源的分歧不会有任何红信号。
 */
export const parseArgs = (argv: readonly string[]): Options => {
  const args = argv.filter((arg) => arg !== "--");
  const since = args
    .filter((arg) => arg.startsWith("--since="))
    .at(-1)
    ?.slice("--since=".length);
  return {
    since: since === undefined || since === "" ? "HEAD" : since,
    print: args.includes("--print"),
    full: args.includes("--full"),
  };
};

/** `package.json` 的脚本表。计划代数(`plan.ts`)以它为唯一输入,所以这里只负责读。 */
const readScripts = (): Scripts =>
  (
    JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
      scripts: Scripts;
    }
  ).scripts;

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

/**
 * **唯一的计划构造函数**:一份改动半径 → 一串要执行的条目。
 *
 * 纯函数(脚本表从参数进来,不读文件、不起进程),所以测试可以对真实 `decide()` 的结果算一遍
 * 计划,再断言收口计划收下了它(`plan.test.ts` 的组合断言)。
 *
 * `observed` 是观测 map 命中的测试文件:它们进不了依赖图的图,只能作为文件路径递给
 * `vitest related`——那正是三源合流第二条腿的落点。
 *
 * `test:gates` 的 `-t` 模式原样取自 `decision.gatesPatterns`(空 = 整族)。这一层不再判断
 * "该不该缩":那是表的事,判断只在 `change-radius.ts` 里做一次。
 */
export const runsFor = (input: {
  readonly scripts: Scripts;
  readonly decision: Decision;
  readonly observed?: readonly string[];
}): readonly RunItem[] => {
  const runs: RunItem[] = input.decision.scripts.map((script) =>
    script === "test:gates"
      ? { kind: "gates", patterns: [...input.decision.gatesPatterns] }
      : { kind: "script", script },
  );
  // `test:all` 一旦被选中,依赖图要跑的文件本来就在它的池子里:再单独问一次是把同一批文件
  // 跑第二遍(`test:all` 67.7s,related 另算)。子集收掉由 `change-radius.ts` 负责,这里只管
  // "全量已选中就不要再多一条 related"。
  const runGraph = !input.decision.scripts.includes("test:all");
  const files = [...new Set([...input.decision.graphFiles, ...(input.observed ?? [])])].sort();
  if (runGraph && files.length > 0) {
    // project 集取自 `test:related` 自己的定义,而不是在这里写死 `["all"]`:脚本改了,
    // 覆盖判断要跟着改;写死就会出现"计划以为跑了 all,实际跑的是别的"。空集 = 不知道 =
    // 收口时会被当作没覆盖(多跑一次,不会少跑)。
    runs.push({
      kind: "related",
      projects: [...scriptProjects(input.scripts, "test:related")],
      files,
    });
  }
  return runs;
};

/** 给日志与断言用的一句话名字。 */
export const labelOf = (item: RunItem): string => {
  switch (item.kind) {
    case "script":
      return item.script;
    case "related":
      return `test:related(${String(item.files.length)} 个文件)`;
    case "gates":
      return item.patterns.length === 0 ? "test:gates" : `test:gates -t ${item.patterns.join("|")}`;
  }
};

/**
 * **删除没有「行为」可测。**
 *
 * 删除的路径按 T1 的语义**留在** ChangeSet 里(状态 `D`)——它必须参与选择,否则「改了什么」
 * 就少了一块。但它不能进「有没有测试候选」那道探针:`vitest related` 问的是一个**已不存在的
 * 文件**,答不出任何东西;而探针这一层只承认「确知为零」与「确知跑过」,答不出就是红。于是每一次
 * 删文件都会拿到一条假红,而假红的方向是要人补一个**删掉的文件**的用例。
 *
 * 删除要保的性质是另一条:**删掉的东西不许带走没人发现的依赖**。它不由"探针有没有选中测试"
 * 兜,而由类型检查(原来的 import 方编译失败,`tsc -b`)与全量测试(那些用例红)兜——两者都
 * 是「删了就在原地喊」的形状,不需要有人预先知道这个文件被谁用。
 *
 * 所以这里判的是**要不要探**,不是"要不要看":删除不进探针清单、不登记 gap,但**不静默**——
 * `note` 那一行必须打出来,读报的人得知道这条路径被有意放过了、以及由谁兜。
 */
export interface ProbeTargets {
  /** 要走逐文件探针的路径(`files` 减去删除的那些)。 */
  readonly probe: readonly string[];
  /** 删除的路径:不探、不登记 gap,只打印说明。 */
  readonly deleted: readonly string[];
  /** 给读报的人的那一行;没有删除时是空串。 */
  readonly note: string;
}

/**
 * 删除那几行的说明。提成纯函数是为了能断言「它真的出现了」,而不是靠读代码相信它被打印。
 *
 * 措辞要点:先说**谁被放过**(点名路径),再说**由谁兜**。只说"跳过"会让读报的人以为这块没人管;
 * 说明里必须出现 `tsc -b` 与全量测试,那才是这条口径的兜底,也是唯一的兜底。
 */
/**
 * 改名那几行的说明。与 `describeDeleted` 分开写,因为两件事**不是**同一个理由:
 *
 * - 删除:`vitest related` 对它答不出任何东西,兜底是 `tsc -b` 与全量测试;
 * - 改名:旧名字**仍要被问**(观测 map 是按旧路径记的,test:related 要靠它把改动翻成候选),
 *   变的只是「不再要求表里有一条指向它的规则」——表项随改名搬走了,而盘上没有旧名字可指。
 *
 * 只印计数不印名字的后果是:读报的人看见「重命名 1」,却不知道被放宽的是哪一个。
 */
export const describeRenamed = (entries: readonly ChangeEntry[]): string => {
  const renamed = entries.flatMap((entry) =>
    entry.from === undefined ? [] : [`${entry.from} → ${entry.path}`],
  );
  return renamed.length === 0
    ? ""
    : `改名 ${String(renamed.length)} 处:${renamed.join(", ")}\n` +
        "    旧名字不要求表里有规则(表项随改名搬走),但它照样进 `test:related` 的候选:\n" +
        "    观测 map 按旧路径记过东西,把它丢出去就是静默少跑。\n";
};

export const describeDeleted = (deleted: readonly string[]): string =>
  deleted.length === 0
    ? ""
    : `  删除 ${String(deleted.length)} 个文件:${deleted.join(", ")}\n` +
      "    它们没有「行为」可测:逐文件探针不跑、也不登记未观测。\n" +
      "    (文件已不存在,`vitest related` 对它答不出任何东西——答不出不是「没人观测」。)\n" +
      "    删掉的东西有没有带走没人发现的依赖,由 `tsc -b`(原来的 import 方编译失败)\n" +
      "    与全量测试(那批用例红)说话,不由探针有没有选中测试说话。\n";

/**
 * 一份 ChangeSet → 哪些路径要探、哪些是删除。纯函数(`main` 与测试共用一份)。
 *
 * 两条与保守方向有关的细节:
 *
 * - 同一路径若**还有**一条非删除的条目(重命名的旧侧、或同一次改动里删了又建回来),它仍有行为
 *   可问,照常探。只按"路径上出现过 D"就放过,会让"删了又建"这种改动绕开红线。
 * - 只放行**状态 `D`**:`M` / `A` / `R` 的未观测仍然红(反方向由测试钉住),否则这里就从
 *   "删除没有行为"滑成"不知道的都放过",而那正是这条红线的反面。
 */
export const probeTargets = (input: {
  readonly entries: readonly ChangeEntry[];
  readonly files: readonly string[];
}): ProbeTargets => {
  const deleted = new Set(
    input.entries.filter((entry) => entry.status === "D").map((entry) => entry.path),
  );
  for (const entry of input.entries) {
    if (entry.status !== "D") deleted.delete(entry.path);
    if (entry.from !== undefined) deleted.delete(entry.from);
  }
  const gone = input.files.filter((path) => deleted.has(path));
  return {
    probe: input.files.filter((path) => !deleted.has(path)),
    deleted: gone,
    note: describeDeleted(gone),
  };
};

/**
 * 未观测的路径 → 两半:**行为输入**与**源码**。纯函数,`main` 与测试共用一份。
 *
 * 两半走的是同一条红线(`reportUnobserved`),但两个不同的入口,而分开它们的那个反问就是
 * 「它有没有 import 边可问」:行为输入(`rulesets/`、`maps/`、wasm、入库的 runtime 产物)
 * 没有边,观测为空就是没有判据;源码有边,所以还得逐个问图。
 *
 * 为什么值得单独提出来而不是写在 `main` 里:债务表注释列举的「四类红」里有一条只在这里成立
 * (行为输入观测为空),埋在 `main` 里的后果是它被删掉时没有任何断言会响——而 `coverage-debt`
 * 是**放行**:少一类红就少一条真的判据。
 */
export const unobservedHalves = (input: {
  readonly paths: readonly string[];
  readonly workspaces: readonly Workspace[];
}): {
  readonly inputs: readonly { readonly path: string; readonly why: string }[];
  readonly code: readonly string[];
} => ({
  inputs: input.paths
    .filter((path) => !isSourceFile(path, input.workspaces))
    .map((path) => ({ path, why: "它是行为输入,而观测 map 里没有任何测试读过它" })),
  code: input.paths.filter((path) => isSourceFile(path, input.workspaces)),
});

/**
 * 探针结论 → 未观测登记(纯函数,`main` 与测试共用一份)。
 *
 * 三条能算出"这条改动没人看"的结论落在这里;`failed` / `no-report` 不在这张表里——它们
 * 不是"没有判据"而是"判据在喊"与"问不出答案",处方不同,由 `main` 各自处理。
 *
 * 结构测试那一条的措辞是判据的一部分:它断言的**不是**被改模块的行为,而是别的文件的形状
 * (依赖方向、文档归属、版本边界)。把这种文件记成"有测试候选"等于用一张图纸证明一栋楼。
 */
export const unobservedGap = (
  path: string,
  outcome: ProbeOutcome,
): { readonly path: string; readonly why: string } | undefined => {
  switch (outcome.kind) {
    case "ran":
      return undefined;
    case "structural-only":
      return {
        path,
        why: `只有结构测试被选中(${outcome.structural.join(", ")}):它们断言的是别的文件的形状,不是这块代码的行为`,
      };
    case "no-tests":
      return { path, why: "依赖图一条用例都没选中:确知为零" };
    case "all-skipped":
      return { path, why: `选中的 ${String(outcome.files.length)} 个测试文件全部 skip` };
    case "failed":
    case "no-report":
      // 这两种红有各自的处方(先修测试 / 先修探针),不走"补用例或登记债务"那条路。
      return undefined;
  }
};

const runCommand = (label: string, args: readonly string[]): number => {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
  return result.status ?? 1;
};

const runScript = (script: string): number => runCommand(script, ["--run", script]);

/** 把改动递给依赖图;失败的两种含义不同,红的时候要分开说。 */
const runRelated = (args: readonly string[]): number => {
  process.stdout.write(`\n=== test:related ===\n`);
  const result = spawnSync(process.execPath, ["--run", "test:related", "--", ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status === 0) return 0;
  process.stderr.write(
    `\n依赖图没有选中任何测试,或选中的测试红了(退出码 ${String(result.status)})。\n` +
      "「没有选中测试候选」与「测试红了」不是一回事:前者说明这块代码没有判据。\n",
  );
  return result.status ?? 1;
};

const runItem = (item: RunItem): number => {
  switch (item.kind) {
    case "script":
      return runScript(item.script);
    case "related":
      return runRelated(item.files);
    case "gates":
      // 门禁自测的子集:`-t` 是 vitest 的 testNamePattern,模式为空表示整族。
      return item.patterns.length === 0
        ? runScript("test:gates")
        : runCommand(`test:gates -t ${item.patterns.join("|")}`, [
            "--run",
            "test:gates",
            "--",
            "-t",
            item.patterns.join("|"),
          ]);
  }
};

const main = async (argv: readonly string[]): Promise<number> => {
  const options = parseArgs(argv);
  const scripts = readScripts();
  const workspaces = workspacesOf(repoRoot);

  // ── 观测快照还能不能当判据:过期即红,而且**不继续用旧 map** ──
  // 顺序是判据的一部分:先判快照,再谈"有没有观测到"。否则旧 map 的少记会被读成
  // "没人读它",而那些路径恰好是行为输入——两种红混成一条,修的地方也看不出来。
  const map = loadInputsMap(repoRoot);
  const stale = snapshotStaleMessage({ map, fingerprint: currentFingerprint(repoRoot) });
  if (stale !== undefined) {
    process.stderr.write(`\n${stale}`);
    return 1;
  }

  // ── 改了什么:一份规范 ChangeSet(merge-base 基准,两端都留,失败显式) ──
  let changeSet: ReturnType<typeof computeChangeSet>;
  try {
    changeSet = computeChangeSet({ run: gitRunIn(repoRoot), sinceRef: options.since });
  } catch (error) {
    // `MergeBaseError` 与 `GitError` 的消息里都写了修法;其余异常照旧抛出去。
    if (error instanceof MergeBaseError || error instanceof GitError) {
      process.stderr.write(`\n${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const files = changeSet.files;
  process.stdout.write(`${describeChangeSet(changeSet)}\n`);
  if (files.length === 0) {
    // 「基准是工作区」的直接后果:提交过的改动看不见。这不能不说话——它与“没改动”在输出上
    // 是同一句话,而两者的处方相反(一个是去干活,一个是去看分支)。
    process.stdout.write(
      `\n这次没有任何改动进判据(基准是工作区:与 \`HEAD\` 比)。\n` +
        `已提交的改动不在里面:分支级判定用 \`--since=main\`,收口用 \`pnpm run check -- --full\`。\n`,
    );
  }

  // 删除的那几条**不走探针**,也不登记未观测;但必须**打印出来**——静默跳过与"没人观测"在输出上
  // 是同一句话,而它们的处方完全相反(前者无事可做,后者要补用例)。判据与措辞都在 `probeTargets`。
  const targets = probeTargets({ entries: changeSet.entries, files });
  if (targets.note !== "") process.stdout.write(targets.note);
  // 改名的旧名字也要点名:它被放宽了(不再要求表规则),而"被放宽"必须读得出来。
  const renamedNote = describeRenamed(changeSet.entries);
  if (renamedNote !== "") process.stdout.write(renamedNote);

  const decideNow = (): ReturnType<typeof decide> =>
    decide({
      paths: files,
      workspaces,
      exists: (path) => existsSync(join(repoRoot, path)),
      // 删除的路径**没有产物可言**:它们不进 `notBuilt`(否则删一个源码文件就把计划退回全量)。
      // 口径只有一份——就在 `probeTargets` 里,这里递过去而不另算。
      deleted: targets.deleted,
      // 改名走的旧名字:不再存在,也就不该要求表里有一条指向它的规则(纯删除仍红)。
      renamedFrom: changeSet.entries.flatMap((entry) =>
        entry.from === undefined ? [] : [entry.from],
      ),
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
        `产物不在盘上(${String(decision.notBuilt.length)} 个),先增量构建再算:build\n`,
      );
      const status = runScript("build");
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
  const observedByInput = invert(map);
  const observedTests = new Set<string>();
  for (const path of files) {
    for (const test of observedByInput.get(path) ?? []) observedTests.add(test);
  }

  // ── 计划:唯一构造函数在 `runsFor`,收口计划在 `fullPlan` ──
  const runs = runsFor({ scripts, decision, observed: [...observedTests] });
  const plan = options.full
    ? fullPlan({ scripts, chain: FULL_CHAIN, runs })
    : { chain: [] as readonly string[], extras: runs };

  // 名字先验一遍:拼错的名字在这里红,而不是等 spawn 时报「Unknown script」。
  for (const item of runs) {
    const name =
      item.kind === "script"
        ? item.script
        : item.kind === "related"
          ? "test:related"
          : "test:gates";
    if (scripts[name] === undefined) {
      process.stderr.write(`改动半径指向了不存在的脚本:${name}\n`);
      return 1;
    }
  }
  for (const name of options.full ? FULL_CHAIN : []) {
    if (scripts[name] === undefined) {
      process.stderr.write(`收口链里有不存在的脚本:${name}\n`);
      return 1;
    }
  }

  // 依据行:每个改动一条,**算出来的**、**看出来的**与**表里的**分开写(ADR-0038 §四)。
  // "表里的"取 `ruleFor`——与选择用的是**同一份**归属,否则依据行会与决定对不上。
  const evidenceLines = files.map((path) => {
    const outputs = buildOutputsOf(path, workspaces);
    const computed =
      outputs.length > 0 || isSourceFile(path, workspaces)
        ? `computed: 源码 + ${String(outputs.length)} 个产物交依赖图`
        : "computed: 图没有边(不是源码,也映射不出产物)";
    const observed = observedByInput.get(path)?.size ?? 0;
    const observedText =
      observed === 0
        ? "observed: 没有测试观测到它"
        : `observed: ${String(observed)} 个测试文件观测到它`;
    const rule = ruleFor(path);
    const suites = suitesFor(path);
    const staticText =
      rule === undefined
        ? "static: 无表规则"
        : rule.fallback === true && suites.length === 0
          ? `static: ${rule.area} → 豁免(测试文件本身,交依赖图)`
          : suites.length === 0
            ? `static: ${rule.area} → 无测试族(静态门禁或本就不进判据)`
            : `static: ${rule.area} → ${suites.join(", ")}`;
    return `  ${path}\n    ${computed} · ${observedText} · ${staticText}`;
  });

  const always = decision.scripts.filter((script) => ALWAYS.includes(script));
  const radius = decision.scripts.filter((script) => !ALWAYS.includes(script));
  /**
   * 门禁自测这一行的意义:让人一眼看出 166s 的那一族这次被缩到了哪几条。
   * 不写这一行的话,`-t` 只存在于最终命令里,而 `--print` 不打印命令。
   */
  const gatesLine = decision.scripts.includes("test:gates")
    ? `  gates:    ${
        decision.gatesPatterns.length === 0
          ? "整族(没有文件级 -t 模式)"
          : `-t ${decision.gatesPatterns.join("|")}`
      }\n`
    : "";
  process.stdout.write(
    `\n选中(三源:computed 依赖图 / observed 观测 map / static 仓库事实):\n` +
      `  always:   ${always.join(", ")}\n` +
      `  radius:   ${radius.join(", ") || "—"}\n` +
      `  computed: ${String(decision.graphFiles.length)} 个文件作为测试候选交给依赖图\n` +
      `  observed: ${String(observedTests.size)} 个测试文件观测到这些运行时输入\n` +
      gatesLine +
      "  术语:上面那几族是选中的验证族,交给图的是测试候选,observed 记的是观测到的运行时输入。\n" +
      '        候选只承诺"会被执行":它断言了什么,只有它自己的失败与通过能说。\n' +
      `${evidenceLines.join("\n")}\n`,
  );
  if (decision.notBuilt.length > 0) {
    process.stdout.write(
      `  ! 产物不在盘上(${decision.notBuilt.slice(0, 3).join(", ")}` +
        `${decision.notBuilt.length > 3 ? " …" : ""}),静态映射失效,已退回全量\n`,
    );
  }

  if (options.full) {
    const covered = chainProjects(scripts, FULL_CHAIN);
    // 按**标签**比,不按对象同一性:`extras` 与 `runs` 里的条目是两批对象,`includes(item)`
    // 判的是引用。一旦 `fullPlan` 换成"构造新对象"的写法(它现在恰好直接过滤原数组),
    // 每一行都会显示成"已覆盖因而去重",而实际上一件事都没去重。
    const extraLabels = new Set(plan.extras.map(labelOf));
    const deduped = runs.filter((item) => !extraLabels.has(labelOf(item)));
    process.stdout.write(
      `\n收口计划(与 CI 同一条定义):${FULL_CHAIN.join(" + ")}\n` +
        `  链覆盖的 project:${covered.size === 0 ? "无(展开不出 project)" : [...covered].sort().join(", ")}\n` +
        `  链没覆盖的(先跑链,再补这些):${plan.extras.length === 0 ? "无" : plan.extras.map(labelOf).join(", ")}\n` +
        `  已覆盖因而去重:${deduped.length === 0 ? "无" : deduped.map(labelOf).join(", ")}\n` +
        `  执行:${[...plan.chain, ...plan.extras.map(labelOf)].join(" → ") || "无"}\n`,
    );
  } else {
    process.stdout.write(
      `\n执行计划(默认):${runs.map(labelOf).join(" → ") || "无"}\n` +
        `  (选中的是测试**候选**:上面这几族会执行;它断言了什么,只有它自己的失败/通过能说)\n`,
    );
  }
  if (options.print) return 0;

  for (const name of plan.chain) {
    const status = runScript(name);
    if (status !== 0) {
      process.stderr.write(`\n${name} 失败(退出码 ${String(status)})\n`);
      return status;
    }
  }
  for (const item of plan.extras) {
    const status = runItem(item);
    if (status !== 0) {
      process.stderr.write(`\n${labelOf(item)} 失败(退出码 ${String(status)})\n`);
      return status;
    }
  }

  const debt = loadDebt();
  /**
   * 改了、但没有任何东西在看着它的路径。
   *
   * 代码的答案要等图跑完才知道(有没有测试 import 它),行为输入的答案现在就有(没有任何测试
   * 读过它)。两者共用一张债务表,理由相同:能看见的债好过看不见的零。
   */
  const unobservedAll = targets.probe.filter(
    (path) =>
      observedByInput.get(path) === undefined &&
      !debt.has(path) &&
      mustObserve({ path, workspaces }),
  );
  /**
   * 没人观测到、也不需要观测:池内的测试文件。
   *
   * 它的判据是它自己的断言,而 `test:related` 那条腿会选中并跑掉它——再探一遍等于把同一个
   * 文件执行两遍(实测 14 个盲文件里的 200s 大部分花在这里,而 `related-probe.test.ts` 这类
   * 文件本身就是在 vitest 里再起 vitest)。
   *
   * 但**“不需要观测”必须被看见**:所以它们照样被收集并打印,和它被探到时一样出声。
   * 不打印的后果就是从“绿但有注”变成“根本不提”。
   */
  const selfEvident = unobservedAll.filter((path) => !probeApplies(path) && inRelatedPool(path));
  const unobserved = unobservedAll.filter((path) =>
    // 探针只答源码。表把池子外的一族指给某个测试文件时,问图等于问错池子(0 条会被读成
    // 「确知为零」),判据是那一族本身,而它已经在计划里被真的执行。
    probeApplies(path),
  );
  const { inputs: unobservedInputs, code: blindCode } = unobservedHalves({
    paths: unobserved,
    workspaces,
  });

  // 行为输入没有 import 边,图对它是瞎的:观测为空就是没有判据,不必等图。
  if (unobservedInputs.length > 0) return reportUnobserved(unobservedInputs, "input");

  /**
   * 代码的答案必须**逐个问**,不能拿整条链的结论代答。
   *
   * 「`test:all` 跑过了」不等于「有人看着这个文件」:全量跑的是既有用例,一个没人 import 的新
   * 模块在它里面照样是零候选。这一步就是 ADR-0038 §六那条红线的落点。
   *
   * 代价是每个未观测文件一次 `test:related`(实测:零候选约 3s——其中几乎全是 vitest 自己的
   * 启动,与选中几条无关)。所以先把成本说在前面——不说的话,agent 会以为进程卡死然后去杀它。
   *
   * **并发跑,但按文件顺序出结论。** 探针之间互不依赖(各自的 `stdio` 是 ignore、报告落在
   * 各自的临时目录),串行的代价只是等启动。但两种红的处方指向具体文件,所以"先报哪个"
   * 必须是确定的:结论按 `blindCode` 的原顺序重放,不按完成顺序——否则同样的改动两次跑
   * 会拿到两张不同的脸。代价是失败时已经把其余探针也跑了:它们本来就在跑(并发),而把
   * 已经在飞的进程杀掉换来的是不确定的次序。
   */
  if (blindCode.length > 0) {
    process.stdout.write(
      `\n要逐个探 ${String(blindCode.length)} 个文件有没有测试候选:典型的每次约 3s,` +
        `并发 ${String(PROBE_CONCURRENCY)} 路。\n`,
    );
  }
  const gaps: { readonly path: string; readonly why: string }[] = [];
  /** 第一次红了、重跑绿了的路径:绿,但“它红过”这件事不能埋。 */
  const flaky: string[] = [];
  // 探针与依赖图必须问**同一个池子**,而池子的定义只有一处:`test:related` 的 project 集。
  // 写死 `all` 会让 `.prop.ts` 在两边同时恒 0——图漏选、探针再把「问错池子」读成「确知为零」。
  const relatedProjects = [...scriptProjects(scripts, "test:related")];
  const probed = await mapLimit(blindCode, PROBE_CONCURRENCY, (path) =>
    probeOnceThenRetry(() =>
      probeRelatedAsync({
        repoRoot,
        paths: [
          path,
          ...buildOutputsOf(path, workspaces).filter((output) =>
            existsSync(join(repoRoot, output)),
          ),
        ],
        projects: relatedProjects,
      }),
    ),
  );
  for (const [index, run] of probed.entries()) {
    const path = blindCode[index] ?? "";
    const { outcome } = run;
    if (run.flaky) flaky.push(path);
    switch (outcome.kind) {
      case "ran":
        // `selfOnly` 在这里不再有意义:探针只探源码,而源码不可能成为它自己的候选。
        // 那个字段留在 `related-probe.ts` 里(它是报告层面的一个真实结论,有它自己的用例)。
        break;
      case "failed":
        // 候选红了不是"没有判据",是"判据在喊":先修它,别把两种红混成一条。
        process.stderr.write(
          `\n${path} 的测试候选红了(${String(outcome.failed)} 条失败):先修它,再谈判据。\n`,
        );
        return 1;
      case "no-report":
        process.stderr.write(
          `\n问不出用例数:${path} 的探针没有产出可解析的 JSON 报告(退出码 ${
            outcome.exit === null ? "无" : String(outcome.exit)
          })。\n未知不是绿:这条判据只承认「确知为零」与「确知跑过」。\n`,
        );
        return 1;
      default: {
        // 三条"算得出没人看"的结论共用一张表(`unobservedGap`),它们都落到同一条红线上。
        const gap = unobservedGap(path, outcome);
        if (gap !== undefined) gaps.push(gap);
      }
    }
  }
  if (gaps.length > 0) return reportUnobserved(gaps, "code");

  if (flaky.length > 0) {
    // 重跑一次就绿的探针:结论是绿,但“它红过”要留在输出里——下一回真红时这份记录就是线索。
    process.stdout.write(
      `\n这几份的探针第一次红了、重跑绿了(并发下的偶发,不是绿):\n${flaky
        .map((path) => `  ${path}\n`)
        .join("")}`,
    );
  }

  if (selfEvident.length > 0) {
    // 说清楚这一条绿是什么:测试文件自己跑过了,而它没有证明**别的东西**的行为。
    process.stdout.write(
      `\n这几份是测试文件自己,没有别的东西观测到它 —— 判据是它自己的断言,` +
        `由 \`test:related\` 那条腿选中并跑过(不是生产代码的行为覆盖):\n${selfEvident
          .map((path) => `  ${path}\n`)
          .join("")}`,
    );
  }

  process.stdout.write(`\n按改动半径要跑的都绿了。收口用 \`pnpm run check -- --full\`。\n`);
  return 0;
};

const reportUnobserved = (
  gaps: readonly { readonly path: string; readonly why: string }[],
  kind: "code" | "input",
): number => {
  const tail =
    kind === "code"
      ? "这是 agent 最大的盲区:代码改了、判据没动。"
      : "这是行为输入,没有 import 边可问——观测为空就是真的没有测试读过它。\n" +
        "(若它其实被读到了,说明 map 过期:重录一遍比对,node --run observe:inputs。)";
  process.stderr.write(
    // 这句要对**两类缺口**都成立:`input`(观测为空)与 `code`(零候选 / 只有结构测试 / 全 skip)。
    // 旧的说法是"computed 与 observed 都是空的",而结构测试那一条的 computed 恰恰**不**空——
    // 它选出了一批文件,只是那些文件证的不是这块代码的行为。措辞比判据宽就会把人引错方向。
    `\n没有测试候选能证明这些改动的行为:\n` +
      `${gaps.map((gap) => `  ${gap.path}\n    ${gap.why}`).join("\n")}\n\n` +
      `${tail}\n选中的验证族没给这块改动留下任何候选;两条出路,选一条:\n` +
      `  1. 补一个用例,让它真的执行到这块;\n` +
      `  2. 在 ${DEBT_PATH} 里登记一行并写清为什么现在不测:\n` +
      `     ${gaps[0]?.path ?? "<路径>"}  # 为什么现在不测\n`,
  );
  return 1;
};

/**
 * 薄壳:只有「自己被当成命令跑」时才执行,被 import 时**无副作用**(ADR-0038 长期约束一)。
 *
 * 这条守卫不是形式主义:`ci.test.ts` 会 `import` 本文件去读 `FULL_CHAIN` 与 `runsFor`,
 * 没有它,一次 import 就等于在这个进程里跑一遍整条链——而那条链里又有 import 本文件的测试,
 * 于是无限递归。用 `argv[1]` 比路径,不用 `import.meta.main`(Node 22 上是 `undefined`,
 * CI 用的是 22)。
 */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
