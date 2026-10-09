/**
 * `scan` 观测的入口:scc 可选,装了就落盘、没装就写跳过标记,退出码如实反映观测命令本身。
 *
 * 用 `node packages/tools/src/gate/run-scan-gate.ts` 直接跑(根脚本 `pnpm run scan`),
 * 与现有 `run-*-gate.ts` 同形——流水线内只调命名脚本,不裸 shell 一句 `scc ...`(ADR-0010)。
 * 本包以源码形式由 Node 的类型擦除执行,不产出 dist、也不设 bin,所以包内相对 import 写 `.ts`。
 *
 * ── 这不是门禁,是一条观测 ──
 * 没有任何分数或行数红线(spec §7、Out of Scope)。成或败都进 meta.json 落盘,供三夜基线对比;
 * 它红不红不该阻断别的 leg(夜间流水线按 `continue-on-error` 处理,那一条归票 07)。
 *
 * ── scc 是手动装的外部工具(无 npm 分发) ──
 * `command -v scc` 失败时写一份带 `skipped` 字段的 meta.json 并退 0:值班者看到一份空的
 * `reports/scan/`,必须能分清「今晚没装 scc」和「今晚没有代码」。这一支的判决由
 * `scan-gate.test.ts` 盯着(`buildScanMeta(null)`)。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildScanMeta, SCAN_META_PATH, SCAN_OUTPUT_DIR, scanArgumentList } from "./scan-gate.ts";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const sccVersion = (): string | null => {
  const probe = spawnSync("scc", ["--version"], { cwd: repoRoot, encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    return null;
  }
  return probe.stdout.trim();
};

const gitSha = (): string => {
  const probe = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : "";
};

const writeMeta = (meta: unknown): void => {
  writeFileSync(`${repoRoot}${SCAN_META_PATH}`, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
};

const main = (): number => {
  mkdirSync(`${repoRoot}${SCAN_OUTPUT_DIR}`, { recursive: true });

  const version = sccVersion();
  const facts = {
    sccVersion: version,
    gitSha: gitSha(),
    scannedAt: new Date().toISOString(),
    args: scanArgumentList(),
  } as const;

  if (version === null) {
    writeMeta(buildScanMeta(facts));
    process.stdout.write(
      `scan 观测:scc 未安装,跳过扫描,已写 ${SCAN_META_PATH}(skipped=scc-not-installed)。\n`,
    );
    return 0;
  }

  const observed = spawnSync("scc", scanArgumentList(), { cwd: repoRoot, stdio: "inherit" });
  const status = observed.status ?? 1;
  writeMeta(buildScanMeta({ ...facts, outcome: status === 0 ? "ok" : "failed" }));
  process.stdout.write(
    `scan 观测:scc ${version} 扫完(${status === 0 ? "绿" : "红"}),` +
      `产物 ${SCAN_META_PATH} / reports/scan/scc.json / reports/scan/scc.txt。\n`,
  );
  return status;
};

process.exitCode = main();
