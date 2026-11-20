/**
 * harness 身份的单测:入库 digest 与现算一致,清单里的数字真的取自真源,以及清单**不含**
 * 档案形状与退避参数。
 *
 * 最后一类断言(「不含」)比它看起来更重要:往清单里加一格是零成本的,而代价是榜在那一点上
 * 断代,且没有任何红会提示。所以那两条排除写成机器判据,而不是写在一句注释里。
 */

import { expect, it } from "vitest";

import { EVALUATE_CALL_LIMIT, SANDBOX_ROOTFS_FILES } from "@model-war/schema";

import { ACTION_REJECT_EXIT_CODE, ACTION_REJECT_REASONS } from "./action.js";
import { PROTOCOL_EXIT_CODE, TOOL_USAGE } from "./host/dispatcher.js";
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
import { CHANNEL_FD, DEFAULT_STEP_WALL_CLOCK_MS } from "./sandbox/execute.js";
import { OBSERVATION_LIMITS, RAW_PATHOLOGICAL_LIMIT_BYTES } from "./truncate.js";

const manifest = (): HarnessManifest => harnessManifest();

it("入库的 digest 等于现算(改一处必须有人回来改那一行)", () => {
  expect(digestOf(manifest())).toBe(HARNESS_DIGEST);
});

it("叙事版本是人维护的那一串,两个身份同进同出", () => {
  expect(HARNESS_VERSION).toBe("bash-mini/0.1");
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
  // 清单记录的是 **dispatcher 执行的那个常量**:两处各写一个 3 时,\「档案说三次、实际能调
  // 四次」这种漂移在读侧看不出来(见 `tool-channel.ts` 的单源注释)。
  expect(current.quotas.evaluate).toBe(EVALUATE_CALL_LIMIT);
  expect(current.observation.stdout.limitBytes).toBe(OBSERVATION_LIMITS.stdout.limitBytes);
  expect(current.observation.stderr.limitBytes).toBe(OBSERVATION_LIMITS.stderr.limitBytes);
  expect(current.observation.stdout.headRatio).toBe("3/10");
  expect(current.observation.stderr.headRatio).toBe("7/10");
  expect(current.observation.raw.limitBytes).toBe(RAW_PATHOLOGICAL_LIMIT_BYTES);
  // ⚠️ `fenceTag` 是票 06 要删的占位格:票 02 删了围栏常量,这一格暂时记 `"none"`。
  // 它不再是「旧协议还在」的证据,只是「这一格还没被重写」的痕迹。
  expect(current.actionSyntax.fenceTag).toBe("none");
  expect(current.actionSyntax.rejectExitCode).toBe(ACTION_REJECT_EXIT_CODE);
  // 被拒的四种形状都在清单里:「拒过什么」下一次调协议时有据可查。
  expect(current.actionSyntax.rejects).toEqual([...ACTION_REJECT_REASONS]);
  for (const reason of [
    "no-tool-call",
    "multiple-tool-calls",
    "unknown-tool",
    "malformed-arguments",
  ])
    expect(current.actionSyntax.rejects).toContain(reason);
  // 收工工具取自 rootfs 与白名单,不是在本文件里再抄一个名字。
  expect(current.finish.command).toBe("finish");
  expect(SANDBOX_ROOTFS_FILES).toContain(`bin/${current.finish.command}`);
  expect(HOST_SERVICE_TOOLS).toContain(current.finish.command);
});

it("收工语义与实现同义:它是命令、经通道上报、不阻断块内剩余命令", () => {
  const current = manifest().finish;
  expect(current).toEqual({
    command: "finish",
    form: "rootfs-shim",
    signal: "host-channel",
    stopsRemainingCommands: false,
    endsSession: true,
    countsAsStep: true,
  });
  // `stopsRemainingCommands: false` 是这一版的行为放宽,不是笔误:整块交给 bash,
  // `finish` 之后写的行仍会执行(ADR-0032 修订)。
  expect(current.stopsRemainingCommands).toBe(false);
});

it("参数面进清单:工具不收参数,拒绝的退出码取自 dispatcher", () => {
  const current = manifest();
  // 模型会试 `evaluate --help` 这种东西,试了会拿到「被拒」——那是行为面,不是实现细节。
  expect(current.services.args).toEqual({
    accepted: false,
    exitCode: PROTOCOL_EXIT_CODE,
    consumesQuota: false,
  });
  // 那句拒绝文案跟它同一个家:判据在 dispatcher,清单只记形状。
  expect(TOOL_USAGE.check).toContain("不接受参数");
  expect(TOOL_USAGE.evaluate).toContain("不接受参数");
});

it("可见面取自真源:二进制清单与 rootfs 一致,三件受限工具确实存在", () => {
  const current = manifest();
  expect(current.visibleBinaries).toEqual(
    SANDBOX_ROOTFS_FILES.filter((file) => file.startsWith("bin/")),
  );
  for (const tool of HOST_SERVICE_TOOLS) {
    expect(SANDBOX_ROOTFS_FILES).toContain(`bin/${tool}`);
  }
  // 通道 fd 取自执行器:宿主与薄壳写的是同一个数。
  expect(current.services.channelFd).toBe(CHANNEL_FD);
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
