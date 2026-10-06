/**
 * 组装层:`match` 与 `verify` 共用的「读盘 → 校验 → 造真沙箱执行器 → 跑一局」。
 *
 * ── 为什么这一格在 `apps/cli` 而不在 engine ──
 *
 * 磁盘 I/O(hld §2.2.8)与 ajv 校验(那**唯一**一个实例)都在这一侧;engine 的 `runMatch` 是纯函数:
 * 吃已装载的世界、吐回放行。所以「装载期拒跑(退出码 1)」与「跑起来(0/2)」的分界正好落在这里——
 * `assemble()` 之前的一切都是装载期,`executeMatch()` 里才是引擎。
 *
 * ── 组装层拿到的都是**字节**,不是路径 ──
 *
 * wasm 字节、runtime bundle 字节、脚本源码都由本模块读盘后交给 `createQuickJsRunner`;引擎侧
 * 一次读盘都没有(它只允许 `node:crypto` 一个内置模块)。VM 的建与释放(`dispose`)也归这里,
 * 引擎不持 VM(ADR-0005)。
 *
 * ── 为什么 `match` 与 `verify` 共用这一套 ──
 *
 * `verify` 的判据是「按同一套组装重新执行、逐 tick 比对」——两处各写一份组装就会让「同一套」
 * 退化成一句注释。所以组装只此一份,`verify` 复用它与 `executeMatch`。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  QUICKJS_WASI_VERSION,
  QUICKJS_WASI_WASM_PATH,
  RULESET_KEY_CATALOG,
  RULESET_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  type JsonValue,
  type MapDefinition,
  type MatchInput,
  type ReplayPlayerRef,
  type ReplaySeat,
  type Ruleset,
} from "@model-war/schema";
import { runMatch, type RunMatchParams, type RunMatchResult } from "@model-war/engine";
import {
  WASI_CLOCK_MS,
  WASI_RANDOM_FILL,
  WASI_TIMEZONE_OFFSET_MINUTES,
  createQuickJsRunner,
} from "@model-war/engine/runner";

import { EXIT_USAGE_OR_VALIDATION, type CommandFailure } from "../exit-codes.js";
import {
  validateArchiveMeta,
  validateMap,
  validateMatchInput,
  validateRuleset,
  type MeasuredArchive,
  type ValidationRejection,
} from "../validator.js";
import { measureSandboxRuntimeHash } from "./sandbox-runtime.js";

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** 存档三件套在不在 + meta 内容 + `script.js` 源码 + 两个实测哈希。 */
type ArchiveRead = {
  readonly present: {
    readonly scriptTs: boolean;
    readonly scriptJs: boolean;
    readonly metaJson: boolean;
  };
  readonly meta: JsonValue | undefined;
  /** `script.js` 的源码(真沙箱的执行体);缺档时 `undefined`。 */
  readonly scriptSource: string | undefined;
  readonly scriptSha256: string | undefined;
  readonly metaSha256: string | undefined;
};

const readArchiveMeta = (archiveDir: string): ArchiveRead => {
  const exists = (name: string): boolean => {
    try {
      readFileSync(join(archiveDir, name));
      return true;
    } catch {
      return false;
    }
  };
  const present = {
    scriptTs: exists("script.ts"),
    scriptJs: exists("script.js"),
    metaJson: exists("meta.json"),
  };
  const read = (name: string): Buffer | undefined => {
    try {
      return readFileSync(join(archiveDir, name));
    } catch {
      return undefined;
    }
  };
  const metaBytes = read("meta.json");
  const scriptBytes = read("script.js");
  return {
    present,
    meta:
      metaBytes === undefined ? undefined : (JSON.parse(metaBytes.toString("utf8")) as JsonValue),
    scriptSource: scriptBytes?.toString("utf8"),
    scriptSha256: scriptBytes === undefined ? undefined : sha256(scriptBytes),
    metaSha256: metaBytes === undefined ? undefined : sha256(metaBytes),
  };
};

/** 已装载、可执行的一局:世界 + 四份脚本源码 + 沙箱字节 + 预算与 meta 头。 */
export type LoadedRun = {
  readonly root: string;
  readonly seed: number;
  readonly ruleset: Ruleset;
  readonly map: MapDefinition;
  readonly players: readonly ReplayPlayerRef[];
  /** 四份 `script.js` 源码,下标即座位。 */
  readonly scripts: readonly string[];
  /** 入库 runtime bundle 的字节(组装层读盘传入,引擎不读盘)。 */
  readonly runtimeCode: string;
  /** `quickjs-wasi` 的 wasm 字节(四 VM 复用同一个编译后的 Module)。 */
  readonly wasmBytes: Buffer;
  readonly budget: NonNullable<RunMatchParams["budget"]>;
  readonly head: RunMatchParams["head"];
};

export type AssembleResult =
  | { readonly ok: true; readonly run: LoadedRun }
  | { readonly ok: false; readonly failure: CommandFailure };

const loadFailure = (
  message: string,
  rejection?: ValidationRejection,
): { readonly ok: false; readonly failure: CommandFailure } => ({
  ok: false,
  failure: {
    exitCode: EXIT_USAGE_OR_VALIDATION,
    message,
    ...(rejection === undefined ? {} : { details: rejection.modelDiagnostics }),
  },
});

/** 预算配置里对应规则集数值键的那几条轨。`scriptSizeLimit` 不在其中(它是编译期的事)。 */
const BUDGET_FIELDS = [
  "exceptionTickLimit",
  "eventTickLimit",
  "apiCallTickLimit",
  "memoryLimit",
  "memoryTickCeiling",
  "wallClockSoftLimit",
  "wallClockHardTimeout",
] as const;

/**
 * 从规则集与键清单解析**已启用**的预算轨。字段缺席即该轨不启用(不是「值 0 即不启用」)。
 *
 * 判据是键清单里那一个两态字段 `calibration.state`:未定值(`undetermined`)就不传这个字段——
 * 引擎不认识「未定值」这个概念(spec《未定值与预算配置》)。当前 v1 的八个预算键全是未定值,
 * 于是交出去的是一个空对象:四轨全不启用。
 */
const budgetOf = (ruleset: Ruleset): NonNullable<RunMatchParams["budget"]> => {
  const budget: Record<string, number> = {};
  for (const field of BUDGET_FIELDS) {
    if (RULESET_KEY_CATALOG[field].calibration.state === "undetermined") {
      continue;
    }
    budget[field] = ruleset[field];
  }
  return budget as NonNullable<RunMatchParams["budget"]>;
};

/** meta 头:真沙箱那一支的五栏读数都是工程常量/入库产物 hash,不是对局参数。 */
const headOf = (input: MatchInput): RunMatchParams["head"] => ({
  runner: "quickjs",
  // 装载时区(与本局无关;WASI 时区是另一栏 `wasiTimezoneOffset`)。
  timezoneOffset: "+00:00",
  mapHash: input.mapSha256,
  quickjsWasiVersion: QUICKJS_WASI_VERSION,
  sandboxRuntimeHash: measureSandboxRuntimeHash(),
  wasiClock: String(WASI_CLOCK_MS),
  wasiRandomFill: WASI_RANDOM_FILL,
  wasiTimezoneOffset: String(WASI_TIMEZONE_OFFSET_MINUTES),
});

/**
 * 装载 + 校验一局:`input.json` → 四份存档 → 地图 → 规则集 → 沙箱字节。
 *
 * `--root` 是这一局的**安装根**:地图与规则集按它的 `maps/` 与 `rulesets/` 取;runtime bundle 与
 * wasm 也当安装根下的资源读(路径常量取自 `@model-war/schema`)。生产 `--root` = 仓库根,
 * 测试 = 临时根(夹具把产物与 wasm 物化进去)。
 */
export const assemble = (inputPath: string, root: string): AssembleResult => {
  // ── 装载期:对局输入 ──
  let rawInput: JsonValue;
  try {
    rawInput = JSON.parse(readFileSync(inputPath, "utf8")) as JsonValue;
  } catch {
    return loadFailure(`读不了对局输入 ${inputPath}(不存在或不是合法 JSON)`);
  }

  // 规则集版本三处一致(文件名/目录名/版本常量)先判:它错时后面每一条诊断都没意义。
  const rulesetFileName = basename(join(root, "rulesets", `${RULESET_VERSION}.json`));
  const rulesDocDirName = basename(join(root, "docs", `rules-${RULESET_VERSION}`));

  // 四个座位的存档:读三件套 + 实测哈希,组装 `measuredArchives`(下标即座位)。
  // `archivePath` 是**仓库根相对**的(hld §7.4 的拓扑),所以按 root 解析,不是按 input.json 所在目录。
  const rawArchives = (
    rawInput as { readonly archives?: readonly { readonly archivePath?: string }[] }
  ).archives;
  const measuredArchives: (MeasuredArchive | null)[] = Array.from({ length: 4 }, (_, seat) => {
    const archivePath = rawArchives?.[seat]?.archivePath;
    if (archivePath === undefined) {
      return null;
    }
    const read = readArchiveMeta(resolve(root, archivePath));
    if (read.scriptSha256 === undefined || read.metaSha256 === undefined) {
      return null;
    }
    return { scriptSha256: read.scriptSha256, metaSha256: read.metaSha256 };
  });

  // 地图:按 `input.map` 找 `maps/<name>.json`,量实测哈希。
  const mapName = (rawInput as { readonly map?: string }).map;
  let measuredMapSha256 = "";
  if (mapName !== undefined) {
    try {
      measuredMapSha256 = sha256(readFileSync(join(root, "maps", `${mapName}.json`)));
    } catch {
      measuredMapSha256 = "";
    }
  }

  const inputValidation = validateMatchInput(rawInput, {
    rulesetFileName,
    rulesDocDirName,
    measuredArchives,
    measuredMapSha256,
  });
  if (!inputValidation.ok) {
    return loadFailure("对局输入未通过装载期校验", inputValidation);
  }
  const input = inputValidation.input;

  // 地图:读 + 校验(判 `map` 字段与实测哈希之外,还判地图本身合法)。
  let mapBytes: Buffer;
  try {
    mapBytes = readFileSync(join(root, "maps", `${input.map}.json`));
  } catch {
    return loadFailure(`读不了地图 ${input.map}.json`);
  }
  const mapValidation = validateMap(JSON.parse(mapBytes.toString("utf8")) as JsonValue);
  if (!mapValidation.ok) {
    return loadFailure("地图未通过校验", mapValidation);
  }
  const map: MapDefinition = mapValidation.map;

  // 规则集:读 + 校验 + 版本三处一致(FR-10 AC2 的错配拒跑就在这一步)。
  let rulesetBytes: Buffer;
  try {
    rulesetBytes = readFileSync(join(root, "rulesets", `${RULESET_VERSION}.json`));
  } catch {
    return loadFailure(`读不了规则集 rulesets/${RULESET_VERSION}.json`);
  }
  const rulesetValidation = validateRuleset(
    JSON.parse(rulesetBytes.toString("utf8")) as JsonValue,
    { rulesetFileName, rulesDocDirName },
  );
  if (!rulesetValidation.ok) {
    return loadFailure("规则集未通过装载期校验", rulesetValidation);
  }

  // 四份存档的 meta 也要各自过 01 票的 `validateArchiveMeta`(缺档/哈希/sandbox hash/轮数);
  // 同时把 `script.js` 源码收起来给真沙箱用。四条存档的 runtime hash 与当前产物不一致即拒跑(不静默降级)。
  const players: ReplayPlayerRef[] = [];
  const scripts: string[] = [];
  for (const [seat, archive] of input.archives.entries()) {
    const archiveDir = resolve(root, archive.archivePath);
    const read = readArchiveMeta(archiveDir);
    if (read.meta === undefined) {
      return loadFailure(`座位 ${String(seat)} 的存档缺 meta.json`);
    }
    const metaValidation = validateArchiveMeta(read.meta, {
      filesPresent: read.present,
      measuredScriptSha256: read.scriptSha256 ?? null,
      measuredSandboxRuntimeHash: measureSandboxRuntimeHash(),
      loadedRulesetVersion: RULESET_VERSION,
    });
    if (!metaValidation.ok) {
      return loadFailure(`座位 ${String(seat)} 的存档 meta 未通过校验`, metaValidation);
    }
    if (read.scriptSource === undefined) {
      return loadFailure(`座位 ${String(seat)} 的存档缺 script.js(真沙箱没有可执行的脚本)`);
    }
    players.push({
      model: metaValidation.meta.model,
      archiveRef: archive.archivePath,
      seat: seat as ReplaySeat,
    });
    scripts.push(read.scriptSource);
  }

  // ── 沙箱字节:读盘(引擎不做磁盘 I/O) ──
  let runtimeCode: string;
  try {
    runtimeCode = readFileSync(join(root, SANDBOX_RUNTIME_ARTIFACT_PATH), "utf8");
  } catch {
    return loadFailure(
      `读不了入库 runtime bundle ${SANDBOX_RUNTIME_ARTIFACT_PATH}(--root 是不是仓库安装根?)`,
    );
  }
  let wasmBytes: Buffer;
  try {
    wasmBytes = readFileSync(join(root, QUICKJS_WASI_WASM_PATH));
  } catch {
    return loadFailure(`读不了 quickjs wasm ${QUICKJS_WASI_WASM_PATH}(--root 是不是仓库安装根?)`);
  }

  return {
    ok: true,
    run: {
      root,
      seed: input.seed,
      ruleset: rulesetValidation.ruleset,
      map,
      players,
      scripts,
      runtimeCode,
      wasmBytes,
      budget: budgetOf(rulesetValidation.ruleset),
      head: headOf(input),
    },
  };
};

/** 一次真沙箱执行的结果:回放行 + 终局 + tick 数 + 观测(本票只把它接出来,文件格式归票 09)。 */
export type ExecutedRun = {
  readonly lines: readonly string[];
  readonly result: RunMatchResult["result"];
  readonly tickCount: number;
  readonly observations: readonly string[];
};

/**
 * 真沙箱执行:编译 wasm(一次)→ 四个 VM → `runMatch` → 释放四个 VM。
 *
 * 建与释放都在这一个函数里成对出现:任一步抛异常都走 `finally` 把已建出来的 VM 释放掉,
 * 半个初始化好的 VM 不该漏出去。
 */
export const executeMatch = async (run: LoadedRun): Promise<ExecutedRun> => {
  const wasmModule = await WebAssembly.compile(run.wasmBytes);
  const handles = await Promise.all(
    ([0, 1, 2, 3] as const).map((seat) =>
      createQuickJsRunner({
        wasm: wasmModule,
        runtimeCode: run.runtimeCode,
        scriptCode: run.scripts[seat] ?? "",
        seat,
        ...(run.budget.memoryLimit === undefined ? {} : { memoryLimit: run.budget.memoryLimit }),
        ...(run.budget.memoryTickCeiling === undefined
          ? {}
          : { memoryTickCeiling: run.budget.memoryTickCeiling }),
      }),
    ),
  );
  try {
    const lines: string[] = [];
    const observations: string[] = [];
    const outcome: RunMatchResult = runMatch({
      ruleset: run.ruleset,
      map: run.map,
      seed: run.seed,
      head: run.head,
      players: run.players,
      runners: handles.map((handle) => handle.runner),
      budget: run.budget,
      sink: { write: (line) => void lines.push(line) },
      // 观测出口**接好**(缺席静默丢弃):票 09 的墙钟软限/内存压力两类会从这里出来。
      observations: {
        record: (observation) => void observations.push(JSON.stringify(observation)),
      },
    });
    return { lines, result: outcome.result, tickCount: outcome.tickCount, observations };
  } finally {
    for (const handle of handles) {
      handle.dispose();
    }
  }
};
