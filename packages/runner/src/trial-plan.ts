/**
 * 试跑计划的**构造、校验与身份摘要**（纯数据 + hash；可以算摘要，但不起 VM、不碰盘）。
 *
 * ── 计划的正文与摘要 ──
 *
 * 计划的正文 = 除 `planSha256` 外的全部字段；`planSha256 = hashOf(正文)`，hash 用
 * `canonical.ts` 的规范序列化（对象键排序、数组保序）。于是「换种子 / 换座位 / 换图 /
 * 换一份对手摘要 / 换规则集或运行时摘要」都会让摘要变。
 *
 * ── 为什么场次是**派生**的，不是输入 ──
 *
 * 构造输入只收「事实」：规则集与运行时摘要、四份陪练（含各自内容摘要）、两张地图。
 * 组合、座位、种子、地图与场序都由这些事实按**网格规则**推出来——所以有人把存下来的计划里
 * `matches[i].seats` / `.seed` / `.map` 改掉时，重建结果与存档不一致，`checkTrialPlan`
 * 立刻指出是哪一处（`matches[1].seed` 这样的路径）。
 *
 * ── 网格规则（v2）──
 *
 * 一次评测 = 陪同组合 × 座位 × 地图，每个格子恰好一场：
 *
 * - **组合**：四份陪练轮空一份，得 4 种组合（`comboIndex` = 轮空那份在 `scripts` 里的下标）；
 * - **座位**：每种组合里候选 + 三份在座的陪练按 `rotateSeats` 整组循环左移 4 次，
 *   于是候选在四个座位各坐一次（`candidateSeat` 依次为 0/3/2/1）；
 * - **地图**：`maps` 顺序即地图序，两张图各占一半场次；
 * - **种子**：不是维度。第 `matchIndex` 格的种子 = `TRIAL_GRID_SEED_BASE + matchIndex`，
 *   由计划唯一决定，执行器不得自己数第几场。
 *
 * 场序 = 组合 → 座位轮转 → 地图（`matchIndex = combo×8 + rotation×2 + mapIndex`），
 * 于是 4 × 4 × 2 = 32 场，且候选每个座位 8 场、每张图 16 场。
 *
 * 反过来说，**对手摘要本身是事实**：单看计划无从判断「这份摘要是否真是那份脚本的」。
 * 那一层由调用方补：`apps/cli` 的试跑入口从盘上现算摘要再造计划，并把它与
 * `--expected-plan` 给的计划逐字段比（`trialPlanMismatch` 会指到 `scripts[1].scriptSha256`）。
 * 计划摘要覆盖摘要字段，所以「换了摘要却没重算 planSha256」同样被拒。
 *
 * ── 为什么哈希不写在 schema 包 ──
 *
 * `@model-war/schema` 不依赖任何包（没有 `node:crypto`），只放形状与网格取值；
 * 需要现算摘要的这一格落在 runner。
 */

import { z } from "zod";
import {
  TRIAL_CANDIDATE_ID,
  TRIAL_GRID_COMBO_COUNT,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SEAT_COUNT,
  TRIAL_GRID_SEED_BASE,
  TRIAL_GRID_SUMMARY_VERSION,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_PLAN_JSON_SCHEMA,
  TRIAL_PLAN_VERSION,
  TRIAL_SCRIPT_ID_SEPARATOR,
  TRIAL_SPARRING_ROLE_ORDER,
  TRIAL_SPARRING_ROLES,
  type JsonValue,
  type TrialGridMatch,
  type TrialGridSummary,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanSeat,
} from "@model-war/schema";

import { canonicalJson, hashOf } from "./canonical.js";
import { rotateSeats } from "./enumerate.js";
import { scoreTrialGrid, type TrialGridReading } from "./trial-score.js";

/** 构造计划所需的事实；座位 / 种子 / 场序由它们派生（见文件头注）。 */
export type BuildTrialPlanInput = Pick<
  TrialPlan,
  "ruleset" | "rulesetSha256" | "sandboxRuntimeHash" | "scripts" | "maps"
>;

const SHA256 = /^[0-9a-f]{64}$/;
const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && SHA256.test(value);

/** 网格的对手清单形态：四份陪练各一份（角色集合与 source 前缀互相钉住）。 */
const SPARRING_SCRIPT_COUNT = TRIAL_SPARRING_ROLE_ORDER.length;

/** 角色与来源指针的对应关系（来源是角色的派生事实，不是自由文本）。 */
const SOURCE_PREFIX_BY_ROLE = {
  benchmark: "benchmark:",
  top: "archive:",
  mid: "archive:",
  last: "archive:",
  incumbent: "archive:",
} as const satisfies Record<(typeof TRIAL_SPARRING_ROLES)[number], string>;

const fail: (path: string, reason: string) => never = (path, reason) => {
  throw new Error(`试跑计划不合法：${path} ${reason}`);
};

/** 只校验「事实」这一侧；派生字段（座位/种子/场序）由构造决定，不接受输入。 */
const checkFacts = (input: BuildTrialPlanInput): void => {
  if (typeof input.ruleset !== "string" || input.ruleset.length === 0)
    fail("ruleset", "必须是非空规则集版本名");
  if (!isSha256(input.rulesetSha256)) fail("rulesetSha256", "必须是 sha256 摘要");
  if (!isSha256(input.sandboxRuntimeHash)) fail("sandboxRuntimeHash", "必须是 sha256 摘要");

  if (input.scripts.length !== SPARRING_SCRIPT_COUNT)
    fail("scripts", `必须是 ${String(SPARRING_SCRIPT_COUNT)} 份陪练（榜首 / 中位 / 末位 / 在位）`);
  input.scripts.forEach((script, index) => {
    const path = `scripts[${String(index)}]`;
    if (typeof script.id !== "string" || script.id.length === 0) fail(`${path}.id`, "必须非空");
    if (script.id === TRIAL_CANDIDATE_ID)
      fail(`${path}.id`, `不得占用候选身份 ${TRIAL_CANDIDATE_ID}`);
    if (!TRIAL_SPARRING_ROLES.includes(script.role))
      fail(`${path}.role`, `必须是 ${TRIAL_SPARRING_ROLES.join(" / ")} 之一`);
    if (script.role === "benchmark")
      fail(`${path}.role`, "评测网格只用四份存档陪练，不接受基准脚本角色");
    // id 是角色的派生身份：`<role>:<slug>`。于是同一 slug 可按角色重复出现而不撞名。
    if (!script.id.startsWith(`${script.role}${TRIAL_SCRIPT_ID_SEPARATOR}`))
      fail(
        `${path}.id`,
        `角色 ${script.role} 的身份必须以 ${script.role}${TRIAL_SCRIPT_ID_SEPARATOR} 开头`,
      );
    if (typeof script.source !== "string" || script.source.length === 0)
      fail(`${path}.source`, "必须非空");
    // 来源指针是角色的派生事实：基准只能来自 `benchmark:`，陪练只能来自 `archive:`。
    const prefix = SOURCE_PREFIX_BY_ROLE[script.role];
    if (!script.source.startsWith(prefix))
      fail(`${path}.source`, `角色 ${script.role} 的来源必须以 ${prefix} 开头`);
    if (!isSha256(script.scriptSha256)) fail(`${path}.scriptSha256`, "必须是 sha256 摘要");
  });
  const ids = input.scripts.map((script) => script.id);
  if (new Set(ids).size !== ids.length) fail("scripts", "id 必须互异");
  const roles = new Set(input.scripts.map((script) => script.role));
  const missing = TRIAL_SPARRING_ROLE_ORDER.filter((role) => !roles.has(role));
  if (missing.length > 0 || roles.size !== SPARRING_SCRIPT_COUNT)
    fail("scripts", `四份陪练必须恰好是 ${TRIAL_SPARRING_ROLE_ORDER.join(" / ")} 各一份`);

  if (input.maps.length !== TRIAL_GRID_MAP_NAMES.length)
    fail("maps", `必须是 ${TRIAL_GRID_MAP_NAMES.join(" / ")} 两张`);
  input.maps.forEach((map, index) => {
    const path = `maps[${String(index)}]`;
    if (map.name !== TRIAL_GRID_MAP_NAMES[index])
      fail(`${path}.name`, `必须按 ${TRIAL_GRID_MAP_NAMES.join(" → ")} 的顺序`);
    if (!isSha256(map.sha256)) fail(`${path}.sha256`, "必须是 sha256 摘要");
  });
};

/**
 * 由事实造网格计划（规则见文件头注「网格规则」）。
 *
 * 场次在这里**派生**，不接受调用方传入：于是「改座位 / 改种子 / 换图即使是自洽的改法」也会
 * 被 `checkTrialPlan` 拒（重建结果不等于送进来的计划）。
 */
export const buildTrialPlan = (input: BuildTrialPlanInput): TrialPlan => {
  checkFacts(input);
  const matches: TrialPlanMatch[] = [];
  for (let comboIndex = 0; comboIndex < TRIAL_GRID_COMBO_COUNT; comboIndex += 1) {
    // 轮空一份：comboIndex 就是在 `scripts` 里被轮空的那一份。
    const present = input.scripts.filter((_, index) => index !== comboIndex);
    const base = [TRIAL_CANDIDATE_ID, present[0]!.id, present[1]!.id, present[2]!.id] as const;
    for (let rotation = 0; rotation < TRIAL_GRID_SEAT_COUNT; rotation += 1) {
      const seats = rotateSeats(base, rotation);
      const candidateSeat = seats.indexOf(TRIAL_CANDIDATE_ID) as TrialPlanSeat;
      if (candidateSeat < 0) throw new Error("试跑计划不合法：座位轮转丢了候选");
      for (const [mapIndex, map] of input.maps.entries()) {
        const matchIndex =
          comboIndex * TRIAL_GRID_SEAT_COUNT * input.maps.length +
          rotation * input.maps.length +
          mapIndex;
        matches.push({
          matchIndex,
          comboIndex,
          seed: TRIAL_GRID_SEED_BASE + matchIndex,
          seats,
          candidateSeat,
          map: map.name,
          mapSha256: map.sha256,
        });
      }
    }
  }
  if (matches.length !== TRIAL_MATCHES_PER_CANDIDATE)
    throw new Error("试跑计划不合法：网格场数与声明不符");
  const body = {
    version: TRIAL_PLAN_VERSION,
    ruleset: input.ruleset,
    rulesetSha256: input.rulesetSha256,
    sandboxRuntimeHash: input.sandboxRuntimeHash,
    scripts: input.scripts,
    maps: input.maps,
    matchesPerCandidate: TRIAL_MATCHES_PER_CANDIDATE,
    matches,
  };
  return { ...body, planSha256: hashOf(body) };
};

const isObject = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const describe = (value: JsonValue): string => {
  const text = canonicalJson(value);
  return text.length <= 120 ? text : `${text.slice(0, 117)}…`;
};

/** 逐字段找第一处不同，返回带路径的中文说明；全同返回 `null`。 */
const firstDifference = (expected: JsonValue, actual: JsonValue, path: string): string | null => {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length)
      return `${path} 长度不符（期望 ${String(expected.length)}，实际 ${String(actual.length)}）`;
    for (const [index, value] of expected.entries()) {
      const found = firstDifference(value, actual[index]!, `${path}[${String(index)}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (isObject(expected) && isObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    // `planSha256` 排在最后：它一变说明别的字段变了，先报那个字段才有用。
    const ordered = [...keys.keys()].sort((left, right) =>
      left === "planSha256" ? 1 : right === "planSha256" ? -1 : left < right ? -1 : 1,
    );
    for (const key of ordered) {
      const child = path === "" ? key : `${path}.${key}`;
      const left = expected[key];
      const right = actual[key];
      if (left === undefined || right === undefined) return `${child} 缺失`;
      const found = firstDifference(left, right, child);
      if (found !== null) return found;
    }
    return null;
  }
  if (canonicalJson(expected) === canonicalJson(actual)) return null;
  return `${path} 不符（期望 ${describe(expected)}，实际 ${describe(actual)}）`;
};

/**
 * 两份计划的差异（含 `planSha256`）。相同返回 `null`；不同返回**第一处**不符的路径与取值，
 * 让「改座位 / 改种子 / 换一份对手摘要」都能被指名。
 */
export const trialPlanMismatch = (expected: TrialPlan, actual: TrialPlan): string | null =>
  firstDifference(expected, actual, "");

/**
 * 计划必须能由它自己的事实完全重建，且摘要与正文一致；否则抛错并指明不符之处。
 *
 * 注意重建会先跑形状校验：摘要不是 64 位 hex、角色不在枚举里之类会以
 * `scripts[1].scriptSha256 必须是 sha256 摘要` 这样的路径报出来。
 */
export const checkTrialPlan = (plan: TrialPlan): void => {
  const rebuilt = buildTrialPlan(plan);
  const mismatch = trialPlanMismatch(rebuilt, plan);
  if (mismatch !== null) throw new Error(`试跑计划与可由输入重建的结果不符：${mismatch}`);
};

/**
 * 一张跑完的网格 → 汇总（观测文件旁的 `.grid.json`）。
 *
 * `readings` 回答两件事：「这 32 个格子是不是都跑过了」（少一场、多一场、重复一场都直接拒绝，
 * **不缩分母、不补零**）与「候选得多少分」（交给 `trial-score.ts`，算术只有那一处真源）。
 * 汇总的 `matches` 是计划的投影（逐场抄场序、种子、候选座位、地图与地图摘要），所以它不能与
 * 计划分家。
 */
export const buildTrialGridSummary = (options: {
  readonly plan: TrialPlan;
  readonly scriptSha256: string;
  readonly readings: readonly TrialGridReading[];
}): TrialGridSummary => {
  const { plan, scriptSha256, readings } = options;
  if (!isSha256(scriptSha256)) fail("scriptSha256", "必须是 sha256 摘要");
  const covered = new Set(readings.map((reading) => reading.matchIndex));
  if (covered.size !== readings.length) fail("readings", "同一场出现了多条读数");
  const missing = plan.matches
    .filter((match) => !covered.has(match.matchIndex))
    .map((match) => match.matchIndex);
  const extra = [...covered].filter(
    (matchIndex) => !plan.matches.some((match) => match.matchIndex === matchIndex),
  );
  if (missing.length > 0) fail("readings", `缺少计划里的第 ${missing.join(" / ")} 场`);
  if (extra.length > 0) fail("readings", `多出计划之外的第 ${extra.join(" / ")} 场`);
  return {
    version: TRIAL_GRID_SUMMARY_VERSION,
    plan,
    scriptSha256,
    // 分数紧跟在完整性判据之后算：到这里计划里每一场都有自己的读数了，
    // 但「读数属于这一格吗」与「哪一场没有终局」仍由计分再判一次（缺场不缩分母）。
    score: scoreTrialGrid(plan, readings),
    matches: trialGridMatchesOf(plan),
  };
};

/**
 * 计划的逐场投影（场序、种子、候选座位、地图名与地图摘要）。
 *
 * 网格汇总的 `matches` 就是它：`plan` 相等说明「同一张网格」，`matches` 相等说明「这些格子
 * 确实是按它跑的」。投影只有这一处写法——汇总（本文件）、选拔的校验与报告侧都读它。
 */
export const trialGridMatchesOf = (plan: TrialPlan): readonly TrialGridMatch[] =>
  plan.matches.map((match) => ({
    matchIndex: match.matchIndex,
    seed: match.seed,
    candidateSeat: match.candidateSeat,
    map: match.map,
    mapSha256: match.mapSha256,
  }));

/** 单场身份：计划摘要 + 候选脚本摘要 + 该场。同一份计划与同一份候选 JS 共享这个身份。 */
export const trialMatchInputSha256 = (
  plan: TrialPlan,
  scriptSha256: string,
  match: TrialPlanMatch,
): string => hashOf({ planSha256: plan.planSha256, scriptSha256, match });

/** 存档里记录的试跑计划：新档有 `plan` 就报计划，旧档明确报「无计划字段」。 */
export type ArchiveTrialPlan =
  | { readonly kind: "plan"; readonly plan: TrialPlan }
  | { readonly kind: "absent"; readonly version: number; readonly note: string };

const readRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
  return value as Record<string, unknown>;
};

/**
 * 计划的单份 JSON 形状由共享 JSON Schema 定（ADR-0003：TypeScript 是真源，Schema 手工对齐）。
 * 这里把 Schema 投影成 zod 校验器——跨字段关系（座位/种子/场序能否由事实重建）不住在 Schema 里，
 * 由 `checkTrialPlan` 补，两者合起来才是「读得进、且说得通」。
 */
const planSchema = z.fromJSONSchema(
  JSON.parse(JSON.stringify(TRIAL_PLAN_JSON_SCHEMA)) as z.core.JSONSchema.JSONSchema,
);

/**
 * 读一份存档里的计划：**形状**由 JSON Schema 定，**能否由事实重建**由 `checkTrialPlan` 定。
 *
 * 摘要比对与事实（盘上字节）的比对归调用方。缺字段 / 额外字段 / 摘要不是 64 位 hex 这类
 * 形状问题在这里就拒；改座位 / 改种子 / 换图即使是自洽的改法，也会在重建那一步被指到具体路径。
 */
export const readTrialPlan = (value: unknown): TrialPlan => {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) fail("plan", "形状不合法（缺字段、额外字段或取值超出形状契约）");
  const plan = parsed.data as TrialPlan;
  checkTrialPlan(plan);
  return plan;
};

/**
 * 存档的 `optimization` 一格 → 试跑计划。
 *
 * 历史档（`optimization.version: 1`）**没有** `plan` 字段，那是正常的：返回
 * `{kind: "absent", version: 1, note: "版本 1、无计划字段…"}`，不迁移、不回填、不猜。
 */
export const archiveTrialPlanOf = (optimization: unknown): ArchiveTrialPlan => {
  const record = readRecord(optimization, "optimization");
  const version = record["version"];
  if (!Number.isSafeInteger(version)) fail("optimization.version", "必须是整数");
  const plan = record["plan"];
  if (plan === undefined)
    return {
      kind: "absent",
      version: version as number,
      note: `版本 ${String(version)}、无计划字段（该档冻结于计划引入之前，不迁移、不回填）`,
    };
  return { kind: "plan", plan: readTrialPlan(plan) };
};
