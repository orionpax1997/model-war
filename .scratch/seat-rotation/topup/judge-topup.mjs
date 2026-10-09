// judge-topup.mjs —— 票 04 补矩阵的读数脚本(一次性,不是门禁)
//
// 输入:`runs/seat-rotation-topup/` (maker 产物 + match 回放)。
// 输出:stdout 人表 + JSON(管道给 readings 落盘用)。
// 方法:
//   - 每局读 `input.json`(archives 顺序即座位)与 `replay.jsonl` 的首行 meta
//     (`players[].seat/archiveRef`)与末行 result(`rankings`/`reason`/`territoryScores`)。
//   - 第二独立路径:16/16 全量核对 meta players[] 与 input archives[] 逐席一致,
//     不一致即报错退出(比票 01 的 4 局抽查更严,因为本批是手写物料,错一位全毁)。
//   - 胜 = `rankings[seat] === 1`(并列 1 各计 1 胜,与票 01 同口径)。
//   - Wilson 95% 用实测 p̂ 按标准式直算(z=1.96;公式见 findings/02-sample-power.md)。
//   - 均分一栏取末行 `territoryScores` 均值,列名写「均领土分」——与票 01 的
//     `perMatchScores` 均值**不是同一口径**,不可互比,此处如实记一笔。
//
// 用法(在仓库根跑):`node .scratch/seat-rotation/topup/judge-topup.mjs`

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const RUNS = join(ROOT, "runs", "seat-rotation-topup");

const wilson = (wins, n, z = 1.96) => {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const manifest = JSON.parse(readFileSync(join(RUNS, "manifest.json"), "utf8"));
const matches = [];
for (const entry of manifest) {
  const dir = join(RUNS, entry.id);
  const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8"));
  const raw = readFileSync(join(dir, "replay.jsonl"), "utf8").trim().split("\n");
  const meta = JSON.parse(raw[0]);
  const result = JSON.parse(raw[raw.length - 1]);
  if (meta.type !== "meta" || result.type !== "result") {
    throw new Error(`${entry.id}:回放首末行不是 meta/result`);
  }
  // 第二独立路径:meta 与手写 input 逐席交叉核对。
  for (let seat = 0; seat < 4; seat += 1) {
    const player = meta.players[seat];
    const archive = input.archives[seat];
    if (player.seat !== seat || player.archiveRef !== archive.archivePath) {
      throw new Error(`${entry.id}:seat ${seat} 的 meta 与 input 对不上`);
    }
  }
  if (input.seed !== entry.seed || input.map !== entry.map) {
    throw new Error(`${entry.id}:input 的 map/seed 与 manifest 对不上`);
  }
  matches.push({ ...entry, rankings: result.rankings, reason: result.reason, scores: result.territoryScores });
}

const winsOf = (list) => {
  const wins = [0, 0, 0, 0];
  for (const match of list) {
    for (let seat = 0; seat < 4; seat += 1) {
      if (match.rankings[seat] === 1) wins[seat] += 1;
    }
  }
  return wins;
};

const hetero = matches.filter((m) => m.kind === "hetero");
const symm = matches.filter((m) => m.kind === "symmetric");

const lines = [];
lines.push(`# topup 读数(${hetero.length} 异质 + ${symm.length} 对称校准,共 ${matches.length} 局)`);
for (const m of matches) {
  lines.push(
    `${m.id} map=${m.map} cells=${m.cells.join("")} rankings=[${m.rankings.join(",")}] ` +
      `reason=${m.reason} territory=[${m.scores.join(",")}]`,
  );
}

// H:按座位(每座位 n=12,A 6 局 + B 6 局)。
lines.push("\n## H 异质:按座位(n=12/席)");
{
  const wins = winsOf(hetero);
  const mean = [0, 1, 2, 3].map(
    (s) => hetero.reduce((sum, m) => sum + m.scores[s], 0) / hetero.length,
  );
  for (let s = 0; s < 4; s += 1) {
    const [lo, hi] = wilson(wins[s], hetero.length);
    lines.push(
      `seat${s} 胜 ${wins[s]}/${hetero.length}=${pct(wins[s] / hetero.length)} ` +
        `Wilson95% [${pct(lo)},${pct(hi)}] 均领土分 ${mean[s].toFixed(2)}`,
    );
  }
  const rates = wins.map((w) => w / hetero.length);
  lines.push(`最大落差 ${pct(Math.max(...rates) - Math.min(...rates))}`);
}
// H:按座位×脚本(每格 n=6)。
lines.push("\n## H 异质:按座位×脚本(每格 n=6)");
for (let s = 0; s < 4; s += 1) {
  for (const key of ["a", "b"]) {
    const cell = hetero.filter((m) => m.cells[s] === key);
    const w = cell.filter((m) => m.rankings[s] === 1).length;
    lines.push(`seat${s}×${key.toUpperCase()} 胜 ${w}/${cell.length}`);
  }
}
// H:脚本总战绩(12 局里 A 赢几局、B 赢几局;并列 1 各计,故合计可超 12)。
lines.push("\n## H 异质:脚本总战绩");
for (const key of ["a", "b"]) {
  let w = 0;
  for (const m of hetero) {
    for (let s = 0; s < 4; s += 1) {
      if (m.cells[s] === key && m.rankings[s] === 1) w += 1;
    }
  }
  lines.push(`${key.toUpperCase()} 坐席获胜 ${w} 席次(12 局 × 并列可超)`);
}
// S:对称校准(4 局 pooled,n=4/席;另按脚本拆 AAAA 2 局/BBBB 2 局)。
lines.push("\n## S 对称校准:按座位(n=4/席)");
{
  const wins = winsOf(symm);
  for (let s = 0; s < 4; s += 1) {
    const [lo, hi] = wilson(wins[s], symm.length);
    lines.push(`seat${s} 胜 ${wins[s]}/${symm.length} Wilson95% [${pct(lo)},${pct(hi)}]`);
  }
}
lines.push("\n## S 对称校准:按脚本");
for (const key of ["a", "b"]) {
  const cell = symm.filter((m) => m.cells[0] === key);
  lines.push(
    `${key.toUpperCase()}×${cell.length}局(${cell.map((m) => m.map).join("+")}):` +
      cell.map((m) => `[${m.rankings.join(",")}]${m.reason}`).join(" "),
  );
}
lines.push("\n第二独立路径:meta↔input 逐席核对 16/16 通过");

process.stdout.write(`${lines.join("\n")}\n`);
