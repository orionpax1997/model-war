/**
 * 门禁自测里**慢的那一半**:契约自证门禁的四问与三个反例、跨进程一致性门禁的正例与反例,
 * 以及会 spawn 全量 `check` 的那一条。
 *
 * 为什么不与 `gates.test.ts` 合在一起:同机实测(2026-10,Node v24 / Linux x64),本文件里这几条
 * 用例合计约 **350s**(加上跨进程那两条真沙箱用例后更多),而 `gates.test.ts` 那 30 条合计约 **43s**
 * ——一个 8:1 以上的比例。
 * 更关键的是其中一条(`--same-script` 反例要证「三对都掉到 0/9」,一个关于指标的论断)必须跑全矩阵,
 * 它自己就 220s。**把 43s 的东西和 350s 的东西捆在一个脚本里,等于让每次想跑快的那一半的人
 * 付出慢的那一半的价钱**,于是两个后果二选一:要么整个门禁自测没人跑,要么它每天都跑,
 * 于是没人看结果。快慢仍分别按需运行,完整慢检查按需分别运行 `check:selfproof` 与 `test:slow`。
 *
 * 覆盖纪律:门禁**已按需**——它不在 `check` 里(理由见 `gates.test.ts` 的
 * `契约自证门禁按需跑:不在 check 里,但有独立入口与反例覆盖`),由 `check:selfproof` 入口运行。
 * 本文件就是它的按需覆盖:四问绿一次 + 三个反例成对「红 → 还原 → 绿」。
 *
 * 同一次改动里留了两条不变量在别处:「slow 不被 unit/gates/property 拾取」与「默认 `test` 不跑 slow」
 * 盯着本文件,断言写在 `gates.test.ts` 末尾那一节。
 */

import { rmSync } from "node:fs";

import { afterAll, expect, it } from "vitest";

import {
  VIOLATING_SCRIPT_PROBE_PATH,
  type Outcome,
  repoRoot,
  script,
  withProbeFile,
} from "./gates-harness.ts";

// ── 会 spawn 全量门禁的那一条 ────────────────────────────────────────────────

it("check(全量门禁)退出 0", () => {
  const result = script("check");
  expect(result.status, result.output).toBe(0);
});

// ── 契约自证门禁:四问的退出码与三个反例 ────────────────────────────────────
//
// 基线绿那一条跑**整张矩阵**(4 臂 × 4 座位轮转 × 4 种子 = 64 场,单次约一分半)——四问的读数
// 只能来自全矩阵。**每条反例跑的是缩矩阵**(`--probe`:1 臂组 × 1 轮转 × 1 种子 = 4 场),成对
// 「红 → 同参数还原 → 绿」。理由是反例要证明的是「改这一项,门禁会红」,不是四问的取值;
// 而红不红在小矩阵上照样判得红——真判不出来时下面那条 `toBe(1)` 会当场红,不会静默放过。
// **例外是 `--same-script` 那一条**:它要证的是「三对都掉到 0/9」,一个关于指标的论断,
// 小矩阵的采样噪声会混进来,所以那一条连同它的还原都跑全矩阵。
// 形态与 `gates.test.ts` 里各节不同:基线绿只跑一次(单独一条用例),每条反例只跑两次,少掉的那次
// 基线不是证据变薄——「同参数还原后回到绿」与「基线是绿的」证明的是同一件事。

const selfproof = (args: readonly string[] = []): Outcome => script("check:selfproof", args);

it("契约自证门禁:四问全绿", () => {
  const result = selfproof();
  expect(result.status, result.output).toBe(0);
  // 报告要说得出四问各自的判据读数,而不只是一个「绿」——否则红起来时没人知道是哪一问。
  expect(result.output, result.output).toContain("① 零静态违规：过");
  expect(result.output, result.output).toContain("② 正常终局：过");
  expect(result.output, result.output).toContain("③ 消耗 ≤ 总储量 1/4");
  expect(result.output, result.output).toContain("④ 取策略互不相同：过");
  // 夹具闸门先于正表:锚点漂了就不该有正表的读数,所以这一行必须在场。
  expect(result.output, "报告里没有夹具闸门的锚点读数").toContain("p100=479");
});

it("契约自证门禁:把配额改小 → ③ 变红,还原 → 绿", () => {
  // 配额是③的判据本身(默认总储量的 1/4),把它改到 6% 就低于 A 的实际消耗中位(6.9%)。
  const shrunk = selfproof(["--probe", "--quota-percent=6"]);
  expect(shrunk.status, `配额改小后门禁仍为绿:\n${shrunk.output}`).toBe(1);
  expect(shrunk.output, shrunk.output).toContain("③ 消耗 ≤ 总储量 1/4（配额 6%");
  expect(shrunk.output, shrunk.output).toContain("**不过**");
  // 红的原因得是③而不是别的:另外三问仍然过。
  expect(shrunk.output, "红的原因不是③").toContain("契约自证门禁:红（① 过 ② 过 ③ 不过 ④ 过）");

  expect(selfproof(["--probe"]).status, "配额还原后没有回到绿").toBe(0);
});

it("契约自证门禁:把一份产物换成违规脚本 → ① 变红,撤掉探针 → 绿", () => {
  const violated = withProbeFile(
    VIOLATING_SCRIPT_PROBE_PATH,
    [
      "// 故意违规的参赛脚本:确定性污染源 + 宿主桥 + 浮点字面量。",
      "function loop() {",
      "    const noise = Math.random() * 100;",
      "    console.log(__peekHost(noise), Date.now(), performance.now());",
      "}",
      "",
    ].join("\n"),
    () => selfproof(["--probe", `--script-a=${repoRoot}${VIOLATING_SCRIPT_PROBE_PATH}`]),
  );
  expect(violated.status, `换成违规脚本后门禁仍为绿:\n${violated.output}`).toBe(1);
  expect(violated.output, violated.output).toContain("① 零静态违规：**不过**");
  // 判红的依据是静态校验器自己的报告,不是本门禁的一句话。
  expect(violated.output, "报告里没有静态校验器的违规原文").toContain("禁列全局名");
  expect(violated.output, violated.output).toContain("宿主桥前缀");

  expect(selfproof(["--probe"]).status, "撤掉探针后没有回到绿").toBe(0);
});

it("契约自证门禁:三份换成同一份 → ④ 变红,还原 → 绿", () => {
  // 这一条**跑全矩阵**,不用 `--probe`:④ 的判据是「每一对至少 3 项指标相对差 ≥ 25%」,
  // 而把三份换成同一份之后要证明的是「三对都掉到 0/9」——那是一个关于指标的论断,
  // 拿 4 场的小矩阵去判它,采样噪声会混进来(淘汰率那一项就是这么混进来的)。
  const same = selfproof(["--same-script"]);
  expect(same.status, `三份同源后门禁仍为绿:\n${same.output}`).toBe(1);
  expect(same.output, same.output).toContain("④ 取策略互不相同：**不过**");
  // 三份指纹逐项相同,所以每一对的分开项数都掉到 0——这是④的判据失效的样子,不是「差距不够大」。
  expect(same.output, same.output).toContain("A vs B：分开 0/9 项");

  expect(selfproof().status, "还原后没有回到绿").toBe(0);
});

// ── 跨进程一致性门禁:正式样本绿一次 + 反例红一次 ────────────────────────
//
// 门禁脚本 `packages/tools/src/cross-process/run-cross-process-gate.ts` 走 CLI 主接缝
// (`match` 进程 A → `verify` 进程 B),它的位置纪律在 `gates.test.ts`。这里跑它本身。
// 反例用 `--tamper`(门禁把回放里一个 tick 的 `stateHash` 改掉一位再交给 verify),不动仓库里的任何东西。

it(
  "跨进程一致性门禁:正式样本 match → verify 逐 tick 一致,退出 0(真沙箱)",
  { timeout: 300_000 },
  () => {
    const result = script("check:cross-process");
    expect(result.status, result.output).toBe(0);
    expect(result.output, result.output).toContain("cell-a-melee-pressure");
    expect(result.output, result.output).toContain("进程 B(verify):退出码 0");
    expect(result.output, result.output).toContain("逐项一致");
    expect(result.output, result.output).toContain("逐 tick hash:一致");
    expect(result.output, result.output).toContain("跨进程一致性门禁:绿");
  },
);

it("跨进程一致性门禁:改一 tick 的 stateHash 即红,还原后绿", { timeout: 300_000 }, () => {
  const tampered = script("check:cross-process", ["--tamper"]);
  expect(tampered.status, `改了一个 tick 门禁仍为绿:\n${tampered.output}`).not.toBe(0);
  expect(tampered.output, tampered.output).toContain("逐 tick hash:**不一致**");
  expect(tampered.output, tampered.output).toContain("跨进程一致性门禁:红");
  // 「还原」= 无参数再跑一次回到绿:门禁只碰临时目录,仓库状态全程未被触碰,所以无需手动还原。
  expect(script("check:cross-process").status, "还原后没有回到绿").toBe(0);
});

// 与 gates.test.ts 的兜底清理同形态:进程被硬杀时 finally 根本没机会跑。
afterAll(() => {
  rmSync(`${repoRoot}${VIOLATING_SCRIPT_PROBE_PATH}`, { force: true });
});

// 「契约自证门禁按需跑:不在 check 里,但有独立入口与反例覆盖」那条断言留在 `gates.test.ts`:
// 它读的是 manifest 而不是跑矩阵(耗时可忽略),而位置纪律与 `check:drift` / `check:bench`
// 是同一条纪律,就该在同一处被看着。它用到的清单由这个模块供值,清单本身只有一份
// (`gates-harness.ts` 的 CONTENT_RECHECKS)。
