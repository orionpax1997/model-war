/**
 * `check` 服务:宿主侧的**类型检查 + 静态校验**,经薄壳通道交给沙箱里的模型。
 *
 * ── 复用什么、不复用什么 ──
 * 复用的是生成侧既有的两条调用缝:`compileScript`(tsc CLI,现场读版本)与 `validateScript`
 * (静态校验器的子进程入口,参数与相位照旧)。它们已经是「一次命令」的形状,这里只做三件
 * 薄壳不该做的事:读 `/workspace/script.ts`、把结果压成**前若干条 + 总数**、把全文落进
 * 工作区(`/workspace/.check.txt`)。
 *
 * ── 为什么 stdout 只给前 20 条 + 总数(ADR-0030「观测外置」) ──
 * 分步形态里每一步的观测都会被后续每一步重复付费,而 tsc 一次能吐几百行诊断。所以常驻 stdout
 * 只给最要紧的那一小段与一个总数,全文落在工作区由模型按需 `sed -n`/`grep` 去取。**一分信息
 * 没丢**,丢的只是「默认全部塞进上下文」。派生视图(`.check.txt`)**不进档案**:它由落盘的
 * 源与判定链确定性生成,搬进档案等于给同一事实第二个家。
 *
 * ── 结果侧只留下稳定的小集合(`steps[i].result`) ──
 * tsc 侧从诊断文本里抽 `TSxxxx`(去重、排序);契约侧从违规行里抽规则标签。两个都是**小函数、
 * 稳定输出**,因为它们会进档案并被跨会话比对:一段文案改一个字就让历史档的 `result` 变样,
 * 那比没有 `result` 更糟。
 *
 * ── 依赖边界 ──
 * 本模块只 import `@model-war/schema`(类型与规则集常量)与 `packages/gen` 自己的
 * `compile` / `validate`。执行器的子进程与试跑入口都在同一个包内,不碰 engine / runner /
 * replay(见 `packages/gen/src/dependency-boundary.test.ts`)。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolResponse } from "@model-war/schema";

import { SCRIPT_SOURCE_NAME } from "../../archive.js";
import { compileScript, type CompileResult } from "../../compile.js";
import {
  scriptSizeLimit,
  validateScript,
  type ScriptLintPhase,
  type ValidateResult,
} from "../../validate.js";

/** stdout 里最多给多少条诊断(ADR-0030 那一档的取值;改动它是换 harness,见 ADR-0032)。 */
export const CHECK_DIAGNOSTIC_LIMIT = 20;

/** 全文落点(工作区里的文件名)。它**不进档案**,只是模型按需读的那份派生视图。 */
export const CHECK_FULL_TEXT_NAME = ".check.txt";

/** 全文在沙箱里的绝对路径(模型看到的那个)。 */
export const CHECK_FULL_TEXT_PATH = `/workspace/${CHECK_FULL_TEXT_NAME}`;

/** 交付物在沙箱里的绝对路径(模型写的、本服务读的同一个东西)。 */
export const WORKSPACE_SCRIPT_PATH = `/workspace/${SCRIPT_SOURCE_NAME}`;

/** 注入缝:编译。生产走 `compileScript`,测试注入假 tsc 输出。 */
export type CompileFn = (options: {
  readonly root: string;
  readonly stagingDir: string;
  readonly source: string;
}) => CompileResult;

/** 注入缝:静态校验。生产走 `validateScript`。 */
export type ValidateFn = (options: {
  readonly root: string;
  readonly artifactPath: string;
  readonly maxBytes: number;
  readonly phase: ScriptLintPhase;
}) => ValidateResult;

/** 一次 `check` 的入参:**工作区由宿主持有**,模型看不见这个形参。 */
export type CheckRequest = { readonly workspaceDir: string };

/** 服务形态:给 dispatcher 调的那一个函数。 */
export type CheckService = (request: CheckRequest) => Promise<ToolResponse>;

/** `createCheckService` 的依赖。除 `root` 全部可注入(单测不跑真 tsc、也不读规则集)。 */
export type CheckServiceDeps = {
  /** 安装根(仓库根):`tsc` 与校验器入口都相对它找。 */
  readonly root: string;
  readonly compile?: CompileFn;
  readonly validate?: ValidateFn;
  /** 体积上限;缺省从 `rulesets/<版本>.json` 现读(不写死)。 */
  readonly maxBytes?: number;
  /** 校验相位;缺省 `iteration`(只提示不硬拦,与生成期的第一次检查同档)。 */
  readonly phase?: ScriptLintPhase;
  /** stdout 的诊断条数上限;缺省 `CHECK_DIAGNOSTIC_LIMIT`。 */
  readonly limit?: number;
};

const nonEmptyLines = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

/**
 * tsc 的诊断条目:含 `error TSxxxx` / `warning TSxxxx` 的那些行。
 *
 * 刻意**不**收 tsc 的汇总行(「Found 3 errors…」)——那一行的信息量由「共 N 条」那句话承担,
 * 收进来会让总数与条目数对不上。
 */
export const tscDiagnostics = (text: string): readonly string[] =>
  nonEmptyLines(text).filter((line) => /(?:error|warning) TS\d+/u.test(line));

/** 从 tsc 诊断文本抽错误码:去重、排序,只留 `TSxxxx`。 */
export const tscErrorCodes = (text: string): readonly string[] =>
  [...new Set(text.match(/TS\d+/gu) ?? [])].sort();

/**
 * 从静态校验的违规行抽规则标签。
 *
 * 违规行的渲染契约(`packages/tools/src/validate/render-violations.ts`)是
 * `- [拦截|提示] <类别标签> · …`,所以标签取「方括号之后、第一个 ` · ` 之前」那一段。认不出
 * 这个形状的行(比如抬头总结句)一律跳过:结果是**可比的稳定小集合**,不是原文。
 */
export const contractRuleLabels = (lines: readonly string[]): readonly string[] => {
  const labels = new Set<string>();
  for (const line of lines) {
    const match = /^- \[[^\]]*\]\s*([^·]+?)\s*(?:·|$)/u.exec(line.trim());
    const label = match?.[1];
    if (label !== undefined && label !== "") labels.add(label);
  }
  return [...labels].sort();
};

/** 一段「前 N 条 + 总数 + 全文位置」的观察文本。空清单时给一句「没有」。 */
const diagnosticSection = (
  heading: string,
  entries: readonly string[],
  limit: number,
  emptyText: string,
): string => {
  if (entries.length === 0) return `${heading}:${emptyText}\n`;
  const shown = entries.slice(0, limit);
  const lines = [
    `${heading}:共 ${String(entries.length)} 条,这里给前 ${String(shown.length)} 条;全文在 ${CHECK_FULL_TEXT_PATH}`,
    ...shown,
  ];
  if (entries.length > shown.length) {
    lines.push(`(其余 ${String(entries.length - shown.length)} 条未列出,同上那份全文)`);
  }
  return `${lines.join("\n")}\n`;
};

/** `.check.txt` 的正文:**确定性生成**,两段各带一句话的抬头,不做时间戳。 */
const fullText = (compiled: CompileResult, validated: ValidateResult | undefined): string => {
  const tscBody = compiled.ok
    ? "没有诊断。\n"
    : `${compiled.diagnostics === "" ? "(tsc 没有输出)" : compiled.diagnostics}\n`;
  const contractBody =
    validated === undefined ? "(类型检查未通过,未进入静态校验。)\n" : validated.stdout;
  return [
    `# 类型检查(tsc ${compiled.tscVersion})`,
    tscBody.trimEnd(),
    "",
    "# 静态校验",
    contractBody.trimEnd(),
    "",
  ].join("\n");
};

/**
 * 造一个 `check` 服务。
 *
 * **`root` 之外的一切都可注入**,单测因此不需要真 tsc(那是秒级的子进程)也不需要规则集文件:
 * 这条缝要断言的判据是「截断与落盘」、「错误码的抽取」与「拒绝语义」,不是「tsc 会不会报错」。
 * 真 tsc 的那一次在 `check:sandbox` 的真 bwrap 路径上跑。
 */
export const createCheckService = (deps: CheckServiceDeps): CheckService => {
  const limit = deps.limit ?? CHECK_DIAGNOSTIC_LIMIT;
  const compile = deps.compile ?? compileScript;
  const validate = deps.validate ?? validateScript;
  const phase = deps.phase ?? "iteration";

  return async (request: CheckRequest): Promise<ToolResponse> => {
    const sourcePath = join(request.workspaceDir, SCRIPT_SOURCE_NAME);
    let source: string;
    try {
      source = readFileSync(sourcePath, "utf8");
    } catch {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `check:${WORKSPACE_SCRIPT_PATH} 不存在:先把脚本写到那里再检查。\n`,
      };
    }

    const stagingDir = mkdtempSync(join(tmpdir(), "model-war-check-"));
    try {
      const compiled = compile({ root: deps.root, stagingDir, source });
      const fullTextPath = join(request.workspaceDir, CHECK_FULL_TEXT_NAME);

      if (!compiled.ok) {
        const entries = tscDiagnostics(compiled.diagnostics);
        writeFileSync(fullTextPath, fullText(compiled, undefined), "utf8");
        const codes = tscErrorCodes(compiled.diagnostics);
        return {
          exitCode: 1,
          stdout: `${diagnosticSection("类型检查", entries, limit, "没有诊断。")}静态校验没有跑:类型检查没过。\n`,
          stderr: "",
          ...(codes.length === 0 ? {} : { result: { kind: "tsc" as const, errorCodes: codes } }),
        };
      }

      const maxBytes = deps.maxBytes ?? scriptSizeLimit(deps.root);
      const validated = validate({
        root: deps.root,
        artifactPath: compiled.jsPath,
        maxBytes,
        phase,
      });
      writeFileSync(fullTextPath, fullText(compiled, validated), "utf8");

      const lines = nonEmptyLines(validated.stdout);
      const violations = lines.filter((line) => line.startsWith("- ["));
      const labels = contractRuleLabels(violations);
      const contract =
        violations.length === 0
          ? `${lines[0] ?? "静态校验没有输出。"}\n`
          : diagnosticSection("静态校验", lines, limit, "没有违规。");

      return {
        exitCode: validated.passed ? 0 : 1,
        stdout: `类型检查通过(tsc ${compiled.tscVersion})。\n${contract}`,
        stderr: "",
        ...(labels.length === 0
          ? {}
          : { result: { kind: "contract" as const, errorCodes: labels } }),
      };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  };
};
