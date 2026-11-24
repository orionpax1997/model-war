/**
 * 逐文件探针的判据。这里的用例盯两件不同的事,故意分开写:
 *
 * 1. **纯函数层**(1–7):报告长什么样 → 哪种状态。直接喂对象,不起进程,毫秒级。
 *    六种状态各有断言,因为它们是六种处方;"零候选"与"读不到报告"必须落在**不同**的结论上,
 *    否则"未知"会以绿的形式回到流水线里。
 * 2. **真探针**(8–10):`spawnSync` 跑真的 `vitest related`。它们是这套判据唯一的证据来源——
 *    报告格式、`passWithNoTests` 的行为都是 vitest 的事实,不是我们能推出来的。
 *
 * 成本诚实记在这里:一次真探针约 2 秒(零候选)到 ~25 秒(有候选,要真跑那些测试),所以这三条
 * 用例的 `timeout` 是显式给的,不靠默认的 5 秒。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STRUCTURAL_TESTS,
  classify,
  isRed,
  messageOf,
  parseReport,
  probeRelated,
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

  it("集成:已知有候选的文件(quickjs.ts)→ ran,且行为测试文件 ≥ 1", { timeout: 240_000 }, () => {
    const outcome = probeRelated({
      repoRoot,
      paths: ["packages/engine/src/runner/quickjs.ts"],
      project: "all",
    });

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.behavior.length).toBeGreaterThanOrEqual(1);
    expect(outcome.behavior).toContain("packages/engine/src/runner/quickjs.test.ts");
    // 报告里确实跑了用例:这是"有候选"的唯一硬证据。
    expect(outcome.tests).toBeGreaterThan(0);
  });

  it("报告落在 tmpdir 下、用完即删;仓库里不留文件", { timeout: 240_000 }, () => {
    const before = gitStatus();
    const dir = mkdtempSync(join(tmpdir(), "modelwar-related-probe-assert-"));
    const reportPath = join(dir, "report.json");
    try {
      expect(reportPath.startsWith(tmpdir())).toBe(true);
      const outcome = probeRelated({
        repoRoot,
        paths: ["packages/engine/src/runner/quickjs.ts"],
        project: "all",
        reportPath,
      });
      expect(outcome.kind).toBe("ran");
      // 用完即删:连报告带目录一起不留。
      expect(existsSync(reportPath)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(gitStatus()).toBe(before);
    // 报告落点不在 tmpdir 下一律拒绝:探针不许往仓库里写文件。
    expect(() =>
      probeRelated({
        repoRoot,
        paths: ["packages/engine/src/runner/quickjs.ts"],
        project: "all",
        reportPath: join(repoRoot, "related-probe-report.json"),
      }),
    ).toThrow(/tmpdir/u);
    expect(existsSync(join(repoRoot, "related-probe-report.json"))).toBe(false);
  });
});
