/**
 * 门禁:**契约自证**——一条命令回答四个外部可问的问题(根脚本 `check:selfproof`)。
 *
 * ```
 * node packages/tools/src/selfproof/run-selfproof-gate.ts [--out=<目录>] [--serial] [--jobs=N]
 *                                                  [--quota-percent=N] [--script-a=<产物路径>]
 *                                                  [--same-script]
 * ```
 *
 * ── 四问(判据与理由在 `questions.ts`,这里只说它跑的是什么) ──────────────────
 * 1. 三份基准脚本**零静态违规**——拿终稿契约的静态校验器(`validate/run-validate-script.ts`,
 *    子进程 + 退出码,理由见那个文件的头注)逐一判 `benchmarks/<舱名>/script.js`。
 *    这一问证明的是「契约没有把合规脚本判死」。
 * 2. 三份都**打出正常终局**,不被判负出局——每席 `exceptionTicks` 为 0,每场终局原因属
 *    正常三种(`victory` / `shortcut` / `timeout`)。
 * 3. 三份的**消耗中位数都落在总储量的四分之一以内**——这就是 gdd §8 记录 #13 里
 *    已过的那条等效命题 ② 在**终稿契约 + 终稿基准脚本**下的复验。
 * 4. 三份的**取策略互不相同**——区分度的可观测代理:若三份脚本的行为指标收敛到同一形态,
 *    规则集就还没被证明有区分度。
 *
 * ── 跑在哪个桩上、为什么那个桩不搬不修 ──────────────────────────────────────
 * 跑在标定环那个已经跑过 **1336 场**的桩上(`.scratch/rules-calibration/sim/`),**一行未改**:
 * 加载路径、结算管线、取证指标口径全部是桩自己的,本文件只做两件事——按 `SCRIPTS[].inject`
 * 把兼容层前缀注进去(那是桩自己的扩展点,标定环的探针就是这么用的),以及把每场读数裁剪成
 * 汇总要的那几项。搬桩或修桩都会让 gdd §8 #7~#13 那些记录不可复现,票面因此禁止。
 * 终稿契约与草案代桩之间的四处缺口由 `contract-compat.ts` 记着,不静默换口径。
 *
 * ── 矩阵:与标定环那一轮同夹具、同臂数 ────────────────────────────────────────
 * **夹具**:三张真图(`maps/{open-clash,corridor-split,fortress-core}.json`)+ 一张无墙夹具对照
 * (`center-fortress@64`,点位布局与三张真图逐格相同)——与 #13 复验那一轮(`pilot-prop2.mjs`)
 * 逐字同夹具。**臂数**:4 臂 × 4 个座位轮转 × 4 颗种子(`SEEDS_PROBE` = 11/23/41/71)= **64 场**,
 * 与那一轮同臂数。参数(`resourcePerSite`、`tickLimit`)一律**从 `rulesets/v1.json` 现读**
 * (见下面的 `RULESET_FILE`,取值不在本文件的任何一行里手写),开局矿一圈取 `FIXTURE.ownedMineOrbits`。
 * **座位轮转**:四席三份,重复席位给 B;四轮转之后每个座位恰好各当一次 A/B/C
 * (与标定环 `rotate(['a','b','c','d'])` 的均摊性质同形)。
 * **不动 mirror**:`mirror: false`。M1 的镜像补丁是草案代「没有座位自认 API」的宿主侧替代品,
 * 终稿契约有 `getMyIndex()`,三份脚本各自认自己的座位——补丁在这里是空操作,开着反而会让人
 * 以为读数依赖它。
 *
 * ── 跑正表前先过夹具闸门 ────────────────────────────────────────────────────
 * 先跑 `farmer6` 四方自战(夹具、探针一字未动),要求 `depletion.ticks.p100 === 479` 且
 * 全场交付合计 `=== 3080`——这两个数是 map-pool 与标定环两轮冻结的受控锚点。漂了就非零退出,
 * 不继续跑正表(与 `pilot-prop2.mjs` 的闸门同一判据、同一组数)。
 *
 * ── 换一份契约版本:这条缝仍绿,但四问的取值会变 ────────────────────────────
 * 契约版本一换(API 面、快照字段、错误处理任一处),三份脚本必须重新盲写并落库
 * (`benchmarks/README.md` §3),而本门禁的**判据**不变——它问的是「这套契约能不能让模型写出
 * 合规脚本并打出正常终局」。所以:版本换了之后**门禁仍绿是正常的**,而**四问的取值会全部变**,
 * 报告里的每一个数字都不是回归基线,拿旧报告与新报告逐项对齐是错的做法。
 * 唯一的例外是③的**配额**:它是判据(总储量的 1/4),不是读数——总储量变了配额跟着变,
 * 拿绝对量跨版本比较同样是错的。
 *
 * ── 反例用的三个开关(红 → 还原 → 绿) ───────────────────────────────────────
 * `--quota-percent=N` 把③的配额改小;`--script-a=<路径>` 把 A 那份产物换成别的脚本;
 * `--same-script` 让三份用同一份产物(④应当变红)。三个都在 `gates.test.ts` 里现做现验。
 *
 * ── `--probe`:反例用的缩矩阵,不是「快速模式」 ───────────────────────────────
 * `--probe` 把矩阵从 **4 臂 × 4 座位轮转 × 4 种子 = 64 场**缩到 **1 臂组 × 1 轮转 × 1 种子 = 4 场**
 * (夹具 + 三张真图各一场,夹具闸门照跑,判据一字不改)。它存在只有一个理由:反例要证明的是
 * **「改这一项,门禁会红」**,不是四问的取值——而红不红在小矩阵上照样能判红。配 `gates.test.ts`
 * 那一组「红 → 同参数还原 → 绿」用:全矩阵七次 → 全矩阵一次 + 缩矩阵六次(墙钟约 14 分钟 → 约 2 分钟)。
 * **`pnpm run check` 里的正跑不许带这个开关**——正跑的取值就是四问的读数,读数来自全矩阵。
 * 小矩阵真的判不出红时,门禁那条断言会当场红,不会静默放过。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SANDBOX_INJECTED_API_SYMBOL_CATALOG } from "@model-war/schema";
import type { Ruleset } from "@model-war/schema";

import { compatGapsOf, compatPrelude } from "./contract-compat.ts";
import { BENCHMARK_NAMES, PRODUCT_FILE, benchmarkFile, repoRoot } from "../benchmarks/compile.ts";
import {
  DEFAULT_QUOTA_PERCENT,
  SCRIPT_LABELS,
  tenthsOfPercent,
  BEHAVIOR_METRICS,
  checkConsumption,
  checkDistinctness,
  checkOutcomes,
  checkStatic,
  type MatchRow,
  type ScriptLabel,
  type SeatRow,
} from "./questions.ts";

const SELF = fileURLToPath(import.meta.url);

/** 桩的位置:标定环那个跑过 1336 场的 sim 目录。本门禁只引用它,不改它。 */
const STUB = `${repoRoot}.scratch/rules-calibration/sim`;

/** 与 #13 复验那一轮逐字同夹具:三张真图 + 一张无墙对照。 */
const MAP_NAMES = ["open-clash", "corridor-split", "fortress-core"];
const FIXTURE = { variant: "center-fortress", size: 64, ownedMineOrbits: 1 };
/** 种子沿用桩的 `SEEDS_PROBE`(#13 那一轮的口径)。 */
const SEEDS = [11, 23, 41, 71];
/** 四席三份:重复席位给 B,四轮转之后每个座位各当一次 A/B/C。 */
const SEAT_BASE: readonly ScriptLabel[] = ["A", "B", "C", "B"];

/** 夹具闸门的受控锚点(与 map-pool / 标定环两轮冻结的那两个数逐字一致)。 */
const ANCHOR = { p100: 479, delivered: 3080 };

// ── 桩的形状(它是 .mjs,没有类型面;这里只声明本文件真正读到的那几项) ──────────

type StubPlayer = {
  index: number;
  script: string | null;
  harvests: number;
  delivered: number;
  workerPeak: number;
  unitPeak: number;
  capsByDriverTotal: number;
  finalRank: number | null;
  unitsByTypeEnd: { w: number; m: number; r: number; c: number };
  workerShareMean: number;
  eliminatedAt: number | null;
  exceptionTicks: number;
};

type StubMatch = {
  id?: string;
  outcome: { reason: string; winner: number | null; tick: number };
  depletion: { total: number; remainingEnd: number; ticks: { p100: number | null } };
  players: readonly StubPlayer[];
  combat: { spawnOrders: number; spawnOrdersRejectedBusyBase: number; refunds: number };
};

type StubScriptEntry = {
  cell: string;
  model: string;
  strategy: string;
  file: string;
  inject?: string;
};

type StubJob = {
  id: string;
  seatScripts: readonly string[];
  seed: number;
  mirror: boolean;
  variant: string;
  size: number;
  label?: string;
  mapFile?: string;
  mapOpts?: { ownedMineOrbits: number };
};

type StubHarness = {
  SCRIPTS: Record<string, StubScriptEntry>;
  runMatrix: (jobs: readonly StubJob[]) => readonly StubMatch[];
  rotate: <T>(seats: readonly T[]) => readonly (readonly T[])[];
};

/**
 * 本文件从规则集文件里读到的那几项。**从真源包的 `Ruleset` 取子集**,不手拄一份形状。
 *
 * 为什么是 `Pick` 而不是整个 `Ruleset`:整份类型在这里用不到(预算键与得分键本文件不读),
 * 而把用不到的那几项也写进来只会让「改了规则集文件多了个键」在这里变成一个无关的编译错。
 * 真正要防的是**另一半**:手拄一份子集形状时,真源包给某个键改了类型(比如 `spawnTicks` 从
 * 键变成派生量),这里会安静地继续按旧形状读,而报告里的数已经不对了——而没有任何东西会红。
 * 从 `Ruleset` 取子集让那种改动当场编译不过。
 */
type RulesetFile = Pick<
  Ruleset,
  | "tickLimit"
  | "resourcePerSite"
  | "initialResources"
  | "harvestRate"
  | "worker"
  | "melee"
  | "ranged"
  | "cavalry"
  | "scriptSizeLimit"
>;

const RULESET_FILE = JSON.parse(readFileSync(`${repoRoot}rulesets/v1.json`, "utf8")) as RulesetFile;

const UNIT_TYPES = ["worker", "melee", "ranged", "cavalry"] as const;

const spawnTicksOf = (): Record<string, number> =>
  Object.fromEntries(UNIT_TYPES.map((type) => [type, RULESET_FILE[type].spawnTicks]));
const unitCostOf = (): Record<string, number> =>
  Object.fromEntries(UNIT_TYPES.map((type) => [type, RULESET_FILE[type].cost]));

/** 错误码名字取自真源包的注入面目录(每一档 `error-code` 一行),不在这里手写第二份,也不数它的个数。 */
const ERROR_CODES = SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter(
  (entry) => entry.kind === "error-code",
).map((entry) => entry.symbol);

// ── 命令行 ──────────────────────────────────────────────────────────────────

type Options = {
  readonly out: string | null;
  readonly serial: boolean;
  readonly jobs: number;
  readonly quotaPercent: number;
  /** 覆盖 A 那份产物的路径(反例①用);`null` = 用入库的那份。 */
  readonly scriptA: string | null;
  /** 三份用同一份产物(反例④用)。 */
  readonly sameScript: boolean;
  /** 缩矩阵(只给反例的「红 → 还原 → 绿」用,判据一字不改;正跑不带)。 */
  readonly probe: boolean;
};

const parseArgs = (argv: readonly string[]): Options => {
  const valueOf = (prefix: string): string | undefined =>
    argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const quotaText = valueOf("--quota-percent=");
  const quotaPercent = quotaText === undefined ? DEFAULT_QUOTA_PERCENT : Number(quotaText);
  if (!Number.isInteger(quotaPercent) || quotaPercent <= 0 || quotaPercent > 100) {
    throw new Error(`--quota-percent 必须是 1..100 的整数,收到 "${quotaText}"。`);
  }
  const jobsText = valueOf("--jobs=");
  const jobs = jobsText === undefined ? 0 : Number(jobsText);
  if (!Number.isInteger(jobs) || jobs < 0) {
    throw new Error(`--jobs 必须是非负整数,收到 "${jobsText}"。`);
  }
  return {
    out: valueOf("--out=") ?? null,
    serial: argv.includes("--serial"),
    jobs: jobs > 0 ? jobs : Math.max(1, Math.min(6, cpus().length - 2)),
    quotaPercent,
    scriptA: valueOf("--script-a=") ?? null,
    sameScript: argv.includes("--same-script"),
    probe: argv.includes("--probe"),
  };
};

// ── 兼容层注入:把三份产物按「脚本 × 座位」注册进桩自己的脚本表 ────────────────

type Registration = { readonly key: string; readonly file: string; readonly inject: string };

/**
 * 产物路径:默认三份各一份;`--script-a` 换掉 A,`--same-script` 让三份同源。
 *
 * 标签与 `benchmarks/` 登记册的顺序一一对应(A = cell-a-melee-pressure,
 * B = cell-b-expansion-economy, C = cell-c-claim-no-harvest)。
 */
const productsOf = (options: Options): readonly string[] => {
  const defaults = BENCHMARK_NAMES.map((name) => benchmarkFile(name, PRODUCT_FILE));
  const [a, b, c] = defaults;
  const scriptA = options.scriptA ?? a ?? "";
  if (options.sameScript) return [scriptA, scriptA, scriptA];
  return [scriptA, b ?? scriptA, c ?? scriptA];
};

const registrationsOf = (products: readonly string[]): readonly Registration[] => {
  const registrations: Registration[] = [];
  SCRIPT_LABELS.forEach((label, index) => {
    const file = products[index] ?? "";
    for (let seat = 0; seat < 4; seat += 1) {
      registrations.push({
        key: `${label}#${seat}`,
        file,
        inject: compatPrelude({
          seat,
          spawnTicks: spawnTicksOf(),
          unitCost: unitCostOf(),
          initialResources: RULESET_FILE.initialResources,
          errorCodes: ERROR_CODES,
        }),
      });
    }
  });
  return registrations;
};

const registerInto = (harness: StubHarness, registrations: readonly Registration[]): void => {
  for (const registration of registrations) {
    harness.SCRIPTS[registration.key] = {
      cell: registration.key.split("#")[0] ?? "",
      model: "benchmark-product",
      strategy: registration.key,
      file: registration.file,
      inject: registration.inject,
    };
  }
};

// ── 矩阵 ────────────────────────────────────────────────────────────────────

const buildJobs = (harness: StubHarness, probe: boolean): readonly StubJob[] => {
  const jobs: StubJob[] = [];
  const rotations = probe ? [SEAT_BASE] : harness.rotate(SEAT_BASE);
  const seeds = probe ? SEEDS.slice(0, 1) : SEEDS;
  for (const seats of rotations) {
    for (const seed of seeds) {
      const seatScripts = seats.map((label, seat) => `${label}#${seat}`);
      const rotation = seats.join("");
      jobs.push({
        id: `P0/fixture/${rotation}/s${seed}`,
        seatScripts,
        seed,
        mirror: false,
        variant: FIXTURE.variant,
        size: FIXTURE.size,
        mapOpts: { ownedMineOrbits: FIXTURE.ownedMineOrbits },
        label: "fixture",
      });
      for (const name of MAP_NAMES) {
        jobs.push({
          id: `P1/${name}/${rotation}/s${seed}`,
          seatScripts,
          seed,
          mirror: false,
          variant: name,
          size: FIXTURE.size,
          mapFile: `${repoRoot}maps/${name}.json`,
          label: name,
        });
      }
    }
  }
  return jobs;
};

const armOf = (id: string): string => id.split("/").slice(0, 2).join("/");

/** 一场对局 → 一行读数(裁剪掉 `series` 那种逐帧大对象,汇总只需要这些)。 */
const slim = (job: StubJob, match: StubMatch): MatchRow => {
  const labelOf = (key: string | null): ScriptLabel => {
    const head = (key ?? "").split("#")[0];
    return (SCRIPT_LABELS.find((label) => label === head) ?? "A") as ScriptLabel;
  };
  const seats: SeatRow[] = match.players.map((player) => ({
    label: labelOf(player.script),
    harvests: player.harvests,
    delivered: player.delivered,
    workerPeak: player.workerPeak,
    unitPeak: player.unitPeak,
    captures: player.capsByDriverTotal,
    finalRank: player.finalRank ?? 0,
    endWorker: player.unitsByTypeEnd.w,
    endMelee: player.unitsByTypeEnd.m,
    endRanged: player.unitsByTypeEnd.r,
    endCavalry: player.unitsByTypeEnd.c,
    workerSharePercent: Math.round(player.workerShareMean * 100),
    eliminated: player.eliminatedAt !== null,
    exceptionTicks: player.exceptionTicks,
  }));
  const consumed = match.depletion.total - match.depletion.remainingEnd;
  const harvested = match.players.reduce((sum, player) => sum + player.harvests, 0);
  return {
    id: job.id,
    arm: armOf(job.id),
    seed: job.seed,
    seats,
    outcomeReason: match.outcome.reason,
    outcomeTick: match.outcome.tick,
    total: match.depletion.total,
    remainingEnd: match.depletion.remainingEnd,
    consumed,
    harvestEqualsConsumed: consumed === harvested,
    spawnOrders: match.combat.spawnOrders,
    spawnOrdersRejectedBusyBase: match.combat.spawnOrdersRejectedBusyBase,
    refunds: match.combat.refunds,
  };
};

// ── 夹具闸门 ────────────────────────────────────────────────────────────────

type AnchorReport = {
  readonly p100: readonly number[];
  readonly delivered: readonly number[];
  readonly pass: boolean;
};

const runAnchor = (harness: StubHarness): AnchorReport => {
  const jobs = SEEDS.map((seed) => ({
    id: `anchor/fixture/farmer6/s${seed}`,
    seatScripts: ["farmer6", "farmer6", "farmer6", "farmer6"],
    seed,
    mirror: true,
    variant: FIXTURE.variant,
    size: FIXTURE.size,
    mapOpts: { ownedMineOrbits: FIXTURE.ownedMineOrbits },
  }));
  const matches = harness.runMatrix(jobs);
  const p100 = matches.map((match) => match.depletion.ticks.p100 ?? -1);
  const delivered = matches.map((match) => match.players.reduce((sum, p) => sum + p.delivered, 0));
  const pass =
    p100.every((value) => value === ANCHOR.p100) &&
    delivered.every((value) => value === ANCHOR.delivered);
  return { p100, delivered, pass };
};

// ── 并行跑批:分片 → fork 本文件(`--worker`)→ 收回裁剪后的读数 ────────────────

type Shard = { readonly registrations: readonly Registration[]; readonly jobs: readonly StubJob[] };

const runJobs = async (
  harness: StubHarness,
  jobs: readonly StubJob[],
  options: Options,
): Promise<readonly MatchRow[]> => {
  if (options.serial || options.jobs === 1) {
    return harness.runMatrix(jobs).map((match, index) => slim(jobs[index] as StubJob, match));
  }
  const dir = mkdtempSync(join(tmpdir(), "model-war-selfproof-"));
  try {
    const shards: StubJob[][] = Array.from(
      { length: Math.min(options.jobs, jobs.length) },
      () => [],
    );
    jobs.forEach((job, index) => (shards[index % shards.length] as StubJob[]).push(job));
    const live = shards.filter((shard) => shard.length > 0);
    const registrations = registrationsOf(productsOf(options));
    const results = await Promise.all(
      live.map(async (shard, index) => {
        const jobsPath = join(dir, `jobs-${index}.json`);
        const outPath = join(dir, `out-${index}.json`);
        writeFileSync(
          jobsPath,
          JSON.stringify({ registrations, jobs: shard } satisfies Shard),
          "utf8",
        );
        await forkWorker(jobsPath, outPath);
        return JSON.parse(readFileSync(outPath, "utf8")) as MatchRow[];
      }),
    );
    const order = new Map(jobs.map((job, index) => [job.id, index]));
    return results.flat().sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

const forkWorker = (jobsPath: string, outPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", SELF, "--worker", jobsPath, outPath],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`跑批工作进程 ${jobsPath} 退出码 ${code}`));
    });
  });

// ── ① 的静态校验:走静态校验器自己的入口(子进程 + 退出码) ────────────────────

const VALIDATE_ENTRY = `${repoRoot}packages/tools/src/validate/run-validate-script.ts`;

type StaticOutcome = { status: number; output: string };

const runValidator = (file: string, maxBytes: number): Promise<StaticOutcome> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [VALIDATE_ENTRY, file, "--max-bytes", String(maxBytes), "--phase", "freeze"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: unknown) => (output += String(chunk)));
    child.stderr.on("data", (chunk: unknown) => (output += String(chunk)));
    child.on("error", reject);
    child.on("close", (status: number | null) => resolve({ status: status ?? -1, output }));
  });

/**
 * 体积上限的取值:规则集文件里那一键仍是未定值占位(`0`),所以按「以三份入库产物的最大值为下限」
 * 这条既有口径取三份的最大字节数——`benchmarks/README.md` §1 就是这么记的。
 * 占位被填上之前,这一栏取的不是规则值而是**地板值**,报告里必须写清是哪一种。
 */
const maxBytesFor = (
  products: readonly string[],
): { readonly maxBytes: number; readonly source: string } => {
  const declared = RULESET_FILE.scriptSizeLimit;
  const sizes = products.map((file) => readFileSync(file).byteLength);
  const floor = Math.max(...sizes);
  return declared > 0
    ? { maxBytes: declared, source: `规则集文件的 scriptSizeLimit=${declared}` }
    : {
        maxBytes: floor,
        source: `规则集文件的 scriptSizeLimit 仍是占位 0 → 取三份入库产物的最大值 ${floor} 字节(地板值)`,
      };
};

// ── 报告 ────────────────────────────────────────────────────────────────────

/**
 * 报告抬头那段**必须随引用一起带的口径**。
 *
 * 前两条是 gdd §8 记录 #13 写下的两条口径,它们约束的是「怎么读 #13 的数字」,而本报告的数字
 * 恰恰要与 #13 并排看,所以那两条得跟着一起出现;后三条是本轮自己的口径(消耗怎么算、
 * 独立样本有多少、矩阵是什么)。
 */
/**
 * 报告抬头那段**必须随引用一起带的口径**。
 *
 * 前两条是 gdd §8 记录 #13 写下的两条口径,它们约束的是「怎么读 #13 的数字」,而本报告的数字
 * 恰恰要与 #13 并排看,所以那两条得跟着一起出现;后几条是本轮自己的口径(消耗怎么算、
 * 独立样本有多少、矩阵是什么)。
 *
 * **本轮自己的那几条里的每一个数都现算**,不手写:矩阵规模从这批跑批自己的行里数(所以
 * `--probe` 缩矩阵时报的是缩矩阵的数),消耗分母从桩逐场报的 `total` 取(那是地图自己的总储量),
 * 单矿储量从规则集文件取。
 * 这一段自称「必须随引用一起带」——而它下面的代码就在从规则集读值,所以把取值抄在这里
 * 等于让这段口径在改取值之后变成假话:报告读数已经变了,抬头还写着上一代的数,而没人会去看它。
 */
const caliberTextOf = (rows: readonly MatchRow[]): string => {
  // 每臂场数与轮转数:**从这批跑批自己的行里数**,不从常量推——`--probe` 缩矩阵时两者都更小,
  // 而抬头那段是要跟着读数一起被引用的,写死常量等于让缩矩阵的报告带上一句关于全矩阵的话。
  const seedsOfFirstArm = new Set(
    rows.filter((row) => row.arm === (rows[0]?.arm ?? "")).map((r) => r.seed),
  );
  const matchesOfFirstArm = rows.filter((row) => row.arm === (rows[0]?.arm ?? "")).length;
  const rotations =
    seedsOfFirstArm.size > 0 ? Math.round(matchesOfFirstArm / seedsOfFirstArm.size) : 0;
  const perArm = matchesOfFirstArm;
  // 总储量与单矿储量:分母是逐场报的 `total`(地图自己的),单矿那一项取规则集文件。
  const total = rows[0]?.total ?? 0;
  const perSite = RULESET_FILE.resourcePerSite;
  const sites = perSite > 0 ? total / perSite : 0;
  return [
    "口径（引用本读数时必须一起带）：",
    "- 「整局 ≈440」是**单矿储量 125 时代、全矩阵平均**的数，**不是「四份基准脚本」的数**；",
    "  基准脚本口径实测 351。这条命题的松紧度是被储量那一刀改掉的，不是被地图改掉的。",
    "  本报告的数字另起一代：终稿契约 + 终稿基准脚本，与 440 / 351 都不可互比。",
    `- **种子维度对消耗指标零方差**，每臂的有效独立样本只有 **${rotations} 个座位轮转**；`,
    `  本报告每臂 ${perArm} 场 = ${rotations} 座位轮转 × ${seedsOfFirstArm.size} 种子，` +
      `**不得写成「${perArm} 场独立样本」**。`,
    "- 消耗 = 全图储量 − 终局剩余，逐场校验恒等于全场采获之和（自洽校验见下）；分母是总储量",
    `  （${sites} 个资源点 × resourcePerSite ${perSite} = ${total}），不是单矿储量。`,
    "- 本轮三份脚本与 #13 那一轮的四份脚本**不可互比**（契约形态、移动层、错误处理三层都变了，",
    "  抬头口径见 benchmarks/README.md）；可比的只有夹具、臂数、种子、判据与消耗口径。",
  ].join("\n");
};

const tenths = (value: number): string => `${Math.floor(value / 10) % 100}.${value % 10}`;

const renderReport = (
  products: readonly string[],
  maxBytes: { readonly maxBytes: number; readonly source: string },
  staticCheck: ReturnType<typeof checkStatic>,
  outcomeCheck: ReturnType<typeof checkOutcomes>,
  consumption: ReturnType<typeof checkConsumption>,
  distinctness: ReturnType<typeof checkDistinctness>,
  anchor: AnchorReport,
  rows: readonly MatchRow[],
): string => {
  const lines: string[] = [];
  lines.push("契约自证门禁：终稿契约 × 三份基准脚本 × 标定环的桩");
  lines.push("");
  lines.push(caliberTextOf(rows));
  lines.push("");
  lines.push(
    `夹具闸门：farmer6 四方自战 p100=${anchor.p100.join("/")}、delivered=${anchor.delivered.join("/")}`,
  );
  lines.push(
    `（受控锚点 p100=${ANCHOR.p100} / delivered=${ANCHOR.delivered}，逐字一致才跑正表）——${anchor.pass ? "一致，0% 漂移" : "**漂移**"}`,
  );
  lines.push("");
  lines.push(
    `产物：${products.map((file, index) => `${SCRIPT_LABELS[index]}=${file.replace(repoRoot, "")}`).join("　")}`,
  );
  lines.push("");
  lines.push(
    `① 零静态违规：${staticCheck.pass ? "过" : "**不过**"}（静态校验器逐份判定，--max-bytes ${maxBytes.maxBytes}，来源：${maxBytes.source}）`,
  );
  for (const verdict of staticCheck.verdicts) {
    lines.push(
      `   ${verdict.status === 0 ? "✓" : "✗"} ${verdict.name}：退出码 ${verdict.status}${verdict.status === 0 ? "" : `｜${verdict.output.trim().split("\n").slice(0, 3).join(" / ")}`}`,
    );
  }
  lines.push("");
  lines.push(
    `② 正常终局：${outcomeCheck.pass ? "过" : "**不过**"}（${outcomeCheck.matches} 场 / ${outcomeCheck.seats} 席，` +
      `异常 tick 合计 ${outcomeCheck.exceptionTicks}；终局原因 ${Object.entries(
        outcomeCheck.reasons,
      )
        .map(([reason, count]) => `${reason}×${count}`)
        .join("/")}）`,
  );
  lines.push("");
  lines.push(
    `③ 消耗 ≤ 总储量 1/4（配额 ${consumption.quotaPercent}% = ${Object.values(consumption.quotaAbsolute)[0] ?? 0}）：${consumption.pass ? "过" : "**不过**"}`,
  );
  lines.push("   逐份脚本（每席位消耗 = 该席位采获；分母 = 总储量）");
  for (const entry of consumption.byLabel) {
    lines.push(
      `   ${entry.label}：席位 ${entry.seats}｜中位 ${entry.consumed.median}（${tenths(entry.medianTenthsPercent)}%）` +
        `｜最坏单席 ${entry.consumed.max}（${tenths(entry.maxTenthsPercent)}%）｜中位判定 ${entry.medianPass ? "过" : "不过"}｜最坏单席判定 ${entry.maxPass ? "过" : "不过"}`,
    );
  }
  lines.push("   逐臂整场（#13 那一轮的可比读数）");
  for (const entry of consumption.byArm) {
    const total = consumption.totals[entry.arm] ?? 0;
    lines.push(
      `   ${entry.arm}：${entry.consumed.n} 场｜中位 ${entry.consumed.median}（${tenths(tenthsOfPercent(entry.consumed.median, total))}%）` +
        `｜最坏 ${entry.consumed.max}（${tenths(tenthsOfPercent(entry.consumed.max, total))}%）｜配额 ${consumption.quotaAbsolute[entry.arm] ?? 0}`,
    );
  }
  lines.push(
    `   全批：${consumption.batch.consumed.n} 场｜中位 ${consumption.batch.consumed.median}｜最坏 ${consumption.batch.consumed.max}｜超配额 ${consumption.batch.overQuota} 场`,
  );
  lines.push(
    `   自洽校验「消耗 ≡ 全场采获」：${consumption.harvestEqualsConsumedEveryMatch ? "逐场相等" : "**有不等**"}`,
  );
  lines.push("");
  lines.push(
    `④ 取策略互不相同：${distinctness.pass ? "过" : "**不过**"}（每一对至少 ${distinctness.separatedNeeded} 项指标相对差 ≥ 25%）`,
  );
  for (const fingerprint of distinctness.fingerprints) {
    lines.push(
      `   ${fingerprint.label}（${fingerprint.seats} 席）：${BEHAVIOR_METRICS.map((metric, index) => `${metric.key}=${fingerprint.values[index] ?? 0}`).join(" ")}`,
    );
  }
  for (const pair of distinctness.pairs) {
    lines.push(
      `   ${pair.left} vs ${pair.right}：分开 ${pair.separated}/${BEHAVIOR_METRICS.length} 项｜` +
        pair.gaps.map((gap) => `${gap.key} ${gap.gap}%`).join(" "),
    );
  }
  lines.push("");
  const compatTotals = rows.reduce(
    (acc, row) => ({
      rejected: acc.rejected + row.spawnOrdersRejectedBusyBase,
      refunds: acc.refunds + row.refunds,
    }),
    { rejected: 0, refunds: 0 },
  );
  lines.push("桩与终稿契约的缺口（由兼容层补，不静默换口径）：");
  for (const gap of compatGapsOf()) lines.push(`   - ${gap.gap} → ${gap.fill}`);
  lines.push(
    `   兼容层账本与引擎真值可能分叉的两处规模：产线忙被拒 ${compatTotals.rejected} 次、基地易主退款 ${compatTotals.refunds} 次。`,
  );
  lines.push("");
  lines.push(
    "换契约版本时：判据不变、门禁仍绿是正常的，四问的取值会全部变——上面的数字不是回归基线。",
  );
  return lines.join("\n");
};

// ── 入口 ────────────────────────────────────────────────────────────────────

const loadStub = async (): Promise<StubHarness> => {
  // 桩的规则集在**模块加载时**读 STUB_SET,所以覆盖必须写在 import 之前(与 `pilot-prop2.mjs` 同形)。
  if (!process.env["STUB_SET"]) {
    process.env["STUB_SET"] = JSON.stringify({ resourcePerSite: RULESET_FILE.resourcePerSite });
  }
  return (await import(join(STUB, "harness.mjs"))) as StubHarness;
};

const runWorkerMode = async (argv: readonly string[]): Promise<number> => {
  const jobsPath = argv[0];
  const outPath = argv[1];
  if (jobsPath === undefined || outPath === undefined) {
    throw new Error("--worker 需要两个参数:分片读入路径与分片写出路径。");
  }
  const shard = JSON.parse(readFileSync(jobsPath, "utf8")) as Shard;
  const harness = await loadStub();
  registerInto(harness, shard.registrations);
  const matches = harness.runMatrix(shard.jobs);
  const rows = shard.jobs.map((job, index) => slim(job, matches[index] as StubMatch));
  writeFileSync(outPath, JSON.stringify(rows), "utf8");
  return 0;
};

const main = async (argv: readonly string[]): Promise<number> => {
  if (argv[0] === "--worker") {
    return runWorkerMode(argv.slice(1));
  }
  const options = parseArgs(argv);
  const products = productsOf(options);
  for (const product of products) {
    if (!existsSync(product)) {
      process.stderr.write(`读不到产物文件 ${product}\n`);
      return 1;
    }
  }

  const harness = await loadStub();
  registerInto(harness, registrationsOf(products));

  // ①：静态校验器逐份判产物。体积上限的取值在跑批之前定下来(它与对局无关)。
  const maxBytes = maxBytesFor(products);
  const verdicts = await Promise.all(
    products.map(async (file, index) => {
      const outcome = await runValidator(file, maxBytes.maxBytes);
      return {
        name: `${SCRIPT_LABELS[index] ?? "?"} ${file.replace(repoRoot, "")}`,
        status: outcome.status,
        output: outcome.output,
      };
    }),
  );
  const staticCheck = checkStatic(verdicts, maxBytes.maxBytes, maxBytes.source);

  // 夹具闸门：不过就不跑正表。
  const anchor = runAnchor(harness);
  if (!anchor.pass) {
    process.stdout.write(
      `[selfproof] 夹具闸门锚点漂移（期望 p100=${ANCHOR.p100} / delivered=${ANCHOR.delivered}），拒绝跑正表。\n`,
    );
    return 1;
  }

  const jobs = buildJobs(harness, options.probe);
  const started = Date.now();
  const rows = await runJobs(harness, jobs, options);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const outcomeCheck = checkOutcomes(rows);
  const consumption = checkConsumption(rows, options.quotaPercent);
  const distinctness = checkDistinctness(rows);

  const report = renderReport(
    products,
    maxBytes,
    staticCheck,
    outcomeCheck,
    consumption,
    distinctness,
    anchor,
    rows,
  );
  process.stdout.write(`${report}\n`);
  process.stdout.write(
    `矩阵：${jobs.length} 场（${options.probe ? "探针缩矩阵（反例用）" : `4 臂 × 4 座位轮转 × ${SEEDS.length} 种子`}，桩 ${STUB.replace(repoRoot, "")} 未改），用时 ${elapsed}s\n`,
  );

  if (options.out !== null) {
    writeEvidence(
      options,
      products,
      maxBytes,
      staticCheck,
      outcomeCheck,
      consumption,
      distinctness,
      anchor,
      rows,
      jobs.length,
      elapsed,
    );
  }

  const pass = staticCheck.pass && outcomeCheck.pass && consumption.pass && distinctness.pass;
  process.stdout.write(
    `契约自证门禁:${pass ? "绿" : "红"}（① ${yn(staticCheck.pass)} ② ${yn(outcomeCheck.pass)} ③ ${yn(consumption.pass)} ④ ${yn(distinctness.pass)}）\n`,
  );
  return pass ? 0 : 1;
};

const yn = (value: boolean): string => (value ? "过" : "不过");

const writeEvidence = (
  options: Options,
  products: readonly string[],
  maxBytes: { readonly maxBytes: number; readonly source: string },
  staticCheck: ReturnType<typeof checkStatic>,
  outcomeCheck: ReturnType<typeof checkOutcomes>,
  consumption: ReturnType<typeof checkConsumption>,
  distinctness: ReturnType<typeof checkDistinctness>,
  anchor: AnchorReport,
  rows: readonly MatchRow[],
  jobCount: number,
  elapsed: string,
): void => {
  mkdirSync(options.out as string, { recursive: true });
  const dir = options.out as string;
  writeFileSync(
    join(dir, "summary.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        ruleSet: {
          resourcePerSite: RULESET_FILE.resourcePerSite,
          tickLimit: RULESET_FILE.tickLimit,
        },
        quotaPercent: options.quotaPercent,
        matrix: {
          jobs: jobCount,
          arms: ["P0/fixture", ...MAP_NAMES.map((name) => `P1/${name}`)],
          seatBase: SEAT_BASE,
          rotations: 4,
          seeds: SEEDS,
          mirror: false,
          stub: STUB.replace(repoRoot, ""),
        },
        products: products.map((file) => ({
          path: file.replace(repoRoot, ""),
          sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        })),
        staticCheck,
        outcomeCheck,
        consumption,
        distinctness,
        anchor,
        compatGaps: compatGapsOf(),
        elapsedSeconds: elapsed,
      },
      null,
      1,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(dir, "matches.json"), `${JSON.stringify(rows, null, 1)}\n`, "utf8");
  writeFileSync(
    join(dir, "report.md"),
    `${renderReport(products, maxBytes, staticCheck, outcomeCheck, consumption, distinctness, anchor, rows)}\n`,
    "utf8",
  );
  process.stdout.write(
    `产物：${dir.replace(repoRoot, "")}/{report.md,summary.json,matches.json}\n`,
  );
};

process.exitCode = await main(process.argv.slice(2));
