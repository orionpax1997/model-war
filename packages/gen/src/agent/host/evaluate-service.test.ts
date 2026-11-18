/**
 * `evaluate` 服务:提交身份、候选快照、真网格的完整性闸门与观测外置。
 *
 * 要钉住的五件:
 * 1. 提交面——评的是**当前** `/workspace/script.ts` 那份字节(源与产物的哈希分开交回);
 * 2. 快照即提交——两份字节在**跑之前**落进既有逐候选命名族,`COPYFILE_EXCL` 不覆盖;
 *    此后工作区再怎么改,快照都不动(「快照字节 == 评估时工作区字节」);
 * 3. 观测外置——stdout 只给聚合对差表与一行路径,逐场一行与最差三场落在
 *    `/workspace/.observations/<n>.md`;观测**原料**(JSONL)进档案(报告侧要从那里复算);
 * 4. 完整性——缺场的网格不产出候选,并把缺了哪几场说给模型听;试跑没落盘同样不产出；
 * 5. 拒绝语义——没有脚本、编译不过、预算触限都不白花一次信息机会。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../../archive.js";
import { completeGridTrial } from "../../trial-grid.fixture.js";
import { gridPlanFixture } from "../../trial-plan.fixture.js";
import type { CompileFn } from "./check-service.js";
import {
  candidateArtifactFiles,
  candidateObservationsFile,
  candidateScriptFile,
  candidateSourceFile,
  createEvaluateService,
  isCandidateArtifactOf,
  type EvaluateServiceDeps,
} from "./evaluate-service.js";

const scratch: string[] = [];

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

/** 一个装得下服务的安装根:服务会把候选证据族写进 `<root>/archive/<slug>/`。 */
const installRoot = (): string => tempDir("model-war-evaluate-root-");

const workspace = (source?: string): string => {
  const dir = tempDir("model-war-evaluate-test-");
  if (source !== undefined) writeFileSync(join(dir, "script.ts"), source, "utf8");
  return dir;
};

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const compileOk: CompileFn = (options) => {
  const jsPath = join(options.stagingDir, "script.js");
  writeFileSync(jsPath, `// compiled from ${options.source}\n`, "utf8");
  return { ok: true, jsPath, diagnostics: "", tscVersion: "7.0.2" };
};

const compileFail: CompileFn = (options) => ({
  ok: false,
  jsPath: join(options.stagingDir, "script.js"),
  diagnostics: "script.ts(2,1): error TS1005: ';' expected.\nscript.ts(9,1): error TS2304: x.",
  tscVersion: "7.0.2",
});

const SOURCE = "export function onTick(): void {}\n";
const plan = gridPlanFixture();

const depsOf = (overrides: Partial<EvaluateServiceDeps> = {}): EvaluateServiceDeps => ({
  root: installRoot(),
  model: "alpha",
  runId: "r1",
  plan: () => plan,
  trial: completeGridTrial(),
  compile: compileOk,
  ...overrides,
});

describe("提交面:评的是当前 `/workspace/script.ts`", () => {
  it("交回源路径、源与产物两个哈希、tsc 版本与观测出口", async () => {
    const dir = workspace(SOURCE);
    const service = createEvaluateService(depsOf());
    const outcome = await service({ workspaceDir: dir, call: 1, step: 2 });

    expect(outcome.exitCode).toBe(0);
    const submission = outcome.submission;
    expect(submission?.workspacePath).toBe("/workspace/script.ts");
    expect(submission?.hostPath).toBe(join(dir, "script.ts"));
    expect(submission?.scriptSha256).toBe(sha256Hex(Buffer.from(SOURCE, "utf8")));
    // 产物哈希 ≠ 源哈希:档案契约复算的是产物,两者混用会让每份档都读成 mismatch。
    expect(submission?.productSha256).not.toBe(submission?.scriptSha256);
    expect(submission?.productSha256).toBe(
      sha256Hex(Buffer.from(`// compiled from ${SOURCE}\n`, "utf8")),
    );
    expect(submission?.tscVersion).toBe("7.0.2");
    expect(submission?.observationsPath).toBe("/workspace/.observations/1.md");
    expect(submission?.observationsFile).toBe("observed-r1-round-2.jsonl");
  });
});

describe("快照即提交:两份字节在跑之前落定", () => {
  it("快照落进既有命名族,且**等于评估时**的工作区字节", async () => {
    const root = installRoot();
    const dir = workspace(SOURCE);
    const service = createEvaluateService(depsOf({ root }));
    const outcome = await service({ workspaceDir: dir, call: 1, step: 2 });
    const observationsFile = candidateObservationsFile("r1", 2);

    const archiveDir = join(root, "archive", "alpha");
    // 源码快照 == 评估那一刻的 /workspace/script.ts。
    expect(readFileSync(join(archiveDir, candidateSourceFile(observationsFile)), "utf8")).toBe(
      SOURCE,
    );
    // 产物快照 == 这次编译出来的那份字节(摘要与提交身份一致)。
    expect(sha256Hex(readFileSync(join(archiveDir, candidateScriptFile(observationsFile))))).toBe(
      outcome.submission?.productSha256,
    );

    // 会话结束后的改动不影响快照:模型评完之后改坏文件,成绩仍是那一版(ADR-0030)。
    writeFileSync(join(dir, "script.ts"), "改坏了\n", "utf8");
    expect(readFileSync(join(archiveDir, candidateSourceFile(observationsFile)), "utf8")).toBe(
      SOURCE,
    );
  });

  it("编译用的字节 == 快照的字节:编译期间工作区被改写也不会串", async () => {
    // 模型写 `evaluate &` 再改 `script.ts`:编译器跑着的时候工作区已经换了另一份字节。
    // 分两次读(先读去编译、之后再拷一份快照)会把第二份字节当成本次提交,而产物来自第一份。
    const root = installRoot();
    const dir = workspace(SOURCE);
    let compiledInput = "";
    const compileWhileRewriting: CompileFn = (options) => {
      compiledInput = options.source;
      // 编译要几秒,这期间模型的写句柄真的可以动手。
      writeFileSync(join(dir, "script.ts"), "改过了\n", "utf8");
      return compileOk(options);
    };
    const service = createEvaluateService(depsOf({ root, compile: compileWhileRewriting }));
    const outcome = await service({ workspaceDir: dir, call: 1, step: 2 });
    expect(outcome.exitCode).toBe(0);

    const observationsFile = candidateObservationsFile("r1", 2);
    const snapshot = readFileSync(
      join(root, "archive", "alpha", candidateSourceFile(observationsFile)),
    );
    // 快照 == 喂给编译器的那段字节 == `scriptSha256` 说的那一份。
    expect(snapshot.equals(Buffer.from(compiledInput, "utf8"))).toBe(true);
    expect(sha256Hex(snapshot)).toBe(outcome.submission?.scriptSha256);
    // 反面证据:工作区里已经是另一份了(否则这条用例证明不了「不串」)。
    expect(readFileSync(join(dir, "script.ts"), "utf8")).toBe("改过了\n");
  });

  it("同一步重复提交是可读的拒绝(不升级成 infra,不覆盖既有证据)", async () => {
    const root = installRoot();
    const dir = workspace(SOURCE);
    const service = createEvaluateService(depsOf({ root }));
    const first = await service({ workspaceDir: dir, call: 1, step: 2 });
    expect(first.submission).toBeDefined();

    // 同一块 bash 里连叫两次:第二次是一次**模型侧**的重复提交,回一条话说清楚。
    const second = await service({ workspaceDir: dir, call: 2, step: 2 });
    expect(second.exitCode).toBe(1);
    expect(second.submission).toBeUndefined();
    expect(second.stderr).toContain("已经评过一次了");
    // 既有那份证据没有被改掉(快照仍是第一次评的那份字节)。
    expect(
      readFileSync(
        join(root, "archive", "alpha", candidateSourceFile(candidateObservationsFile("r1", 2))),
        "utf8",
      ),
    ).toBe(SOURCE);
  });
});

describe("观测外置:stdout 只给聚合对差表 + 一行路径", () => {
  it("stdout 只有判定行、对差表与指针,逐场明细留在观测文件里", async () => {
    const dir = workspace(SOURCE);
    const calls: Array<{ artifactPath: string; observationsPath: string }> = [];
    const service = createEvaluateService(depsOf({ trial: completeGridTrial({ calls }) }));

    const outcome = await service({ workspaceDir: dir, call: 1, step: 1 });
    const stdout = outcome.stdout;

    // 判定行说清跑了几场(分母是计划场数,不缩)。
    expect(stdout.split("\n")[0]).toBe("evaluate:通过(32/32 场)");
    // 聚合对差表在:八格一行一格,带同格变化(第一次评测没有对照物 → 明写)。
    expect(stdout).toContain("一、对差表");
    expect(stdout.match(/与上一次评测同一格：无上一次评测。/g)).toHaveLength(8);
    // 逐场一行与最差三场**不在** stdout 上(常驻上下文只留聚合)。
    expect(stdout).not.toContain("二、逐场一行");
    expect(stdout).not.toContain("三、最差三场");
    // 最后一行是模型能直接读的绝对路径。
    expect(stdout.trimEnd().split("\n").at(-1)).toBe("完整观测:/workspace/.observations/1.md");
    // 体量口径:常驻观测压在 1k token 量级(这里按字符给一个宽松上限)。
    expect(stdout.length).toBeLessThan(2_000);

    // 观测原料进档案(报告侧从这份字节复算),派生视图进工作区。
    expect(
      readFileSync(calls[0]?.observationsPath ?? "", "utf8")
        .trimEnd()
        .split("\n"),
    ).toHaveLength(32);
    const view = readFileSync(join(dir, ".observations", "1.md"), "utf8");
    expect(view).toContain("二、逐场一行");
    expect(view).toContain("三、最差三场");
    // 派生视图不进档案:它在工作区,不在 archive/<slug>/ 下。
    expect(existsSync(join(calls[0]?.observationsPath ?? "", "..", "1.md"))).toBe(false);
  });

  it("第二次评测的对差表带与上一次同一格的变化", async () => {
    const dir = workspace(SOURCE);
    const service = createEvaluateService(depsOf());

    const first = await service({ workspaceDir: dir, call: 1, step: 1 });
    const second = await service({ workspaceDir: dir, call: 2, step: 3 });

    expect(first.stdout).toContain("与上一次评测同一格：无上一次评测。");
    expect(second.stdout.match(/与上一次评测同一格：Δ平均名次积分 [+-]/g)).toHaveLength(8);
    expect(
      readFileSync(join(dir, ".observations", "2.md"), "utf8").match(/Δ平均名次积分/g),
    ).toHaveLength(8);
  });
});

describe("完整性:缺场的网格不产出候选", () => {
  it("少写几行就不产出候选,并把缺了哪几场说给模型听", async () => {
    const dir = workspace(SOURCE);
    const service = createEvaluateService(depsOf({ trial: completeGridTrial({ matches: 28 }) }));

    const outcome = await service({ workspaceDir: dir, call: 1, step: 1 });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.submission).toBeUndefined();
    expect(outcome.stderr).toContain("试跑观测不完整");
    // 缺的是最后四场(matchIndex 28..31),按两位编号点名。
    for (const index of ["#28", "#29", "#30", "#31"]) expect(outcome.stderr).toContain(index);
    // 一行都没跑到的场次一个不补零:明细仍然落盘,但候选不会出现。
    expect(outcome.stderr).toContain("完整观测:/workspace/.observations/1.md");
  });

  it("试跑没落盘时同样不产出候选(观测文件缺了不等于零分)", async () => {
    const dir = workspace(SOURCE);
    const service = createEvaluateService(
      depsOf({ trial: completeGridTrial({ writeEvidence: false }) }),
    );

    const outcome = await service({ workspaceDir: dir, call: 1, step: 1 });
    expect(outcome.submission).toBeUndefined();
    expect(outcome.stderr).toContain("试跑没有写观测文件");
  });
});

describe("拒绝语义:不白花一次信息机会", () => {
  it("没有 `/workspace/script.ts` 时不跑试跑,也不落候选快照", async () => {
    const root = installRoot();
    const dir = workspace();
    const calls: Array<{ artifactPath: string; observationsPath: string }> = [];
    const service = createEvaluateService(depsOf({ root, trial: completeGridTrial({ calls }) }));

    const outcome = await service({ workspaceDir: dir, call: 1, step: 1 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("/workspace/script.ts 不存在");
    expect(outcome.submission).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(existsSync(join(root, "archive"))).toBe(false);
  });

  it("编译不过时不跑试跑,并把最前面的诊断交回去(先修再提交)", async () => {
    const dir = workspace("x\n");
    const calls: Array<{ artifactPath: string; observationsPath: string }> = [];
    const service = createEvaluateService(
      depsOf({ trial: completeGridTrial({ calls }), compile: compileFail }),
    );

    const outcome = await service({ workspaceDir: dir, call: 1, step: 1 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("编译不过");
    expect(outcome.stderr).toContain("error TS1005");
    expect(outcome.submission).toBeUndefined();
    expect(calls).toHaveLength(0);
    // 观测目录也不该被建出来:那会让「没评过」看起来像「评过」。
    expect(existsSync(join(dir, ".observations"))).toBe(false);
  });

  it("预算触限(拦下)跑满一场不少,但不产出候选", async () => {
    const dir = workspace(SOURCE);
    const service = createEvaluateService(
      depsOf({
        trial: completeGridTrial({
          passed: false,
          stdout: "试跑未通过：第 3 场第 7 tick 触发预算超限。\n",
        }),
      }),
    );

    const outcome = await service({ workspaceDir: dir, call: 1, step: 1 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.submission).toBeUndefined();
    expect(outcome.stdout).toContain("evaluate:拦下 · 试跑未通过");
    // 拦下的那一次同样给聚合对差表:模型要看见「拦下时这张网格长什么样」。
    expect(outcome.stdout).toContain("一、对差表");
  });
});

describe("基础设施:计划是网格的身份", () => {
  it("缺步号就大声失败(候选证据族不能无名落盘)", async () => {
    const dir = workspace(SOURCE);
    const service = createEvaluateService(depsOf());
    await expect(service({ workspaceDir: dir, call: 1 })).rejects.toThrow(/缺步号/);
  });

  it("试跑子进程抛错原样上抛(计划重建不符 / 入口异常都是 infra)", async () => {
    const dir = workspace(SOURCE);
    mkdirSync(join(dir, ".observations"), { recursive: true });
    const service = createEvaluateService(
      depsOf({
        trial: () => {
          throw new Error("试跑子进程异常退出（码 2，观测 …）：预期试跑计划与现场事实不符");
        },
      }),
    );
    await expect(service({ workspaceDir: dir, call: 1, step: 1 })).rejects.toThrow(/计划/);
  });
});

describe("失败清理:按名字认出自己那一族", () => {
  it("四份旁挂产物都算自己的;别的 runId、前缀串与三件套都不算", () => {
    const names = candidateArtifactFiles(candidateObservationsFile("r1", 3));
    // 观测原料 + 源快照 + 产物快照 + 网格汇总:少写一份就是一条残留。
    expect(names).toHaveLength(4);
    for (const name of names) expect(isCandidateArtifactOf(name, "r1")).toBe(true);

    // 不是自己的:三件套目录名、失败记录、别的跑的字节。
    for (const name of [
      "r1",
      "failed-r1.json",
      ...candidateArtifactFiles(candidateObservationsFile("r2", 3)),
    ]) {
      expect(isCandidateArtifactOf(name, "r1")).toBe(false);
    }
    // 前缀串不是自己:`r1-round-2` 那一跑的档不该被 `r1` 的清掉。
    expect(isCandidateArtifactOf(candidateObservationsFile("r1-round-2", 3), "r1")).toBe(false);
  });
});
