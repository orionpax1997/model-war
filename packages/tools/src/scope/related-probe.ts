/**
 * 逐文件探针:问依赖图"这个文件对应的改动,到底有没有测试候选"。
 *
 * ── 判据只有一个来源:报告里的用例数 ──────────────────────────────────────────
 *
 * 判据是 **vitest 的 JSON 报告里真的跑了多少条用例**,不是退出码。这一条必须写死:本仓库的
 * vitest 配置带 `passWithNoTests: true`,一条没选中时退出码是 **0**(实测:同一个文件,加
 * `--passWithNoTests=false` 退出 1,不加退出 0)。只判退出码就会把"零候选"读成"通过",而那是
 * 这套系统最不能犯的错——它不报错,它给绿。
 *
 * 所以两件事都是**显式**的,不依赖配置文件里恰好有没有:
 *
 * - `--passWithNoTests=false`:零选中必须是失败,而不是"没什么可跑";
 * - `--reporter=json --outputFile=<tmpdir 下的临时文件>`:报告落点由自己给,不读"默认报告路径"
 *   那种隐式事实。早先的实现读固定路径 `.vitest/json/output.json`,而那个路径只有报告器恰好
 *   被配置时才存在;不存在时旧代码 `catch` 返回 `undefined`,分支又要求"退出码非零"才判红,
 *   于是"读不到报告"这条路径**静默变绿**。
 *
 * ── 六种状态,因为对应六种处方 ────────────────────────────────────────────────
 *
 * | 状态              | 含义                                   | 处方                          |
 * | ----------------- | -------------------------------------- | ----------------------------- |
 * | `ran`             | 选中并跑过(至少一个行为测试文件)       | 绿                            |
 * | `structural-only` | 只有结构测试被选中                     | 红:那是别的文件的形状         |
 * | `no-tests`        | 确知为零                               | 红:补用例或登记 coverage-debt |
 * | `all-skipped`     | 选中的全部 `skip`                      | 红:跳过不是证据               |
 * | `failed`          | 选中且红了                             | 红:`test:related` 本身红      |
 * | `no-report`       | 报告缺失 / 不可解析 / 进程没跑起来     | 红:未知不是绿                 |
 *
 * 最后两条的区别是**知道**与**不知道**,不是程度差别:`no-tests` 是"报告说 0 条",
 * `no-report` 是"没有报告可读"。两者都红,但消息不同(见 `messageOf`),因为处方不同——
 * 前者要写用例,后者要先修探针本身。
 *
 * `parseReport` / `classify` 是**纯函数**:测试直接喂报告对象,不起进程。
 * 探针的报告文件落在 `tmpdir()` 下、用完即删;探针不往仓库里写文件。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * **结构测试**:断言的是"别的文件的形状"(依赖方向、文档归属、版本边界),不执行被改模块的行为。
 *
 * 它们被选中**不算**行为证据。列成显式常量而不是靠命名约定,是因为命名约定无法验证;这张表本身
 * 由测试盯着(每条路径必须真实存在,见 `related-probe.test.ts`)。
 *
 * 这份清单只影响**证据判定**,不影响**选择**:它不会让任何测试多跑或少跑。
 */
export const STRUCTURAL_TESTS: readonly string[] = [
  "packages/engine/src/dependency-boundary.test.ts",
  "packages/gen/src/dependency-boundary.test.ts",
  "packages/tools/src/version-control-boundary.test.ts",
  "packages/tools/src/doc-homes.test.ts",
];

/** 报告里与判定有关的那几个字段(仓库只要这四个)。 */
export interface ProbeReport {
  /** 报告里的测试文件,仓库相对路径,去重后升序。 */
  readonly files: readonly string[];
  /** `numTotalTests`:选中的用例总数(含 skip)。 */
  readonly tests: number;
  /** `numFailedTests`。 */
  readonly failed: number;
  /** `numPendingTests`:skip / todo 的用例数。 */
  readonly pending: number;
}

/** 探针的结论。六种,见文件头注的表。 */
export type ProbeOutcome =
  | {
      readonly kind: "ran";
      /** 行为测试文件(结构测试已剔除),升序。 */
      readonly behavior: readonly string[];
      readonly structural: readonly string[];
      readonly tests: number;
    }
  | { readonly kind: "structural-only"; readonly structural: readonly string[] }
  | { readonly kind: "no-tests" }
  | { readonly kind: "all-skipped"; readonly files: readonly string[] }
  | {
      readonly kind: "failed";
      readonly files: readonly string[];
      readonly failed: number;
    }
  | { readonly kind: "no-report"; readonly exit: number | null };

/** 结论是否算红。只有 `ran` 是绿——列表留白比"看起来有测试"诚实。 */
export const isRed = (outcome: ProbeOutcome): boolean => outcome.kind !== "ran";

/**
 * 结论的一句话处方。`no-tests` 与 `no-report` 的措辞必须不同:一个是"确知为零",一个是"问不出
 * 答案",修的地方不一样。
 */
export const messageOf = (outcome: ProbeOutcome): string => {
  switch (outcome.kind) {
    case "ran":
      return `选中 ${String(outcome.behavior.length)} 个测试文件 / ${String(outcome.tests)} 条用例`;
    case "structural-only":
      return `只选中了结构测试(${outcome.structural.join(", ")}):那是别的文件的形状,不是被改模块的行为证据`;
    case "no-tests":
      return "报告说 0 条用例:确知为零。补用例,或在 coverage-debt.txt 里登记";
    case "all-skipped":
      return `选中的 ${String(outcome.files.length)} 个测试文件全部 skip:跳过不是证据`;
    case "failed":
      return `选中的测试红了(${String(outcome.failed)} 条失败):先修 test:related`;
    case "no-report":
      return `读不到 vitest 的 JSON 报告(退出码 ${outcome.exit === null ? "无" : String(outcome.exit)}):未知不是绿,先修探针`;
  }
};

/**
 * 报告里的绝对路径 → 仓库相对。报告缺失(不是合法 JSON)时返回 `undefined`。
 *
 * 调用方**不许**把 `undefined` 当绿:它交给 `classify` 变成 `no-report`。
 *
 * 不在 `repoRoot` 下的路径原样保留(而不是 `../` 拼出来):探针只关心"哪些测试文件参与了",
 * 把外部路径伪装成仓库内的相对路径会让 `STRUCTURAL_TESTS` 的比对悄悄错位。
 */
export const parseReport = (json: string, repoRoot: string): ProbeReport | undefined => {
  const prefix = `${repoRoot.replace(/\/+$/, "")}/`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const report = parsed as {
    numTotalTests?: unknown;
    numFailedTests?: unknown;
    numPendingTests?: unknown;
    testResults?: unknown;
  };
  // `testResults` 缺失按"这份报告不是 json reporter 的东西"处理:形状不对就是读不出来。
  if (!Array.isArray(report.testResults)) return undefined;
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  const names = (report.testResults as readonly { name?: unknown }[]).flatMap((result) => {
    const name = typeof result.name === "string" ? result.name : "";
    if (name === "") return [];
    return [name.startsWith(prefix) ? name.slice(prefix.length) : name];
  });
  return {
    files: [...new Set(names)].sort(),
    tests: count(report.numTotalTests),
    failed: count(report.numFailedTests),
    pending: count(report.numPendingTests),
  };
};

/**
 * 六种状态的分派。纯函数:输入是报告与退出码,不碰文件系统、不起进程。
 *
 * 顺序是判据的一部分:
 *
 * 1. 没有报告 → `no-report`(什么都还没法说);
 * 2. `tests === 0` → `no-tests`。放在失败判定**之前**:零选中时退出码本来就是 1
 *    (`--passWithNoTests=false`),那是"零候选"的信号,不该被读成"测试红了";
 * 3. 有失败或退出码非零 → `failed`(套件级错误也算:报告里的计数可能全是 0 以外的正常数,
 *    但进程红过);
 * 4. `pending === tests` 且 `tests > 0` → `all-skipped`。跳过不是证据,不能算 `ran`;
 * 5. 行为测试文件为空 → `structural-only`;
 * 6. 其余 `ran`。
 */
export const classify = (
  report: ProbeReport | undefined,
  structural: readonly string[],
  exit: number | null,
): ProbeOutcome => {
  if (report === undefined) return { kind: "no-report", exit };
  if (report.tests === 0) return { kind: "no-tests" };
  if (report.failed > 0 || exit !== 0) {
    return { kind: "failed", files: report.files, failed: report.failed };
  }
  if (report.pending === report.tests) return { kind: "all-skipped", files: report.files };
  const structuralFiles = report.files.filter((path) => structural.includes(path));
  const behavior = report.files.filter((path) => !structural.includes(path));
  if (behavior.length === 0) return { kind: "structural-only", structural: structuralFiles };
  return {
    kind: "ran",
    behavior,
    structural: structuralFiles,
    tests: report.tests,
  };
};

/**
 * 探针的临时报告目录前缀。放在 `tmpdir()` 下是硬要求:探针是**问**一次就走的东西,不该在
 * 被问的仓库里留下任何文件(`git status` 干净是这套系统的一条底线)。
 */
const REPORT_DIR_PREFIX = "modelwar-related-probe-";

/** 一次探针的报告落点:在 `tmpdir()` 下新建的目录里的 `report.json`。 */
export const tempReportPath = (): string =>
  join(mkdtempSync(join(tmpdir(), REPORT_DIR_PREFIX)), "report.json");

/**
 * 报告路径必须在 `tmpdir()` 下。这条不是洁癖:仓库内的报告路径会被当成"改动"(或需要被
 * `.gitignore` 特批),而探针的产物零价值——它只在这一次判定里有意义。
 */
const assertUnderTemp = (path: string): void => {
  const root = resolve(tmpdir());
  const resolved = resolve(path);
  if (resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(
      `探针报告必须落在 tmpdir 下(${root}),拿到的是 ${resolved}。` +
        "仓库里不留探针产物:用 tempReportPath() 取一个临时落点。",
    );
  }
};

export interface ProbeInput {
  /** 仓库根(报告里的绝对路径靠它相对化)。 */
  readonly repoRoot: string;
  /** 交给依赖图的路径(源码 + 产物)。 */
  readonly paths: readonly string[];
  /** 要问的 project(`all` / `gates` …)。 */
  readonly project: string;
  /** 报告落点;不传就自己在 `tmpdir()` 下开一个。 */
  readonly reportPath?: string;
}

/**
 * 跑一次 `vitest related`,自己拿 JSON 报告判状态。
 *
 * `--passWithNoTests=false` 与 `--reporter=json --outputFile=` 都是**显式**传的:不依赖配置
 * 文件里的那一份,也不依赖 vitest 将来会不会改默认值。
 */
export const probeRelated = (input: ProbeInput): ProbeOutcome => {
  const owned = input.reportPath === undefined;
  const reportPath = input.reportPath ?? tempReportPath();
  assertUnderTemp(reportPath);
  try {
    rmSync(reportPath, { force: true });
    const result = spawnSync(
      process.execPath,
      [
        join(input.repoRoot, "node_modules", "vitest", "vitest.mjs"),
        "related",
        "--run",
        "--project",
        input.project,
        "--passWithNoTests=false",
        "--reporter=json",
        `--outputFile=${reportPath}`,
        ...input.paths,
      ],
      { cwd: input.repoRoot, stdio: "ignore" },
    );
    let json: string | undefined;
    try {
      json = readFileSync(reportPath, "utf8");
    } catch {
      // 报告没写出来(目录不可写、进程没跑起来、报告器没装):交给 classify 判 no-report。
      json = undefined;
    }
    const report = json === undefined ? undefined : parseReport(json, input.repoRoot);
    return classify(report, STRUCTURAL_TESTS, result.status);
  } finally {
    rmSync(reportPath, { force: true });
    if (owned) rmSync(dirname(reportPath), { recursive: true, force: true });
  }
};
