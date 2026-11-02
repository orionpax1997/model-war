/**
 * 陪练池装载：把「四份钉死的身份」解析成**盘上真实字节**，并逐份钉住内容摘要。
 *
 * ── 池子是哪四份 ──
 *
 * 榜首 / 中位 / 末位是 `@model-war/schema` 的 `TRIAL_SPARRING_LADDER`（钉死的模型 slug +
 * 冻结存档运行标识 + 期望摘要，来源 `runs/2026-11-02T04-53-46-815Z`）；在位是「正在被优化的
 * 那个模型自己最近一次冻结存档」，名字随模型而定，所以在这里**读盘解析**——它不该由调用方传
 * 字符串进来，否则「最近一次」这条规则就会在调用点各写一遍。
 *
 * ── 摘要为什么现算，为什么不信记录 ──
 *
 * `meta.json` 里的 `scriptSha256` 是落档那一刻的自述；这里回答的是「盘上这份 `script.js` 是不是
 * 当初那一份」，所以只认字节：读 `script.js` → sha256 → 与钉死值逐字比。不符即拒绝，并把角色、
 * 模型、运行标识、期望值与实际值一起报出来（拒绝理由要能让人立刻知道换的是哪一份）。
 * 交回的 `code` 与用来算摘要的是**同一份字节**，不给「算完摘要再读一次」留缝。
 *
 * ── 「最近一次冻结存档」不能取目录名字典序最大 ──
 *
 * `archive/<slug>/` 下与存档目录同层的还有旁挂件：`failed-<runId>.json`（文件）、
 * `observed-<runId>*.jsonl`（文件）、以及历史上出现过的 `feedback-<runId>-<hash>` 目录。
 * `'f' > '2'`，所以「按名字排序取最大」会选中 feedback 目录而不是真正的最新档。判定因此两步：
 * 先按 `runId` 的固定形态（`runIdOf` 把 `:` `.` 换成 `-` 的 ISO 时间戳）过滤目录名，
 * 再在剩下的里面取最大——该形态下字典序 == 时间序。目录枚举的纪律与
 * `archive-report.ts` 的 `readArchiveReports` 同形（`withFileTypes` + `isDirectory` + 排序）。
 *
 * ── 没有存档时用代位档，并把「代位」写进来源 ──
 *
 * 模型首次生成时它还没有任何冻结存档：这时在位脚本用 `TRIAL_SPARRING_SUBSTITUTE`
 * （次弱档）顶替，`source` 追加 `#substitute`，`notes` 里写明「谁的存档缺席、由谁顶替」。
 * 代位是**来源**而不是另一个角色——`role` 仍是 `incumbent`，读计划的人看 `source` 就知道
 * 这一份不是该模型自己的脚本。
 *
 * ── 为什么交回结果而不是抛 ──
 *
 * 装载失败（缺档 / 摘要不符 / 目录读不了）在调用方那里有两种归宿：生成侧是 infra 错（不回喂
 * 候选），报告侧可能只想跳过。所以这里只交回 `{ok:false, reason}`，让调用方决定是打 infra 还是
 * 留痕；`reason` 一律是人话且指名哪一份。本包不得 import engine（runner 的硬约束），
 * 交回的 `code` 由 `apps/cli` 交给真沙箱。
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
  TRIAL_SUBSTITUTE_SOURCE_SUFFIX,
  type TrialPlanScript,
  type TrialSparringIdentity,
  type TrialSparringLadderRole,
  type TrialSparringSubstituteIdentity,
} from "@model-war/schema";

/** sha256(小写十六进制)。与 `scheduler.ts` / `gen` 侧的同名 helper 逐字同义（各留一份，不跨包）。 */
const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** `runId` 的固定形态：ISO 时间戳把 `:` / `.` 换成 `-`（与 `scheduler.ts` 的 `runIdOf` 同款）。 */
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

const ROLE_LABELS: Record<TrialSparringLadderRole | "incumbent", string> = {
  top: "榜首",
  mid: "中位",
  last: "末位",
  incumbent: "在位",
};

/** 计划里的来源指针写法：`archive:<slug>/<runId>`（代位时由调用处追加后缀）。 */
export const sparringSourceOf = (id: string, runId: string): string => `archive:${id}/${runId}`;

/** 盘上存档脚本的相对位置（相对安装根；拒绝理由里逐字引用这一串）。 */
export const sparringScriptPathOf = (id: string, runId: string): string =>
  `archive/${id}/${runId}/script.js`;

/** 装载输入。`ladder` / `substitute` 缺省取 schema 的钉死身份；只有夹具会覆盖它们。 */
export type LoadSparringPoolOptions = {
  readonly root: string;
  /** 在位脚本所属模型（= 候选自己的模型 slug）；该模型没有存档时以代位档顶替。 */
  readonly model: string;
  readonly ladder?: readonly TrialSparringIdentity[];
  readonly substitute?: TrialSparringSubstituteIdentity;
};

/** 一份装载好的陪练：计划条目 + 执行用的脚本源码（两者出自同一份字节）。 */
export type LoadedSparringScript = {
  readonly script: TrialPlanScript;
  /** `script.js` 的源码（算摘要的就是它）。执行器直接拿它建 VM。 */
  readonly code: string;
  /** 盘上位置（相对安装根）。 */
  readonly path: string;
};

/** 装载好的陪练池：顺序恒为 榜首 → 中位 → 末位 → 在位。 */
export type SparringPool = {
  readonly model: string;
  readonly scripts: readonly LoadedSparringScript[];
  /** 人话留痕（在位解析结果、代位说明）；进日志与存档旁注，不进计划。 */
  readonly notes: readonly string[];
};

export type LoadSparringPoolResult =
  | { readonly ok: true; readonly pool: SparringPool }
  | { readonly ok: false; readonly reason: string };

/** 计划要的那一格：四份陪练的身份（不含源码），可直接喂 `buildTrialPlan` 的 `scripts`。 */
export const sparringPoolScriptsOf = (pool: SparringPool): readonly TrialPlanScript[] =>
  pool.scripts.map((entry) => entry.script);

/**
 * `archive/<slug>/` 下最近一次冻结存档的运行标识；没有存档目录时 `undefined`。
 *
 * 只认 `runId` 形态的目录名（`feedback-<runId>-<hash>` 这类旁挂目录因此被挡在外面），
 * 该形态下字典序 == 时间序，取最大即最新。
 */
export const latestArchiveRunId = (root: string, model: string): string | undefined => {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, "archive", model), { withFileTypes: true });
  } catch {
    return undefined;
  }
  const runIds = entries
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return runIds.at(-1);
};

type ScriptRead = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false };

const readScriptBytes = (path: string): ScriptRead => {
  try {
    return { ok: true, bytes: readFileSync(path) };
  } catch {
    return { ok: false };
  }
};

/** 一份字节 → 装载结果（计划条目 + 源码）；摘要取自这同一份字节。 */
const entryOf = (options: {
  readonly role: TrialSparringLadderRole | "incumbent";
  readonly id: string;
  readonly runId: string;
  readonly substitute: boolean;
  readonly bytes: Buffer;
}): LoadedSparringScript => ({
  script: {
    id: options.id,
    role: options.role,
    source:
      sparringSourceOf(options.id, options.runId) +
      (options.substitute ? TRIAL_SUBSTITUTE_SOURCE_SUFFIX : ""),
    scriptSha256: sha256Hex(options.bytes),
  },
  code: options.bytes.toString("utf8"),
  path: sparringScriptPathOf(options.id, options.runId),
});

/** 读一份钉死的存档脚本并比对摘要；不符即交回指名道姓的拒绝理由。 */
const readPinnedScript = (options: {
  readonly root: string;
  readonly role: TrialSparringLadderRole | "incumbent";
  readonly id: string;
  readonly runId: string;
  readonly expectedSha256: string;
  readonly substitute: boolean;
}):
  | { readonly ok: true; readonly script: LoadedSparringScript }
  | { readonly ok: false; readonly reason: string } => {
  const path = sparringScriptPathOf(options.id, options.runId);
  const where = `${ROLE_LABELS[options.role]}（${options.role}，${options.id}）`;
  const read = readScriptBytes(join(options.root, path));
  if (!read.ok) {
    return {
      ok: false,
      reason: `${where}的存档脚本读不到：${path}（该运行标识下没有 script.js，或整个存档目录不存在）`,
    };
  }
  const actual = sha256Hex(read.bytes);
  if (actual !== options.expectedSha256) {
    return {
      ok: false,
      reason:
        `${where}的存档脚本内容摘要不符：${path}` +
        `（钉死 ${options.expectedSha256}，盘上 ${actual}）`,
    };
  }
  return {
    ok: true,
    script: entryOf({
      role: options.role,
      id: options.id,
      runId: options.runId,
      substitute: options.substitute,
      bytes: read.bytes,
    }),
  };
};

/** 在位脚本：该模型最近一次冻结存档；一份都没有时以代位档顶替并写明。 */
const resolveIncumbent = (options: {
  readonly root: string;
  readonly model: string;
  readonly substitute: TrialSparringSubstituteIdentity;
}):
  | { readonly ok: true; readonly script: LoadedSparringScript; readonly note: string }
  | { readonly ok: false; readonly reason: string } => {
  const runId = latestArchiveRunId(options.root, options.model);
  if (runId !== undefined) {
    // 在位脚本的摘要不是钉死的常量：它就是盘上那一份，「最近一次」变了摘要就跟着变。
    const path = sparringScriptPathOf(options.model, runId);
    const read = readScriptBytes(join(options.root, path));
    if (!read.ok) {
      return {
        ok: false,
        reason:
          `${ROLE_LABELS.incumbent}（incumbent，${options.model}）的存档脚本读不到：${path}` +
          `（该运行标识下没有 script.js）`,
      };
    }
    return {
      ok: true,
      script: entryOf({
        role: "incumbent",
        id: options.model,
        runId,
        substitute: false,
        bytes: read.bytes,
      }),
      note: `在位脚本：模型 ${options.model} 的最近一次冻结存档是 ${runId}（${sparringSourceOf(options.model, runId)}）。`,
    };
  }
  const { substitute } = options;
  const read = readPinnedScript({
    root: options.root,
    role: "incumbent",
    id: substitute.id,
    runId: substitute.runId,
    expectedSha256: substitute.scriptSha256,
    substitute: true,
  });
  if (!read.ok) return read;
  return {
    ok: true,
    script: read.script,
    note:
      `在位脚本：模型 ${options.model} 还没有冻结存档，以代位档 ${substitute.id}` +
      `（${substitute.runId}）顶替，来源标注 ${TRIAL_SUBSTITUTE_SOURCE_SUFFIX}；` +
      `后续该模型一旦有存档，在位会自动切到它自己最近的那一份。`,
  };
};

/**
 * 装载陪练池：按 role 解析到 `archive/<slug>/<runId>/script.js`，现算内容摘要并校验。
 *
 * 交回的 `scripts` 顺序恒为 榜首 → 中位 → 末位 → 在位；任何一份失败即整池拒绝
 * （`{ok:false, reason}`，理由指名是哪一份、期望与实际的摘要各是什么）。
 */
export const loadSparringPool = (options: LoadSparringPoolOptions): LoadSparringPoolResult => {
  const ladder = options.ladder ?? TRIAL_SPARRING_LADDER;
  const substitute = options.substitute ?? TRIAL_SPARRING_SUBSTITUTE;
  const loaded: LoadedSparringScript[] = [];
  for (const identity of ladder) {
    const read = readPinnedScript({
      root: options.root,
      role: identity.role,
      id: identity.id,
      runId: identity.runId,
      expectedSha256: identity.scriptSha256,
      substitute: false,
    });
    if (!read.ok) return { ok: false, reason: `陪练池装载失败：${read.reason}` };
    loaded.push(read.script);
  }
  const incumbent = resolveIncumbent({
    root: options.root,
    model: options.model,
    substitute,
  });
  if (!incumbent.ok) return { ok: false, reason: `陪练池装载失败：${incumbent.reason}` };
  return {
    ok: true,
    pool: {
      model: options.model,
      scripts: [...loaded, incumbent.script],
      notes: [incumbent.note],
    },
  };
};
