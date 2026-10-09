/**
 * 引擎级**确定性**复现:真实冻结脚本组合触发 quickjs-ng 的 find-中断 GC 崩溃(issue #1792)。
 *
 * 它重建 season 票 11 那一局的 `input.json`(map `corridor-split`、seed `2936867027`、
 * 四席 = 该局存档,下标序即崩溃序),再跑 `modelwar match`。**不依赖网络 / 凭证**:四份存档
 * (archive/ 下,入库)与地图(maps/,入库)都在仓里,sha256 现算。
 *
 * 用法(先在仓库根 build 出 CLI 产物):
 *   pnpm run build && pnpm --filter @model-war/cli build
 *   node probes/quickjs-find-interrupt-gc/repro-match.mjs
 *
 * 退出码:0 = 该局跑满 600 tick(修复后的预期);2 = 引擎崩溃(修复前的预期)。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RUN_ID = "2026-10-09T01-09-09-599Z";
// 座位序即崩溃序:这一序(票 11 记录的 archives 序)稳定触发断言。
const SEATS = [
  "mimo-v2.6-flash",
  "muse-spark-1.3-contributor",
  "deepseek-v4-flash",
  "gpt-6-luna",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const archiveEntry = (slug) => {
  const dir = join(repoRoot, "archive", slug, RUN_ID);
  return {
    archivePath: `archive/${slug}/${RUN_ID}`,
    scriptSha256: sha256(readFileSync(join(dir, "script.js"))),
    metaSha256: sha256(readFileSync(join(dir, "meta.json"))),
  };
};

const mapName = "corridor-split";
const input = {
  archives: SEATS.map(archiveEntry),
  map: mapName,
  mapSha256: sha256(readFileSync(join(repoRoot, "maps", `${mapName}.json`))),
  seed: 2936867027,
  ruleset: "v1",
};

const workDir = mkdtempSync(join(tmpdir(), "mw-quickjs-find-repro-"));
const inputPath = join(workDir, "input.json");
writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);

const cli = join(repoRoot, "apps", "cli", "dist", "modelwar.mjs");
const cliExists = spawnSync("node", ["-e", `require('node:fs').accessSync(${JSON.stringify(cli)})`]);
if (cliExists.status !== 0) {
  process.stderr.write(
    `缺少 CLI 产物 ${cli}。先跑:pnpm run build && pnpm --filter @model-war/cli build\n`,
  );
  process.exit(1);
}

const result = spawnSync("node", [cli, "match", inputPath, "--root", repoRoot], {
  cwd: repoRoot,
  encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.stdout.write(
  `\n[repro] input.json = ${inputPath}\n[repro] modelwar match 退出码 = ${String(result.status)}\n`,
);
process.exit(result.status ?? 1);
