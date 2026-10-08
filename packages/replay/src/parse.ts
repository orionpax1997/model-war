/**
 * 回放读入端:把一份 `replay.jsonl` 读成**带类型的行**(meta / tick / result)。
 *
 * ── 为什么读入端只住在这里 ──
 *
 * 「读一份回放」就是三步:读盘 → 逐行 `JSON.parse` → 按判别式 `type` 收窄成 `ReplayLine`。
 * 这三步曾在渲染器与 `apps/cli/src/verify/index.ts` 各写了一份——同一件事两个家。本模块是它的
 * **唯一家**:渲染器(`modelwar replay`)与复算链(`modelwar verify`,NFR-2)都从这里取行。
 *
 * ── 为什么行类型取自真源包,不在这里声明 ──
 *
 * 行的**形状**归 `packages/schema`(hld §7.5,ADR-0003)。本模块只做**解析**:按判别式 `type`
 * 把一行收窄成 `ReplayLine`,不重声明任何行类型,也**不做形状校验**——形状的真判据是
 * JSON Schema + ajv,而唯一的 ajv 实例在 `apps/cli`(`replay` 不得依赖它:反向依赖,且
 * `replay` 不许引三方包,hld §3.2)。于是「合法 JSON、字段形状却不对」的行在本模块**不算错**,
 * 留给校验那侧判;拿一批过不了 schema 的旧夹具喂进来,这里也不该拒跑。
 *
 * ── 错误只有一种:装载期拒跑 ──
 *
 * 读盘失败、某行不是合法 JSON、某行不是回放行(`type` 不在三者之内)、整个文件一行都读不出,
 * 一律抛 `ReplayReadError`(消息带路径与行号)。它只作类型标记:调用方(如渲染器)据
 * `instanceof` 决定是「拒这份回放」还是原样上抛。
 */

import { readFileSync } from "node:fs";

import type { JsonValue, ReplayLine } from "@model-war/schema";

/** 回放行的三类取值,判别式都是 `type`(`ReplayLine` 的联合也按它分)。 */
const META = "meta";
const TICK = "tick";
const RESULT = "result";

/** 装载期拒跑。空体,只作类型标记——调用方靠 `instanceof` 认出「这是坏回放,不是内部错」。 */
export class ReplayReadError extends Error {}

/** `Array.isArray` 的类型谓词是 `any[]`,收窄不掉 `readonly JsonValue[]`,所以这里自己写一个。 */
const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !isJsonArray(value);

const isReplayLineType = (value: JsonValue | undefined): boolean =>
  value === META || value === TICK || value === RESULT;

/** 逐行解析的中间形态:带上这一行**在文件里的**行号(1 起),空行不进这张表。 */
type ParsedLine = { readonly at: number; readonly value: JsonValue };

const parsedLinesOf = (path: string): readonly ParsedLine[] => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ReplayReadError(
      `读不到回放 ${path}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return raw.split("\n").flatMap((text, at) => {
    if (text.trim() === "") {
      return [];
    }
    try {
      return [{ at: at + 1, value: JSON.parse(text) as JsonValue }];
    } catch (cause) {
      throw new ReplayReadError(
        `${path} 第 ${String(at + 1)} 行不是合法 JSON:` +
          `${cause instanceof Error ? cause.message : String(cause)}(文件可能被截断或没写完)`,
      );
    }
  });
};

/**
 * 读一份回放并**逐行解析**,不按行类型收窄。空行跳过——尾随换行会在末尾产生一个空串。
 *
 * 返回 `JsonValue[]` 而非 `ReplayLine[]`:这一层只判「每一行是不是合法 JSON」,行是不是回放行
 * 归 `parseReplay`。要带类型的行就用 `parseReplay`。
 */
export const readLinesOf = (path: string): readonly JsonValue[] =>
  parsedLinesOf(path).map((line) => line.value);

/**
 * 把一份 `replay.jsonl` 读成**带类型的回放行**:每一行按判别式 `type` 收窄成 `ReplayLine`。
 *
 * 整个文件没有任何一行(空回放 / 全是空行),或某行不是回放行(`type` 不在三者之内),
 * 都抛 `ReplayReadError`,**不静默跳过**——半截的行集会让人读出不存在的对局,
 * 而问题要到更远处(叙事缺一段、复算少一 tick)才暴露,那时已经看不出是回放的问题。
 */
export const parseReplay = (path: string): readonly ReplayLine[] => {
  const parsed = parsedLinesOf(path);
  if (parsed.length === 0) {
    throw new ReplayReadError(`${path} 是空的:读不到任何一行回放(至少要有一行 meta)`);
  }
  return parsed.map(({ at, value }) => {
    if (!isRecord(value) || !isReplayLineType(value["type"])) {
      throw new ReplayReadError(
        `${path} 第 ${String(at)} 行不是回放行:type 不在 meta/tick/result 之内`,
      );
    }
    // 只收窄类型,**不做形状校验**(那是 `apps/cli` 的 ajv 那侧,见文件头注)。
    return value as ReplayLine;
  });
};
