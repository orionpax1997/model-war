/**
 * 门禁:**跨进程一致性**——抽一份正式对局样本,在两个进程里重跑并逐 tick 比对状态 hash
 * (根脚本 `check:cross-process`)。
 *
 * ```
 * node --disable-warning=ExperimentalWarning \
 *   packages/tools/src/cross-process/run-cross-process-gate.ts \
 *   [--cell=<基准舱名>] [--seed=<整数>] [--tamper] [--keep]
 * ```
 *
 * ── 它证明什么(srs NFR-1 的 AC、spec 决策 2/3) ──────────────────────────────
 * NFR-1 的验收条款是「抽正式对局样本,重新执行并与 JSONL 比对,每 tick 状态 hash 一致」。
 * **同进程**十次重跑已经落在 `packages/engine/src/determinism.test.ts`(check 链上);本门禁补的是
 * **跨进程**那一层:进程 A `modelwar match <input.json>` 写一份回放,进程 B
 * `modelwar verify <replay.jsonl>` 按同一份 input.json **重新执行**并逐 tick 比对 `stateHash`。
 * 这条缝就是 hld §10.3 的复算链,也是 `apps/cli/src/cli.test.ts:676-701` 那条真实基准脚本端到端
 * 用例走的同一条公开面——本文件只是把那条用例从测试里提出来,变成一道独立的命名门禁。
 *
 * ── 样本从哪来 ──────────────────────────────────────────────────────────────
 * 执行体是**入库的冻结基准脚本** `benchmarks/<cell>/script.js`(它自己被 `check:bench` 逐字节钉在
 * `script.ts` 上),配固定种子、入库地图 `maps/open-clash.json` 与 `rulesets/v1.json`。门禁把四份
 * 存档三件套、input.json、地图、规则集、runtime bundle(`packages/engine/sandbox-runtime/
 * runtime.iife.js`,入库)与 `quickjs-wasi` 的 wasm(由 `pnpm install` 提供)现造进一个**临时
 * root**(做法同 `cli.test.ts` 的 `writeMatchInput`),让 `--root` 就是这一局的安装根;所有产物落在
 * 系统临时目录,仓库树里不留任何东西(`runs/**` 本就入库在外)。
 *
 * **为什么不入库一份冻结 `input.json`**(票面给的另一条路):这份样本的可复现输入只有四样——冻结
 * 脚本、固定种子、入库地图、入库规则集——它们在库里各自已被逐字节钉住(`check:bench`、地图 lint、
 * `rulesets/v1.json` 是取值真源)。再入库一份由这四样派生的 `input.json`,只多一份会与那四样悄悄
 * 漂移的副本。基准脚本正是 srs NFR-1 说的「正式对局样本」的执行体:它要用**完整注入面**,而注入面
 * 铺没铺全,恰好由这条跨进程复算连同证明。
 *
 * ── 红/绿与反例 ─────────────────────────────────────────────────────────────
 * 退出码:0 = 两个进程都退 0 且 verify 报「逐 tick 逐项一致」;1 = 任一处不成立(含「一个 tick 都
 * 没有」这种假绿)。`--tamper` 是反例开关:match 跑完后把回放里一个 tick 的 `stateHash` 改掉一位,
 * 再交给 verify——门禁必红。它使 `gates-slow.test.ts` 能注入一份被改的回放,而不必去动仓库里的任何
 * 东西。`--keep` 保留临时 root(排障用),默认删。
 *
 * ── 它属于哪一层 ────────────────────────────────────────────────────────────
 * 它 spawn 一次 `tsc -b` + esbuild 打一份 CLI 单文件 bundle(与 `cli.test.ts:52-58` 同形),再真跑
 * 一局真沙箱——**不是零构建**的 `gate/run-*-gate.ts` 那一族,故归**按需→夜间**层:不进
 * `check:quick` / `check` / `test` / `verify:fast`(spec §3 与用户故事 19)。它的位置纪律由
 * `packages/tools/src/gates.test.ts` 的 `跨进程一致性门禁按需跑…` 盯着。
 *
 * ── 与另两份文档的分工 ──────────────────────────────────────────────────────
 * F ⇢ L 的桩结论复验矩阵(gdd §8 #7/#8/#9/#10 的夹具位置 / 复验形态 / 停止条件)在
 * `.scratch/release-gates/verification-matrix.md`,本文件只引用、不重复它的内容。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/** 仓库根 = 本文件上溯四级(`packages/tools/src/cross-process/`)。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 入库基准脚本登记册(与 `packages/tools/src/benchmarks/compile.ts` 的清单同源,这里只列名)。 */
const BENCHMARK_CELLS = [
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
] as const;
type BenchmarkCell = (typeof BENCHMARK_CELLS)[number];

const DEFAULT_CELL: BenchmarkCell = "cell-a-melee-pressure";
/** 与 `cli.test.ts` 的 `writeMatchInput` 同一颗种子,样本因此逐次可复现。 */
const DEFAULT_SEED = 20260101;
const MAP_NAME = "open-clash";
const RULESET_VERSION = "v1";
const MODEL_SLOTS = ["alpha", "beta", "gamma", "delta"] as const;

// ── 命令行 ──────────────────────────────────────────────────────────────────

type Options = {
  readonly cell: BenchmarkCell;
  readonly seed: number;
  readonly tamper: boolean;
  readonly keep: boolean;
};

const parseArgs = (argv: readonly string[]): Options => {
  const valueOf = (prefix: string): string | undefined =>
    argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const cellText = valueOf("--cell=") ?? DEFAULT_CELL;
  if (!(BENCHMARK_CELLS as readonly string[]).includes(cellText)) {
    throw new Error(`--cell 必须是 ${BENCHMARK_CELLS.join(" / ")} 之一,收到 "${cellText}"。`);
  }
  const seedText = valueOf("--seed=");
  const seed = seedText === undefined ? DEFAULT_SEED : Number(seedText);
  if (!Number.isInteger(seed)) {
    throw new Error(`--seed 必须是整数,收到 "${seedText}"。`);
  }
  return {
    cell: cellText as BenchmarkCell,
    seed,
    tamper: argv.includes("--tamper"),
    keep: argv.includes("--keep"),
  };
};

// ── 进程与构建 ──────────────────────────────────────────────────────────────

type Outcome = { readonly status: number; readonly stdout: string; readonly stderr: string };

/** 与 `cli.test.ts` 的执行器同形:`cwd` 固定仓库根,不传 `env`(继承父进程)。 */
const run = (command: string, args: readonly string[]): Outcome => {
  const result = spawnSync(command, [...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

const CLI_ENTRY = join(repoRoot, "apps/cli/src/index.ts");
const TSC = join(repoRoot, "node_modules/typescript/bin/tsc");

/**
 * 备齐真沙箱复算需要的那份 CLI 产物:先 `tsc -b`(工作区包的 `exports` 指向 `dist/`),再 esbuild
 * 打一份单文件 bundle。返回 `null` 表示成功,否则返回一句可读的失败缘由。
 */
const buildCliBundle = async (outfile: string): Promise<string | null> => {
  const typecheck = run(process.execPath, [TSC, "-b", "--pretty", "false"]);
  if (typecheck.status !== 0) {
    return `tsc -b 失败:\n${typecheck.stdout}${typecheck.stderr}`;
  }
  try {
    await build({
      entryPoints: [CLI_ENTRY],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      outfile,
      logLevel: "silent",
    });
  } catch (cause) {
    return `esbuild 打 CLI bundle 失败:${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return null;
};

// ── 样本物化 ────────────────────────────────────────────────────────────────

const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

type ArchiveRecord = {
  readonly seat: number;
  readonly archivePath: string;
  readonly scriptSha256: string;
  readonly metaSha256: string;
};

type Sample = {
  readonly root: string;
  readonly inputPath: string;
  readonly replayPath: string;
  readonly scriptRelative: string;
  readonly archives: readonly ArchiveRecord[];
};

/** 沙箱资源在安装根下的相对路径(真源在 `@model-war/schema`,运行时动态取,不在这里手抄)。 */
type SandboxPaths = {
  readonly artifact: string;
  readonly wasm: string;
  readonly runtimeHash: string;
};

/**
 * 在临时 root 里现造一份「四份存档 + input.json + 地图 + 规则集 + 沙箱资源」的对局样本。
 * 形态逐条对齐 `cli.test.ts:writeMatchInput`,执行体换成**入库的基准脚本产物**。
 */
const materialize = (root: string, options: Options, sandbox: SandboxPaths): Sample => {
  const mapBytes = readFileSync(join(repoRoot, "maps", `${MAP_NAME}.json`));
  const scriptJs = readFileSync(join(repoRoot, "benchmarks", options.cell, "script.js"), "utf8");
  const scriptTs = readFileSync(join(repoRoot, "benchmarks", options.cell, "script.ts"), "utf8");

  const archives: readonly ArchiveRecord[] = MODEL_SLOTS.map((model, seat) => {
    const archivePath = `archive/${model}/r1`;
    const archiveDir = join(root, archivePath);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "script.js"), scriptJs);
    writeFileSync(join(archiveDir, "script.ts"), scriptTs);
    const scriptSha256 = sha256Hex(scriptJs);
    const meta = {
      model,
      modelVersion: "benchmark-product",
      generatedAt: "2026-01-01T00:00:00Z",
      protocolRounds: 1,
      prompts: [`基准脚本 ${options.cell} 作为第 ${String(seat)} 席的执行体`],
      generationLog: [`benchmarks/${options.cell}/script.js`],
      ruleset: RULESET_VERSION,
      validation: { passed: true, errors: [] },
      tscVersion: "7.0.2",
      scriptSha256,
      sandboxRuntimeHash: sandbox.runtimeHash,
    };
    const metaBytes = `${JSON.stringify(meta, null, 2)}\n`;
    writeFileSync(join(archiveDir, "meta.json"), metaBytes);
    return { seat, archivePath, scriptSha256, metaSha256: sha256Hex(metaBytes) };
  });

  const runDir = join(root, "runs", "cross-process", "matches", "c0");
  mkdirSync(runDir, { recursive: true });
  const inputPath = join(runDir, "input.json");
  const input = {
    archives: archives.map((archive) => ({
      archivePath: archive.archivePath,
      scriptSha256: archive.scriptSha256,
      metaSha256: archive.metaSha256,
    })),
    map: MAP_NAME,
    mapSha256: sha256Hex(mapBytes),
    seed: options.seed,
    ruleset: RULESET_VERSION,
  };
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");

  // root 下的安装面:地图、规则集、runtime bundle、wasm(路径真源在 `@model-war/schema`)。
  mkdirSync(join(root, "maps"), { recursive: true });
  writeFileSync(join(root, "maps", `${MAP_NAME}.json`), mapBytes);
  mkdirSync(join(root, "rulesets"), { recursive: true });
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`)),
  );
  const artifactPath = join(root, sandbox.artifact);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, readFileSync(join(repoRoot, sandbox.artifact)));
  const wasmPath = join(root, sandbox.wasm);
  mkdirSync(dirname(wasmPath), { recursive: true });
  writeFileSync(wasmPath, readFileSync(join(repoRoot, sandbox.wasm)));

  return {
    root,
    inputPath,
    replayPath: join(runDir, "replay.jsonl"),
    scriptRelative: `benchmarks/${options.cell}/script.js`,
    archives,
  };
};

// ── 反例:改一个 tick 的 stateHash ────────────────────────────────────────────

/** 参数 `--tamper`:把回放里第一个 tick 的 `stateHash` 末位改掉(与 `cli.test.ts` 的反例同形)。 */
const tamperOneTick = (replayPath: string): void => {
  const lines = readFileSync(replayPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const tick = lines.find((line) => line["type"] === "tick");
  if (tick === undefined) {
    throw new Error("回放里没有 tick 行,无法制造反例。");
  }
  const hash = String(tick["stateHash"]);
  tick["stateHash"] = `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
  writeFileSync(replayPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
};

// ── 入口 ────────────────────────────────────────────────────────────────────

const tickCountOf = (replay: string): number =>
  replay
    .trim()
    .split("\n")
    .filter((line) => (JSON.parse(line) as { type?: string }).type === "tick").length;

const main = async (argv: readonly string[]): Promise<number> => {
  const options = parseArgs(argv);
  const scratch = mkdtempSync(join(tmpdir(), "model-war-cross-process-"));
  const bundlePath = join(scratch, "modelwar.mjs");
  try {
    const buildFailure = await buildCliBundle(bundlePath);
    if (buildFailure !== null) {
      process.stderr.write(`${buildFailure}\n`);
      process.stdout.write("跨进程一致性门禁:红(CLI 产物没打出来)\n");
      return 1;
    }
    // `tsc -b` 已跑过,`@model-war/schema` 的 dist 一定在;动态取路径真源,不在本文件手抄。
    const sandbox = await import("@model-war/schema");
    const sample = materialize(join(scratch, "root"), options, {
      artifact: sandbox.SANDBOX_RUNTIME_ARTIFACT_PATH,
      wasm: sandbox.QUICKJS_WASI_WASM_PATH,
      runtimeHash: sandbox.SANDBOX_RUNTIME_HASH,
    });

    process.stdout.write("跨进程一致性门禁:正式对局样本 match(进程 A)→ verify(进程 B)\n");
    process.stdout.write(
      `样本:cell=${options.cell},种子=${String(options.seed)},地图=${MAP_NAME},` +
        `规则集=${RULESET_VERSION},执行体=${sample.scriptRelative}\n`,
    );
    process.stdout.write(
      `席位:${sample.archives.map((archive) => `archive/${MODEL_SLOTS[archive.seat]}/r1`).join(" / ")}\n`,
    );

    // ── 进程 A:装载 → 跑一局 → 写回放 ──
    const matched = run(process.execPath, [
      bundlePath,
      "match",
      sample.inputPath,
      "--root",
      sample.root,
    ]);
    process.stdout.write(
      `进程 A(match):退出码 ${String(matched.status)}|${matched.stdout.trim()}\n`,
    );
    if (matched.status !== 0) {
      process.stderr.write(matched.stderr);
      process.stdout.write("跨进程一致性门禁:红(进程 A 没跑出回放)\n");
      return 1;
    }

    const tickCount = tickCountOf(readFileSync(sample.replayPath, "utf8"));
    process.stdout.write(`回放:${sample.replayPath}(tick ${String(tickCount)} 行)\n`);

    if (options.tamper) {
      tamperOneTick(sample.replayPath);
      process.stdout.write("反例(--tamper):已把回放里第一个 tick 的 stateHash 改掉一位\n");
    }

    // ── 进程 B:按同一份 input.json 重新执行 → 逐 tick 比对 stateHash ──
    const verified = run(process.execPath, [
      bundlePath,
      "verify",
      sample.replayPath,
      "--root",
      sample.root,
    ]);
    process.stdout.write(
      `进程 B(verify):退出码 ${String(verified.status)}|${verified.stdout.trim()}\n`,
    );
    if (verified.status !== 0) {
      for (const line of verified.stderr.trim().split("\n").slice(0, 12)) {
        process.stdout.write(`  ${line}\n`);
      }
    }

    const consistent = verified.status === 0 && verified.stdout.includes("逐项一致");
    process.stdout.write(
      `逐 tick hash:${
        consistent ? `一致(${String(tickCount)}/${String(tickCount)})` : "**不一致**"
      }\n`,
    );

    if (tickCount === 0) {
      process.stdout.write("跨进程一致性门禁:红(回放里一个 tick 都没有——防假绿)\n");
      return 1;
    }
    if (!consistent) {
      process.stdout.write("跨进程一致性门禁:红\n");
      return 1;
    }
    process.stdout.write("跨进程一致性门禁:绿\n");
    return 0;
  } finally {
    if (options.keep) {
      process.stdout.write(`临时 root 保留在 ${scratch}\n`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
};

process.exitCode = await main(process.argv.slice(2));
