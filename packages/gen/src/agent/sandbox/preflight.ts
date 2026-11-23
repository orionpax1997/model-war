/**
 * 启动自证(fail-closed):bwrap 在不在、版本够不够、**这一套隔离参数**在这台机器上成不成立。
 *
 * ── 不可用就失败,不降级 ──
 * 失败即抛,任务直接失败,**不回落**到宿主进程执行。理由不是洁癖:降级路径正是 `cmd &` 那条洞
 * 所在的路径(宿主进程 + `start_new_session` 让后台进程活过一步),允许它存在会让威胁模型变成
 * 两套,于是逐条核对失去意义;而「标注降级」在实践中会退化成降级样本悄悄进了对比表
 * (ADR-0033「不可用就失败,不降级」)。
 *
 * ── 报错必须写出已知成因 ──
 * bwrap 从内核只拿到 `EPERM`,这是上游明说的限制,不是 bug——一条只有 `EPERM` 的报错不可诊断。
 * 所以失败文本里**必须**同时给出三种已知成因与各自的处置:Ubuntu 24.04 的
 * `kernel.apparmor_restrict_unprivileged_userns`、26.04 起要卸载的 `bwrap-userns-restrict`
 * profile、以及在容器里跑需要的四个 override。成因清单是唯一的缓解,别只给 `EPERM`。
 *
 * ── 版本下限 ──
 * `0.9.0` 是 Ubuntu 24.04(noble)源里的版本,也是本执行器用到的全部参数(`--tmpfs` /
 * `--ro-bind` / `--bind` / `--dev` / `--proc` / `--unshare-*` / `--cap-drop` / `--new-session` /
 * `--die-with-parent` / `--clearenv` / `--setenv`)都已存在的版本。比它低就拒绝启动:
 * 参数表少一条,隔离就少一块,而少的那一块不会以报错的形式出现,只会以「沙箱没隔离住」出现。
 */

import { spawnSync } from "node:child_process";

import { preflightArgv } from "./argv.js";

/** bwrap 可执行文件名(走 PATH 解析)。测试与调试可用 `bwrapPath` 覆盖。 */
export const BWRAP_BINARY = "bwrap";

/** 版本下限(见头注)。 */
export const BWRAP_MIN_VERSION = "0.9.0";

/** preflight 那条最小调用的墙钟上限。它只 `printf` 一个词,超时说明环境坏了。 */
export const PREFLIGHT_TIMEOUT_MS = 10_000;

/** preflight 成功的判据:stdout 恰好是这个词。 */
export const PREFLIGHT_SENTINEL = "preflight-ok";

/**
 * 从一个版本字符串里取三段数码。
 *
 * `bwrap --version` 的输出形态是 `bubblewrap 0.11.1`;取不到三段的一律返回 `undefined`
 * ——「读不出**版本」与「版本太低」是两句不同的处方,不能混成一句。
 */
export const parseBwrapVersion = (output: string): readonly number[] | undefined => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (match === null) return undefined;
  return match.slice(1, 4).map((part) => Number(part));
};

/** 逐段比较;`actual` 不低于 `floor` 为真。段数不同的两个版本按缺位补 0。 */
export const versionAtLeast = (actual: readonly number[], floor: readonly number[]): boolean => {
  const length = Math.max(actual.length, floor.length);
  for (let index = 0; index < length; index += 1) {
    const left = actual[index] ?? 0;
    const right = floor[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
};

/**
 * 三种已知成因的处置。**唯一**的缓解:三条都不给,报错就只剩 `EPERM`。
 */
export const PREFLIGHT_FAILURE_CAUSES = [
  "Ubuntu 24.04 默认打开 kernel.apparmor_restrict_unprivileged_userns=1。一步 sysctl 可解:\n" +
    "    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n" +
    "  (sysctl -w 重启后失效;要常驻请写进 /etc/sysctl.d/ 下的一份 .conf)",
  "Ubuntu 26.04 起 bwrap-userns-restrict profile 默认已加载,光改 sysctl 不够,还要卸载它:\n" +
    "    sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict\n" +
    "  且 bwrap 的子进程会跑在一个拒掉全部 capability 的 profile 下。",
  "在容器里跑 harness(devcontainer / 容器化 CI)需要四个 override,少一个就是另一种 EPERM:\n" +
    "    docker run --security-opt seccomp=unconfined --security-opt apparmor=unconfined \\\n" +
    "               --security-opt systempaths=unconfined --cap-add SYS_ADMIN …\n" +
    "  缺的是哪一个,只能逐个试——本仓库不提供兼容层(ADR-0033 残余风险 3)。",
] as const;

/**
 * 组装失败的报错文本。三种成因逐条列出,并在末尾说明「为什么这里不降级」。
 *
 * 它是**给人看的**:下一次 triage 的人必须先看到这三条,才可能在没有内核调试信息的情况下
 * 把 `EPERM` 归到一个具体动作上。
 */
export const preflightFailureMessage = (reason: string): string =>
  [
    `沙箱不可用:bwrap preflight 失败(${reason})。`,
    "",
    "执行器不回落到宿主进程:降级路径正是 `cmd &` 那条洞所在的路径,允许它存在会让威胁模型变成两套。",
    "所以任务在这里直接失败,而不是换一种方式跑。",
    "",
    "bwrap 从内核只拿到 EPERM 是上游明说的限制,不是 bug。已知成因三种,按你的机器挑:",
    ...PREFLIGHT_FAILURE_CAUSES.map((cause, index) => `${String(index + 1)}. ${cause}`),
    "",
    "自检:`pnpm run verify:kernel`(真跑可用性 / 无网络 / 后台进程回收)。",
    "CI 侧的安装走命名脚本 `pnpm run setup:sandbox`,不在 workflow 里写裸 apt-get。",
  ].join("\n");

/** bwrap 的可用性结论。`ok` 为真时 `version` 一定在。 */
export type BwrapVerdict =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

/** 读 `bwrap --version`,判版本下限。不 spawn 沙箱,只问一句版本。 */
export const bwrapVerdict = (bwrapPath: string = BWRAP_BINARY): BwrapVerdict => {
  const probe = spawnSync(bwrapPath, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (probe.error !== undefined) {
    return {
      ok: false,
      reason: `\`${bwrapPath} --version\` 起不来(${probe.error.message});先确认 bubblewrap 装没装`,
    };
  }
  if (probe.status !== 0) {
    return {
      ok: false,
      reason: `\`${bwrapPath} --version\` 退出码 ${String(probe.status)}:${probe.stderr.trim()}`,
    };
  }
  const parsed = parseBwrapVersion(probe.stdout);
  if (parsed === undefined) {
    return { ok: false, reason: `读不出版本号(输出是 ${JSON.stringify(probe.stdout)})` };
  }
  const version = parsed.join(".");
  if (
    !versionAtLeast(
      parsed,
      BWRAP_MIN_VERSION.split(".").map((part) => Number(part)),
    )
  ) {
    return {
      ok: false,
      reason:
        `版本 ${version} 低于下限 ${BWRAP_MIN_VERSION}:本执行器用到的隔离参数在那个版本上` +
        "不齐,少了哪一条不会报错,只会让隔离少一块。升级 bubblewrap,或换一台达标的机器",
    };
  }
  return { ok: true, version };
};

/** preflight 的入参。`rootfsDir` 必给:冒烟调用要挂的正是入库 rootfs 的 `bin/`。 */
export type PreflightOptions = {
  readonly rootfsDir: string;
  /** 覆盖 bwrap 路径(测试 / 调试用)。 */
  readonly bwrapPath?: string;
};

/**
 * 启动自证:版本下限 + 一条**真的**最小 bwrap 调用。失败抛 `Error`,错误文本见
 * `preflightFailureMessage`。
 *
 * 调用本身复用执行器同一批隔离参数(`preflightArgv`):要证明的是「这一套参数在这台机器上
 * 成立」,换一套去证明就是另一件事了。
 */
export const assertSandboxReady = (options: PreflightOptions): { readonly version: string } => {
  const bwrapPath = options.bwrapPath ?? BWRAP_BINARY;
  const verdict = bwrapVerdict(bwrapPath);
  if (!verdict.ok) {
    throw new Error(preflightFailureMessage(verdict.reason));
  }

  const run = spawnSync(bwrapPath, [...preflightArgv(options.rootfsDir)], {
    encoding: "utf8",
    timeout: PREFLIGHT_TIMEOUT_MS,
  });
  if (run.error !== undefined) {
    throw new Error(preflightFailureMessage(`最小 bwrap 调用起不来(${run.error.message})`));
  }
  if (run.status !== 0 || run.stdout.trim() !== PREFLIGHT_SENTINEL) {
    const detail = [
      `退出码 ${String(run.status)}`,
      `stdout ${JSON.stringify(run.stdout)}`,
      `stderr ${JSON.stringify(run.stderr.trim())}`,
    ].join(",");
    throw new Error(preflightFailureMessage(`最小 bwrap 调用没有跑通(${detail})`));
  }
  return { version: verdict.version };
};
