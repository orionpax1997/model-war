/**
 * 入口:读全仓测试源码 → 诊断 → 落报告。
 *
 * 形状与 `mutation/run-mutation-diagnose.ts` 一致:入口只做四件事(解析参数、读文件、
 * 调纯函数、设退出码),判定与渲染都在纯函数层。
 *
 * **它是观测,不是门禁**:只读源码、只写一份报告,不判定任何东西、不改任何东西,
 * 因此不进任何常跑链(那条纪律由 `packages/tools/src/gates.test.ts` 钉住)。
 *
 * 退出码:0 = 报告已生成;1 = 读不到任何测试源码(那是空转,不是「干净」)。
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { diagnoseVitestRules } from "./diagnose-vitest-rules.ts";
import { renderVitestRulesReport } from "./diagnose-vitest-rules-markdown.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 参与扫描的目录:仓库自身源码(测试文件都在这里)。 */
const SOURCE_ROOTS = ["packages", "apps"] as const;

/** 测试文件的命名:与 vitest 项目的 include 口径一致。 */
const TEST_FILE = /\.(?:test|prop)\.ts$/u;

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git", "reports", ".stryker-tmp"]);

/** 收集测试源码。读文件是入口的活,判定不碰文件系统。 */
const collectSources = (): Map<string, string> => {
  const sources = new Map<string, string>();
  const walk = (directory: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true }) as import("node:fs").Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(path);
        continue;
      }
      if (!TEST_FILE.test(entry.name)) {
        continue;
      }
      try {
        sources.set(path, readFileSync(path, "utf8"));
      } catch {
        // 读不到的文件不算「干净」:它不在结论里,也不在缺陷里。
      }
    }
  };
  for (const root of SOURCE_ROOTS) {
    walk(`${repoRoot}${root}`);
  }
  return sources;
};

const main = (): number => {
  const sources = collectSources();
  if (sources.size === 0) {
    process.stderr.write("没找到任何测试源码:诊断是空转,不给结论。\n");
    return 1;
  }
  const diagnosis = diagnoseVitestRules(sources);
  const report = renderVitestRulesReport(diagnosis, {
    generatedAt: new Date().toISOString(),
  });

  const outputDir = `${repoRoot}reports/lint`;
  mkdirSync(outputDir, { recursive: true });
  const outputPath = `${outputDir}/vitest-rules.md`;
  writeFileSync(outputPath, report, "utf8");

  process.stdout.write(
    [
      `扫了 ${sources.size} 个测试文件。`,
      `零断言用例 ${diagnosis.zeroAssertionCases.length} 条,`,
      `用例级早退 ${diagnosis.caseLevelSkips.length} 处,`,
      `守卫落点 ${diagnosis.guardSites} 处(其中在守卫里的断言形态分布见报告)。`,
      "",
      `报告:${outputPath}`,
      "",
    ].join("\n"),
  );
  return 0;
};

process.exitCode = main();
