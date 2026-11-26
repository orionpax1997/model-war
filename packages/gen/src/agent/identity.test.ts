/**
 * harness 身份的单测:入库 digest 与现算一致,清单里的数字真的取自真源,清单**不含**档案形状与
 * 退避参数,以及清单**不含任何描述旧协议的字段**。
 *
 * 后两类断言(「不含」)比它们看起来更重要:往清单里加一格是零成本的,而代价是榜在那一点上
 * 断代,且没有任何红会提示;反过来,旧协议的残留(围栏标记、fd 3、薄壳形状)不会让任何东西变红,
 * 只会让清单在说谎——清单的作用是「模型当时面对的世界」。所以两类排除都写成机器判据,而不是
 * 写在一句注释里。
 */

import { expect, it } from "vitest";

import {
  EVALUATE_CALL_LIMIT,
  PROBE_CALL_LIMIT,
  PROBE_MATCH_LIMIT,
  PROBE_NEAR_LIMIT_RATIO,
  SANDBOX_ROOTFS_FILES,
} from "@model-war/schema";

import { ACTION_REJECT_REASONS } from "./action.js";
import { TOOL_USAGE } from "./host/dispatcher.js";
import {
  HARNESS_DIGEST,
  HARNESS_VERSION,
  HOST_SERVICE_TOOLS,
  OBSERVATION_ADVICE_HINTS,
  digestOf,
  harnessIdentity,
  harnessManifest,
  type HarnessManifest,
} from "./identity.js";
import { AGENT_MAX_STEPS, AGENT_TOTAL_WALL_CLOCK_MS, CONTEXT_GUARD } from "./limits.js";
import { DEFAULT_STEP_WALL_CLOCK_MS } from "./sandbox/execute.js";
import { AGENT_TOOLS, TOOL_NAMES, acceptsArgumentsOf } from "./tools.js";
import { OBSERVATION_LIMITS, RAW_PATHOLOGICAL_LIMIT_BYTES } from "./truncate.js";

const manifest = (): HarnessManifest => harnessManifest();

it("入库的 digest 等于现算(改一处必须有人回来改那一行)", () => {
  expect(digestOf(manifest())).toBe(HARNESS_DIGEST);
});

it("叙事版本是人维护的那一串,两个身份同进同出", () => {
  // 代号里带的是**协议形状**,不是执行器的名字:旧代号 `bash-mini/0.1` 会让读者以为协议没变。
  expect(HARNESS_VERSION).toBe("tool-call/1.0");
  expect(harnessIdentity()).toEqual({ version: HARNESS_VERSION, digest: HARNESS_DIGEST });
});

it("清单里的数字取自真源,不是在本文件里抄的第二份", () => {
  const current = manifest();
  expect(current.deadline.maxSteps).toBe(AGENT_MAX_STEPS);
  expect(current.deadline.totalWallClockMs).toBe(AGENT_TOTAL_WALL_CLOCK_MS);
  expect(current.deadline.stepWallClockMs).toBe(DEFAULT_STEP_WALL_CLOCK_MS);
  expect(current.contextGuard.ratio).toBe(
    `${String(CONTEXT_GUARD.numerator)}/${String(CONTEXT_GUARD.denominator)}`,
  );
  // 清单记录的是 **dispatcher 执行的那个常量**:两处各写一个数时,「档案说三次、实际能调四次」
  // 这种漂移在读侧看不出来。
  expect(current.quotas.evaluate).toBe(EVALUATE_CALL_LIMIT);
  // 探针的额度与 `evaluate` 各记各的(互不侵占),但同一条判据:计数发生在调用之前。
  expect(current.quotas.probe).toBe(PROBE_CALL_LIMIT);
  expect(current.quotas.check).toBe("counts-as-step");
  expect(current.observation.stdout.limitBytes).toBe(OBSERVATION_LIMITS.stdout.limitBytes);
  expect(current.observation.stderr.limitBytes).toBe(OBSERVATION_LIMITS.stderr.limitBytes);
  expect(current.observation.stdout.headRatio).toBe("3/10");
  expect(current.observation.stderr.headRatio).toBe("7/10");
  expect(current.observation.raw.limitBytes).toBe(RAW_PATHOLOGICAL_LIMIT_BYTES);
  // 动作语法只有「一步恰好一次工具调用」这一种;围栏标记与拒绝退出码两格已删。
  expect(current.actionSyntax.blocks).toBe("exactly-one-tool-call");
  expect(current.actionSyntax.multiLine).toBe("one-command-string");
  // 有 `tool_call_id` 可配对了,观测就是标准的 `tool` 消息(修订③)。
  expect(current.actionSyntax.observationRole).toBe("tool");
  // 被拒的四种形状都在清单里,且逐项来自真源:「拒过什么」下一次调协议时有据可查。
  expect(current.actionSyntax.rejects).toEqual([...ACTION_REJECT_REASONS]);
  for (const reason of [
    "no-tool-call",
    "multiple-tool-calls",
    "unknown-tool",
    "malformed-arguments",
  ])
    expect(current.actionSyntax.rejects).toContain(reason);
});

it("工具面取自声明:名字、谁收参数、并行调用与探针读数都不另抄", () => {
  const surface = manifest().toolSurface;
  // 五个声明,顺序即声明的顺序(`bash` → `check` → `probe` → `evaluate` → `finish`)。
  expect(surface.tools).toEqual(TOOL_NAMES);
  expect(surface.tools).toEqual(AGENT_TOOLS.map((tool) => tool.name));
  expect(surface.tools).toHaveLength(5);
  // 「收不收参数」是逐工具的派生值:手写一份会在声明改名时悄悄分叉。
  expect(surface.acceptsArguments).toEqual(
    Object.fromEntries(TOOL_NAMES.map((name) => [name, acceptsArgumentsOf(name)])),
  );
  expect(surface.acceptsArguments).toEqual({
    bash: true,
    check: false,
    probe: false,
    evaluate: false,
    finish: false,
  });
  // 并行调用归拒绝档:它是行为面的判据(一步多次调用会打穿「候选与步号的单向引用」),
  // 不是格式偏好。
  expect(surface.parallelCalls).toBe("rejected");
  // 探针回的是**每轨最坏占用读数**,不是二值判定——这条事实属于工具面,不属于配额面。
  expect(surface.probe).toEqual({
    matchLimit: PROBE_MATCH_LIMIT,
    nearLimitRatio: PROBE_NEAR_LIMIT_RATIO,
    returns: "peak-usage",
  });
});

it("收工语义与实现同义:它是一次工具调用,不是沙箱里的命令", () => {
  const current = manifest().finish;
  expect(current).toEqual({
    command: "finish",
    form: "tool-call",
    signal: "tool-result",
    endsSession: true,
    countsAsStep: true,
  });
  // 它是宿主的工具,所以**不在** `bin/` 里:模型在沙箱里连这个名字都敲不到。
  expect(SANDBOX_ROOTFS_FILES).not.toContain(`bin/${current.command}`);
});

it("参数面进清单:工具不收参数,被拒的一次不耗配额", () => {
  const current = manifest();
  // 模型会试 `evaluate --help` 这种东西,试了会拿到「被拒」——那是行为面,不是实现细节。
  // 旧清单里还有一格 `exitCode`:工具调用没有 shell 退出码这一层,它已删。
  expect(current.services.args).toEqual({ accepted: false, consumesQuota: false });
  // 那句拒绝文案跟它同一个家:判据在 dispatcher,清单只记形状。
  expect(TOOL_USAGE.check).toContain("不接受参数");
  expect(TOOL_USAGE.probe).toContain("不接受参数");
  expect(TOOL_USAGE.evaluate).toContain("不接受参数");
});

it("可见面取自真源:二进制清单与 rootfs 一致,宿主工具一个都不在 `bin/` 里", () => {
  const current = manifest();
  expect(current.visibleBinaries).toEqual(
    SANDBOX_ROOTFS_FILES.filter((file) => file.startsWith("bin/")),
  );
  // 薄壳删掉之后 `bin/` 里只剩 ELF:这一条是「可见面自动收窄」的机器判据。
  for (const binary of current.visibleBinaries) expect(SANDBOX_ROOTFS_FILES).toContain(binary);
  // 宿主工具是**四个**,一个都不在沙箱里:新世界不是「敲得到但不干实事」(薄壳),而是
  // 「没有那个路径」——模型唯一够得着它们的方式是一次工具调用。
  expect(current.services.tools).toEqual(HOST_SERVICE_TOOLS);
  expect(current.services.tools).toHaveLength(4);
  expect(current.services.shape).toBe("host-side-service");
  for (const tool of HOST_SERVICE_TOOLS) {
    expect(SANDBOX_ROOTFS_FILES).not.toContain(`bin/${tool}`);
  }
});

it("挂载面与网络取自 bwrap 的参数表,不是另抄一张表", () => {
  const current = manifest();
  for (const fragment of ["--tmpfs", "--ro-bind", "--bind", "--dev", "--proc", "--chdir"]) {
    expect(current.sandboxArgv).toContain(fragment);
  }
  expect(current.sandboxArgv).toContain("/workspace");
  expect(current.sandboxArgv).toContain("/contract");
  // 绝对路径不进身份:换一台机器不该断代。
  expect(current.sandboxArgv.join(" ")).not.toContain("/home/");
  expect(current.network).toBe("unshared");
  expect(current.sandboxArgv).not.toContain("--share-net");
});

it("观测出口:处方是逐条存在性核对出来的,删一条就是换 harness", () => {
  const advice = manifest().observation.advice;
  expect(advice).toHaveLength(OBSERVATION_ADVICE_HINTS.length);
  for (const entry of advice) {
    expect(entry.endsWith(":present"), entry).toBe(true);
  }
});

it("清单不含档案形状,也不含退避参数", () => {
  const serialized = JSON.stringify(manifest());
  for (const forbidden of [
    "archiveSchemaVersion",
    "protocolRounds",
    "steps",
    "prompts",
    "maxRetries",
    "backoff",
    "jitter",
    "retry",
    "initialDelayMs",
    "harnessDigest",
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
});

it("清单不含任何描述旧协议的字段:留一格就是清单在说谎", () => {
  // 清单的判据是「模型当时处在一个什么样的世界里」,所以旧世界的形状一律不许留在里面。
  // 这一条不是洁癖:它每一次都会把人拉回来看「这个字段还有真源吗」。
  const serialized = JSON.stringify(manifest());
  for (const retired of [
    // 围栏标记:动作不再是一段被 ```bash 围起来的文本。
    "fenceTag",
    "fence",
    // 拒绝的载体:工具调用没有 shell 退出码这一层,拒绝是一条 `isError` 的工具结果。
    "rejectExitCode",
    // fd 3 薄壳通道:通道与薄壳都已删除,`check`/`probe`/`evaluate`/`finish` 不在沙箱里。
    "channelFd",
    "shim",
    "rootfs-shim",
    "host-channel",
    // 「`finish` 之后的行仍会执行」:一次调用就是一个动作,没有「之后的行」。
    "stopsRemainingCommands",
    "one-bash-c",
  ]) {
    expect(serialized).not.toContain(retired);
  }
  // 观测不再是 `user` 角色:那是初版「没有 tool_call_id 可配对」那条理由的产物。
  expect(JSON.stringify(manifest().actionSyntax)).not.toContain('"user"');
});

it("参与身份的是取值:改一格 digest 就变,对调键序不变", () => {
  const base = manifest();
  const longer = { ...base, deadline: { ...base.deadline, maxSteps: base.deadline.maxSteps + 1 } };
  const wider = {
    ...base,
    observation: {
      ...base.observation,
      stdout: { ...base.observation.stdout, limitBytes: base.observation.stdout.limitBytes * 2 },
    },
  };
  expect(digestOf(longer)).not.toBe(HARNESS_DIGEST);
  expect(digestOf(wider)).not.toBe(HARNESS_DIGEST);
  // 同一个内容、不同的书写顺序 → 同一个身份(纯整理不该断代)。
  const reordered = Object.fromEntries(Object.entries(base).reverse()) as HarnessManifest;
  expect(Object.keys(reordered)[0]).toBe("toolchain");
  expect(digestOf(reordered)).toBe(HARNESS_DIGEST);
});
