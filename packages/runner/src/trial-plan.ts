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
 * 构造输入只收「事实」：规则集与运行时摘要、对手清单（含各自内容摘要）、地图清单。
 * 座位、种子、地图与场序都由这些事实按 v1 的规则推出来——所以有人把存下来的计划里
 * `matches[i].seats` / `.seed` / `.map` 改掉时，重建结果与存档不一致，`checkTrialPlan`
 * 立刻指出是哪一处（`matches[1].seed` 这样的路径）。
 *
 * 反过来说，**对手摘要本身是事实**：单看计划无从判断「这份摘要是否真是那份脚本的」。
 * 那一层由调用方补：`apps/cli` 的试跑入口从盘上现算摘要再造计划，并把它与
 * `--expected-plan` 给的计划逐字段比（`trialPlanMismatch` 会指到 `scripts[1].scriptSha256`）。
 * 计划摘要覆盖摘要字段，所以「换了摘要却没重算 planSha256」同样被拒。
 *
 * ── 为什么哈希不写在 schema 包 ──
 *
 * `@model-war/schema` 不依赖任何包（没有 `node:crypto`），只放形状与 v1 默认值；
 * 需要现算摘要的这一格落在 runner。
 */

import {
  TRIAL_CANDIDATE_ID,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_PLAN_VERSION,
  TRIAL_SEEDS,
  TRIAL_SPARRING_ROLES,
  type JsonValue,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanScript,
} from "@model-war/schema";

import { canonicalJson, hashOf } from "./canonical.js";

/** 构造计划所需的事实；座位 / 种子 / 场序由它们派生（见文件头注）。 */
export type BuildTrialPlanInput = Pick<
  TrialPlan,
  "ruleset" | "rulesetSha256" | "sandboxRuntimeHash" | "scripts" | "maps"
>;

const SHA256 = /^[0-9a-f]{64}$/;
const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && SHA256.test(value);

const fail: (path: string, reason: string) => never = (path, reason) => {
  throw new Error(`试跑计划不合法：${path} ${reason}`);
};

/** 只校验「事实」这一侧；派生字段（座位/种子/场序）由构造决定，不接受输入。 */
const checkFacts = (input: BuildTrialPlanInput): void => {
  if (typeof input.ruleset !== "string" || input.ruleset.length === 0)
    fail("ruleset", "必须是非空规则集版本名");
  if (!isSha256(input.rulesetSha256)) fail("rulesetSha256", "必须是 sha256 摘要");
  if (!isSha256(input.sandboxRuntimeHash)) fail("sandboxRuntimeHash", "必须是 sha256 摘要");

  if (input.scripts.length !== TRIAL_SEEDS.length)
    fail("scripts", `必须是 ${String(TRIAL_SEEDS.length)} 份对手`);
  input.scripts.forEach((script, index) => {
    const path = `scripts[${String(index)}]`;
    if (typeof script.id !== "string" || script.id.length === 0) fail(`${path}.id`, "必须非空");
    if (script.id === TRIAL_CANDIDATE_ID)
      fail(`${path}.id`, `不得占用候选身份 ${TRIAL_CANDIDATE_ID}`);
    if (!TRIAL_SPARRING_ROLES.includes(script.role))
      fail(`${path}.role`, `必须是 ${TRIAL_SPARRING_ROLES.join(" / ")} 之一`);
    if (typeof script.source !== "string" || script.source.length === 0)
      fail(`${path}.source`, "必须非空");
    if (!isSha256(script.scriptSha256)) fail(`${path}.scriptSha256`, "必须是 sha256 摘要");
  });
  const ids = input.scripts.map((script) => script.id);
  if (new Set(ids).size !== ids.length) fail("scripts", "id 必须互异");

  if (input.maps.length !== 1) fail("maps", "v1 只有一张地图");
  const map = input.maps[0]!;
  if (typeof map.name !== "string" || map.name.length === 0) fail("maps[0].name", "必须非空");
  if (!isSha256(map.sha256)) fail("maps[0].sha256", "必须是 sha256 摘要");
};

/**
 * 由事实造计划：v1 = 单图、三场、候选 0 号位、每场一个固定种子，座位 = 候选 + 三份基准。
 *
 * 场次在这里**派生**，不接受调用方传入（见文件头注「为什么场次是派生的」）。
 */
export const buildTrialPlan = (input: BuildTrialPlanInput): TrialPlan => {
  checkFacts(input);
  const map = input.maps[0]!;
  const seats = [
    TRIAL_CANDIDATE_ID,
    input.scripts[0]!.id,
    input.scripts[1]!.id,
    input.scripts[2]!.id,
  ] as const;
  const matches = TRIAL_SEEDS.map((seed, matchIndex): TrialPlanMatch => ({
    matchIndex,
    comboIndex: 0,
    seed,
    seats,
    candidateSeat: 0,
    map: map.name,
    mapSha256: map.sha256,
  }));
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

const PLAN_KEYS = [
  "version",
  "ruleset",
  "rulesetSha256",
  "sandboxRuntimeHash",
  "scripts",
  "maps",
  "matchesPerCandidate",
  "matches",
  "planSha256",
] as const;

const readRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
  return value as Record<string, unknown>;
};

const readClosed = (
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> => {
  const record = readRecord(value, path);
  const extra = Object.keys(record).filter((key) => !keys.includes(key));
  if (extra.length > 0) fail(path, `不接受额外字段 ${extra.join(" / ")}`);
  for (const key of keys) if (record[key] === undefined) fail(`${path}.${key}`, "缺失");
  return record;
};

/**
 * 读一份存档里的计划（装载期断言；单份 JSON 的形状仍归 JSON Schema，计划进存档时补）。
 *
 * 只做「形状 + 能否重建」两件事：摘要比对与事实（盘上字节）的比对归调用方。
 */
export const readTrialPlan = (value: unknown): TrialPlan => {
  const plan = readClosed(value, "plan", PLAN_KEYS);
  if (!Number.isSafeInteger(plan["version"])) fail("plan.version", "必须是整数");
  if (plan["version"] !== TRIAL_PLAN_VERSION)
    fail(
      "plan.version",
      `必须是 ${String(TRIAL_PLAN_VERSION)}（本版本只认 v1 形状；更高版本由对应版本读取）`,
    );
  const scripts = plan["scripts"];
  if (!Array.isArray(scripts)) fail("plan.scripts", "必须是数组");
  const maps = plan["maps"];
  if (!Array.isArray(maps)) fail("plan.maps", "必须是数组");
  const matches = plan["matches"];
  if (!Array.isArray(matches)) fail("plan.matches", "必须是数组");
  const typed = {
    ...plan,
    scripts: scripts.map((script, index): TrialPlanScript => {
      const item = readClosed(script, `plan.scripts[${String(index)}]`, [
        "id",
        "role",
        "source",
        "scriptSha256",
      ]);
      return item as unknown as TrialPlanScript;
    }),
    maps: maps.map((map, index) => {
      const item = readClosed(map, `plan.maps[${String(index)}]`, ["name", "sha256"]);
      return { name: item["name"], sha256: item["sha256"] } as unknown as TrialPlan["maps"][number];
    }),
    matches: matches.map((match, index): TrialPlanMatch => {
      const item = readClosed(match, `plan.matches[${String(index)}]`, [
        "matchIndex",
        "comboIndex",
        "seed",
        "seats",
        "candidateSeat",
        "map",
        "mapSha256",
      ]);
      return item as unknown as TrialPlanMatch;
    }),
  } as unknown as TrialPlan;
  checkTrialPlan(typed);
  return typed;
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
