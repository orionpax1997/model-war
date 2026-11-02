/**
 * 冻结期试跑的子进程封装：以子进程调 `apps/cli` 的试跑入口，契约是
 * 「`<候选产物.js> --root <安装根> --observations <路径>`，stdout = 面向模型的文本，
 * 退出码 = 过/拦」
 *（hld §6.2「API 误用」那一行与 `validate.ts` 同款形状：子进程 + 退出码 + stdout）。
 *
 * ── 为什么是子进程，而不是 import 试跑的库 ──
 *
 * 与 `validate.ts` 头注同一条理由：试跑入口的对外契约只有三样（退出码、stdout、参数）。
 * 直接 import 会把引擎的执行链并进生成管线的 program——而门禁（`dependency-boundary` +
 * `no-match-result-symbols`）禁的正是这条边。所以生成管线只经子进程消费试跑。
 *
 * ── 计划在这条缝里是**搬运**的，不是造的 ──
 *
 * 造计划要读盘算摘要（规则集 / 两张地图 / 四份陪练脚本字节），那条边会把装载与执行链并进
 * 生成管线的 program（门禁禁止）。所以本包只：`--plan --model` 拿一次 expected plan，
 * 每次执行把它写成临时文件、以 `--expected-plan` 交回入口；入口按现场事实重建的计划必须与它
 * 逐字相等，不等即 infra（「计划被换过」不是候选的错）。
 *
 * `--model` 不是对手参数：四份陪练里「在位」那份是**该模型自己最近一次冻结存档**，所以造计划
 * 必须知道给谁生成。
 *
 * ── `--observations` 是同一个私有协议的第三个参数 ──
 *
 * 路径由本包**原样转发**给入口（真源在 `observations.ts`），入口照它把「无得分来源」
 * 读数落盘。这样本包不必解析 stderr 文本，而文本解析正是「换个文案就静默读不到数」
 * 的那种脆。观测数据**不进** `TrialResult`：它是旁证，不是预算结论；显式观测回喂
 * 由 pipeline 读本次 invocation 的文件，预算回喂仍消费 stdout。
 *
 * ── 退出码是试跑入口的私有协议 ──
 *
 * `0` 通过；`1` 预算超限（stdout = 回喂文本，逐字交回）；其它一律抛错（infra 错误，
 * 大声失败，不回喂）。空 stdout 的 `1` 也是抛错：回喂空文本等于往 transcript 里
 * 追加一条空 user 消息，那是入口的协议违约，不是候选的错。
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TrialPlan } from "@model-war/schema";

export type TrialResult = {
  /** 退出码 0 = 通过；1 = 拦下（`stdout` 为回喂文本）。 */
  readonly passed: boolean;
  /**
   * 子进程 stdout。拦下时是**面向模型的文本**——唯一允许回喂给模型的内容；
   * 通过时是过线小结，调用方忽略它。
   */
  readonly stdout: string;
};

/** 试跑探针：一处可注入的缝（生产走真子进程，测试走桩）。 */
export type TrialProbe = (options: {
  readonly root: string;
  /** 正在被生成的模型 slug（在位陪练 = 它自己最近一次冻结存档）。 */
  readonly model: string;
  readonly artifactPath: string;
  /**
   * 本次 invocation 的观测文件路径（`observations.ts` 是路径真源）。入口照它整份重写。
   */
  readonly observationsPath: string;
  /**
   * 本次生成共用的评测网格计划（`--plan` 那一次的输出）。给了就必须与入口按现场事实重建的
   * 计划逐字相等（入口 `--expected-plan`），写回的 `.grid.json` 也必须与它一致。
   *
   * 缺省 = 只跑不比对（未开启事实优化的路径不读观测，也没有 expected plan）。
   * 测试桩拿它写 32 行观测与汇总，不需要自己造计划。
   */
  readonly plan?: TrialPlan;
}) => TrialResult;

/** 试跑入口在安装根下的位置（`apps/cli` 的构建产物，调用约定见那份入口的头注）。 */
const TRIAL_ENTRY = join("apps", "cli", "dist", "trial", "run-trial-script.js");

/**
 * 试跑计划的**搬运**：入口的 `--plan` 模式从安装根现算事实、打印计划的 canonical JSON。
 *
 * 本包不造计划——造它需要读盘算摘要（规则集 / 地图 / 对手脚本字节），而那条边会把
 * 装载与执行链并进生成管线的 program（门禁禁止）。所以这里只 `spawnSync` 一次、
 * 把 JSON 解析回来；计划**是什么、能不能由输入重建**由 runner 侧判断（本包不得 import runner）。
 * 形状校验由存档落地那一侧补（计划进存档时配 JSON Schema）。
 */
export const prepareTrialPlan = (root: string, model: string): TrialPlan => {
  const ran = spawnSync(
    process.execPath,
    [join(root, TRIAL_ENTRY), "--plan", "--root", root, "--model", model],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (ran.error !== undefined) throw ran.error;
  const status = ran.status ?? -1;
  if (status !== 0)
    throw new Error(`试跑计划装载失败（码 ${String(status)}）：${ran.stderr ?? ""}`.trim());
  try {
    return JSON.parse(ran.stdout) as TrialPlan;
  } catch {
    throw new Error("试跑计划输出不完整");
  }
};

/**
 * 跑一次试跑。`artifactPath` 是编译产物（`script.js`）的路径；
 * `observationsPath` 是这次试跑的观测文件落盘点（调用方算，本包逐字转发）。
 *
 * 参数顺序照入口的用法串：`<产物文件> --root <安装根> --observations <观测文件>`。
 */
export const runTrialScript = (options: {
  readonly root: string;
  readonly model: string;
  readonly artifactPath: string;
  readonly observationsPath: string;
  readonly plan?: TrialPlan;
}): TrialResult => {
  const entry = join(options.root, TRIAL_ENTRY);
  // 计划走文件而不走参数：它是 32 场的完整身份（几十 KB），入口按 `--expected-plan` 逐字段比。
  // 临时目录建在系统临时区（不进安装根，也不进存档面），跑完即删。
  const args = [
    entry,
    options.artifactPath,
    "--root",
    options.root,
    "--model",
    options.model,
    "--observations",
    options.observationsPath,
  ];
  if (options.plan === undefined) {
    return resultOf(
      spawnSync(process.execPath, args, { encoding: "utf8" }),
      options.observationsPath,
    );
  }
  const planDir = mkdtempSync(join(tmpdir(), "modelwar-trial-plan-"));
  const planPath = join(planDir, "plan.json");
  try {
    writeFileSync(planPath, JSON.stringify(options.plan));
    return resultOf(
      spawnSync(process.execPath, [...args, "--expected-plan", planPath], { encoding: "utf8" }),
      options.observationsPath,
    );
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
};

/** 子进程结果 → 试跑结论（退出码是私有协议：0 过、1 拦下、其余 infra）。 */
const resultOf = (result: SpawnSyncReturns<string>, observationsPath: string): TrialResult => {
  if (result.error !== undefined) {
    throw result.error;
  }
  const status = result.status ?? -1;
  const stdout = result.stdout ?? "";
  if (status === 0) {
    return { passed: true, stdout };
  }
  if (status === 1 && stdout.trim().length > 0) {
    return { passed: false, stdout };
  }
  throw new Error(
    `试跑子进程异常退出（码 ${String(status)}，观测 ${observationsPath}）：${result.stderr ?? ""}`.trim(),
  );
};
