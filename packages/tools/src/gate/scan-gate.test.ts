/**
 * `scan` 观测纯函数层的单测:落盘形状的两支(装了 scc / 没装)与观测命令的 argv。
 *
 * 落 `unit` project(本轮无构建开销),所以它跟着 `check` 走。跑在 `gates` project 的那一份
 * (`gates.test.ts`)只断言位置纪律与真实脚本可调通,不重复这里的形状断言。
 */

import { expect, it } from "vitest";

import { buildScanMeta, SCAN_JSON_PATH, SCAN_TEXT_PATH, scanArgumentList } from "./scan-gate.ts";

const facts = {
  gitSha: "0123456789abcdef",
  scannedAt: "2026-10-09T00:00:00.000Z",
  args: scanArgumentList(),
} as const;

it("没装 scc 时 meta 只带 skipped,不伪装成一次空扫描", () => {
  const meta = buildScanMeta({ ...facts, sccVersion: null });
  expect(meta.tool).toBe("scc");
  expect(meta.config).toBe("none(--no-config)");
  expect(meta.skipped).toBe("scc-not-installed");
  // 二者必居其一:不能既没版本也没跳过标记——那样的产物读起来像「扫了,但什么都没扫到」。
  expect(meta.version).toBeUndefined();
  expect(meta.outcome).toBeUndefined();
});

it("装了 scc 时 meta 记版本与成败,不记 skipped", () => {
  const ok = buildScanMeta({ ...facts, sccVersion: "scc version 4.0.0", outcome: "ok" });
  expect(ok.version).toBe("scc version 4.0.0");
  expect(ok.skipped).toBeUndefined();
  expect(ok.outcome).toBe("ok");

  const failed = buildScanMeta({ ...facts, sccVersion: "scc version 4.0.0", outcome: "failed" });
  expect(failed.outcome).toBe("failed");
});

it("观测命令带 --no-config 与多格式落盘,口径不随仓库里的 .sccconfig 漂移", () => {
  const args = scanArgumentList();
  expect(args).toContain("--no-config");
  expect(args).toContain("--by-file");
  expect(args).toContain("--cognitive");
  expect(args.join(" ")).toContain(`json:${SCAN_JSON_PATH}`);
  expect(args.join(" ")).toContain(`tabular:${SCAN_TEXT_PATH}`);
});
