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
 * - 无人观测:改完没有任何测试候选、观测也为空 → 红,并给出两条出路(补用例,或登记
 *   `coverage-debt.txt`)。这是 agent 最大的盲区,而原来的系统在它改完之后什么都不说。
 * - 问不出用例数:探针报告缺失 / 不可解析 → 红。**未知不是绿**,而且本仓库的 vitest 配置带
 *   `passWithNoTests: true`,只看退出码会把"一条没选中"读成"通过"。
 * - 判据本身过期:入库观测快照的内容指纹(recorder / setup / `vitest.config.ts`)与现在对不上
 *   → 红,并在消息里给两个指纹与两条重录命令。旧的 map 不再被当成判据:它的失效方向是少记,
 *   而少记与“没人读”在输出上是同一句话。
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
import { buildOutputsOf, isSourceFile, workspacesOf } from "./build-outputs.ts";
import {
  ALWAYS,
  UnregisteredPathError,
  decide,
  mustObserve,
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
} from "./change-set.ts";
import { chainProjects, fullPlan, scriptProjects, type RunItem, type Scripts } from "./plan.ts";
import { probeRelated, type ProbeOutcome } from "./related-probe.ts";
import {
  currentFingerprint,
  invert,
  isSnapshotCurrent,
  loadInputsMap,
  type InputsMap,
} from "./test-inputs.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 收口的定义。CI 与本地跑的是同一串名字,不各写一份。 */
export const FULL_CHAIN: readonly string[] = ["verify", "gate:types"];

/** 未覆盖登记的落点。路径相对仓库根,`#` 之后写为什么现在不测。 */
export const DEBT_PATH = "coverage-debt.txt";

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
 * 观测快照过期时的红消息。**过期即红**:`undefined` = 还能当判据。
 *
 * 为什么不是"警告一句然后照旧用":旧 map 的失效方向是**少记**——recorder 换了 hook、project
 * 划分变了之后,它会安静地少几条观测,于是选择器少选一批测试,而少选不报错。既然"用过期的
 * 判据"与"没有判据"是同一件事,这里就必须在**拿它当判据之前**停下。
 *
 * 消息里三个要素缺一不可:两个指纹(谁跟谁对不上)、"为什么指纹能决定这件事"、两条命令
 * (`observe:inputs:accept` 重录、`observe:inputs` 复核,后者是防止重录把变窄写进仓库)。
 */
export const snapshotStaleMessage = (input: {
  readonly map: InputsMap;
  readonly fingerprint: string;
}): string | undefined => {
  if (isSnapshotCurrent(input)) return undefined;
  const recorded = input.map.fingerprint === "" ? "(空:旧快照没有指纹)" : input.map.fingerprint;
  return (
    `观测快照过期:入库指纹 ${recorded},现在是 ${input.fingerprint}。\n` +
    '指纹覆盖 recorder / setup / vitest.config.ts:观测仪器变了,旧 map 里"谁读什么"不再是\n' +
    '同一回事,拿它判"有没有测试观测到"只会少跑,所以这里直接红。\n' +
    "重录:`node --run observe:inputs:accept`(约 85s);复核:`node --run observe:inputs`" +
    "(重录变窄等于少跑,复核就是在拦这件事)。\n"
  );
};

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

const main = (argv: readonly string[]): number => {
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
    const deduped = runs.filter((item) => !plan.extras.includes(item));
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
  const unobserved = files.filter(
    (path) =>
      observedByInput.get(path) === undefined &&
      !debt.has(path) &&
      mustObserve({ path, workspaces }),
  );
  const unobservedInputs = unobserved
    .filter((path) => !isSourceFile(path, workspaces))
    .map((path) => ({ path, why: "它是行为输入,而观测 map 里没有任何测试读过它" }));

  // 行为输入没有 import 边,图对它是瞎的:观测为空就是没有判据,不必等图。
  if (unobservedInputs.length > 0) return reportUnobserved(unobservedInputs, "input");

  /**
   * 代码的答案必须**逐个问**,不能拿整条链的结论代答。
   *
   * 「`test:all` 跑过了」不等于「有人看着这个文件」:全量跑的是既有用例,一个没人 import 的新
   * 模块在它里面照样是零候选。这一步就是 ADR-0038 §六那条红线的落点。
   *
   * 代价是每个未观测文件一次 `test:related`(实测:零候选约 2s,有候选要真跑那些测试,最坏
   * ~24s)。所以先把成本说在前面——不说的话,agent 会以为进程卡死然后去杀它。
   */
  const blindCode = unobserved.filter((path) => isSourceFile(path, workspaces));
  if (blindCode.length > 0) {
    process.stdout.write(
      `\n要逐个探 ${String(blindCode.length)} 个文件有没有测试候选:典型的每次约 3s,最坏 24s。\n`,
    );
  }
  const gaps: { readonly path: string; readonly why: string }[] = [];
  for (const path of blindCode) {
    const outputs = buildOutputsOf(path, workspaces);
    const outcome = probeRelated({
      repoRoot,
      paths: [path, ...outputs.filter((output) => existsSync(join(repoRoot, output)))],
      project: "all",
    });
    switch (outcome.kind) {
      case "ran":
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
    `\n改动没有被任何测试观测到(computed 与 observed 都是空的):\n` +
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
  process.exitCode = main(process.argv.slice(2));
}
