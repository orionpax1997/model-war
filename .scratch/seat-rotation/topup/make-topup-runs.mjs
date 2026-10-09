// make-topup-runs.mjs —— 票 04 灰区补矩阵的运行物料生成器(一次性,不是门禁)
//
// 目的:在 `runs/seat-rotation-topup/` 下现造 16 个对局的四座存档三件套 + `input.json`。
// 形态沿 `.scratch/contract-closure/make-runs.mjs` 的先例(同一份装载校验,同一批三件套),
// 差异只在场次矩阵(见下),故本文件不复述三件套的口径,只写矩阵的定义。
//
// 场次矩阵(共 16 局,累计真沙箱 60+16=76 ≤100,见 map 成本预算):
//   H 异质 12 局:基序列 [A,A,B,B](A=cell-a-melee-pressure,B=cell-b-expansion-economy)
//     × 3 图(corridor-split, fortress-core, open-clash,与 season.yaml 同序)
//     × 4 轮换(shift 0..3,左旋;与 `packages/runner/src/enumerate.ts` 的 rotateSeats 同构)。
//     每座位恰坐 A 6 局、B 6 局(3 图 × 2 shift),脚本-座位正交,落差可直接读座位效应。
//   S 对称校准 4 局:AAAA × 2 图 + BBBB × 2 图(取 open-clash 与 corridor-split:
//     前者是 contract-closure 混编局的参照图,后者是 c3 崩溃史的图,需稳定性信号;
//     fortress-core 为省预算只由 H 覆盖,此处如实记一笔)。
//
// 种子:与调度器同一派生 `H(masterSeed, comboId, mapIndex, seedIndex)`
// (`enumerate.ts` 的 deriveSeed 逐字同构,编码 `sha256("m|c|mi|si")` 前 8 hex→uint32)。
// masterSeed 取 `seat-rotation-topup-v1`(与赛季 `2026-m4` 不同源,独立样本);
// comboId `t1`(H) / `t1-calib`(S)。
//
// 存档执行体一律是 `benchmarks/` 的入库产物(`check:bench` 逐字节门禁作证,
// 本脚本运行前须先 `node packages/tools/src/benchmarks/run-benchmarks-gate.ts` 为绿)。
// 全部哈希现算,不照抄任何夹具占位值。meta.json 十一栏与 contract-closure maker 同形。
//
// 用法(在仓库根跑):
//   node packages/tools/src/benchmarks/run-benchmarks-gate.ts   # 先绿
//   node .scratch/seat-rotation/topup/make-topup-runs.mjs

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const RUNS = join(ROOT, "runs", "seat-rotation-topup");

const SHA = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path) => SHA(readFileSync(path));

// 沙箱 runtime hash 的真值。真源是 packages/schema/src/sandbox-runtime.ts;此处先读源文件
// 正则抽出再断言一致——值只此一处手写,漂移时本脚本当场红,不静默用旧值跑。
const schemaRuntimeSource = readFileSync(
  join(ROOT, "packages", "schema", "src", "sandbox-runtime.ts"),
  "utf8",
);
const runtimeHashInSource = schemaRuntimeSource.match(
  /SANDBOX_RUNTIME_HASH\s*=\s*"([0-9a-f]{64})"/,
)?.[1];
if (runtimeHashInSource === undefined) {
  throw new Error("读不到 packages/schema/src/sandbox-runtime.ts 的 SANDBOX_RUNTIME_HASH");
}
const SANDBOX_RUNTIME_HASH = runtimeHashInSource;

const RULESET = "v1";
const MASTER_SEED = "seat-rotation-topup-v1";

const CELLS = {
  a: "cell-a-melee-pressure",
  b: "cell-b-expansion-economy",
};

// 与 season.yaml 同序,下标即 mapIndex(种子派生与轮换说明都依赖这个顺序)。
const MAPS = ["corridor-split", "fortress-core", "open-clash"];

// 与 enumerate.ts 的 deriveSeed 逐字同构。
const deriveSeed = (masterSeed, comboId, mapIndex, seedIndex) => {
  const digest = createHash("sha256")
    .update(`${masterSeed}|${comboId}|${mapIndex}|${seedIndex}`)
    .digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
};

// 与 enumerate.ts 的 rotateSeats 同构:基序列按 shift 循环左移。
const rotateCells = (base, shift) => {
  const offset = ((shift % 4) + 4) % 4;
  return [...base.slice(offset), ...base.slice(0, offset)];
};

const MATCHES = [];
// H:异质 12 局,基 [A,A,B,B] × 3 图 × 4 shift。
const H_BASE = ["a", "a", "b", "b"];
for (const [mapIndex, map] of MAPS.entries()) {
  for (let shift = 0; shift < 4; shift += 1) {
    MATCHES.push({
      id: `h-${map}-s${shift}`,
      kind: "hetero",
      cells: rotateCells(H_BASE, shift),
      map,
      seed: deriveSeed(MASTER_SEED, "t1", mapIndex, shift),
    });
  }
}
// S:对称校准 4 局,AAAA/BBBB × open-clash/corridor-split。
for (const key of ["a", "b"]) {
  for (const map of ["open-clash", "corridor-split"]) {
    MATCHES.push({
      id: `s-${key.repeat(4)}-${map}`,
      kind: "symmetric",
      cells: [key, key, key, key],
      map,
      seed: deriveSeed(MASTER_SEED, "t1-calib", MAPS.indexOf(map), key === "a" ? 0 : 1),
    });
  }
}

const cellDir = (key) => join(ROOT, "benchmarks", CELLS[key]);
const readCell = (key) => ({
  scriptJs: readFileSync(join(cellDir(key), "script.js")),
  scriptTs: readFileSync(join(cellDir(key), "script.ts")),
});

// 先把上一轮同一批物料清掉,避免残留旧档(一次性、幂等)。
rmSync(RUNS, { recursive: true, force: true });

const manifest = [];
for (const match of MATCHES) {
  const matchDir = join(RUNS, match.id);
  const mapPath = join(ROOT, "maps", `${match.map}.json`);
  const mapSha256 = sha256File(mapPath);

  const archives = match.cells.map((key, seat) => {
    const archivePath = `runs/seat-rotation-topup/${match.id}/archive/seat${seat}`;
    const dir = join(ROOT, archivePath);
    mkdirSync(dir, { recursive: true });
    const { scriptJs, scriptTs } = readCell(key);
    writeFileSync(join(dir, "script.js"), scriptJs);
    writeFileSync(join(dir, "script.ts"), scriptTs);

    const scriptSha256 = SHA(scriptJs);
    const meta = {
      model: CELLS[key],
      modelVersion: "bench-2026-10-final",
      generatedAt: "2026-06-01T00:00:00Z",
      protocolRounds: 1,
      prompts: [`benchmark cell ${CELLS[key]} (strategy ${key.toUpperCase()})`],
      generationLog: [`runtime hash ${SANDBOX_RUNTIME_HASH}`],
      ruleset: RULESET,
      validation: { passed: true, errors: [] },
      tscVersion: "7.0.2",
      scriptSha256,
      sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
    };
    const metaBytes = `${JSON.stringify(meta, null, 2)}\n`;
    writeFileSync(join(dir, "meta.json"), metaBytes, "utf8");
    return { archivePath, scriptSha256, metaSha256: SHA(metaBytes) };
  });

  const input = { archives, map: match.map, mapSha256, seed: match.seed, ruleset: RULESET };
  mkdirSync(matchDir, { recursive: true });
  writeFileSync(join(matchDir, "input.json"), `${JSON.stringify(input, null, 2)}\n`, "utf8");
  // 顺带把所用地图复制进对局目录,便于人工核对 mapSha256 的来源(非必需,装载不读它)。
  copyFileSync(mapPath, join(matchDir, `${match.map}.json`));
  manifest.push({ id: match.id, kind: match.kind, cells: match.cells, map: match.map, seed: match.seed });
  process.stdout.write(`wrote ${match.id} (${match.kind}, map ${match.map}, seed ${match.seed})\n`);
}
writeFileSync(join(RUNS, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(`\n${MATCHES.length} matches materialized under ${RUNS}\n`);
