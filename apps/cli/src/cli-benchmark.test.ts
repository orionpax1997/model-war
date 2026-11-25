/**
 * **真实基准脚本**走 CLI 公开面:在真沙箱里跑完整场,不报未定义名、产出可复算的回放。
 *
 * 与 `cli-match.test.ts`(默认夹具的整场与 `--root` 解析)分开住:这里每份脚本都要起一个
 * 真 bwrap 沙箱跑 600 tick,vitest 的并行单位是文件。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prepareCli, type CliHarness } from "./cli-harness.js";

let cli: CliHarness;

beforeAll(async () => {
  cli = await prepareCli();
});

afterAll(() => {
  cli.dispose();
});

/**
 * 至少一份**真实基准脚本**要走 CLI 公开面(`match` 写回放、`verify` 复算)全绿。
 * 它**不是**夹具脚本、**不是**桩:夹具脚本只用得到极少几个注入面符号,而真实基准脚本要用
 * 完整注入面——它能跑通,就是「注入面铺全」的独立证据(hld §6.1)。
 * 执行体取 `benchmarks/<舱>/script.js` 这份**入库产物**(真沙箱编译执行的那一份)。
 */
it(
  "真实基准脚本 cell-a:match 写回放 → verify 复算一致,退出 0(真沙箱)",
  { timeout: 120_000 },
  () => {
    const inputPath = cli.writeMatchInput({ cell: "cell-a-melee-pressure" });
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const matched = cli.run(["match", inputPath, "--root", root]);
    expect(matched.status, matched.stderr).toBe(0);

    const replayPath = join(inputPath, "..", "replay.jsonl");
    const lines = readFileSync(replayPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // 真沙箱的一整场:meta 在前、600 个 tick、末行 result。
    expect(lines[0]?.["type"]).toBe("meta");
    expect(lines[0]?.["runner"]).toBe("quickjs");
    expect(lines.at(-1)?.["type"]).toBe("result");
    expect(lines.length).toBeGreaterThan(2);

    // 复算:按 input.json 重新执行,逐 tick 与末行都一致。
    const verified = cli.run(["verify", replayPath, "--root", root]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("逐项一致");
  },
);

/**
 * 基准脚本作为夹具在真沙箱里各跑完整场:**含 `cell-c`**。
 *
 * `cell-c`(占点不采集)在真规则下**不累积占领进度**——它的占领机制是猜的(契约 §5 未排期),
 * 那笔账归「占领契约补齐」这条开放项(hld §12),不是本仓库的缺口。这里要证的是
 * 它**仍能跑完**(产出合法 result 行),不假装它不存在,也不被它拖住。
 *
 * `cell-a` 不在这一组里:上面「真实基准脚本 cell-a:match 写回放 → verify 复算一致」那条
 * 已经把它跑了一整场,而且多验了一样(verify 复算)。同一份脚本在同一层再跑一遍,
 * 拿到的是同一行 meta 与同一个 result 类型——那 4.8s 不买到新证据。
 */
const BENCHMARK_CELLS = ["cell-b-expansion-economy", "cell-c-claim-no-harvest"] as const;

it.each(BENCHMARK_CELLS)(
  "真实基准脚本 %s 作为夹具在真沙箱里跑完整场,退出 0",
  { timeout: 120_000 },
  (cell) => {
    const inputPath = cli.writeMatchInput({ cell });
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const matched = cli.run(["match", inputPath, "--root", root]);
    // 「跑完整场」的判据 = 产出了一份合法的末行 result(规则内结果一律 0)。
    expect(matched.status, matched.stderr).toBe(0);
    const lines = readFileSync(join(inputPath, "..", "replay.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]?.["type"]).toBe("meta");
    expect(lines[0]?.["runner"]).toBe("quickjs");
    expect(lines.at(-1)?.["type"]).toBe("result");
  },
);
