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
 * **靶子故意小。** 这两条“有候选”的用例早先用的是 `packages/engine/src/runner/quickjs.ts`:
 * 它拉进 7 个文件 / 89 条用例,单次 ~23 秒。它们归在 `unit`——编辑循环里反复跑的那一档——
 * 于是默认 `test` 从 26s 涨到了 69s,每次业务改动多付 43s。判据要的是“真 spawn + 报告可解析 +
 * 确实选中了行为测试”,不是“靶子有多大”;大靶子的形态由 `test:related` 在真实改动上覆盖。
 * 换成 `scope/plan.ts` 后相关集合只有 3 个文件 / 91 条用例,整条文件回到个位数秒。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
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

/** `git status --short` 的快照:用于断言"探针不在仓库里留东西"。 */
const gitStatus = (): string =>
  spawnSync("git", ["status", "--short"], { cwd: repoRoot, encoding: "utf8" }).stdout;

/**
 * 真探针的靶子:小、稳、相关集合只包含引用它自己的那几个测试文件。
 *
 * 为什么不拿 `runner/quickjs.ts` 当靶子:这里要证的是"探针能问出候选并把报告读回来",
 * 与靶子的体量无关,而那个靶子会把 89 条用例拉进 `unit`(编辑循环那一档),代价见文件头注。
 */
const SMALL_TARGET = "packages/tools/src/scope/plan.ts";

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
      project: "all",
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
    const outcome = classify(report([], { tests: 0 }), STRUCTURAL_TESTS, 1);
    expect(outcome.kind).toBe("no-tests");
  });

  it("全部 skip → all-skipped(不许算 ran)", () => {
    const outcome = classify(
      report(["packages/a/x.test.ts"], { tests: 3, pending: 3 }),
      STRUCTURAL_TESTS,
      0,
    );
    expect(outcome.kind).toBe("all-skipped");
    expect(isRed(outcome)).toBe(true);
  });

  it("有失败,或退出码非零 → failed", () => {
    const failed = classify(
      report(["packages/a/x.test.ts"], { tests: 4, failed: 2 }),
      STRUCTURAL_TESTS,
      1,
    );
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" && failed.failed).toBe(2);

    // 计数看起来正常、进程红过(套件级错误)也算红:退出码是"跑完了没有"的信号。
    const crashed = classify(report(["packages/a/x.test.ts"], { tests: 4 }), STRUCTURAL_TESTS, 1);
    expect(crashed.kind).toBe("failed");
  });

  it("只有结构测试文件 → structural-only(消息点名「别的文件的形状」)", () => {
    // 这张表的每条路径必须真实存在:清单腐烂会让 structural-only 静默退化成 ran。
    for (const path of STRUCTURAL_TESTS) {
      expect(existsSync(join(repoRoot, path)), `结构测试清单里的 ${path} 不存在`).toBe(true);
    }

    const structural = STRUCTURAL_TESTS[0] ?? "";
    const outcome = classify(report([structural], { tests: 2 }), STRUCTURAL_TESTS, 0);

    expect(outcome.kind).toBe("structural-only");
    expect(outcome.kind === "structural-only" && outcome.structural).toEqual([structural]);
    // 这句话本身就是判据的一部分:读的人得知道为什么“有测试”却不给绿。
    expect(isRed(outcome)).toBe(true);
    expect(messageOf(outcome)).toContain("别的文件的形状");
  });

  it("报告 undefined → no-report(不是 no-tests),且与 no-tests 的消息不同", () => {
    const missing = classify(undefined, STRUCTURAL_TESTS, null);
    const empty = classify(report([], { tests: 0 }), STRUCTURAL_TESTS, 1);

    expect(missing.kind).toBe("no-report");
    expect(missing.kind).not.toBe("no-tests");
    expect(isRed(missing)).toBe(true);
    // 两种处方:一个要修探针,一个要写用例。
    expect(messageOf(missing)).not.toBe(messageOf(empty));
    expect(messageOf(missing)).toContain("读不到");
    expect(messageOf(empty)).toContain("确知为零");
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
        project: "all",
      });
      expect(outcome.kind).toBe("no-tests");
    } finally {
      rmSync(orphan, { force: true });
    }
    expect(existsSync(orphan)).toBe(false);
  });

  it("集成:已知有候选的文件(plan.ts)→ ran,且行为测试文件 ≥ 1", { timeout: 240_000 }, () => {
    const { outcome } = runSmallProbe();

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.behavior.length).toBeGreaterThanOrEqual(1);
    expect(outcome.behavior).toContain("packages/tools/src/scope/plan.test.ts");
    // 报告里确实跑了用例:这是"有候选"的唯一硬证据。
    expect(outcome.tests).toBeGreaterThan(0);
  });

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
        project: "all",
        reportPath: join(repoRoot, "related-probe-report.json"),
      }),
    ).toThrow(/tmpdir/u);
    expect(existsSync(join(repoRoot, "related-probe-report.json"))).toBe(false);
  });
});
