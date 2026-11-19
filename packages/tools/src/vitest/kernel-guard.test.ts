/**
 * 「常跑链不碰内核」这条判据的**自证**:unit / property 里的 `bwrap` 是探针,不是系统那个。
 *
 * ── 为什么这条判据存在 ──
 *
 * `fast.yml` 不装 bubblewrap,开发机装了。于是「unit 里一条用例忘了换沙箱替身」这件事在 CI 上
 * 红、在本机绿——本机绿得刚好把它盖住,而等它红的时候已经是别人的 PR 上了。判据不能依赖
 * 「这台机器有没有装 bwrap」这个自由度,所以快链上 `bwrap` 一律解析到 `vitest.kernel-guard.setup.ts`
 * 造的探针:真起沙箱的用例在**任何机器上**都当场红,并且红得指名。
 *
 * ── 三个断言各盯一件事 ──
 *
 * 1. **接线在**:`MW_KERNEL_GUARD_DIR` 只有那份 setup 会写。它缺席 = 接线被删了,这时下面两条
 *    断言会在真 bwrap 上通过(本机)或报 ENOENT(CI),两种都不是「判据还在」。
 * 2. **解析到探针**:按 PATH 逐项找 `bwrap`,第一个命中的必须是探针目录里的那个——不是「PATH 里
 *    有它」,而是「`spawn("bwrap")` 一定命中它」。
 * 3. **探针的话**能回到人眼前:`kernel-guard` 会经由 `preflightFailureMessage` 的
 *    `\`bwrap --version\` 退出码 N:<stderr>` 原样带出来,所以一句「不知道为什么红」在这里被排除。
 *
 * 第 4 条读 `vitest.config.ts`:`property` 那条链只跑 `*.prop.ts`,没有一条用例会去启动沙箱,所以
 * 它的接线只能从配置文本上判——两个 project 都装上,少一个就是一条没人看着的链。
 *
 * ── 这条判据抓到的第一例 ──
 *
 * 落地后第一条红的是 `apps/cli/src/gen-cli.test.ts`:它 spawn 打好的单文件 CLI 产物、打假端点、
 * **在真沙箱里**跑满一整张网格,却挂在 `unit` 上。之前没人看见,是因为它包在
 * `it.skipIf(!archivePresent)` 里——`archive/` 不入库,没冻档的机器上它是 skip,于是一条要内核
 * 能力的用例在两边都不报红(本机 skip、CI 没有 `archive/` 也 skip)。探针把「本机装了 bwrap」
 * 这个自由度去掉之后,它当场变成一次指名道姓的失败,而不是一条只在别人 PR 上才发作的红。
 * 处置见 `vitest.config.ts` 的 `GEN_CLI_TEST`:整条移进 `sandbox` project。
 *
 * ── 探针看不到的地方,谁在看 ──
 *
 * 探针只能钉住**装了探针的那两条链**。一条用例被移到 `sandbox` 之后探针就不再看它了,所以「移
 * 走」这件事本身也得有人盯:下面第 5 条断言 `unit` 的 exclude 与 `sandbox` 的 include 引用同一
 * 个路径字面量(排除过头与没排除是同一种失败)。而「`sandbox` 真收到它」那一侧的证据由
 * `packages/tools/src/gates.test.ts` 用 `vitest list` 给(这里不 spawn 第二份 vitest)。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const SETUP_FILE = "vitest.kernel-guard.setup.ts";
const GUARD_ENV = "MW_KERNEL_GUARD_DIR";

/** 按 PATH 顺序找可执行体:这正是 `spawn("bwrap")` 的解析规则。 */
const resolveOnPath = (name: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

/** `vitest.config.ts` 里某个 project 的那一段(从 `name:` 到下一个 `name:`)。 */
const projectBlockOf = (config: string, name: string): string => {
  const start = config.indexOf(`name: "${name}"`);
  expect(start, `vitest.config.ts 里找不到 project ${name}`).toBeGreaterThanOrEqual(0);
  const rest = config.slice(start);
  const next = rest.indexOf('name: "', 1);
  return next < 0 ? rest : rest.slice(0, next);
};

describe("快链上的 bwrap 是探针", () => {
  it("接线在:setup 写下的目录变量在场", () => {
    expect(
      process.env[GUARD_ENV],
      `${GUARD_ENV} 不在:${SETUP_FILE} 没被 unit / property 装进 setupFiles`,
    ).toBeTruthy();
  });

  it("PATH 解析先命中探针,不是系统那份", () => {
    const dir = process.env[GUARD_ENV] ?? "";
    expect(resolveOnPath("bwrap")).toBe(join(dir, "bwrap"));
  });

  it("探针拒绝执行,而且那句话指名道姓", () => {
    const probed = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
    expect(probed.status, "快链上的 bwrap 竟然跑起来了").not.toBe(0);
    const said = probed.stderr.trim();
    expect(said, "探针没有留下可诊断的一句话").toContain("kernel-guard");
    // 这句话的确来自那份 setup,不是某个 ENOENT 的巧合。
    expect(readFileSync(`${repoRoot}${SETUP_FILE}`, "utf8")).toContain(said);
  });
});

describe("两条快链都装上了,真 bwrap 的 project 没被误伤", () => {
  const config = readFileSync(`${repoRoot}vitest.config.ts`, "utf8");

  it.each(["unit", "property"])("%s 链装了探针", (project) => {
    expect(projectBlockOf(config, project)).toContain(SETUP_FILE);
  });

  // 反面:探针装进这三个 project 会把「真沙箱能不能跑」也一起弄假,那正是 `check:sandbox` 要验的事。
  it.each(["gates", "slow", "sandbox"])("%s 链没装探针", (project) => {
    expect(projectBlockOf(config, project)).not.toContain(SETUP_FILE);
  });
});

describe("真 bwrap 的用例不会被放回快链(探针看不到的那一侧)", () => {
  const config = readFileSync(`${repoRoot}vitest.config.ts`, "utf8");

  /**
   * 两条真 bwrap 的用例:探针抓出来的那一条(`gen-cli`)与早就拆出去的那一条(`agent-real-session`)。
   *
   * 判据不是「探针会拦住它们」——搬走之后探针就不再跑它们了——而是「排除它的那条链与收着它的
   * 那条链引用**同一个常量**」。两处各写一份路径的话,谁把 exclude 删了都不会有人发现,而后果是
   * 快链上重新出现一条要内核能力的用例(本机绿、CI 红的那一种)。
   *
   * 断言拆成三段,是因为这份配置的形状是「常量定义一处 + 两处引用」:只查引用会漏掉「常量被改了
   * 值」,只查字面量会漏掉「exclude 被删了」。
   */
  it.each([
    ["apps/cli/src/gen-cli.test.ts", "GEN_CLI_TEST"],
    ["apps/cli/src/agent-real-session.test.ts", "SANDBOX_TEST"],
  ])("%s:unit 排除、sandbox 收着", (path, constant) => {
    expect(config, `${constant} 的定义被改了值或删了`).toContain(`const ${constant} = "${path}";`);
    expect(
      projectBlockOf(config, "unit"),
      `unit 没排除 ${constant}:快链上重新出现了一条真 bwrap 的用例`,
    ).toContain(constant);
    expect(projectBlockOf(config, "sandbox"), `sandbox 没收 ${constant}`).toContain(constant);
    // 收着它的那条链不能装探针,否则这条用例在真沙箱上也会被探针拒掉。
    expect(projectBlockOf(config, "sandbox")).not.toContain(SETUP_FILE);
  });
});
