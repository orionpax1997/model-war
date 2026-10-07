// make-runs.mjs —— 票 05 的运行物料生成器(一次性,不是门禁)
//
// 目的:在 `runs/contract-closure/` 下现造 10 个对局的四座存档三件套 + `input.json`。
// 存档用的是 `benchmarks/` 三份基准脚本的**入库产物**(`script.js` 才是真沙箱跑的那份),
// `script.ts` 只作随档源码。所有哈希一律**现算**,不照抄任何测试夹具里的占位值:
//   - `sandboxRuntimeHash`: `packages/schema` 的 `SANDBOX_RUNTIME_HASH`(本仓真值)
//   - `scriptSha256`: sha256(script.js 字节)
//   - `metaSha256`:   sha256(meta.json 字节,含尾换行)
//   - `mapSha256`:    sha256(maps/<map>.json 字节)
//
// 用法(在仓库根跑):`node .scratch/contract-closure/make-runs.mjs`

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const RUNS = join(ROOT, "runs", "contract-closure");

const SHA = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path) => SHA(readFileSync(path));

// 沙箱 runtime hash 的真值。真源是 packages/schema/src/sandbox-runtime.ts;此处按字面量取,
// 与真源漂移由 `check:runtime` 与装载期核对兜住(本脚本不引入第二真源,只引用同一常量值)。
const SANDBOX_RUNTIME_HASH = "46c93013071ebdc2ddd29e1d07604854a0a3e48fa2c6f1bf7f9e9cd811285f83";
const RULESET = "v1";
const SEED = 20260101;

const CELLS = {
  a: "cell-a-melee-pressure",
  b: "cell-b-expansion-economy",
  c: "cell-c-claim-no-harvest",
};

// 场次矩阵:9 个单策略(三舱 × 三图)+ 1 个四座混编 A/B/C/A。
const MATCHES = [
  { id: "a-open-clash", cells: ["a", "a", "a", "a"], map: "open-clash" },
  { id: "a-corridor-split", cells: ["a", "a", "a", "a"], map: "corridor-split" },
  { id: "a-fortress-core", cells: ["a", "a", "a", "a"], map: "fortress-core" },
  { id: "b-open-clash", cells: ["b", "b", "b", "b"], map: "open-clash" },
  { id: "b-corridor-split", cells: ["b", "b", "b", "b"], map: "corridor-split" },
  { id: "b-fortress-core", cells: ["b", "b", "b", "b"], map: "fortress-core" },
  { id: "c-open-clash", cells: ["c", "c", "c", "c"], map: "open-clash" },
  { id: "c-corridor-split", cells: ["c", "c", "c", "c"], map: "corridor-split" },
  { id: "c-fortress-core", cells: ["c", "c", "c", "c"], map: "fortress-core" },
  { id: "mixed-a-b-c-a", cells: ["a", "b", "c", "a"], map: "open-clash" },
];

const cellDir = (key) => join(ROOT, "benchmarks", CELLS[key]);
const readCell = (key) => ({
  scriptJs: readFileSync(join(cellDir(key), "script.js")),
  scriptTs: readFileSync(join(cellDir(key), "script.ts")),
});

// 先把上一轮同一批物料清掉,避免残留旧档(一次性、幂等)。
rmSync(RUNS, { recursive: true, force: true });

for (const match of MATCHES) {
  const matchDir = join(RUNS, match.id);
  const mapPath = join(ROOT, "maps", `${match.map}.json`);
  const mapSha256 = sha256File(mapPath);

  const archives = match.cells.map((key, seat) => {
    const archivePath = `runs/contract-closure/${match.id}/archive/seat${seat}`;
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

  const input = { archives, map: match.map, mapSha256, seed: SEED, ruleset: RULESET };
  mkdirSync(matchDir, { recursive: true });
  writeFileSync(join(matchDir, "input.json"), `${JSON.stringify(input, null, 2)}\n`, "utf8");
  // 顺带把所用地图复制进对局目录,便于人工核对 mapSha256 的来源(非必需,装载不读它)。
  copyFileSync(mapPath, join(matchDir, `${match.map}.json`));
  process.stdout.write(`wrote ${match.id} (map ${match.map})\n`);
}

process.stdout.write(`\n${MATCHES.length} matches materialized under ${RUNS}\n`);
