/**
 * `evaluate` 服务:宿主侧的**提交 + 整张网格 + 观测外置**,经薄壳通道交给沙箱里的模型。
 *
 * ── `evaluate` 就是提交(ADR-0030) ──
 *
 * 模型写文件、叫 `evaluate`,宿主读**当前** `/workspace/script.ts` 送去跑整张网格;成绩取
 * **最后一次** `evaluate` 评的那个版本。所以本服务的第一步是把「当前这份文件」定下来:
 * 记它的 sha256、编译,并把两份字节**立刻快照**进候选证据族——不是会话结束时再读一遍工作区
 * (那会把「评完之后又改过」这件事变成成绩的一部分,而模型可能只是想清理一下)。
 *
 * ── 一次读,两条路 ──
 *
 * 工作区只读一次,同一段文本既喂编译器也落源码快照。分两次读会造出一个真的窗口:模型写
 * `evaluate &` 再改 `script.ts` 时(或短会话里有后台写句柄时),快照拿到的是第二份字节,而
 * 产物来自第一份——「快照就是被评的那份字节」当场变成假话。
 *
 * ── 快照沿用既有命名族,不新建目录(ADR-0031) ──
 *
 * `observed-<runId>-round-<步号>{.jsonl,.jsonl.candidate.ts,.jsonl.candidate.js}` 就是既有逐候选
 * 产物的那一族:观测旁挂 + 候选源码/产物。报告侧按它判完整性(`scriptFile` 必须恰为
 * `${observationsFile}.candidate.js`、`observationsFile` 必须以 `-round-<step>.jsonl` 结尾),
 * 所以这里一行名字都不许自造。`COPYFILE_EXCL`:已有同名证据即整次拒绝,不覆盖、不静默复用。
 *
 * ── 观测出口:stdout 只给聚合对差表与一行路径(ADR-0030「外置,而不是压缩」) ──
 *
 * 常驻上下文只放**聚合对差表**(座位 × 地图的八格)与一行指向完整观测的路径;逐场一行与最差
 * 三场的展开落 `/workspace/.observations/<n>.md`,模型按需读。派生视图**不进档案**:它由落盘的
 * 观测数据与渲染规则确定性生成,搬进档案等于给同一事实第二个家。进档案的是**原料**(观测 JSONL)
 * 与候选身份——报告侧要从那里复算。
 *
 * ── 几处拒绝都不白花一次信息机会 ──
 *
 * 1. 没有 `/workspace/script.ts`:不编译、不跑;
 * 2. 编译不过:不跑(先用 `check` 修掉再提交);
 * 3. 同一步已经评过:回一条可读的拒绝——那是模型侧的手滑,不该升级成 infra;
 * 4. 观测不完整(缺场):不产出候选,并把缺了哪几场说给模型听——「少跑几场凑个好看的数」在
 *    这里就被拦掉,而不是留到报告侧。
 *
 * 预算触限(试跑判拦)同样不产出候选:那是「这份脚本跑不了」,不是「跑了但分低」。
 *
 * ── 提交身份交回调用方,成绩不在这里 ──
 *
 * 本服务回答「评的是哪份字节、观测落在哪」;「这张网格给多少分」由旁挂的 `.grid.json` 回答,
 * 读它、校它、落进候选条目的是 `pipeline.ts` 的评分接缝(`EvaluateScoring`)。两半分开是因为
 * 它们的真源不同:身份在这里(读了什么字节),分数在网格里(跑出什么结果)。
 */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRIAL_GRID_SUMMARY_SUFFIX, type ToolResponse, type TrialPlan } from "@model-war/schema";

import { SCRIPT_SOURCE_NAME, sha256Hex } from "../../archive.js";
import { compileScript, type CompileResult } from "../../compile.js";
import {
  candidateObservationsFileOf,
  candidateObservationsFilePrefixOf,
  missingTrialGridMatches,
  readTrialObservations,
  renderScoreSourceFeedback,
  renderScoreSourceSummary,
} from "../../observations.js";
import type { TrialProbe } from "../../trial.js";
import {
  CHECK_DIAGNOSTIC_LIMIT,
  tscDiagnostics,
  WORKSPACE_SCRIPT_PATH,
  type CompileFn,
} from "./check-service.js";

/** 观测目录(工作区里的名字)。逐次评测一份,`<n>` = 第几次评测。 */
export const OBSERVATIONS_DIR_NAME = ".observations";

/** 观测目录在沙箱里的绝对路径(模型 `cat` 的就是它)。 */
export const OBSERVATIONS_DIR_PATH = `/workspace/${OBSERVATIONS_DIR_NAME}`;

/**
 * 候选证据族在 `archive/<slug>/` 下的 basename:观测 JSONL。
 *
 * 名字的真源在 `observations.ts`(`-round-<步号>` 与报告侧的对账同一条规则),这里只转发 +
 * 补这一族另外两份的名字。三处共用:服务落盘、pipeline 的候选条目、测试。
 */
export const candidateObservationsFile = candidateObservationsFileOf;

/** 候选编译产物(`.candidate.js`)的 basename;候选条目的 `scriptFile` 就是它。 */
export const candidateScriptFile = (observationsFile: string): string =>
  `${observationsFile}.candidate.js`;

/** 候选源码(`.candidate.ts`)的 basename:评估时那份工作区字节的副本。 */
export const candidateSourceFile = (observationsFile: string): string =>
  `${observationsFile}.candidate.ts`;

/**
 * 一次评测在 `archive/<slug>/` 下落下的**一族**文件:观测原料 + 两份候选快照 + 网格汇总。
 *
 * 名字从这一处出,调用方不各写一份字面量:失败清理要按名字认出自己那一族,而认错一个后缀
 * 就是一个残留文件。
 */
export const candidateArtifactFiles = (observationsFile: string): readonly string[] => [
  observationsFile,
  candidateSourceFile(observationsFile),
  candidateScriptFile(observationsFile),
  `${observationsFile}${TRIAL_GRID_SUMMARY_SUFFIX}`,
];

/** `name` 是不是 `runId` 这一跑的候选旁挂产物(`observed-<runId>-round-<步号>.jsonl…`)。
 *
 * 判据是「前缀 + 纯数字步号 + 本族的后缀」三件都对上。只看前缀不够:另一次的 runId 可能是
 * 这一跑的前缀串(`r1` 对 `r1-round`),那样会把另一份档的字节删掉。
 */
export const isCandidateArtifactOf = (name: string, runId: string): boolean => {
  const head = candidateObservationsFilePrefixOf(runId);
  if (!name.startsWith(head)) return false;
  const rest = name.slice(head.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return false;
  const step = rest.slice(0, dot);
  if (!/^\d+$/u.test(step)) return false;
  return candidateArtifactFiles(`${head}${step}.jsonl`).includes(name);
};

/**
 * 失败会话的清理:把这一跑在 `archive/<slug>/` 下落下的候选旁挂产物删干净。
 *
 * ── 为什么需要它 ──
 *
 * 候选快照必须在**评测那一刻**落盘(「快照即提交」),而那时还不知道整场会话会不会成功。
 * 所以零候选 / 冻结失败 / 落档失败这三条路上,`archive/<slug>/` 会剩下没有主人的旁挂产物。
 * 发布不变量(`docs/hld.md`)是「失败只写 `failed-<runId>.json`」:目录里的东西要么是一份
 * 完整的三件套,要么是一条失败记录。
 *
 * ── 只删自己那一跑 ──
 *
 * 名字按 runId 认(见 `isCandidateArtifactOf`),同目录里别的档、别的跑的字节一律不碰。
 * 工作区里的派生视图(`/workspace/.observations/<n>.md`)不在这里:它住在会话工作区,
 * 不在 `archive/` 的发布面上。
 */
export const discardCandidateArtifacts = (options: {
  readonly root: string;
  readonly model: string;
  readonly runId: string;
}): void => {
  const archiveDir = join(options.root, "archive", options.model);
  let names: readonly string[];
  try {
    names = readdirSync(archiveDir);
  } catch {
    // 目录不在 = 一次评测都没跑过 = 没有可清的。
    return;
  }
  for (const name of names) {
    if (isCandidateArtifactOf(name, options.runId)) rmSync(join(archiveDir, name), { force: true });
  }
};

/** 一次提交的身份:评的是哪份字节、产物是什么、观测落在哪。 */
export type EvaluateSubmission = {
  /** 沙箱视角的源路径(恒为 `/workspace/script.ts`)。 */
  readonly workspacePath: string;
  /** 宿主视角的源路径(本服务读到的那一份)。 */
  readonly hostPath: string;
  /** 源字节的 sha256(回答「评的是哪一版」)。 */
  readonly scriptSha256: string;
  /** 编译产物(宿主临时目录里那份;**返回即删**,要留就留快照)。 */
  readonly artifactPath: string;
  /**
   * 编译产物的 sha256。
   *
   * 它与 `scriptSha256` 不是同一个数:档案契约复算的是**产物**,观测行里的行动事实也是按产物
   * 归属候选的。两个哈希分开写清,是因为谁替谁都读侧看不出来。
   */
  readonly productSha256: string;
  /** 编出这份产物的 tsc 版本(冻结时要写进 `meta.tscVersion`,所以在这里记下)。 */
  readonly tscVersion: string;
  /** 完整观测的**派生视图**(沙箱视角):聚合 + 逐场 + 最差三场。 */
  readonly observationsPath: string;
  /** 候选证据族的 basename(候选条目的 `observationsFile`)。 */
  readonly observationsFile: string;
};

/** 一次 `evaluate` 的结论:协议响应 + 提交身份。`submission` 缺席 = 这一次没有产出候选。 */
export type EvaluateOutcome = ToolResponse & { readonly submission?: EvaluateSubmission };

/** 一次 `evaluate` 的入参。 */
export type EvaluateRequest = {
  readonly workspaceDir: string;
  /** 第几次评测(1 起,由 dispatcher 的计数器给)。 */
  readonly call: number;
  /**
   * 步号(1 起):候选证据族的序号就是它。
   *
   * **必填而不是可选**:以前它是「当前步」槽里读出来的,缺了就用 `NaN` 兜底再由服务拒——那让
   * 「这一步是第几步」变成一个要按时序保证的东西。现在步号由执行器请求带进来
   * (`requestHandlerFor(step)` 把它绑进通道应答端),缺了是类型错误,不是运行期惊喜。
   */
  readonly step: number;
};

/** 服务形态:给 dispatcher 调的那一个函数。 */
export type EvaluateService = (request: EvaluateRequest) => Promise<EvaluateOutcome>;

/** `createEvaluateService` 的依赖。 */
export type EvaluateServiceDeps = {
  /** 安装根(仓库根)。 */
  readonly root: string;
  /** 正在被生成的模型 slug(试跑入口要它:在位陪练 = 它自己最近一次冻结存档)。 */
  readonly model: string;
  /** 本次会话的 run id(候选证据族名字的一半)。 */
  readonly runId: string;
  /**
   * 本次会话那张网格的计划。**惰性**给:搬计划要 spawn 一次试跑入口(`--plan`),而一次会话可能
   * 一次 `evaluate` 都不做——没做就没必要搬,更没必要因为搬不动而让整场会话失败。
   *
   * 计划进试跑时以 `--expected-plan` 交回入口,入口按现场事实重建并逐字段比对(`checkTrialPlan`):
   * 换图、换座位、换种子、换一份陪练摘要都在那里被拒,而那是 infra,不是候选的错。
   */
  readonly plan: () => TrialPlan;
  /** 试跑探针:生产走 `runTrialScript`,测试与 gate 注入假实现。 */
  readonly trial: TrialProbe;
  readonly compile?: CompileFn;
  /** 失败观测里给多少条 tsc 诊断;缺省与 `check` 同档。 */
  readonly diagnosticLimit?: number;
};

/** 只取第一行:stdout 的判定行只要一句,明细归观测文件。 */
const firstLine = (text: string): string => {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line ?? "";
};

/**
 * 造一个 `evaluate` 服务。
 *
 * 计数器**不在这里**:「本会话已用几次」是会话级状态,归 dispatcher(它是每个会话一份的
 * 实例)。本服务只负责「评这一次」,把第几次作为入参收下,用它给观测文件起名。
 *
 * 上一次评测的读数留在这里(闭包状态),因为对差表的「Δ」列要拿它当对照:一次会话里的候选是
 * 一串迭代,第一次没有对照物,后面每一次都有。
 */
export const createEvaluateService = (deps: EvaluateServiceDeps): EvaluateService => {
  const compile = deps.compile ?? compileScript;
  const limit = deps.diagnosticLimit ?? CHECK_DIAGNOSTIC_LIMIT;
  const archiveDir = join(deps.root, "archive", deps.model);
  /** 上一次评测的读数(对差表的对照物);第一次评测时缺席。 */
  let previous: ReturnType<typeof readTrialObservations> | undefined;

  return async (request: EvaluateRequest): Promise<EvaluateOutcome> => {
    const step = request.step;
    if (!Number.isSafeInteger(step) || step < 1) {
      // 候选证据族的序号来自步号,没有序号就没有能对得上的名字——大声失败,不猜一个。
      // 类型上它已经必填;这一条拦的是「传了个 0 或 NaN 进来」那种契约外的调用。
      throw new Error(
        `evaluate 服务的步号必须是正整数(收到 ${String(step)}):候选证据族不能无名落盘`,
      );
    }
    const hostPath = join(request.workspaceDir, SCRIPT_SOURCE_NAME);
    let source: string;
    try {
      source = readFileSync(hostPath, "utf8");
    } catch {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `evaluate:${WORKSPACE_SCRIPT_PATH} 不存在:先把脚本写到那里再提交。\n`,
      };
    }

    const observationsFile = candidateObservationsFile(deps.runId, step);
    const observationsHostPath = join(archiveDir, observationsFile);
    const stagingDir = mkdtempSync(join(tmpdir(), "model-war-evaluate-"));
    try {
      const compiled: CompileResult = compile({
        root: deps.root,
        stagingDir,
        source,
      });
      if (!compiled.ok) {
        const entries = tscDiagnostics(compiled.diagnostics).slice(0, limit);
        return {
          exitCode: 1,
          stdout: "",
          stderr: ["evaluate:提交的脚本编译不过,这一次不评(先用 check 修掉):", ...entries].join(
            "\n",
          ),
        };
      }

      // ── 一步只评一次 ──
      //
      // 同一块 bash 里连叫两次 `evaluate`(或上一次留下的同名证据还在)时,证据族已经有主:
      // 这是一次**模型侧**的重复提交,回一条可读的拒绝就行——把它升级成 infra 会让一次手滑
      // 掀掉整场会话。真正的并发/撞名(下面那两个 `COPYFILE_EXCL`)仍然是大声失败。
      if (
        existsSync(join(archiveDir, candidateSourceFile(observationsFile))) ||
        existsSync(join(archiveDir, candidateScriptFile(observationsFile)))
      ) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            `evaluate:这一步(第 ${String(step)} 步)已经评过一次了,一次只评一次;` +
            "要再评就换一步写文件后再叫 evaluate。\n",
        };
      }

      // ── 快照即提交:两份字节在**跑之前**就落定 ──
      //
      // 先落快照再跑网格,是因为「评的是哪份字节」这件事在跑之前就已经定了;跑完之后再读一遍
      // 工作区会把模型后来的改动混进成绩里。`COPYFILE_EXCL`:同名证据已存在即整次失败,
      // 宁可红也不覆盖别人的字节。
      //
      // 源码快照写的是**喂给编译器的那段字节**(`source`),不是再从 `hostPath` 拷一遍:
      // 模型写 `evaluate &` 再改 `script.ts` 时,第二次读会拿到另一份字节,于是快照里的源与
      // 产物的来源不是同一份——而 `scriptSha256` 算的正是喂给编译的那一份。一次读、两条路
      // 用同一份字节,「快照字节 == 评估时字节」在构造上成立,不靠时序。
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, candidateSourceFile(observationsFile)), source, {
        encoding: "utf8",
        flag: "wx",
      });
      copyFileSync(
        compiled.jsPath,
        join(archiveDir, candidateScriptFile(observationsFile)),
        constants.COPYFILE_EXCL,
      );
      const productSha256 = sha256Hex(
        readFileSync(join(archiveDir, candidateScriptFile(observationsFile))),
      );
      const plan = deps.plan();

      // 探针可以是异步的(注入缝的两种形态):真探针是 `spawnSync`(它阻塞,那正是子进程语义),
      // 而测试要演「服务在宿主侧干了几秒」时不该被迫把事件循环一起冻住——冻住的话单步墙钟的
      // 计时器根本不会到期,于是「服务在途时冻结墙钟」这件事在测试里测不出来。见
      // `apps/cli/src/agent-real-session.test.ts` 那条慢评测用例。
      const result = await deps.trial({
        root: deps.root,
        model: deps.model,
        artifactPath: compiled.jsPath,
        observationsPath: observationsHostPath,
        plan,
      });

      const observationsPath = `${OBSERVATIONS_DIR_PATH}/${String(request.call)}.md`;
      const observationsViewPath = join(
        request.workspaceDir,
        OBSERVATIONS_DIR_NAME,
        `${String(request.call)}.md`,
      );
      mkdirSync(join(request.workspaceDir, OBSERVATIONS_DIR_NAME), { recursive: true });

      /** 上一次评测的读数是对差表的对照物;第一次评测没有它。 */
      const earlier = previous;
      const readings = readTrialObservations(observationsHostPath, productSha256, plan);
      const missing = missingTrialGridMatches(readings ?? [], plan);
      // 派生视图照写:被拦下或缺场的那一次同样值得读,而它不进档案(ADR-0030/0031)。
      if (readings !== undefined && readings.length > 0) {
        writeFileSync(
          observationsViewPath,
          `${renderScoreSourceFeedback(readings, plan, earlier, productSha256)}\n`,
          "utf8",
        );
        previous = readings;
      }

      // ── 缺场:不产出候选,并把缺了哪几场说给模型听 ──
      if (readings === undefined || missing.length > 0) {
        const detail =
          readings === undefined
            ? "试跑没有写观测文件"
            : `计划 ${String(plan.matches.length)} 场,读数 ${String(readings.length)} 场,缺 ${missing
                .map((index) => `#${String(index).padStart(2, "0")}`)
                .join(" / ")}`;
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            `evaluate:试跑观测不完整,这一次不产出候选(少跑几场凑不了分):${detail}。\n` +
            `完整观测:${observationsPath}\n`,
        };
      }

      // ── 预算触限:同样不产出候选(跑不了 ≠ 分低) ──
      if (!result.passed) {
        const reason = firstLine(result.stdout);
        return {
          exitCode: 1,
          stdout:
            `evaluate:拦下${reason === "" ? "" : ` · ${reason}`}\n` +
            `${renderScoreSourceSummary(readings, plan, earlier)}\n` +
            `完整观测:${observationsPath}\n`,
          stderr: "",
        };
      }

      return {
        exitCode: 0,
        stdout:
          `evaluate:通过(${String(readings.length)}/${String(plan.matches.length)} 场)\n` +
          `${renderScoreSourceSummary(readings, plan, earlier)}\n` +
          `完整观测:${observationsPath}\n`,
        stderr: "",
        submission: {
          workspacePath: WORKSPACE_SCRIPT_PATH,
          hostPath,
          scriptSha256: sha256Hex(Buffer.from(source, "utf8")),
          artifactPath: compiled.jsPath,
          productSha256,
          tscVersion: compiled.tscVersion,
          observationsPath,
          observationsFile,
        },
      };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  };
};
