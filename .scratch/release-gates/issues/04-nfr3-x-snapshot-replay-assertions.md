# 04: 对局墙钟目标值与快照回放停止断言

**What to build:** 同机单进程用同一批基准脚本逐局落墙钟,取分布三栏定出对局平均墙钟上限并写回需求与设计文档;快照拷贝粒度与回放体量复测后各落一条可执行停止断言,超限即红,不做重构。

**Blocked by:** 01 (采样方法与基线口径先定), 03 (采样走同一条跨进程链).

**Status:** resolved

## 验收

- [x] 不少于 30 局的三栏读数已落盘,机器配置写进读数
- [x] 墙钟上限已按均值加倍数余量定出并写回需求与设计文档
- [x] 快照差值占比与单季回放总量两条断言挂夜间层,两侧阈值各有弄红反例

## Answer

**选定方案。** 一条门禁脚本 `packages/tools/src/limits/run-limits-gate.ts`(命名 `check:limits`)用**真引擎、
真沙箱、单进程逐局**跑**入库基准脚本**(`benchmarks/<cell>/script.js`,三舱轮换),一次量齐三样东西:
单局墙钟分布、`buildSnapshot` 与纯 `structuredClone` 的差值、每局回放字节。X 由这条脚本的 36 局采样定出;
#6/#7 两条停止断言由同一条脚本判红/绿。它 spawn 一次 `tsc -b`,再**用绝对路径动态 `import` 引擎 dist**
(`packages/engine/dist/index.js` 的 `runMatch`、`dist/snapshot/snapshot.js` 的 `buildSnapshot`、
`dist/runner/quickjs.js` 的 `createQuickJsRunner` 与 WASI 常量,以及 `packages/schema/dist/index.js` 的沙箱常量)——
`import(变量)` 不经 tsc 解析,所以既不给 `packages/tools` 加包依赖(那是架构禁令,hld §3.2),
也不新增引擎导出面。动态 import 还顺带让 `tsc -b` 能排在模块装载之前。

**为什么这么定 X。** 口径 = 同机、单进程、逐局取 `runMatch` 一次调用的墙钟(不含进程启动、不含并发),
执行体是同一批入库基准脚本(≥2 份),36 局报 p50 / 均值 / 最坏三栏——**不拿 K 的单局最坏 3801ms、
也不拿 I 的整轮吞吐 0.81 局/s**(那条含 8 路并发与排队)当单局口径。采样读数:**p50 2373.2ms / 均值
2725.7ms / 最坏 4650.8ms**。**X = 均值的两倍 = 5451.4ms,向上取整到 100ms → 5500ms**,即「均值 + 一倍
余量」的物理量轨口径(沿 hld §5.3「余量分轨而非统一系数」):一倍余量把本次最坏(1.71 × 均值)全覆盖
并留约 18% 机器负载余量,又不像 K 的峰值轨那样留 20×/200×。规则写进 `docs/hld.md` §10.1(§5.3 留指针),
数值回填 `docs/srs.md` NFR-3 AC——按「每个事实只有一个家」,srs 只放数、hld 放规则。

**#6/#7 两条停止断言(不重构)。** #6:深拷贝+深 freeze 与纯 clone 的差值,按「每 tick 四席各一次」
换算成整局拷贝税,占同一局墙钟 **< 10%** 即停——本次 **4.96%**(复测确认 F 那条「约 5%」),超了即红、
**不做零拷贝重构**(合并两次遍历会踩 `traversal-independence.test.ts` 钉住的禁令)。#7:单季(算例 75 局)
回放总量 **< 1 GiB** 且夜间一遍读完 **< 10 min** 即停——本次单季 **171.1 MiB** / 一遍 **0.140 s**,
超了即红、不做压缩 / 增量回放。两条都挂**按需→夜间**层(它要 `tsc -b` 加真跑对局,与快门禁的零构建
性质不相容),**不进** `check:quick` / `check` / `test` / `verify:fast`。

**反例形态。** 门禁留两个倍率开关:`--copy-inflate=N` 放大拷贝差值、`--volume-inflate=N` 放大单局回放
体量(默认 1)。`gates-slow.test.ts` 现做现验:默认绿一次;`--copy-inflate=4`(占比 ~20%)红一次、
`--volume-inflate=8`(单季 ~1.4 GiB)红一次;各去掉开关再跑回到绿。**开关只改断言代入的那一笔量,
不动仓库任何文件**,故「还原」= 无参数/无开关再跑一次。

**改动文件:行号。**
- `packages/tools/src/limits/run-limits-gate.ts`(新增,540 行):`parseArgs`;`typecheck`;`loadEngine`
  (动态 import dist);`runSample`(逐局墙钟 + 快照微基准 + 回放字节);`buildReport`(两条判据 +
  两个倍率开关);`renderReport`;入口。
- `package.json:39`:新增 `check:limits`(在 `check:cross-process` 之后)。
- `packages/tools/src/gates.test.ts:1400`(新增「单局墙钟与快照回放门禁按需跑…」):位置纪律——
  `check:limits` 不在 `check` / `check:quick` / `check:types` / `test` / `verify:fast` / 末尾复核组,
  但按需入口在(照 `:559-567` 的漂移检查位置纪律形态)。
- `packages/tools/src/gates-slow.test.ts:150`(新增三条):默认绿一次 + `--copy-inflate=4` 红一次 +
  `--volume-inflate=8` 红一次,每条红后紧跟一次还原绿。
- `docs/srs.md:126`:NFR-3 AC 把「≤ X」填成「≤ **5500ms**」,并把读数指针改指向 `.scratch/release-gates/readings.md`。
- `docs/hld.md:826`(§10.1,新增一段):X 的取值规则(均值 + 一倍余量、口径、与 §5.3 的分工);
  `docs/hld.md:637`(§5.3):「对局平均墙钟」的指针由「归节点 L」改为「取值规则在 §10.1」。
- `docs/hld.md:867-868`(§12 #6/#7 两行):把「停止条件归 L」「存储/IO 方案归 L」改成已定的可执行断言
  与本次读数、门禁名(`check:limits`)。
- `docs/hld.md:179`(§2.2.7 按需→夜间行):登记 `check:limits`,并补上票 03 落了脚本却没登记的
  `check:cross-process`(归属层登记,命令真源仍以 `package.json` 为准)。
- `.scratch/release-gates/readings.md`(追加一节「对局墙钟、快照拷贝占比与单季回放体量读数(票 04)」;
  票 01 的门禁耗时内容未动);同目录新增结构化读数 `.scratch/release-gates/limits-readings.json`。
- `packages/runner/src/season-config.ts:164-169`(**票外**:`oxfmt` 一处纯格式换行修复)。它是票前
  就存在的 `fmt` 红灯(见下「旁证」),不改语义,只为让 `check:quick` 绿。

**测试证据(跑了哪条、为什么)。**
- `pnpm run check:quick` → 绿(新增/改动的 .ts 过 fmt/lint;它读 `package.json` 的 `check:limits`,
  快门禁是快反馈第一步)。跑之前先修了票前就红的 `season-config.ts` 格式。
- `pnpm run check:limits -- --matches=36 --readings-out=.scratch/release-gates/limits-readings.json`
  → 退出码 0,`limits 门禁:绿`,99s;三栏读数与 #6/#7 占比见上。
- `pnpm run check:limits -- --matches=2 --copy-inflate=4` → 退出码 1,`#6 … 占单局墙钟 18.20% → **红**`、
  `limits 门禁:红`。`--volume-inflate=8` → 退出码 1,`#7 … 1446.3 MiB → **红**`。各自去掉开关再跑 → 绿。
- `pnpm exec vitest run --project gates -t "单局墙钟与快照回放门禁按需跑"` → 1 passed。
- `pnpm exec vitest run --project slow -t "单局墙钟与快照回放门禁"` → 3 passed(绿 + 两侧反例,~33s)。
- `pnpm run check:declared-deps` → 绿(新脚本只 import node 内建,未新增未声明依赖)。

**旁证(非本票引入)。** `packages/runner/src/season-config.ts` 在票前的工作树上是 `oxfmt` 红灯:
`git stash -u` 后 `pnpm run fmt` 仍红同一条;`git diff ad3181f HEAD -- <file>` 为空,说明它由 `ad3181f`
引入且一路带到本票的 HEAD(中间几次 merge 都没跑 `fmt`)。本票只做一处三行换行,无语义改动。

**落地提交:** (见分支 `t/04` 上本票的 `feat(limits): …` 提交)。
