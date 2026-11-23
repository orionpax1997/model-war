/**
 * 门禁自测里**慢的那一半**:契约自证门禁的四问与三个反例、跨进程一致性门禁的正例与反例、
 * 单局墙钟与快照回放门禁、标定复算门禁。
 *
 * 「spawn 一遍全量门禁 `verify:wide` 并期望退出 0」那一条**不在这里**(2026-11 移出):
 * 它 143.6s,而它独有要证明的只是「这条链串起来不打架」——链的骨架由 `gates.test.ts` 的
 * `quick 在空壳上退出 0` 盯着,四道需要构建 / 巡航的复核各有自己的自测(名单见
 * `CONTENT_RECHECKS`),真机上整条 `verify:wide` 由夜间链的那条腿从头跑一遍。
 * 在门禁自测里再 spawn 一次,买到的是同一件事的第二个副本。
 *
 * 为什么不与 `gates.test.ts` 合在一起:同机实测(2026-10,Node v24 / Linux x64),本文件里这几条
 * 用例合计约 **350s**(加上跨进程那两条真沙箱用例后更多),而 `gates.test.ts` 那 30 条合计约 **43s**
 * ——一个 8:1 以上的比例。
 * 更关键的是其中一条(`--same-script` 反例要证「三对都掉到 0/9」,一个关于指标的论断)必须跑全矩阵,
 * 它自己就 220s。**把 43s 的东西和 350s 的东西捆在一个脚本里,等于让每次想跑快的那一半的人
 * 付出慢的那一半的价钱**,于是两个后果二选一:要么整个门禁自测没人跑,要么它每天都跑,
 * 于是没人看结果。快慢仍分别按需运行,完整慢检查按需分别运行 `gate:selfproof` 与 `test:slow`。
 *
 * 覆盖纪律:门禁**已按需**——它不在 `check` 里(理由见 `gates.test.ts` 的
 * `契约自证门禁按需跑:不在 check 里,但有独立入口与反例覆盖`),由 `gate:selfproof` 入口运行。
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

/**
 * 按「脚本名 + 全部参数」memo 的 runner。
 *
 * ── 为什么要有它 ──
 * 本文件的每条用例都是「正例绿 → 反例红 → 还原绿」的同一副形状,而**还原步的命令与别处的正例
 * 逐字相同**:`gate:limits --matches=2` 被跑三遍、`gate:budget:recheck` 三遍、
 * `gate:selfproof` 四遍(其中两遍是 `--same-script` 反例与四问正例的还原,一次全矩阵 ~55s)。
 * 同一个进程里为同一件事付第二遍、第三遍的价钱,买到的不是证据,是重复。
 *
 * ── 为什么这样不削弱断言 ──
 * 键里带全部参数,所以命中只发生在**同一条命令**上;缓存里放的是那次真实 spawn 的退出码与
 * 全部输出,断言照旧逐字检查。这些门禁脚本都只碰临时目录与本进程 env(各节注释逐条写明了这一
 * 点),同机同参数的结果就是「还原后回到绿」本来要拿的那一份。用 `-t` 单跑某一条时缓存为空,
 * 走的仍是真实 spawn——证据只会在「同一条命令已经真跑过」时被复用。
 */
const spawnMemo = new Map<string, Outcome>();

const cached = (name: string, args: readonly string[] = []): Outcome => {
  const key = JSON.stringify([name, ...args]);
  const hit = spawnMemo.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const fresh = script(name, args);
  spawnMemo.set(key, fresh);
  return fresh;
};

const selfproof = (args: readonly string[] = []): Outcome => cached("gate:selfproof", args);

/**
 * 「还原」步:去掉反例开关再跑一次,必须回到绿。
 *
 * ── 为什么单独抽出来 ──
 * 这一步原本只断言 status,而慢门禁红的原因有五六种(构建没过、空转、判据不过、真沙箱跑崩),
 * 事后拿一个 `expected 1 to be 0` 无从分辨,只能靠重跑猜。夜跑里真发生过一次
 * (`gate:limits` 的还原步在 CI 上红过一次、同参数重跑又绿),那次连哪一档红的都说不出来。
 * 于是把输出一律带进消息——它只在红的时候才被读,不影响绿的那条路径。
 */
const expectRestored = (result: Outcome, what: string): void => {
  expect(result.status, `${what} 还原后没有回到绿:\n${result.output}`).toBe(0);
};

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

  expectRestored(selfproof(["--probe"]), "配额改小后");
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

  expectRestored(selfproof(), "三份换成同一份后");
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
    const result = cached("gate:cross-process");
    expect(result.status, result.output).toBe(0);
    expect(result.output, result.output).toContain("cell-a-melee-pressure");
    expect(result.output, result.output).toContain("进程 B(verify):退出码 0");
    expect(result.output, result.output).toContain("逐项一致");
    expect(result.output, result.output).toContain("逐 tick hash:一致");
    expect(result.output, result.output).toContain("跨进程一致性门禁:绿");
  },
);

it("跨进程一致性门禁:改一 tick 的 stateHash 即红,还原后绿", { timeout: 300_000 }, () => {
  const tampered = cached("gate:cross-process", ["--tamper"]);
  expect(tampered.status, `改了一个 tick 门禁仍为绿:\n${tampered.output}`).not.toBe(0);
  expect(tampered.output, tampered.output).toContain("逐 tick hash:**不一致**");
  expect(tampered.output, tampered.output).toContain("跨进程一致性门禁:红");
  // 「还原」= 无参数再跑一次回到绿:门禁只碰临时目录,仓库状态全程未被触碰,所以无需手动还原。
  expectRestored(cached("gate:cross-process"), "改 tick hash 后");
});

// ── 单局墙钟与快照回放门禁:正例绿一次 + 两侧反例各红一次 ────────────────────────
//
// 门禁脚本 `packages/tools/src/limits/run-limits-gate.ts` 用真引擎、真沙箱、单进程逐局跑入库基准
// 脚本,判 #6(快照拷贝税占单局墙钟 < 10%)与 #7(单季回放 < 1 GiB 且一遍读完 < 10 min)两条停止
// 断言。它 spawn 一次 `tsc -b` + 真跑对局,不是零构建,所以正例与反例都落在 slow project。
// 反例用门禁自己的两个倍率开关(`--copy-inflate` / `--volume-inflate`),**不动仓库里的任何文件**;
// 「还原」= 去掉开关再跑一次回到绿。`--matches=2` 只为把三舱里最小的采样跑出来(反例要证的是「放大即
// 红」,不是读数的取值),判据一字不改。

it("单局墙钟与快照回放门禁:默认阈值下 #6/#7 都绿,退出 0(真沙箱)", { timeout: 300_000 }, () => {
  const result = cached("gate:limits", ["--matches=2"]);
  expect(result.status, result.output).toBe(0);
  expect(result.output, result.output).toContain("#6 快照拷贝");
  expect(result.output, result.output).toContain("#7 单季回放");
  expect(result.output, result.output).toContain("limits 门禁:绿");
});

it("单局墙钟与快照回放门禁:人为放大拷贝差值即红,还原后绿", { timeout: 300_000 }, () => {
  const inflated = cached("gate:limits", ["--matches=2", "--copy-inflate=4"]);
  expect(inflated.status, `放大拷贝差值后门禁仍为绿:\n${inflated.output}`).not.toBe(0);
  expect(inflated.output, inflated.output).toContain("占单局墙钟");
  expect(inflated.output, inflated.output).toContain("**红**");
  expect(inflated.output, inflated.output).toContain("limits 门禁:红");
  // 「还原」= 去掉开关再跑一次回到绿:门禁只碰临时目录,仓库状态全程未被触碰。
  expectRestored(cached("gate:limits", ["--matches=2"]), "放大拷贝差值后");
});

it("单局墙钟与快照回放门禁:人为放大回放体量即红,还原后绿", { timeout: 300_000 }, () => {
  const inflated = cached("gate:limits", ["--matches=2", "--volume-inflate=8"]);
  expect(inflated.status, `放大回放体量后门禁仍为绿:\n${inflated.output}`).not.toBe(0);
  expect(inflated.output, inflated.output).toContain("#7 单季回放");
  expect(inflated.output, inflated.output).toContain("**红**");
  expect(inflated.output, inflated.output).toContain("limits 门禁:红");
  expectRestored(cached("gate:limits", ["--matches=2"]), "放大回放体量后");
});

// ── 标定复算门禁:终值下复算绿一次 + 失配语义两侧各红一次 ────────────────
//
// 门禁脚本 `packages/tools/src/budget-recheck/run-budget-recheck-gate.ts` 重跑预算探针与三份基准
// 脚本（复算的实际断言在 `probe-harness.test.ts` 的三条 `复算:*` 用例里），它的位置纪律在
// `gates.test.ts`。这里跑它本身。反例用 `--tamper-probe` / `--tamper-baseline`（门禁只改本进程传给
// 被测测试的 env），不动仓库里的任何东西；还原 = 无参数再跑一次回到绿。

it("标定复算门禁:终值下探针被截停、基准不被截停,退出 0", { timeout: 900_000 }, () => {
  const result = cached("gate:budget:recheck");
  expect(result.status, result.output).toBe(0);
  expect(result.output, result.output).toContain("MW_BUDGET_RECHECK=1");
  expect(result.output, result.output).toContain("探针:终值下三类探针均被截停");
  expect(result.output, result.output).toContain("基准:终值预算下三份基准脚本均不被截停");
  expect(result.output, result.output).toContain("推导:终值推导与规则集逐键自洽");
  expect(result.output, result.output).toContain("预算复算门禁:绿");
});

it("标定复算门禁:探针不被截停 → 红,还原 → 绿", { timeout: 900_000 }, () => {
  const tampered = cached("gate:budget:recheck", ["--tamper-probe"]);
  expect(tampered.status, `探针不被截停门禁仍为绿:\n${tampered.output}`).not.toBe(0);
  expect(tampered.output, tampered.output).toContain("预算复算门禁:红(探针未被截停)");
  // 「还原」= 无参数再跑一次回到绿:门禁只碰临时进程的 env，仓库状态全程未被触碰。
  expectRestored(cached("gate:budget:recheck"), "探针反例后");
});

it("标定复算门禁:基准被截停 → 红,还原 → 绿", { timeout: 900_000 }, () => {
  const tampered = cached("gate:budget:recheck", ["--tamper-baseline"]);
  expect(tampered.status, `基准被截停门禁仍为绿:\n${tampered.output}`).not.toBe(0);
  expect(tampered.output, tampered.output).toContain("预算复算门禁:红(基准被截停)");
  expectRestored(cached("gate:budget:recheck"), "基准反例后");
});

// 与 gates.test.ts 的兜底清理同形态:进程被硬杀时 finally 根本没机会跑。
afterAll(() => {
  rmSync(`${repoRoot}${VIOLATING_SCRIPT_PROBE_PATH}`, { force: true });
});

// 「契约自证门禁按需跑:不在 check 里,但有独立入口与反例覆盖」那条断言留在 `gates.test.ts`:
// 它读的是 manifest 而不是跑矩阵(耗时可忽略),而位置纪律与 `gate:drift` / `gate:bench`
// 是同一条纪律,就该在同一处被看着。它用到的清单由这个模块供值,清单本身只有一份
// (`gates-harness.ts` 的 CONTENT_RECHECKS)。
