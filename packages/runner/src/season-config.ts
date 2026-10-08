/**
 * `season.yaml` 的形状与装载(hld §9 的「`modelwar run` 读 `season.yaml`」)。
 *
 * ── 字段真源只在本模块 ──
 *
 * `season.yaml` 的字段、取值域与默认值语义**只在这里定义一处**;hld / srs / gdd 只写字段意图,
 * 不复制细节(hld §9)。本模块是**纯函数装载器**:只读文件、解析 YAML、逐字段校验,不碰时钟、
 * 不看 `cpus()`、不探 `maps/` 目录——凡依赖环境才能定的默认值,一律由调用方(薄壳 `runSeason`)
 * 注入:
 *   - `concurrency` 缺省 → `min(cpus, 8)`(调用方算);
 *   - `maps` 缺省 → `maps/` 下全部地图(调用方按 fs 读);
 *   - `outputDir` 缺省 → `runs/<新 runId>`(调用方按当前时刻生成);
 *   - `rankPoints` 缺省 → `DEFAULT_RANK_POINTS`(`[3,2,1,0]`,取自 `./ranker.js`)。
 * 因此本模块导出的 `SeasonConfig` 里这几个字段都是**可选**的,且**缺省不落成 undefined 键**
 * (`Object.hasOwn` 为 false),把「没写」与「写了 undefined」分开。
 *
 * ── 为什么不引 zod ──
 *
 * 全仓零 zod、零 YAML 库,唯一的运行时第三方依赖是 `apps/cli` 的 `ajv`,且校验器只在
 * `apps/cli` 一处(ADR-0003 的「校验栈只有一份」)。`models.yaml`(`packages/gen/src/config.ts`)
 * 的既有惯例就是**手写逐字段汇总报错**,本模块与它同款:先收集 `issues[]`,末尾一次拼成
 * 「一次看完」的清单 `赛季配置无效(<path>):\n  - …`。引 zod 会平添第二个校验栈,收益不抵成本。
 *
 * ── 本模块不判「存档是否存在」 ──
 *
 * 校验引用的存档 `archive/<slug>/<runId>` 是否存在需要 `root`,而装载器不接 `root`(纯函数)。
 * 存在性(以及规则版本与 <root>/rulesets 三处一致)由装载期检查负责(票 06)。本模块只校验
 * 形状与取值域:`participants` 至少 4 条、每条是非空字符串。同理,`maps` 缺省时 M 未知,
 * 故 `M × K ≡ 0 (mod 4)` 只在配置里显式给出 `maps` 时判定;缺省 maps 的兜底由 `enumerateMatchUps`
 * 在枚举期负责。
 */

import { readFileSync } from "node:fs";
import { RULESET_VERSION, type RulesetVersion } from "@model-war/schema";
import { rankPointsIssue, type RankPoints } from "./ranker.js";
import { parseYamlSubset } from "./yaml-lite.js";

/** 赛季配置(field 真源)。字段含义见文件头注;可选字段缺省语义由调用方注入。 */
export type SeasonConfig = {
  /** 赛季根种子,与组合 / 地图 / 种子序号一起决定每局种子。 */
  readonly masterSeed: string;
  /** 赛季唯一规则版本,须与当前 `RULESET_VERSION` 一致。 */
  readonly ruleset: RulesetVersion;
  /** 种子数 K,须满足 `M × K ≡ 0 (mod 4)`。 */
  readonly seeds: number;
  /** 参赛存档引用(`archive/<slug>/<runId>`),**下标即 playerIndex**,至少 4 条。 */
  readonly participants: readonly string[];
  /** 并发上限;缺省由调用方取 `min(cpus, 8)`。 */
  readonly concurrency?: number;
  /** 名次积分表;缺省由调用方取 `DEFAULT_RANK_POINTS`(`[3,2,1,0]`)。不进 `rulesets/`。 */
  readonly rankPoints?: RankPoints;
  /** 地图池(引用 `maps/` 下的 slug);缺省由调用方取 `maps/` 下全部。 */
  readonly maps?: readonly string[];
  /** 赛季产物目录;缺省由调用方取 `runs/<新 runId>`。 */
  readonly outputDir?: string;
};

/** 每个对局的座位数。`M × K` 必须能被它整除,座位轮换才精确均摊。 */
const SEAT_COUNT = 4;

/** 四方对局要求至少四名参赛者。 */
const MIN_PARTICIPANTS = 4;

/** `unknown` → 「键值对映射」的收窄判据(与 `packages/gen/src/record.ts` 同义,本包私有)。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 装载失败的统一出口:把逐字段问题拼成一份一次看完的清单(与 gen 的 `configError` 同款)。 */
const seasonError = (filePath: string, issues: readonly string[]): Error =>
  new Error(`赛季配置无效(${filePath}):\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);

const readSource = (filePath: string): string => {
  try {
    return readFileSync(filePath, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`读不到赛季配置 ${filePath}:${reason}`);
  }
};

const parseSource = (source: string, filePath: string): unknown => {
  try {
    return parseYamlSubset(source, filePath);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`赛季配置 YAML 解析失败(${filePath}):${reason}`);
  }
};

/** 必填字符串:缺失或类型不符时记一条问题并返回 `undefined`(不抛,继续攒清单)。 */
const requiredString = (
  entry: Record<string, unknown>,
  key: string,
  issues: string[],
): string | undefined => {
  const value = entry[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`必填字段 "${key}" 缺失或不是非空字符串`);
    return undefined;
  }
  return value;
};

/** 必填正整数 K。 */
const requiredSeeds = (entry: Record<string, unknown>, issues: string[]): number | undefined => {
  const value = entry.seeds;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issues.push('必填字段 "seeds" 必须是 ≥1 的整数(K,种子数)');
    return undefined;
  }
  return value;
};

/** 必填规则版本:必须等于当前 `RULESET_VERSION`(写错版本在此拦下,不静默降级)。 */
const parseRuleset = (
  entry: Record<string, unknown>,
  issues: string[],
): RulesetVersion | undefined => {
  const value = entry.ruleset;
  if (value === RULESET_VERSION) {
    return RULESET_VERSION;
  }
  if (value === undefined) {
    issues.push('必填字段 "ruleset" 缺失');
    return undefined;
  }
  issues.push(
    `必填字段 "ruleset" 取值 "${String(value)}" 与当前规则版本 "${RULESET_VERSION}" 不一致`,
  );
  return undefined;
};

/** 必填参赛存档引用列表:非空字符串数组,且至少 `MIN_PARTICIPANTS` 条。 */
const parseParticipants = (
  entry: Record<string, unknown>,
  issues: string[],
): readonly string[] | undefined => {
  const value = entry.participants;
  if (!Array.isArray(value)) {
    issues.push('必填字段 "participants" 缺失或不是数组(参赛存档引用,下标即 playerIndex)');
    return undefined;
  }
  if (value.length < MIN_PARTICIPANTS) {
    issues.push(
      `必填字段 "participants" 至少要有 ${MIN_PARTICIPANTS} 条参赛存档(四方对局),当前 ${value.length} 条`,
    );
    return undefined;
  }
  const participants: string[] = [];
  let valid = true;
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      issues.push(`participants[${index}] 必须是非空字符串(形如 archive/<slug>/<runId>)`);
      valid = false;
      return;
    }
    participants.push(item);
  });
  return valid ? participants : undefined;
};

/** 可选正整数(concurrency):给了就必须是 ≥1 的整数。 */
const optionalPositiveInteger = (
  entry: Record<string, unknown>,
  key: string,
  issues: string[],
): number | undefined => {
  const value = entry[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issues.push(`可选字段 "${key}" 必须是 ≥1 的整数`);
    return undefined;
  }
  return value;
};

/** 可选非空字符串(outputDir)。 */
const optionalString = (
  entry: Record<string, unknown>,
  key: string,
  issues: string[],
): string | undefined => {
  const value = entry[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`可选字段 "${key}" 必须是非空字符串`);
    return undefined;
  }
  return value;
};

/** 可选非空字符串数组(maps):给了就必须是非空、逐项非空字符串。 */
const optionalStringArray = (
  entry: Record<string, unknown>,
  key: string,
  issues: string[],
): readonly string[] | undefined => {
  const value = entry[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`可选字段 "${key}" 必须是非空数组(如 maps/ 下的 slug)`);
    return undefined;
  }
  const items: string[] = [];
  let valid = true;
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      issues.push(`${key}[${index}] 必须是非空字符串`);
      valid = false;
      return;
    }
    items.push(item);
  });
  return valid ? items : undefined;
};

/** 可选名次积分表:长度必须为 4、每项必须是有限数(判据复用 `./ranker.js` 的 `rankPointsIssue`)。 */
const optionalRankPoints = (
  entry: Record<string, unknown>,
  issues: string[],
): RankPoints | undefined => {
  const value = entry.rankPoints;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    issues.push('可选字段 "rankPoints" 必须是长度 4 的数组(第 i 项 = 第 i+1 名的分值)');
    return undefined;
  }
  const issue = rankPointsIssue(value);
  if (issue !== undefined) {
    issues.push(`可选字段 "rankPoints" 无效:${issue}`);
    return undefined;
  }
  // 已通过 rankPointsIssue 的四项校验,此处只是把 any[] 收窄成定长四元组。
  return [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
};

/** 兜住 TS 的收窄:走到这里说明 `issues` 为空,必填值必已就位。 */
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) {
    throw new Error(`内部错误:${label} 已通过校验却缺失`);
  }
  return value;
};

/**
 * 从 `season.yaml` 读入并校验赛季配置。
 *
 * 读不到文件 / YAML 语法错误 / 顶层非映射 / 缺必填字段 / 字段类型不符 / `ruleset` 与当前版本
 * 不一致 / `participants` 少于 4 条 / 显式 `maps` 时 `M × K ≢ 0 (mod 4)` / `rankPoints` 长度或
 * 取值不符 → 抛错,消息里逐条点名是哪个字段。成功则返回 `SeasonConfig`(可选字段缺席即不落键)。
 */
export const loadSeasonConfig = (filePath: string): SeasonConfig => {
  const data = parseSource(readSource(filePath), filePath);
  if (!isRecord(data)) {
    throw seasonError(filePath, [
      "顶层必须是一个键值对映射(masterSeed / ruleset / seeds / participants 等)",
    ]);
  }

  const issues: string[] = [];
  const masterSeed = requiredString(data, "masterSeed", issues);
  const ruleset = parseRuleset(data, issues);
  const seeds = requiredSeeds(data, issues);
  const participants = parseParticipants(data, issues);
  const concurrency = optionalPositiveInteger(data, "concurrency", issues);
  const rankPoints = optionalRankPoints(data, issues);
  const maps = optionalStringArray(data, "maps", issues);
  const outputDir = optionalString(data, "outputDir", issues);

  // 均摊条件:只有配置里显式给出 maps 时才判得了 M;缺省 maps 的兜底交给 enumerateMatchUps。
  if (maps !== undefined && seeds !== undefined) {
    const product = maps.length * seeds;
    if (product % SEAT_COUNT !== 0) {
      issues.push(
        `地图池与种子数不满足 M × K ≡ 0 (mod 4):当前 M=${maps.length} × K=${seeds} = ` +
          `${product}(mod 4 = ${product % SEAT_COUNT})`,
      );
    }
  }

  if (issues.length > 0) {
    throw seasonError(filePath, issues);
  }

  return {
    masterSeed: required(masterSeed, "masterSeed"),
    ruleset: required(ruleset, "ruleset"),
    seeds: required(seeds, "seeds"),
    participants: required(participants, "participants"),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(rankPoints !== undefined ? { rankPoints } : {}),
    ...(maps !== undefined ? { maps } : {}),
    ...(outputDir !== undefined ? { outputDir } : {}),
  };
};
