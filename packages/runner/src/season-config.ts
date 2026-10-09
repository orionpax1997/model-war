/**
 * `season.yaml` 的形状与装载(hld §9 的「`modelwar run` 读 `season.yaml`」)。
 *
 * ── 字段真源只在本模块 ──
 *
 * `season.yaml` 的字段、取值域与默认值语义**只在这里定义一处**;hld / srs / gdd 只写字段意图,
 * 不复制细节(hld §9)。本模块是**纯函数装载器**:只读文件、解析 YAML、用 zod 校验,不碰时钟、
 * 不看 `cpus()`、不探 `maps/` 目录——凡依赖环境才能定的默认值,一律由调用方(薄壳 `runSeason`)
 * 注入:
 *   - `concurrency` 缺省 → `min(cpus, 8)`(调用方算);
 *   - `maps` 缺省 → `maps/` 下全部地图(调用方按 fs 读);
 *   - `outputDir` 缺省 → `runs/<新 runId>`(调用方按当前时刻生成);
 *   - `rankPoints` 缺省 → `DEFAULT_RANK_POINTS`(`[3,2,1,0]`,取自 `./ranker.js`)。
 * 因此本模块导出的 `SeasonConfig` 里这几个字段都是**可选**的,且**缺省不落成 undefined 键**
 * (`Object.hasOwn` 为 false),把「没写」与「写了 undefined」分开。
 *
 * ── zod 只做「形状 + 结构域」,跨字段判据仍复用各自的家 ──
 *
 * 形状与逐字段取值域用 zod 定义(season schema 的唯一家);跨字段判据不在这里另写第二份,
 * 而是调各自既有判据:`rankPoints` 复用 `./ranker.js` 的 `rankPointsIssue`;`ruleset` 与
 * `RULESET_VERSION` 比对;显式 `maps` 的 `M × K ≡ 0 (mod 4)` 由本模块判(枚举期还有一条兜底)。
 * zod 的 `error.issues` 由 `issueMessageOf` 汇总成仓内惯用的「一次看完」清单
 * `赛季配置无效(<path>):\n  - …`(照 `packages/gen/src/config.ts` 的形态)。
 *
 * YAML 仍由本模块私有的 `./yaml-lite.ts` 读入(zod 不解析 YAML,且本仓无可用 ESM YAML 库)。
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
import { z } from "zod";
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

/** 名次积分表的固定长度(四方对局第 i 项 = 第 i+1 名)。 */
const RANK_POINTS_LENGTH = 4;

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

/**
 * season schema 的**唯一家**:形状 + 逐字段取值域用 zod 定义。
 *
 * 这一层只管「字段在不在、类型对不对、数组够不够长」;跨字段判据(版本比对、`rankPoints` 的
 * 内容、`M × K`)在下面那条 `superRefine` 里调各自的家,不在这里复制判据。
 */
const seasonSchema = z
  .object({
    masterSeed: z.string().min(1),
    ruleset: z.string(),
    seeds: z.number().int().min(1),
    participants: z.array(z.string().min(1)).min(MIN_PARTICIPANTS),
    concurrency: z.number().int().min(1).optional(),
    rankPoints: z.array(z.number()).optional(),
    maps: z.array(z.string().min(1)).min(1).optional(),
    outputDir: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    // ruleset 必须与当前版本一致(写错版本在此拦下,不静默降级)。
    if (value.ruleset !== RULESET_VERSION) {
      ctx.addIssue({
        code: "custom",
        path: ["ruleset"],
        message:
          `必填字段 "ruleset" 取值 "${value.ruleset}" ` +
          `与当前规则版本 "${RULESET_VERSION}" 不一致`,
      });
    }
    // rankPoints 的内容判据复用 ranker 的同一处(不新开第二条校验栈)。
    if (value.rankPoints !== undefined) {
      const issue = rankPointsIssue(value.rankPoints);
      if (issue !== undefined) {
        ctx.addIssue({ code: "custom", path: ["rankPoints"], message: issue });
      }
    }
    // 均摊条件:只有配置里显式给出 maps 时才判得了 M;缺省 maps 的兜底交给 enumerateMatchUps。
    if (value.maps !== undefined) {
      const product = value.maps.length * value.seeds;
      if (product % SEAT_COUNT !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["maps"],
          message:
            `地图池与种子数不满足 M × K ≡ 0 (mod 4):当前 M=${value.maps.length} × K=${value.seeds} = ` +
            `${product}(mod 4 = ${product % SEAT_COUNT})`,
        });
      }
    }
  });

/**
 * 把一条 zod issue 翻成仓内惯用的中文说明(zod 默认文案不含字段名,这里按 `path` 统一口吻)。
 *
 * 自定义 issue(`code === "custom"`,即上面 `superRefine` 加的那几条)的消息已是终稿,原样透出。
 */
const issueMessageOf = (issue: z.core.$ZodIssue, data: Record<string, unknown>): string => {
  if (issue.code === "custom") {
    return issue.message;
  }
  const [root, child] = issue.path;
  switch (root) {
    case "masterSeed":
      return '必填字段 "masterSeed" 缺失或不是非空字符串';
    case "ruleset": {
      const ruleset = data["ruleset"];
      if (ruleset === undefined) {
        return '必填字段 "ruleset" 缺失';
      }
      // 非字符串(如映射/数组)用 JSON 形态展示,避免 `String(object)` 的 `[object Object]`。
      const displayed = typeof ruleset === "string" ? ruleset : (JSON.stringify(ruleset) ?? "null");
      return `必填字段 "ruleset" 取值 "${displayed}" ` + `与当前规则版本 "${RULESET_VERSION}" 不一致`;
    }
    case "seeds":
      return '必填字段 "seeds" 必须是 ≥1 的整数(K,种子数)';
    case "concurrency":
      return '可选字段 "concurrency" 必须是 ≥1 的整数';
    case "outputDir":
      return '可选字段 "outputDir" 必须是非空字符串';
    case "rankPoints":
      return typeof child === "number"
        ? `可选字段 "rankPoints" 第 ${child} 项必须是有限数`
        : `可选字段 "rankPoints" 长度必须为 ${RANK_POINTS_LENGTH}` + `(第 i 项 = 第 i+1 名的分值)`;
    case "maps":
      return typeof child === "number"
        ? `maps[${child}] 必须是非空字符串`
        : '可选字段 "maps" 必须是非空数组(如 maps/ 下的 slug)';
    case "participants":
      if (typeof child === "number") {
        return `participants[${child}] 必须是非空字符串(形如 archive/<slug>/<runId>)`;
      }
      return issue.code === "too_small"
        ? `必填字段 "participants" 至少要有 ${MIN_PARTICIPANTS} 条参赛存档(四方对局),当前 ` +
            `${Array.isArray(data["participants"]) ? data["participants"].length : 0} 条`
        : '必填字段 "participants" 缺失或不是数组(参赛存档引用,下标即 playerIndex)';
    default:
      return issue.message;
  }
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

  const parsed = seasonSchema.safeParse(data);
  if (!parsed.success) {
    throw seasonError(
      filePath,
      parsed.error.issues.map((issue) => issueMessageOf(issue, data)),
    );
  }

  const config = parsed.data;
  return {
    masterSeed: config.masterSeed,
    ruleset: config.ruleset as RulesetVersion,
    seeds: config.seeds,
    participants: config.participants,
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.rankPoints !== undefined
      ? { rankPoints: config.rankPoints as unknown as RankPoints }
      : {}),
    ...(config.maps !== undefined ? { maps: config.maps } : {}),
    ...(config.outputDir !== undefined ? { outputDir: config.outputDir } : {}),
  };
};
