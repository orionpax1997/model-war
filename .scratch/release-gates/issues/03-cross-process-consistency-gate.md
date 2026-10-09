# 03: 跨进程一致性门禁与桩结论复验矩阵

**What to build:** 一条走对局/校验命令行主接缝的跨进程一致性门禁:抽正式对局样本重跑并逐 tick 比对状态 hash;附带桩结论复验矩阵,三条需复验结论各有夹具位置、复验形态与停止条件,接受为设计意图的那条明文不复验。每道新门禁都有能被弄红的反例。

**Blocked by:** 02 (复算读入端须先统一).

**Status:** resolved

## 验收

- [x] 跨进程一致性门禁脚本落地并挂夜间层,正式样本重跑逐 tick 一致
- [x] 改一 tick 即红的反例存在且通过
- [x] 复验矩阵单列,三条各有停止条件,设计意图条目明文不复验

## Answer

**选定方案。** 门禁脚本落 `packages/tools/src/cross-process/run-cross-process-gate.ts`,命名 `check:cross-process`
(根 `package.json`),归**按需→夜间**层(不进 `check:quick` / `check` / `test` / `verify:fast`)。正式对局样本
**运行时现造进临时 root**:执行体是**入库的冻结基准脚本** `benchmarks/<cell>/script.js`(默认 cell-a),配
固定种子 `20260101`、入库地图 `maps/open-clash.json`、`rulesets/v1.json`;四份存档三件套、input.json、
地图、规则集、runtime bundle(入库)与 quickjs-wasi 的 wasm 按 `cli.test.ts:writeMatchInput` 的做法物化
(`--root` 就是这一局的安装根)。走 CLI 主接缝:进程 A `modelwar match <input> --root <root>` → 进程 B
`modelwar verify <replay> --root <root>`(重新执行、逐 tick 比对 `stateHash`)。

**为什么选「现造」而不是入库冻结 `input.json`(票面给的另一条路)。** 样本的可复现输入只有四样——冻结
脚本、固定种子、入库地图、入库规则集——它们各自在库里已被逐字节钉住(`check:bench` 把 `script.js` 钉在
`script.ts` 上、地图走 lint、`rulesets/v1.json` 是取值真源)。再入库一份由这四样派生的 `input.json`,只多
一份会与那四样悄悄漂移的副本;而基准脚本正是 srs NFR-1 说的「正式对局样本」的执行体——它要用**完整注入
面**,注入面铺没铺全恰好由这条跨进程复算连同证明。产物全落系统临时目录,仓库树不留任何东西(`runs/**`
本就入库在外)。

**反例形态。** 门禁留了 `--tamper` 开关:match 跑完后把回放里第一个 tick 的 `stateHash` 改掉一位再交给
verify(与 `cli.test.ts` 改一 tick 的反例同形),门禁必红;无参数再跑回到绿。测试只用这个开关注入被改的
回放,**不动仓库里的任何东西**(反例不需要「finally 还原真实仓库状态」,因为改动全在临时 root;「还原」=
无参数再跑一次)。

**改动文件:行号。**
- `packages/tools/src/cross-process/run-cross-process-gate.ts`(新增):`parseArgs` 支持
  `--cell=<名>` / `--seed=<整数>` / `--tamper` / `--keep`;`buildCliBundle`(`:120` 附近)先 `tsc -b` 再
  esbuild 打单文件 bundle;`materialize`(`:158` 附近)物化样本;`tamperOneTick` 制造反例;`main` 走
  match→verify 并按退出码 + verify 的「逐项一致」判红/绿。头注引用复验矩阵、不重复其内容。
- `package.json`:新增 `check:cross-process`(在 `check:selfproof` 之后)。
- `.scratch/release-gates/verification-matrix.md`(新增):gdd §8 #7/#8/#9 各一行(夹具位置 / 复验形态 /
  停止条件),#10 明文「接受为设计意图,不复验」;带 gdd `:230-235` 的口径警告与 `:236-239` 的回流行号。
- `packages/tools/src/gates.test.ts`(新增「跨进程一致性门禁按需跑…」):位置纪律——不在
  `check` / `check:quick` / `check:types` / `test` / `verify:fast` / 末尾复核组,但按需入口在。
- `packages/tools/src/gates-slow.test.ts`(新增两条真沙箱用例):正例绿一次、反例(`--tamper`)红一次 +
  无参数还原绿。

**测试证据(跑了哪条、为什么)。**
- `pnpm run check:quick` → 绿(改动的三处 .ts 与 package.json 过 fmt/lint;因为它读 `package.json` 的
  `check:cross-process`、又改了两处测试文件,快门禁是快反馈第一步)。
- `pnpm run check:cross-process` → 退出码 0,`600 tick 逐项一致`,`逐 tick hash:一致(600/600)`,`绿`(真沙箱,
  ~11s)。证明正例。
- `pnpm run check:cross-process --tamper` → 退出码 1,verify 报 `回放与本次执行不一致(2 处)`,`逐 tick
  hash:**不一致**`,`红`。证明反例。
- `pnpm exec vitest run --project gates -t "跨进程一致性门禁按需跑"` → 1 passed(位置纪律)。
- `pnpm exec vitest run --project slow -t "跨进程一致性门禁"` → 2 passed(正例 + 反例,~26s)。真沙箱用例慢,
  故落 `gates-slow.test.ts`(slow project),不进快链。

**落地提交:** `26a036c` `feat(gate): 跨进程一致性门禁(match → verify 逐 tick hash)+ F ⇢ L 复验矩阵`。

**旁证(非本票引入)。** 跑 `--project gates` 全量时 `check:types(check:quick + tsc -b + 类型感知 lint)退出 0` 一条
红:`packages/runner/src/season-config.ts:163` 的 `no-base-to-string`。`git stash -u` 后在干净的票前 HEAD
上 `pnpm run lint:types` 同样红——**本票改动不碰 runner**,故这是票前就存在的 fail(且 `check:types` 不在
`check:quick` / `verify:fast` 这两条默认快链上)。不顺手改(超出本票范围),登记在此供收口时处置。
