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
 * ── `--observations` 是同一个私有协议的第三个参数 ──
 *
 * 路径由本包**原样转发**给入口（真源在 `observations.ts`），入口照它把「无得分来源」
 * 读数落盘。这样本包不必解析 stderr 文本，而文本解析正是「换个文案就静默读不到数」
 * 的那种脆。观测数据**不进** `TrialResult`：它是旁证，不是结论，回喂与记账都用不着它。
 *
 * ── 退出码是试跑入口的私有协议 ──
 *
 * `0` 通过；`1` 预算超限（stdout = 回喂文本，逐字交回）；其它一律抛错（infra 错误，
 * 大声失败，不回喂）。空 stdout 的 `1` 也是抛错：回喂空文本等于往 transcript 里
 * 追加一条空 user 消息，那是入口的协议违约，不是候选的错。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

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
  readonly artifactPath: string;
  /**
   * 观测文件路径（`observations.ts` 是真源）。入口照它整份重写；**本包不读那几行**。
   */
  readonly observationsPath: string;
}) => TrialResult;

/** 试跑入口在安装根下的位置（`apps/cli` 的构建产物，调用约定见那份入口的头注）。 */
const TRIAL_ENTRY = join("apps", "cli", "dist", "trial", "run-trial-script.js");

/**
 * 跑一次试跑。`artifactPath` 是编译产物（`script.js`）的路径；
 * `observationsPath` 是这次试跑的观测文件落盘点（调用方算，本包逐字转发）。
 *
 * 参数顺序照入口的用法串：`<产物文件> --root <安装根> --observations <观测文件>`。
 */
export const runTrialScript = (options: {
  readonly root: string;
  readonly artifactPath: string;
  readonly observationsPath: string;
}): TrialResult => {
  const entry = join(options.root, TRIAL_ENTRY);
  const result = spawnSync(
    process.execPath,
    [
      entry,
      options.artifactPath,
      "--root",
      options.root,
      "--observations",
      options.observationsPath,
    ],
    { encoding: "utf8" },
  );
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
    `试跑子进程异常退出（码 ${String(status)}，stdout 为空或非 0/1）：${result.stderr ?? ""}`.trim(),
  );
};
