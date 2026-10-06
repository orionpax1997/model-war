# 10: 五条复验探针、版本耦合断言与 hld 写回

**What to build:** hld §5.0 的五条沙箱行为结论各有**可执行探针**,按当时版本组合重跑、把新数字写回 §5.0,并关闭 §12 #8;`quickjs-wasi` 一升版,默认门禁立刻红并提示去跑复验。

**为什么本票只等产物入库,不等裁决那几张票**:它是 hld 明写的「第一条验收」,要尽早跑起来当基线;中间的裁决工作与它并行,谁也不挡谁。

**为什么要一条廉价的版本耦合断言**:hld 自己写着那五条只对某个版本成立,而「**没有任何机器会提醒后来者它们已经过期**」。本仓库没有 CI(门禁是命名脚本、手工触发),所以提醒只能挂在默认的快速链上:版本一升,那条断言立刻红,报错信息里直接说明该去跑哪个脚本、该写回哪一节。

**为什么探针与那条断言要分开**:探针要真装 VM、跑行为,不能塞进每次编辑都跑的快速链;版本断言只比对两个字符串,几乎零成本。

**为什么既有的标定代桩不并进来**:那套桩的价值恰恰在「桩一行未改」,它是某些既有读数的复现前提。把真 VM 塞进同一脚本就有了两种口径,那份报告会失去单一解释。两个脚本各自独立。

决策依据:`.scratch/sandbox-executor/spec.md`《Testing Decisions》。

**Blocked by:** 04(runtime bundle 成形并入库)

**Status:** resolved

- [x] 五条探针各一条,分别断言 hld §5.0 对应那一行的行为:脚本入口契约 / 深递归失败形态 / 计数回调的粒度与不可捕获性 / 内存读数口径与封顶 / 删桥后的不可见性
- [x] 数值类断言用**已冻结的常量**、计时类断言用区间;每条探针的报错信息带上它对应的 hld 行号
- [x] 一个冻结常量模块记录核对时的运行时版本与 Node 大版本
- [x] 探针输出落盘(避免出现「引用了某个探针输出、而那个输出无处可查」的复现缺口)
- [x] 一个命名脚本一键跑五条探针;它**不进**默认快速链
- [x] 默认快速链里有一条**版本耦合断言**:改根级依赖里钉的版本号即红,报错信息写明「跑复验脚本并把数字写回 hld §5.0」
- [x] hld §5.0 的五条数字/措辞按本次实测更新,出处声明(环境、版本、测量日期)同步更新,并与探针输出一致
- [x] hld §12 #8 标为关闭;同时修掉那两处早先写错的断言加总(表里是 6 成立 / 4 不成立 / 1 缺机制,不是 7/4/1)
- [x] 探针本身不需要引擎(它直接驱动 VM),这样它不随引擎内部重构而红

## Answer

五条探针与版本耦合断言落地,并完成 hld 写回。

- **探针**:`packages/tools/src/sandbox-probes/`(`lib.ts` 驱动根 `node_modules` 的 `quickjs-wasi@3.6.2`,不 import 引擎;`run-probes.ts` 五条 + 落盘;`constants.ts` 冻结常量;`webassembly.d.ts` 最小 `WebAssembly` 名面)。根脚本 `pnpm run probes:sandbox`,不进 `check:quick`、不进默认 `test`。每次运行把逐条输出写到 `.scratch/sandbox-executor/probe-output/probe-0N-*.txt` 与 `probes.txt`(不被 `.gitignore` 吞,`version-control-boundary.test.ts` 新加一条断言钉住)。判据形式:数值类用 `constants.ts` 的冻结常量(粒度 5000、空 VM 基线 75128/64098、分配上限),计时类用区间(拖慢 ±10%);每条报错带 `docs/hld.md:NNN`。
- **版本耦合断言**:`packages/tools/src/gate/run-quickjs-coupling-gate.ts`(根脚本 `coupling:quickjs`,已挂进 `check:quick`;形态照 `toolchain-coupling.ts`:导出的纯函数 `findQuickjsMisalignments` + 反例形式参数 + 独立入口 + 退出码)。改根 `package.json` 钉的 `quickjs-wasi` 版本即红,报错信息写明跑 `pnpm run probes:sandbox` 并把数字写回 `docs/hld.md §5.0`。自测:`gate/quickjs-coupling.test.ts`(unit,反例能红 + 冻结常量与 `@model-war/schema` 的 `QUICKJS_WASI_VERSION` 同步)与 `gates.test.ts` 一条退出码用例。`quickjs-wasi` 已同步声明进 `packages/tools/package.json` 的 `dependencies`(声明即依赖门禁),lockfile 已更新。
- **hld 写回**:§5.0 五条按 2026-10-06 复验改数字/措辞(结论与 spike 一致)并把来源指向探针输出;出处声明加复验与「机器会提醒过期」的耦合断言;§5.0 升级条款由「空头承诺」改为「已收口」;§5.2 WASM trap 行去掉「防御性重建」、改为归引擎故障轨(§8.4 重跑一次、再触发剔除);§5.3 回调改为「不得放每次都做的重活,时钟按抽样读」、墙钟软限改「写入观测文件、不进回放 events 流」;§5.1 三件套与删桥/排空措辞按实现改正(random_get 不覆盖、载入期删桥、每 tick 排空到不动点);§12 #8 标为「已收口」。另修 `.scratch/sandbox-budget/map.md:28` 的加总残留(7 成立 → 6 成立)。
