/**
 * 入口:读入库基线 → 变异分数趋势报告。
 *
 * 形状与 `run-mutation-diagnose.ts` 一致:入口只做四件事(读文件、调纯函数、落盘、设退出码)。
 *
 * **它是观测,不是门禁**:只读基线、只写一份报告,不判定任何东西、不改任何东西。
 * 特别地:它**不能**改基线——能改判据的开关不能出现在判据自己的路径上(《门禁纪律》)。
 *
 * 退出码:0 = 报告已生成;1 = 读不到任何基线(空转,不是「没有趋势」)。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { diagnoseHistory, type HistoryDiagnosis } from "./history.ts";
import { isShardBaseline, type ShardBaseline } from "./ratchet.ts";
import { shardNames } from "./shards.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const baselineDir = `${repoRoot}stryker/baseline`;

/** 读全部分片的入库基线。读不出形状不对的那份就跳过,并在报告里点名。 */
const readBaselines = (): {
  readonly baselines: readonly ShardBaseline[];
  readonly broken: readonly string[];
} => {
  const baselines: ShardBaseline[] = [];
  const broken: string[] = [];
  for (const name of shardNames()) {
    const path = `${baselineDir}/${name}.json`;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      broken.push(`${name}(读不出来或不是 JSON)`);
      continue;
    }
    if (!isShardBaseline(raw)) {
      broken.push(`${name}(形状不合规)`);
      continue;
    }
    baselines.push(raw);
  }
  return { baselines, broken };
};

const render = (
  diagnosis: HistoryDiagnosis,
  broken: readonly string[],
  generatedAt: string,
): string => {
  const lines: string[] = [];
  lines.push("# 变异分数的趋势");
  lines.push("");
  lines.push(
    "每片一条**片内**的时间序列。历史来自入库基线文件里的 `history` 字段:",
    "产物会过期(夜间 artifact 只留 14 天),基线不会——历史随仓库走,随 diff 可见。",
  );
  lines.push("");
  lines.push(
    "**分片之间不可横向比较**:分片的 mutate 范围与统计口径各不一样,跨包覆盖会被静默记成",
    "Survived / NoCoverage。所以这份报告只做片内比较,不排名、不汇总总分。",
  );
  lines.push("");
  lines.push(`生成时刻:${generatedAt}`);
  lines.push("");
  lines.push("复跑:`pnpm run observe:history`(只读基线,不跑变异,不改基线)。");
  lines.push("");

  lines.push("## 摘要");
  lines.push("");
  lines.push("| 分片 | 历史条数 | 首个分数 | 最新分数 | 净变化 | 方向 |");
  lines.push("|---|---|---|---|---|---|");
  for (const shard of diagnosis.shards) {
    const first = shard.entries[0];
    const last = shard.entries[shard.entries.length - 1];
    lines.push(
      `| ${shard.shard} | ${shard.entries.length} | ` +
        `${first === undefined ? "—" : `${first.score.toFixed(2)}%`} | ` +
        `${last === undefined ? "—" : `${last.score.toFixed(2)}%`} | ` +
        `${shard.comparable ? `${shard.netChange >= 0 ? "+" : ""}${shard.netChange.toFixed(2)}` : "—"} | ` +
        `${shard.direction === "up" ? "↑ 升" : shard.direction === "down" ? "↓ 降" : shard.direction === "flat" ? "→ 平" : "— 不可比"} |`,
    );
  }
  lines.push("");
  lines.push(
    `有可比历史(≥2 条)的分片:${diagnosis.comparableShards} / ${diagnosis.shards.length}。`,
  );
  lines.push("");

  lines.push("## 逐片明细");
  lines.push("");
  for (const shard of diagnosis.shards) {
    lines.push(`### ${shard.shard}`);
    lines.push("");
    if (shard.entries.length === 0) {
      lines.push(
        "没有历史:这个分片的基线是在历史机制之前立的,",
        "下一次抬升会把当前值补成第一条。",
      );
      lines.push("");
      continue;
    }
    lines.push("| 时间 | detected | valid | 原始分 |");
    lines.push("|---|---|---|---|");
    for (const entry of shard.entries) {
      lines.push(
        `| ${entry.at} | ${entry.detected} | ${entry.valid} | ${entry.score.toFixed(2)}% |`,
      );
    }
    lines.push("");
    if (!shard.comparable) {
      lines.push("只有一条记录:还没有可比的前一次。");
      lines.push("");
      continue;
    }
    lines.push(
      `净变化:${shard.netChange >= 0 ? "+" : ""}${shard.netChange.toFixed(2)} 个百分点` +
        `(${shard.direction === "up" ? "升" : shard.direction === "down" ? "降" : "平"})。`,
    );
    lines.push("");
  }

  if (broken.length > 0) {
    lines.push("## 读不出的基线");
    lines.push("");
    for (const entry of broken) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
};

const main = (): number => {
  const { baselines, broken } = readBaselines();
  if (baselines.length === 0) {
    process.stderr.write("读不到任何入库基线:没有结论(空转不是「没有趋势」)。\n");
    return 1;
  }
  const diagnosis = diagnoseHistory(baselines);
  const report = render(diagnosis, broken, new Date().toISOString());
  const outputDir = `${repoRoot}reports/mutation`;
  mkdirSync(outputDir, { recursive: true });
  const outputPath = `${outputDir}/history.md`;
  writeFileSync(outputPath, report, "utf8");
  process.stdout.write(
    [
      `${diagnosis.shards.length} 个分片,${diagnosis.comparableShards} 个有可比历史。`,
      `报告:${outputPath}`,
      "",
    ].join("\n"),
  );
  return 0;
};

process.exitCode = main();
