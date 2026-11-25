/**
 * CLI 进程级断言的共用夹具:`spawn` 打好的单文件产物,造地图池、对局输入、赛季根。
 *
 * 断言对象是**打好的单文件产物**,不是 `src/index.ts` 里的内部函数——改了内部结构而让这些
 * 断言失效,就是坏断言。所以每个用例都跑真实的 bundle。
 *
 * 为什么是「一个文件一份 harness」而不是模块级单例:断言按主题分住在四个文件里
 * (`cli` 表面 / `cli-match` 整场 / `cli-season` 赛季 / `cli-verify` 复算),vitest 的并行单位
 * 是**文件**,住在一个文件里的 44 个同步用例只能排队。分成四个文件各拿一个 worker,
 * 每个文件自己打一份 bundle(实测 ~0.4s),换来的是 80s 的单文件长尾被摊平。
 *
 * 这里**不**跑 `tsc -b`:那件事由 `vitest.global-setup.ts` 在任何测试模块加载之前做一次,
 * 失败即让整个运行失败。原先 `cli.test.ts` 的 `beforeAll` 里还各跑一次(增量空操作 ~0.1s),
 * 拆成四个文件后就是四次并发写 `.tsbuildinfo`——没有收益,只有竞态。
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { MapDefinition } from "@model-war/schema";
// 直接 import 入口(ADR-0038 第一条)。两件事:
// 1. 依赖图上多一条**最直接的边**:测试文件 → 入口源码。跨包的边指向产物(`dist/`),而
//    `git diff` 给的是 `src/`——所以选择器(scope/)还要把源码展开成产物才看得见跨包依赖;
//    这条边省掉的那一跳是「包内」。两者互补,不是替代。
// 2. 让 `runInProcess` 成立:同一条命令面能在同进程里跑,不必为拿一个退出码打一份 bundle。
// 入口末尾有 `argv[1]` 判定守卫,所以这个 import 不会触发执行。
import { main } from "./index.js";
import {
  QUICKJS_WASI_WASM_PATH,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  SANDBOX_RUNTIME_HASH,
} from "@model-war/schema";

export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const mapPath = fileURLToPath(new URL("../../../maps/open-clash.json", import.meta.url));

export const COMMANDS = ["gen", "run", "match", "replay", "verify", "map-lint"] as const;

export const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** 真沙箱 runtime 的实测哈希 = 入库产物字节的 sha256(真源在 `@model-war/schema`,由 gate:runtime 盯住)。 */
export const sandboxRuntimeHash = SANDBOX_RUNTIME_HASH;

export interface InProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 在**同一个进程里**跑一次命令行:断言「命令面的行为」,不付 esbuild 的账。
 *
 * 与 `run`(spawn 打好的 bundle)分工:本函数证「解析、路由、退出码、输出」这些行为,
 * `run` 证「进程边界成立」(退出码真的传出去、bundle 真的打得出来)。
 *
 * 捕获方式是替换 `process.stdout/stderr.write`——所以**同一个文件里的用例必须串行**,
 * 并行会互相截获对方的输出。vitest 的并行单位是文件,文件内的用例默认串行,这个前提成立。
 */
export const runInProcess = async (args: readonly string[]): Promise<InProcessResult> => {
  const out: string[] = [];
  const err: string[] = [];
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { status: await main(args), stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  }
};

/** 落库那张开阔对攻图(进程级断言的原料;它本身是合规的)。 */
export const openMap = (): MapDefinition => JSON.parse(readFileSync(mapPath, "utf8"));

/**
 * 候选清单里剔掉「已经被画成墙」的轨道。
 *
 * 夹具把候选轨道填进地形当墙用,而候选清单的语义是「种子可以往这里填墙」——两处同时留着
 * 同一组格子就是一条死格,新判据 `variant-slot-on-wall` 会把这张夹具图判失败。
 * 剔掉它们是让夹具自洽,不是给判据开口子:真图 `maps/*.json` 早已满足这条。
 */
export const slotsOf = (
  source: MapDefinition,
  used: readonly number[],
): Record<string, unknown> => ({
  variantSlots: source.variantSlots.filter((_, index) => !used.includes(index)),
});

/** 把候选变体轨道填进地形:第 `indexes` 几条。先清空原有墙,免得两图共享墙格。 */
export const terrainWithOrbits = (source: MapDefinition, indexes: readonly number[]): string[] => {
  const rows = source.terrain.map((row) => row.replaceAll("#", ".").split(""));
  for (const index of indexes) {
    for (const [x, y] of source.variantSlots[index] ?? []) {
      const row = rows[y];
      if (row !== undefined) row[x] = "#";
    }
  }
  return rows.map((row) => row.join(""));
};

/** 读回放为可改的对象数组,改完写回同一个目录(verify 按 `dirname(replay)/input.json` 找输入)。 */
export const editReplay = (
  replayPath: string,
  mutate: (lines: Record<string, unknown>[]) => void,
): void => {
  const lines = readFileSync(replayPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  mutate(lines);
  writeFileSync(replayPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
};

export interface CliHarness {
  /** 跑一次打好的产物,`cwd` 固定仓库根(不传 `env`,继承父进程)。 */
  readonly run: (args: readonly string[]) => SpawnSyncReturns<string>;
  /** 本文件专属的临时根:造池、造输入、造赛季都落在它下面。 */
  readonly scratch: string;
  /**
   * 在临时目录里造一个地图池并返回它的路径。
   *
   * `map-lint` 现在收的是**目录**,而 `maps/` 里只有一张图(池级判据要求至少 3 张),所以
   * 进程级断言得自己造池。造法与 `pool-lint.test.ts` 同源:沿用落库那张图的点位,
   * 墙从它的候选变体轨道里取——那 8 条轨道实测一格不压点位、天生四重对称。
   * 当了墙的轨道同时从候选清单里剔掉(`slotsOf`):夹具里 `orbitIndexes` 就是那张图**用掉**了
   * 哪几条候选轨道,它一进 `writePool`,地形与候选清单就一起由它决定,两处不可能再分叉。
   */
  readonly writePool: (
    maps: readonly {
      name: string;
      orbitIndexes?: readonly number[];
      terrain?: string[];
      patch?: Record<string, unknown>;
    }[],
  ) => string;
  /** 在临时目录里造一份**合法**的对局输入(4 份存档三件套 + input.json),返回 input.json 的路径。 */
  readonly writeMatchInput: (options?: {
    readonly tamper?:
      | "mapSha"
      | "scriptSha"
      | "metaSha"
      | "ruleset"
      | "dropArchive"
      | "sandboxHash";
    /** 用一份**真实基准脚本**当四席的执行体(目录名,如 `cell-a-melee-pressure`)。
     * 给了它就覆盖默认的 `function loop(){ return []; }` 夹具。 */
    readonly cell?: string;
    /** 用一段自定义 `script.js` 当执行体(四席相同);与 `cell` 互斥,二选一。 */
    readonly script?: string;
  }) => string;
  /** 复用 `writeMatchInput` 造好的料再补一份 `season.yaml`,返回赛季根与配置路径。 */
  readonly writeSeasonRoot: (options?: { readonly ruleset?: string; readonly script?: string }) => {
    readonly root: string;
    readonly configPath: string;
  };
  /** 在临时根下写一份回放(行数组),返回路径。 */
  readonly writeReplay: (lines: readonly unknown[]) => string;
  dispose: () => void;
}

export const prepareCli = async (): Promise<CliHarness> => {
  const scratch = mkdtempSync(`${tmpdir()}/modelwar-cli-`);
  const bundle = `${scratch}/modelwar.mjs`;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
  });

  // 目录名带序号:同一个临时根下造两个池时不会互相覆盖(否则断言顺序一变就读到别人的文件)。
  let poolSeq = 0;
  let seq = 0;

  const run = (args: readonly string[]): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [bundle, ...args], { cwd: repoRoot, encoding: "utf8" });

  const writePool: CliHarness["writePool"] = (maps) => {
    poolSeq += 1;
    const dir = join(scratch, `pool-${poolSeq}`);
    mkdirSync(dir, { recursive: true });
    const source = openMap();
    for (const map of maps) {
      const indexes = map.orbitIndexes ?? [];
      const terrain = map.terrain ?? terrainWithOrbits(source, indexes);
      writeFileSync(
        join(dir, `${map.name}.json`),
        JSON.stringify({
          ...source,
          ...slotsOf(source, indexes),
          terrain,
          name: map.name,
          ...map.patch,
        }),
      );
    }
    return dir;
  };

  /**
   * 存档与 input 写在同一个 `root` 下,`archivePath` 按仓库根相对(hld §7.4 的拓扑)。
   */
  const writeMatchInput: CliHarness["writeMatchInput"] = (options = {}) => {
    const root = mkdtempSync(`${scratch}/root-`);
    const mapBytes = readFileSync(mapPath);
    const mapSha = options.tamper === "mapSha" ? "d".repeat(64) : sha256Hex(mapBytes);

    // 执行体:默认空转夹具;给了基准目录就读它的**入库产物**(`script.js` 是真沙箱跑的那份),
    // 给了自定义脚本就用它。基准脚本走 CLI 公开面(而不是引擎内部 API)正是端到端要证的那条。
    const defaultScript = `function loop(){ return []; }\n`;
    const scriptJs =
      options.script ??
      (options.cell === undefined
        ? defaultScript
        : readFileSync(join(repoRoot, "benchmarks", options.cell, "script.js"), "utf8"));
    const scriptTs =
      options.cell === undefined
        ? defaultScript
        : readFileSync(join(repoRoot, "benchmarks", options.cell, "script.ts"), "utf8");

    const models = ["alpha", "beta", "gamma", "delta"];
    const archives = models.map((model, seat) => {
      const archivePath = `archive/${model}/r1`;
      const dir = join(root, archivePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "script.js"), scriptJs);
      writeFileSync(join(dir, "script.ts"), scriptTs);
      const scriptSha = sha256Hex(scriptJs);
      const meta = {
        model,
        modelVersion: "snapshot-1",
        generatedAt: "2026-01-01T00:00:00Z",
        protocolRounds: 1,
        prompts: [`prompt ${model}`],
        generationLog: [`generated ${model}`],
        ruleset: "v2",
        validation: { passed: true, errors: [] },
        tscVersion: "7.0.2",
        scriptSha256: scriptSha,
        sandboxRuntimeHash:
          options.tamper === "sandboxHash" && seat === 0 ? "0".repeat(64) : sandboxRuntimeHash,
      };
      const metaBytes = `${JSON.stringify(meta, null, 2)}\n`;
      writeFileSync(join(dir, "meta.json"), metaBytes);
      const recordedScript =
        options.tamper === "scriptSha" && seat === 0 ? "e".repeat(64) : scriptSha;
      const recordedMeta =
        options.tamper === "metaSha" && seat === 0 ? "f".repeat(64) : sha256Hex(metaBytes);
      return { archivePath, scriptSha256: recordedScript, metaSha256: recordedMeta };
    });

    if (options.tamper === "dropArchive") {
      rmSync(join(root, archives[2]?.archivePath ?? "", "script.js"), { force: true });
    }

    const input = {
      archives,
      map: "open-clash",
      mapSha256: mapSha,
      seed: 20260101,
      ruleset: options.tamper === "ruleset" ? "v1" : "v2",
    };
    const runDir = join(root, "runs", "r1", "matches", "c0");
    mkdirSync(runDir, { recursive: true });
    const inputPath = join(runDir, "input.json");
    writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
    // 地图按名复制到 root,让 --root 找得到;规则集也复制一份(装载期从 root 读它)。
    mkdirSync(join(root, "maps"), { recursive: true });
    writeFileSync(join(root, "maps", "open-clash.json"), mapBytes);
    mkdirSync(join(root, "rulesets"), { recursive: true });
    writeFileSync(
      join(root, "rulesets", "v2.json"),
      readFileSync(fileURLToPath(new URL("../../../rulesets/v2.json", import.meta.url))),
    );

    // 真沙箱把 runtime bundle 与 wasm 当**安装根下的资源**读(路径真源在 `@model-war/schema`);
    // 物化进临时 root,于是 `--root` 就是这一局的安装根,测试不必依赖仓库根的 node_modules 布局。
    const artifactPath = join(root, SANDBOX_RUNTIME_ARTIFACT_PATH);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, readFileSync(join(repoRoot, SANDBOX_RUNTIME_ARTIFACT_PATH)));
    const wasmPath = join(root, QUICKJS_WASI_WASM_PATH);
    mkdirSync(dirname(wasmPath), { recursive: true });
    writeFileSync(wasmPath, readFileSync(join(repoRoot, QUICKJS_WASI_WASM_PATH)));

    return inputPath;
  };

  /**
   * 显式给 `outputDir`,让产物目录名**确定**(默认 `runs/<时间戳>` 不可预测,断言无从下手)。
   * `M=1 × K=4 = 4 ≡ 0 (mod 4)`,四方一名册 → 1 组合 × 1 图 × 4 种子 = 4 局(真沙箱串行)。
   * `ruleset` 传非 v2 时改掉 alpha 的 `meta.ruleset`,用来钉住「前置拒绝」那条路径。
   */
  const writeSeasonRoot: CliHarness["writeSeasonRoot"] = (options = {}) => {
    const inputPath = writeMatchInput(
      options.script === undefined ? {} : { script: options.script },
    );
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    if (options.ruleset !== undefined) {
      const metaPath = join(root, "archive", "alpha", "r1", "meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      meta["ruleset"] = options.ruleset;
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    }
    writeFileSync(
      join(root, "season.yaml"),
      [
        'masterSeed: "season-1"',
        "ruleset: v2",
        "seeds: 4",
        "outputDir: runs/season",
        "maps:",
        "  - open-clash",
        "participants:",
        "  - archive/alpha/r1",
        "  - archive/beta/r1",
        "  - archive/gamma/r1",
        "  - archive/delta/r1",
        "",
      ].join("\n"),
    );
    return { root, configPath: "season.yaml" };
  };

  const writeReplay: CliHarness["writeReplay"] = (lines) => {
    const path = join(scratch, `replay-${String(seq++)}.jsonl`);
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    return path;
  };

  return {
    run,
    scratch,
    writePool,
    writeMatchInput,
    writeSeasonRoot,
    writeReplay,
    dispose: () => rmSync(scratch, { force: true, recursive: true }),
  };
};
