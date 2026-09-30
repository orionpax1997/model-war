# 02: 机器门禁三件套

**What to build:** 三道门禁各自可跑通,并且各自被证明会在该失败的时候失败。①依赖方向:包之间的合法依赖图与「引擎包运行时只允许一个内置模块」由机器断言,不再是纸面约定;②格式与 lint:未格式化文件与被禁写法各自被拦下,整道快速门禁的耗时被实测记录;③工具版本耦合:TypeScript 与类型感知 lint 的配套版本一旦错位即非零退出。

**Blocked by:** 01 工具链与骨架落地

**Status:** resolved

- [x] 依赖规则可执行:schema 无依赖、replay 只依赖 schema、engine 不依赖 runner 与 gen、runner 不得依赖 engine、gen 不得依赖 engine、engine 运行时只允许 `node:crypto`
- [x] 引入一处违规 import 时依赖门禁非零退出,还原后恢复 0
- [x] 依赖门禁只作用于运行时代码;必然要读盘与 spawn 进程的测试代码不被拦下
- [x] 格式门禁在空壳上退出 0;未格式化文件被拦下,格式化后通过
- [x] lint 门禁在空壳上退出 0;被禁写法被拦下,改正后通过
- [x] 快速门禁的耗时被实测并记录:不少于 3 次取样,报中位数,不报单次最好成绩
- [x] 工具版本耦合断言就位:TypeScript 与类型感知 lint 的配套版本一致时通过,错位时非零退出
- [x] 快慢分层的门禁组合(快速 / 带类型感知 / 全量)在空壳上各自退出 0

---

## 交付说明

### 门禁与落点

| 门禁 | 命令 | 落点 |
|---|---|---|
| 格式 | `pnpm run fmt` | `.oxfmtrc.json` |
| lint | `pnpm run lint` | `.oxlintrc.json` |
| 类型感知 lint | `pnpm run lint:types` | 同上,`--type-aware` |
| 工具版本耦合 | `pnpm run coupling` | `packages/tools/src/toolchain-coupling.ts` |
| 依赖 | `pnpm run check:deps` | `.dependency-cruiser.js` |
| 快速 | `pnpm run check:quick` | fmt + lint + coupling |
| 带类型感知 | `pnpm run check:types` | check:quick + `tsc -b` + `--type-aware` |
| 全量 | `pnpm run check` | check:types + vitest(unit/property) + check:deps |
| 属性测试 | `pnpm run test:props` | — |

`mutate`(Stryker)与生成物漂移检查按 spec 的 Out of Scope 不落占位脚本。

### 三条必须记住的实现事实

1. **依赖门禁巡航的是 `dist`,不是 `src`。** dependency-cruiser 18.4.0 把可用的 TypeScript
   编译器硬编码为 `>=2.0.0 <7.0.0`,而本仓库的 TypeScript 7.0.2 **不再有 JS 编程 API**
   (`transpileModule` 不存在)。直接巡航 `src` 会得到 `0 modules cruised` + **exit 0** 的假门禁。
   故 `check:deps` 自带 `tsc -b`,入口是 `packages/*/dist` 与 `apps/*/dist`(acorn 可解析,
   import 说明符原样保留)。`gates.test.ts` 里有一条专门断言巡航规模不为零,防这条假门禁复发。
2. **`to.path` 匹配 specifier 还是 resolved realpath 是互斥的两态。** 本文件的架构规则一律用
   `(?:specifier|resolved)` 交替式,dist 未 build 与已 build 都成立。
   内建模块另有一处坑:depcruise **剥掉 `node:` 前缀**,故一律 `dependencyTypes: ["core"]` + `pathNot`。
3. **`sortPackageJson` 显式置 false。** 它默认是 `true`,会重排所有 `package.json` 的键;
   本仓库 manifest 的键序是手写语义(名字/版本/private/type/描述/packageManager/engines/scripts/…),
   让格式化器重排会在每次改依赖时把 diff 搅浑。格式基座逐条钉死默认值,
   使 oxfmt 未来改默认值不会静默重排全仓。

### 已知缺口(已复核并更正)

`packages/tools` 以源码形态执行(`emitDeclarationOnly`,dist 里没有 `.js`),因此**不在依赖门的巡航范围内**。
实测巡航出的 21 个模块里一个 tools 的都没有。缺掉的覆盖面分两块,一块有人兜底、一块没人兜底:

- **包图方向:有人兜底。** tools 的 tsconfig 没有 references、package.json 没有 dependencies,
  pnpm 因此不把任何 `@model-war/*` 软链进 `packages/tools/node_modules`(该目录压根不存在)。
  实测:`packages/tools/src` 里 import `@model-war/engine` ⇒ **TS2307**,`tsc -b` 非零退出。
  也就是说 tools → 其它包的反向边会被编译器拦住,只是拦它的是 `tsc` 而不是本门禁。
- **第三方依赖面:没人兜底。** 本节先前写的是「pnpm 隔离 node_modules + `tsc -b` 的 TS2307 兜住,
  引用未声明的包必然编译失败」——**这句是错的,已按实测更正**。Node 与 TypeScript 的模块解析一路
  向上找 `node_modules`,而 workspace 根把所有 devDependency 都摆平了,于是 `packages/tools/src`
  可以 import `ajv` / `fast-check` / `esbuild` / `vitest` / `oxc-parser` 而 `tsc -b` 退出 0,
  尽管 `packages/tools/package.json` 一个都没声明。TS2307 只对「整条祖先链上都没装」的包触发
  (实测 `lodash` ⇒ TS2307)。仓库此刻正吃这条:`packages/tools/src/index.ts` import `oxc-parser`
  就是未声明的。所以**「声明即依赖」这条纪律在 tools 包里目前只靠自觉,没有机器门禁**。
- `node:*` 那条禁令本身只作用于 engine,对 tools 谈「禁令生效与否」没有意义。

补上最后一块有两条路(都不在本票范围内):给 tools 加一条自举的「声明即依赖」检查,或把它也纳入
某个会产出 `.js` 的编译路径。

### 快慢门禁的实测数字

测量环境:Linux x64,`nproc=8`,Node v24.15.0,pnpm 12.8.1(corepack shim)。测量方法:`date +%s%N`
包住整条命令的**墙钟**;每条先跑 2 次预热并丢弃,再取 7 次的**中位数**(不报最好成绩);
工作区是已构建、已格式化的干净态,`check:quick` 不含 `tsc -b` 也不含任何安装步骤。

| 命令 | 7 次样本 (ms) | 中位数 |
|---|---|---|
| `corepack pnpm run check:quick` | 787 796 801 802 809 814 826 | **0.80s** |
| `pnpm run check:quick`(不经 corepack) | 795 799 800 806 813 815 820 | **0.81s** |
| `corepack pnpm run check:types` | 1448 1466 1467 1487 1512 1541 1578 | **1.49s** |
| `corepack pnpm run check` | 4189 4408 4521 4575 4660 4761 5176 | **4.58s** |

单步成本(各 3 次取最好,只用于归因,不作预算依据):oxfmt 100ms、oxlint 88ms、耦合断言 123ms。
三步相加 311ms 而整条 `check:quick` 要 0.80s——差额是 pnpm 逐层 `run` 派发(quick 内嵌 3 条脚本,
3 条脚本又各起一次 pnpm)与 4 次 node 冷启。因此「快速门禁 < 5s」这条预算的余量主要被脚本派发吃掉,
而不是被任何一个工具吃掉;将来若要再压,该压的是脚本层数,不是 oxfmt/oxlint。

`check:quick` 不含 `tsc -b`,因此上面这组数字与 dist 是否存在无关;冷 dist 态下 `check:quick` 同样
是 0.8s 量级。`check:types` 与 `check` 都以 `tsc -b` 起手,在已构建态上是增量的。

### 门禁的反例清单(每条都现做现验过)

反例一律落在真实的门禁脚本上,不另起夹具。两种落点:oxfmt/oxlint 的探针落**源码树**(按目录扫描,
必须是真实源文件才进视野),dependency-cruiser 的探针落**产物树**(dist 不入库,失败也不脏工作区)。

| 门禁 | 弄红的手法 | 门禁的输出 | 退出码 | 还原 |
|---|---|---|---|---|
| fmt | 写 `packages/schema/src/__fmt-probe.js`(未格式化) | `Format issues found in above 1 files` | 1 | `oxfmt` 改写后同一门禁 0 |
| lint | 写 `packages/schema/src/__lint-probe.js`(未用变量) | `error eslint(no-unused-vars)` | 1 | 同路径改写后 0 |
| lint | 写 `packages/schema/src/__lint-probe.ts`(`any`) | `error typescript(no-explicit-any)` | 1 | 同路径改 `unknown` 后 0 |
| check:deps | 写 `packages/runner/dist/__gate-probe.js` import engine | `error runner-must-not-depend-on-engine` | 2 | 删文件后 0 |
| check:deps | 写 `packages/engine/dist/__gate-probe.js` import `node:fs` | `error engine-runtime-only-allows-node-crypto` | 1 | 删文件后 0 |
| coupling | `node toolchain-coupling.ts 7.0.2 7.0.1003` | `工具版本耦合断言不通过 [版本配套]` | 1 | 传配套版本 0 |
| coupling | `node toolchain-coupling.ts 7.0.2 0.25.0` | `[版本号编码]` | 1 | 同上 |
| coupling | `node toolchain-coupling.ts ^7.0.0 7.0.2003` | `[typescript 精确锁版]` | 1 | 同上 |

`gates.test.ts` 里另有两条不属于上面这张表的:

- **巡航规模不为零**:`check:deps` 退出 0 的同时必须报告 `N modules, M dependencies cruised`
  且 N、M 都 > 5。depcruise 缺 TS 编译器时会静默跳过 `.ts`、报 0 modules 并 exit 0,
  这条断言是那条假门禁复发的唯一防线。
- **反递归不变量**:`vitest list --project unit` 的输出里不得出现 `gates.test.ts`。
  它一旦被 `unit` 收进去,`check` → 本文件 → `check` 就是无限套娃,而它只在有人手工跑 `check`
  时才发作,前面所有门禁全绿也拦不住。

### 与并行的 03 号票合并时需要注意

- `check:quick` 由本票创建(03 号票若也改它,需合并成「含双方检查」的一份)。
- 本票新增 `packages/tools/src/toolchain-coupling.ts` 与 `gates.test.ts`,**未改动 `packages/tools/src/index.ts`**,
  以避开 03 号票大概率也要动的那一个文件。
- `check:deps` 借道 `packages/runner/dist/` 与 `packages/engine/dist/` 注入反例(构建产物、不入库);
  03 号票的禁浮点校验器若要进 `check:quick`,注意不要与 coupling 重复调用。
