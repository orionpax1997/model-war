/**
 * `modelwar match` 的处理器:装载 → 校验 → 跑一局 → 写回放 → 映射退出码。
 *
 * ── 为什么这一格在 `apps/cli` 而不在 engine ──
 *
 * 磁盘 I/O(hld §2.2.8)与 ajv 校验(那**唯一**一个实例)都在这一侧。engine 的 `runMatch` 是纯函数:
 * 吃已装载的世界、吐回放行。所以「装载期拒跑(退出码 2)」与「跑起来(0/1)」的分界正好落在这个模块
 * 的边界上——`runMatch` 之前的一切都是装载期。
 *
 * ── 退出码二分(规则内结果一律 0) ──
 *
 * - `0`:产出了一份合法 `result` 行。**胜/负/超时/四方全淘汰/席位异常出局/经济死亡全都是 0**——
 *   gdd 的异常与出局机制意味着一份**完全正常**的对局可以带着异常出局的席位;给它非零码会让
 *   赛季按 hld §8.4 的崩溃条款重跑并剔除,让合法对局从报告里消失。
 * - `2`:装载期拒跑(输入缺项/哈希不符/规则集版本三处不一致/地图非法/存档缺档/四座不齐)。
 * - `1`:引擎自身故障(未捕获异常、确定性断言失败)。`1` 是所有非零里**唯一不该有的**值——
 *   刻意选的,任何误用立刻暴露。
 *
 * ── 为什么规则集版本三处一致在这里判,不在 engine ──
 *
 * hld §7.1 自陈「被校验过不等于被装载时校验过」:`rulesets/vN.json` 的文件名与 `docs/rules-vN/`
 * 的目录名都要读盘才知道,engine 拿不到这两个名字。错配即拒(FR-10 AC2),不静默降级。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { RULESET_VERSION, type JsonValue, type MapDefinition } from "@model-war/schema";
import { runMatch, type RunMatchResult } from "@model-war/engine";
import type { ReplayPlayerRef, ReplaySeat } from "@model-war/replay";

import {
  validateArchiveMeta,
  validateMap,
  validateMatchInput,
  validateRuleset,
  type MeasuredArchive,
} from "../validator.js";
import { measureSandboxRuntimeHash } from "./sandbox-runtime.js";

/** 进程退出码。名字让三处 `return` 各自可读。 */
const EXIT_OK = 0;
const EXIT_LOAD_REJECTED = 2;
const EXIT_ENGINE_FAULT = 1;

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** 把一条 `ValidationRejection` 渲染成面向人的几行(用面向模型层那组短句),写到 stderr。 */
const reportRejection = (label: string, rejection: { readonly modelDiagnostics: readonly string[] }): void => {
  process.stderr.write(`${label}\n`);
  for (const diagnostic of rejection.modelDiagnostics) {
    process.stderr.write(`  ${diagnostic}\n`);
  }
};

/** 存档三件套在不在。缺哪一件由 01 票的 `validateArchiveMeta` 判,这里只如实报。 */
type ArchiveRead = {
  readonly present: { readonly scriptTs: boolean; readonly scriptJs: boolean; readonly metaJson: boolean };
  readonly meta: JsonValue | undefined;
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
    meta: metaBytes === undefined ? undefined : (JSON.parse(metaBytes.toString("utf8")) as JsonValue),
    scriptSha256: scriptBytes === undefined ? undefined : sha256(scriptBytes),
    metaSha256: metaBytes === undefined ? undefined : sha256(metaBytes),
  };
};

/** 空转对局的策略:什么都不交回。冻结脚本文本→策略的编译是沙箱执行器那一格的事(见 `runMatch` 头注)。 */
const idleStrategy = () => () => [];

/**
 * `modelwar match <input.json>`。
 *
 * 用法约定(与 hld §7.4 的拓扑一致):`input.json` 所在的目录是这一局的根;地图与规则集按
 * **仓库根**的 `maps/` 与 `rulesets/` 取(用 `--root` 覆盖,测试用)。回放写到
 * `<input 所在目录>/replay.jsonl`。
 */
export const runMatchCommand = async (args: readonly string[]): Promise<number> => {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const inputPath = positional[0];
  if (inputPath === undefined) {
    process.stderr.write("用法:modelwar match <input.json> [--root <仓库根>]\n");
    return EXIT_LOAD_REJECTED;
  }
  const rootIndex = args.indexOf("--root");
  const root = resolve(rootIndex === -1 ? process.cwd() : (args[rootIndex + 1] ?? process.cwd()));

  try {
    return runMatchLoaded(inputPath, root);
  } catch (cause) {
    // 走到这里的是**引擎自身故障**(未捕获异常/确定性断言失败),不是装载期拒跑——
    // 装载期的每一条都在下面显式 `return EXIT_LOAD_REJECTED` 了。
    process.stderr.write(
      `modelwar match: 引擎故障:${cause instanceof Error ? cause.stack : String(cause)}\n`,
    );
    return EXIT_ENGINE_FAULT;
  }
};

/** 装载 + 校验 + 跑 + 写 + 映射退出码。分出去是为了让「try 边界」只包住引擎那一段。 */
const runMatchLoaded = (inputPath: string, root: string): number => {
  // ── 装载期:对局输入 ──
  let rawInput: JsonValue;
  try {
    rawInput = JSON.parse(readFileSync(inputPath, "utf8")) as JsonValue;
  } catch {
    process.stderr.write(`modelwar match: 读不了对局输入 ${inputPath}(不存在或不是合法 JSON)\n`);
    return EXIT_LOAD_REJECTED;
  }

  // 规则集版本三处一致(文件名/目录名/版本常量)先判:它错时后面每一条诊断都没意义。
  const rulesetFileName = basename(join(root, "rulesets", `${RULESET_VERSION}.json`));
  const rulesDocDirName = basename(join(root, "docs", `rules-${RULESET_VERSION}`));

  // 四个座位的存档:读三件套 + 实测哈希,组装 `measuredArchives`(下标即座位)。
  // `archivePath` 是**仓库根相对**的(hld §7.4 的拓扑:存档在仓库根下的 `archive/<model>/<runId>/`),
  // 所以按 root 解析,不是按 input.json 所在目录。
  const rawArchives = (rawInput as { readonly archives?: readonly { readonly archivePath?: string }[] })
    .archives;
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
    reportRejection("modelwar match: 对局输入未通过装载期校验:", inputValidation);
    return EXIT_LOAD_REJECTED;
  }
  const input = inputValidation.input;

  // 地图:读 + 校验(判 `map` 字段与实测哈希之外,还判地图本身合法)。
  let mapBytes: Buffer;
  try {
    mapBytes = readFileSync(join(root, "maps", `${input.map}.json`));
  } catch {
    process.stderr.write(`modelwar match: 读不了地图 ${input.map}.json\n`);
    return EXIT_LOAD_REJECTED;
  }
  const mapValidation = validateMap(JSON.parse(mapBytes.toString("utf8")) as JsonValue);
  if (!mapValidation.ok) {
    reportRejection("modelwar match: 地图未通过校验:", mapValidation);
    return EXIT_LOAD_REJECTED;
  }
  const map: MapDefinition = mapValidation.map;

  // 规则集:读 + 校验 + 版本三处一致(FR-10 AC2 的错配拒跑就在这一步)。
  let rulesetBytes: Buffer;
  try {
    rulesetBytes = readFileSync(join(root, "rulesets", `${RULESET_VERSION}.json`));
  } catch {
    process.stderr.write(`modelwar match: 读不了规则集 rulesets/${RULESET_VERSION}.json\n`);
    return EXIT_LOAD_REJECTED;
  }
  const rulesetValidation = validateRuleset(
    JSON.parse(rulesetBytes.toString("utf8")) as JsonValue,
    { rulesetFileName, rulesDocDirName },
  );
  if (!rulesetValidation.ok) {
    reportRejection("modelwar match: 规则集未通过装载期校验:", rulesetValidation);
    return EXIT_LOAD_REJECTED;
  }

  // 四份存档的 meta 也要各自过 01 票的 `validateArchiveMeta`(缺档/哈希/sandbox hash/轮数)。
  const players: ReplayPlayerRef[] = [];
  for (const [seat, archive] of input.archives.entries()) {
    const archiveDir = resolve(root, archive.archivePath);
    const read = readArchiveMeta(archiveDir);
    if (read.meta === undefined) {
      process.stderr.write(`modelwar match: 座位 ${String(seat)} 的存档缺 meta.json\n`);
      return EXIT_LOAD_REJECTED;
    }
    const metaValidation = validateArchiveMeta(read.meta, {
      filesPresent: read.present,
      measuredScriptSha256: read.scriptSha256 ?? null,
      measuredSandboxRuntimeHash: measureSandboxRuntimeHash(),
      loadedRulesetVersion: RULESET_VERSION,
    });
    if (!metaValidation.ok) {
      reportRejection(`modelwar match: 座位 ${String(seat)} 的存档 meta 未通过校验:`, metaValidation);
      return EXIT_LOAD_REJECTED;
    }
    players.push({ model: metaValidation.meta.model, archiveRef: archive.archivePath, seat: seat as ReplaySeat });
  }

  // ── 跑一局(engine 纯函数) ──
  const lines: string[] = [];
  const outcome: RunMatchResult = runMatch({
    ruleset: rulesetValidation.ruleset,
    map,
    seed: input.seed,
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: input.mapSha256 },
    players,
    strategies: [idleStrategy(), idleStrategy(), idleStrategy(), idleStrategy()],
    sink: { write: (line) => void lines.push(line) },
  });

  // ── 写回放 ──
  // 回放与输入物化件同目录(hld §7.5 的拓扑:`matches/<...>/replay.jsonl`)。
  const replayPath = join(dirname(inputPath), "replay.jsonl");
  writeFileSync(replayPath, `${lines.join("\n")}\n`);
  process.stdout.write(
    `modelwar match: ${outcome.tickCount} tick 已结算,回放写入 ${replayPath}(runner=stub,${outcome.result.reason})\n`,
  );
  return EXIT_OK;
};
