/**
 * 逐文件探针的判据。这里的用例盯两件不同的事,故意分开写:
 *
 * 1. **纯函数层**(1–7):报告长什么样 → 哪种状态。直接喂对象,不起进程,毫秒级。
 *    六种状态各有断言,因为它们是六种处方;"零候选"与"读不到报告"必须落在**不同**的结论上,
 *    否则"未知"会以绿的形式回到流水线里。
 * 2. **真探针**(8–10):`spawnSync` 跑真的 `vitest related`。它们是这套判据唯一的证据来源——
 *    报告格式、`passWithNoTests` 的行为都是 vitest 的事实,不是我们能推出来的。
 *
 * 成本诚实记在这里:一条真探针的耗时几乎全是 vitest 自己的启动(零候选也要 ~3.3 秒),所以这
 * 三条用例的 `timeout` 是显式给的,不靠默认的 5 秒。
 *
 * **靶子故意小,更要稳。** 这两条“有候选”的用例早先用的是
 * `packages/engine/src/runner/quickjs.ts`:它拉进 7 个文件 / 89 条用例,单次 ~23 秒。它们归在
 * `unit`——编辑循环里反复跑的那一档——于是默认 `test` 从 26s 涨到了 69s,每次业务改动多付
 * 43s。判据要的是“真 spawn + 报告可解析 + 确实选中了行为测试”,不是“靶子有多大”;大靶子的
 * 形态由 `test:related` 在真实改动上覆盖。
 *
 * 但“小”不够。中途换成 `scope/plan.ts` 时相关集合确实缩到了 3 个文件,可其中一个是
 * `test-layers.test.ts`——**它断言的是仓库事实**(某些路径在不在盘上),在开发者机器上绿、
 * 在干净克隆上红。于是探针如实报 `failed`,而这两条用例期望 `ran`:级联的根因是靶子不稳,
 * 而判据挑在受环境影响的文件上就已经错了。现在靶子是 `fixtures/probe-target.ts`,纯函数夹具,
 * 唯一候选是它自己的测试文件。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { scriptProjects } from "./plan.ts";
import {
  STRUCTURAL_TESTS,
  classify,
  isRed,
  messageOf,
  parseReport,
  probeRelated,
  type ProbeOutcome,
  type ProbeReport,
} from "./related-probe.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 手搓一份报告:纯函数用例只需要这几项,其余字段与判定无关。 */
const report = (files: readonly string[], counts: Partial<ProbeReport> = {}): ProbeReport => ({
  files,
  tests: files.length,
  failed: 0,
  pending: 0,
  ...counts,
});

/**
 * 孤儿目标文件名(`集成:临时新建一个无人 import 的源文件 → no-tests` 自己造的临时靶子)。
 *
 * 为什么要单独拿出来:全量入口与编辑循环入口跑的是**同一个**测试文件(`unit` 与 `all` 两个
 * project 的拾取范围重叠),于是两个 worker 在同时跑:一个拍 `git status` 快照时,另一个的孤儿
 * 文件可能正好在盘上。那不是“探针留了文件”,所以两边都把这类行剔掉再比。
 * 孤儿自己的生死由那条用例的 `finally` 与末尾的 `existsSync` 断言管。
 */
const ORPHAN_PATTERN = /tmp-related-probe-orphan-/u;

/**
 * `git status --short` 的快照:用于断言“探针不在仓库里留东西”。
 *
 * 只剔掉并行 worker 的孤儿文件:除此之外的任何一个字节变化都算探针留了东西。
 */
const gitStatus = (): string =>
  spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter((line) => !ORPHAN_PATTERN.test(line))
    .join("\n");

/**
 * 真探针的靶子:**测试专用夹具**,纯函数,相关集合只有它自己的那个测试文件。
 *
 * 为什么不拿 `runner/quickjs.ts` 当靶子:这里要证的是“探针能问出候选并把报告读回来”,
 * 与靶子的体量无关,而那个靶子会把 89 条用例拉进 `unit`(编辑循环那一档),代价见文件头注。
 *
 * 为什么不拿 `scope/plan.ts`:它的相关集合里带着 `test-layers.test.ts`,那一条断言的是仓库
 * 事实(本机忽略目录在不在盘上),于是这两条用例在 CI 上会红在一个与探针无关的原因上。
 *
 * 路径写成**字符串**而不是 `import` 进来的值:import 会把本文件自己变成这个靶子的候选,
 * 于是“相关集合只有它自己的测试”这条性质当场破掉。
 */
const SMALL_TARGET = "packages/tools/src/scope/fixtures/probe-target.ts";

/**
 * 探针问的 project 集:**与生产同一条推导**(`test:related` 的定义),不在这里写一份字面量。
 *
 * 手写 `["all"]` 就是这次修复前的 bug:`.prop.ts` 住在 `property` project,问 `all` 结构上只能
 * 答 0 条。两处必须同源,否则「探针说没人看」与「计划真的跑了」会同时成立。
 */
const PROBE_PROJECTS = (): readonly string[] => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  return [...scriptProjects(manifest.scripts, "test:related")];
};

/**
 * `classify` 的 `subjects`:这一次被探的路径。
 *
 * 用一个和 `STRUCTURAL_TESTS` 不交的普通路径,是因为绝大多数用例要问的是「只有结构测试在看
 * 别人」——被探的路径若在清单里,那条结构测试就不再算「别人」。自指那一条自己传自己。
 */
const SUBJECT = "packages/a/target.ts";

/**
 * 全文件共用**一次**小靶子真探针。
 *
 * 两条"有候选"的用例看的是同一次运行:一次 spawn 里绝大部分是 vitest 自己的启动(~3.3 秒,
 * 零候选时也一样),起两遍等于白付一倍。报告落点显式给出,好让"用完即删"那条能指着同一文件说话;
 * `statusBefore` 在探针**开始前**取,所以"仓库里不留文件"仍是这条运行的断言。
 */
let smallProbe: {
  readonly outcome: ProbeOutcome;
  readonly dir: string;
  readonly reportPath: string;
  readonly statusBefore: string;
};

let smallProbeDir: string | undefined;

const runSmallProbe = (): typeof smallProbe => {
  smallProbe ??= (() => {
    const statusBefore = gitStatus();
    const dir = mkdtempSync(join(tmpdir(), "modelwar-related-probe-assert-"));
    smallProbeDir = dir;
    const reportPath = join(dir, "report.json");
    const outcome = probeRelated({
      repoRoot,
      paths: [SMALL_TARGET],
      projects: PROBE_PROJECTS(),
      reportPath,
    });
    return { outcome, dir, reportPath, statusBefore };
  })();
  return smallProbe;
};

/** 共用的临时目录不能留到下一次运行里(探针自己要删的只是那份报告)。 */
afterAll(() => {
  if (smallProbeDir !== undefined) {
    rmSync(smallProbeDir, { recursive: true, force: true });
  }
});

describe("parseReport:报告的计数与文件列表", () => {
  it("正常报告 → 文件列表仓库相对化、去重升序,计数照抄", () => {
    const json = JSON.stringify({
      numTotalTests: 7,
      numPassedTests: 6,
      numFailedTests: 1,
      numPendingTests: 2,
      testResults: [
        { name: "/repo/root/packages/a/b.test.ts" },
        { name: "/repo/root/packages/a/b.test.ts" },
        { name: "/repo/root/c.test.ts" },
        // 不在仓库下的路径原样保留:换成 `../` 会让结构测试的比对悄悄错位。
        { name: "/somewhere/else/x.test.ts" },
        {},
      ],
    });

    const parsed = parseReport(json, "/repo/root/");

    expect(parsed?.files).toEqual([
      "/somewhere/else/x.test.ts",
      "c.test.ts",
      "packages/a/b.test.ts",
    ]);
    expect(parsed?.tests).toBe(7);
    expect(parsed?.failed).toBe(1);
    expect(parsed?.pending).toBe(2);
  });

  it("非法 JSON / 形状不对 → undefined(读不出来不许装作 0 条)", () => {
    expect(parseReport("{", "/repo/root")).toBeUndefined();
    expect(parseReport("", "/repo/root")).toBeUndefined();
    expect(parseReport("null", "/repo/root")).toBeUndefined();
    // 没有 `testResults` 的报告不是 json reporter 的东西:同样算读不出来。
    expect(parseReport('{"numTotalTests":0}', "/repo/root")).toBeUndefined();
  });
});

describe("classify:六种状态", () => {
  it("0 条用例 → no-tests(退出码是 1 也还是 no-tests,不是 failed)", () => {
    const outcome = classify(report([], { tests: 0 }), STRUCTURAL_TESTS, 1, []);
    expect(outcome.kind).toBe("no-tests");
  });

  it("全部 skip → all-skipped(不许算 ran)", () => {
    const outcome = classify(
      report(["packages/a/x.test.ts"], { tests: 3, pending: 3 }),
      STRUCTURAL_TESTS,
      0,
      [SUBJECT],
    );
    expect(outcome.kind).toBe("all-skipped");
    expect(isRed(outcome)).toBe(true);
  });

  it("有失败,或退出码非零 → failed", () => {
    const failed = classify(
      report(["packages/a/x.test.ts"], { tests: 4, failed: 2 }),
      STRUCTURAL_TESTS,
      1,
      [SUBJECT],
    );
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" && failed.failed).toBe(2);

    // 计数看起来正常、进程红过(套件级错误)也算红:退出码是"跑完了没有"的信号。
    const crashed = classify(report(["packages/a/x.test.ts"], { tests: 4 }), STRUCTURAL_TESTS, 1, [
      SUBJECT,
    ]);
    expect(crashed.kind).toBe("failed");
  });

  it("只有结构测试文件 → structural-only(消息点名「别的文件的形状」)", () => {
    // 这张表的每条路径必须真实存在:清单腐烂会让 structural-only 静默退化成 ran。
    for (const path of STRUCTURAL_TESTS) {
      expect(existsSync(join(repoRoot, path)), `结构测试清单里的 ${path} 不存在`).toBe(true);
    }

    const structural = STRUCTURAL_TESTS[0] ?? "";
    // 被探的是一个**不在**结构测试清单里的路径:这条结构测试就是那个「别人」。
    const outcome = classify(report([structural], { tests: 2 }), STRUCTURAL_TESTS, 0, [SUBJECT]);

    expect(outcome.kind).toBe("structural-only");
    expect(outcome.kind === "structural-only" && outcome.structural).toEqual([structural]);
    // 这句话本身就是判据的一部分:读的人得知道为什么“有测试”却不给绿。
    expect(isRed(outcome)).toBe(true);
    expect(messageOf(outcome)).toContain("别的文件的形状");
  });

  /**
   * **被改的文件自己就在 `STRUCTURAL_TESTS` 里时,它不是「别人」。**
   *
   * 改一份结构测试自己的注释,`vitest related` 选出来的就是它自己。旧判据把 `files − structural`
   * 为空一律读成 `structural-only`,于是「谁看着这份文件」的答案——“它自己”——被判成“没人”。
   *
   * 绿不代表覆盖了生产代码:`selfOnly` 把它说清楚(见下一条)。
   */
  it("被探的路径就是结构测试自己时,不判 structural-only", () => {
    const self = STRUCTURAL_TESTS[0] ?? "";
    const outcome = classify(report([self], { tests: 2 }), STRUCTURAL_TESTS, 0, [self]);

    expect(outcome.kind).toBe("ran");
    expect(isRed(outcome)).toBe(false);
    expect(outcome.kind === "ran" && outcome.selfOnly).toBe(true);
    // 「它自己的判据」不能被说成生产代码的行为覆盖。
    expect(messageOf(outcome)).toContain("不是生产代码的行为覆盖");
  });

  it("结构测试自己 + 一份真行为测试一起被选中时,不算 selfOnly", () => {
    const self = STRUCTURAL_TESTS[0] ?? "";
    const outcome = classify(
      report([self, "packages/a/x.test.ts"], { tests: 5 }),
      STRUCTURAL_TESTS,
      0,
      [self],
    );

    expect(outcome.kind).toBe("ran");
    expect(outcome.kind === "ran" && outcome.selfOnly).toBe(false);
    // 被探的路径自己不算「别人」:它既不是行为证据,也不该被列成「看着这块代码的结构测试」。
    expect(outcome.kind === "ran" && outcome.structural).toEqual([]);
  });

  it("报告 undefined → no-report(不是 no-tests),且与 no-tests 的消息不同", () => {
    const missing = classify(undefined, STRUCTURAL_TESTS, null, [SUBJECT]);
    const empty = classify(report([], { tests: 0 }), STRUCTURAL_TESTS, 1, []);

    expect(missing.kind).toBe("no-report");
    expect(missing.kind).not.toBe("no-tests");
    expect(isRed(missing)).toBe(true);
    // 两种处方:一个要修探针,一个要写用例。
    expect(messageOf(missing)).not.toBe(messageOf(empty));
    expect(messageOf(missing)).toContain("读不到");
    expect(messageOf(empty)).toContain("确知为零");
  });

  /**
   * **“落点用不了”与“路径写在 tmpdir 外”是两件事,处方相反。**
   *
   * - 路径不在 tmpdir = **调用方写错了**(探针不许往仓库里写文件):这是编程错误,该抛,
   *   修的是调用点。它由 `assertUnderTemp` 管,不属六态里的任何一格。
   * - 路径在 tmpdir、那个位置却写不出来(目录被占 / 无权限)= **环境**:探针这道判据这一次
   *   确实问不出答案,那就是 `no-report`。抛出去会把「未知」伪装成「工具坏了」。
   *
   * 落点是一个被普通文件占住的“目录”:不依赖文件权限位,任何 uid 下都是同一个形状
   * (无权限的 EACCES 也是同一格,只是 root 下不成立)。
   */
  it("落点在 tmpdir 内但写不出去 → no-report,且消息与 no-tests 不同", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelwar-related-probe-occupied-"));
    const occupied = join(dir, "occupied");
    writeFileSync(occupied, "占位\n");
    try {
      const outcome = probeRelated({
        repoRoot,
        paths: [SMALL_TARGET],
        projects: PROBE_PROJECTS(),
        reportPath: join(occupied, "report.json"),
      });
      expect(outcome.kind).toBe("no-report");
      // 进程压根没起:退出码是「无」,不是某个红过的码。
      expect(outcome.kind === "no-report" ? outcome.exit : "?").toBeNull();
      expect(isRed(outcome)).toBe(true);
      expect(messageOf(outcome)).not.toBe(messageOf({ kind: "no-tests" }));
      expect(messageOf(outcome)).toContain("读不到");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("落点在 tmpdir 外 → 仍然抛错(那是调用方写错了,不是环境)", () => {
    for (const reportPath of [
      join(repoRoot, "related-probe-report.json"),
      join(repoRoot, "packages", "tools", "report.json"),
    ]) {
      expect(() =>
        probeRelated({ repoRoot, paths: [SMALL_TARGET], projects: PROBE_PROJECTS(), reportPath }),
      ).toThrow(/tmpdir/u);
      expect(existsSync(reportPath), `探针在仓库里留了文件:${reportPath}`).toBe(false);
    }
  });
});

describe("真探针:报告是唯一的判据", () => {
  it("集成:临时新建一个无人 import 的源文件 → no-tests", { timeout: 240_000 }, () => {
    /**
     * 故意放在包的**根**而不是 `src/`:放 `src/` 会被 `tsc -b` 编进 `dist/`,而我们删掉源文件
     * 之后那个产物没人认领(tsc 不会回收失去源文件的产物)。依赖图对"没人 import 的文件"给出的
     * 答案与它放在哪个子目录无关。
     */
    const orphan = join(
      repoRoot,
      "packages",
      "engine",
      `tmp-related-probe-orphan-${String(process.pid)}.ts`,
    );
    writeFileSync(orphan, "export const orphan = 1;\n");
    try {
      const outcome = probeRelated({
        repoRoot,
        paths: [orphan.slice(repoRoot.length)],
        projects: PROBE_PROJECTS(),
      });
      expect(outcome.kind).toBe("no-tests");
    } finally {
      rmSync(orphan, { force: true });
    }
    expect(existsSync(orphan)).toBe(false);
  });

  it(
    "集成:已知有候选的文件(夹具 probe-target.ts)→ ran,且行为测试文件 ≥ 1",
    { timeout: 240_000 },
    () => {
      const { outcome } = runSmallProbe();

      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") return;
      // **只有它自己一个候选**——这正是靶子“稳”的定义。多出一个(比如又选进了某个读仓库事实的
      // 文件),这条用例就会在干净克隆上红在与探针无关的原因上,所以这里钉住相等而不是“至少一个”。
      expect(outcome.behavior).toEqual(["packages/tools/src/scope/fixtures/probe-target.test.ts"]);
      // 报告里确实跑了用例:这是"有候选"的唯一硬证据。
      expect(outcome.tests).toBeGreaterThan(0);
    },
  );

  it("报告落在 tmpdir 下、用完即删;仓库里不留文件", { timeout: 240_000 }, () => {
    const { outcome, dir, reportPath, statusBefore } = runSmallProbe();

    expect(reportPath.startsWith(tmpdir())).toBe(true);
    expect(outcome.kind).toBe("ran");
    // 用完即删:连报告带目录一起不留。
    expect(existsSync(reportPath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(gitStatus()).toBe(statusBefore);
    // 报告落点不在 tmpdir 下一律拒绝:探针不许往仓库里写文件。
    expect(() =>
      probeRelated({
        repoRoot,
        paths: [SMALL_TARGET],
        projects: PROBE_PROJECTS(),
        reportPath: join(repoRoot, "related-probe-report.json"),
      }),
    ).toThrow(/tmpdir/u);
    expect(existsSync(join(repoRoot, "related-probe-report.json"))).toBe(false);
  });
});
