/**
 * 启动自证的三块可测部分:**版本比较**、**失败文本的三种成因**、**不可用就失败**。
 *
 * 真跑 bwrap 的那一条在 `pnpm run verify:kernel`(需要非特权 user namespace);这里只测纯判据与
 * 「bwrap 根本起不来」这一支——它不依赖内核能力,任何机器上都跑得出来。
 *
 * 为什么失败文本值得断言:`bwrap` 从内核只拿到 `EPERM`,这是上游明说的限制。报错里那三条成因
 * 是**唯一的缓解**——文本里少一条,下一个人就得从零 triage 一次。所以这里把三条与各自的处置
 * 逐条钉住(而不是只断言「有报错」)。
 */

import { describe, expect, it } from "vitest";

import {
  BWRAP_MIN_VERSION,
  bwrapVerdict,
  parseBwrapVersion,
  PREFLIGHT_FAILURE_CAUSES,
  preflightFailureMessage,
  versionAtLeast,
} from "./preflight.js";

describe("bwrap 版本", () => {
  it("从 `bubblewrap 0.11.1` 里取三段数码", () => {
    expect(parseBwrapVersion("bubblewrap 0.11.1\n")).toEqual([0, 11, 1]);
    expect(parseBwrapVersion("bubblewrap 0.9.0")).toEqual([0, 9, 0]);
    // 末行的换行、前缀与后缀都不影响:上游输出形态变了一次,判据不该跟着瞎。
    expect(parseBwrapVersion("bubblewrap 1.2.3 (built 2026)\n")).toEqual([1, 2, 3]);
  });

  it("读不出版本时返回 undefined:那是「读不出」,与「太低」是两句不同的处方", () => {
    expect(parseBwrapVersion("bubblewrap")).toBeUndefined();
    expect(parseBwrapVersion("")).toBeUndefined();
  });

  it("下限比较逐段进行,不是字符串比较", () => {
    const floor = BWRAP_MIN_VERSION.split(".").map((part) => Number(part));
    // 字符串比较会把 "0.11.1" 判成小于 "0.9.0"(`1` < `9`),那正好是 24.04 之后的常态。
    expect(versionAtLeast([0, 11, 1], floor)).toBe(true);
    expect(versionAtLeast([0, 9, 0], floor)).toBe(true);
    expect(versionAtLeast([0, 8, 9], floor)).toBe(false);
    expect(versionAtLeast([1, 0, 0], floor)).toBe(true);
    // 段数不足按缺位补 0:`0.9` 就是 `0.9.0`,刚好达标;`0.9` 对 `0.9.1` 则不够。
    expect(versionAtLeast([0, 9], floor)).toBe(true);
    expect(versionAtLeast([0, 9], [0, 9, 1])).toBe(false);
  });

  it("bwrap 根本起不来时给出结论而不是抛异常,并且指向「装没装」", () => {
    const verdict = bwrapVerdict("model-war-no-such-bwrap-binary");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toContain("bubblewrap");
  });
});

describe("失败文本:三种已知成因一条不落", () => {
  const message = preflightFailureMessage("最小 bwrap 调用没有跑通");

  it("保留原始原因,并明说这里不降级", () => {
    expect(message).toContain("最小 bwrap 调用没有跑通");
    expect(message).toContain("不回落到宿主进程");
    // 不降级的理由要说出来,否则读的人会以为「加个 fallback 就好了」。
    expect(message).toContain("威胁模型变成两套");
  });

  it("① Ubuntu 24.04 的 apparmor sysctl,连那条命令一起给", () => {
    expect(message).toContain("kernel.apparmor_restrict_unprivileged_userns");
    expect(message).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
  });

  it("② 26.04 起还要卸载 bwrap-userns-restrict profile", () => {
    expect(message).toContain("bwrap-userns-restrict");
    expect(message).toContain("apparmor_parser -R");
  });

  it("③ 容器里的四个 override 一个不缺", () => {
    for (const override of [
      "--security-opt seccomp=unconfined",
      "--security-opt apparmor=unconfined",
      "--security-opt systempaths=unconfined",
      "--cap-add SYS_ADMIN",
    ]) {
      expect(message, `${override} 没写进报错`).toContain(override);
    }
  });

  it("成因清单只有一份:三条都从常量来,不在这里另抄一段", () => {
    expect(PREFLIGHT_FAILURE_CAUSES).toHaveLength(3);
    for (const cause of PREFLIGHT_FAILURE_CAUSES) {
      expect(message).toContain(cause);
    }
  });

  it("还写着自检入口与 CI 的安装入口(读报错的人下一步该敲哪条)", () => {
    expect(message).toContain("verify:kernel");
    expect(message).toContain("setup:sandbox");
  });
});
