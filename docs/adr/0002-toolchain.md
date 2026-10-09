---
status: superseded by ADR-0010
---

# 工具链:pnpm 12 + TypeScript 7 + oxc 三件套,包间类型引用走 exports + project references

工具链一次装齐并钉死,类型闸门只有一条命令(`tsc -b`,从仓库根跑),格式与 lint 统一走 oxc,不引入 ESLint/Prettier。版本一律取**可用的最新稳定版**,只对影响对局复现的三项精确锁版,其余走 caret 并由 lockfile 固定。相对 hld §2.2.2 有一处有意偏离:**包间类型引用不用 tsconfig `paths`**,改为 workspace `exports` 的 `types` 条件 + TypeScript project references(实测错误码见下)。全仓库遵守"可擦除语法"(禁 `enum`/`namespace`/参数属性),因为工具包以源码形式由 Node 的类型擦除直接执行。门禁以命名 npm 脚本手工触发,**不建 CI/CD**。门禁脚本本身分三层落地(hld §2.2.7),本 ADR 只记选型与被否方案。

## 锁定版本

装在根 `devDependencies`;包管理器版本由 `packageManager` 字段钉死。

| 工具 | 版本 | 约束 | 备注 |
|---|---|---|---|
| pnpm | 12.8.1 | `packageManager` 精确 | 构建脚本白名单在本仓库的 `pnpm-workspace.yaml` 顶层 `allowBuilds` |
| typescript | 7.0.2 | **精确锁版** | 影响复现:冻结脚本的编译产物由它产出。`bin` 是 `tsc`;`tsgo` 是 nightly 包 `@typescript/native-preview` 的名字,已取消 |
| quickjs-wasi | 3.6.2 | **精确锁版** | 影响复现:沙箱运行时。锁版理由见 [0001](./0001-sandbox-quickjs-wasi.md) |
| oxlint-tsgolint | 7.0.2003 | **精确锁版** | 随 TypeScript 主版本走,二者须同时升级。该包提供 `tsgolint` 二进制,但其独立 CLI 入口不受支持,类型感知 lint 走 `oxlint --type-aware` |
| oxlint | ^1.86.0 | caret + lockfile | |
| oxfmt | ^0.71.0 | caret + lockfile | 0.x 风险见下 |
| oxc-parser | ^0.152.0 | caret + lockfile | 静态校验器(工具包)的解析层 |
| vitest | ^5.0.3 | caret + lockfile | |
| fast-check | ^4.10.2 | caret + lockfile | |
| ajv | ^8.20.0 | caret + lockfile | 数据格式校验 |
| dependency-cruiser | ^18.4.0 | caret + lockfile | |
| esbuild | ^0.28.2 | caret + lockfile | **唯一需要执行构建脚本的依赖**(它的 `postinstall` 才把原生二进制装到位),列进 `allowBuilds` |
| @types/node | ^24.19.0 | caret,**必须锁在 24.x** | 类型定义随运行时 Node 主版本走;`latest` dist-tag 指向 26.x,取它会让 Node 24 的 API 面凭空多出一截 |
| Node | ≥ 22.18.0 | `engines` | 22.18 是 Node 22 LTS 里默认开启 type stripping 的第一个版本,`packages/tools` 直接跑源码依赖这一点 |

两条实测出来的操作事实,写在这里免得下次再踩:

- **构建脚本白名单在 `pnpm-workspace.yaml`,不在 `package.json#pnpm`**。pnpm 12 里 `onlyBuiltDependencies` 自 v11 起不再被读取,写在那里只会得到一条 WARN;`pnpm approve-builds` 写的是顶层 `allowBuilds: { <pkg>: true }`。默认 `strictDepBuilds`,未列入白名单的依赖有构建脚本会让安装以非零码退出(不是静默跳过)。
- **pnpm 12 内置 `minimumReleaseAge: 1440`(24h)并对 lockfile 重新校验**。`vitest@5.0.3` 发布于 2026-09-30T11:30Z,当时未满 24h,`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 会拦住安装;豁免写在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`(按版本号限定,最窄),该文件里有它可删的时点。

**Stryker 不装**。变异测试在本 feature 之外,配置随引擎结算管线落地(hld §2.2.4);先装一个没有配置、也没有被任何脚本调用的 Stryker,只会让人以为这条门禁存在。

## 偏离:包间类型引用不用 `paths`

hld §2.2.2 写的是"project references + `paths`"。本仓库**只保留 project references**,`paths` 一处不写,类型解析走 pnpm workspace 软链 + `exports` 的 `types` 条件。实测矩阵(在 `packages/engine` 上改配置后跑 `tsc -b --force`):

| 形状 | `tsc -b` 结果 |
|---|---|
| `exports` + project references(**采用**) | 退出 0 |
| `paths` 直指包源码,**且**保留 project reference | 退出 0——但源码路径被重定向到对方的 `.d.ts` 产物,`paths` 沦为一条与 `exports` 重复解析同一模块的映射 |
| `paths` 直指包源码,**无** project reference | TS6059 + TS6307 |
| `tsc -p packages/engine`(replay 未构建) | TS2307 |

第三行的原始输出(`<repo>` 是仓库根的省略,其余逐字照抄):

```
packages/engine/src/index.ts(10,29): error TS6059: File '<repo>/packages/replay/src/index.ts' is not under 'rootDir' '<repo>/packages/engine/src'. 'rootDir' is expected to contain all source files.
  The file is in the program because:
    Imported via "@model-war/replay" from file '<repo>/packages/engine/src/index.ts'
    Imported via "@model-war/replay" from file '<repo>/packages/engine/src/replay-tick-line.test.ts'
  File is ECMAScript module because '<repo>/packages/replay/package.json' has field "type" with value "module"
packages/engine/src/index.ts(10,29): error TS6307: File '<repo>/packages/replay/src/index.ts' is not listed within the file list of project '<repo>/packages/engine/tsconfig.json'. Projects must list all files or use an 'include' pattern.
  The file is in the program because:
    Imported via "@model-war/replay" from file '<repo>/packages/engine/src/index.ts'
    Imported via "@model-war/replay" from file '<repo>/packages/engine/src/replay-tick-line.test.ts'
  File is ECMAScript module because '<repo>/packages/replay/package.json' has field "type" with value "module"
```

第四行:

```
packages/engine/src/index.ts(10,29): error TS2307: Cannot find module '@model-war/replay' or its corresponding type declarations.
```

成因,两条:

1. 没有 project reference 时,`paths` 解析到的包源码会被并进引用方的 program——于是它既在引用方 `rootDir` 之外,也不在它的 include 列表里(TS6059 与 TS6307 同时报),而且产物还会被发到错误的位置(实测那四个文件落到了 `packages/replay/src/index.js` 一侧,而不是任何包的 `dist/`)。有 project reference 时这条路径被重定向到产物,`paths` 不再有任何增量,却让同一个模块多出一条解析路径;`paths` 与 `exports` 同时解析同一模块,正是 pnpm 软链布局下类型声明不可移植(TS2883 一类问题)的成因。
2. TypeScript 7 不对裸包名做"产物缺失就回退到源码"的兜底,依赖未构建时直接 TS2307。**`tsc -b`(从根)是唯一的类型闸门命令**,没有第二条;`tsc -b --noEmit` 也不行——被引用项目不得禁用 emit,实测 `TS6310: Referenced project '…/packages/schema' may not disable emit.`(注意这条只在真的要构建时才报:树已是最新时 `tsc -b --noEmit` 会静默返回 0,别据此以为它能用)。

「禁用 `baseUrl`」的原结论不变,只是理由更硬了:TypeScript 7 已把它移除(TS5102),连写都写不进去。

## Considered Options

- **并装 TypeScript 6.x 以取回编程 API**:否——TS 7 不含编程 API(读 AST / 改写代码的能力),但本仓库**没有一处需要读自己的 AST**:静态校验交给 `oxc-parser`(oxc 自己的 parser,自带 AST),lint 交给 oxlint,类型分析交给 `tsgolint`。为一个用不到的能力长期背一份第二编译器,等于让"用哪个 tsc 编译冻结脚本"变成一个每次都要回答的问题——而那条链路恰恰要求唯一版本(`script.js` 的 sha256 入存档 meta,hld §7.4)。真出现读 AST 的需求,先把它写成独立的一次性脚本,再评估要不要引第二编译器。
- **等待格式化工具 1.0**:否——官方声称 JS/TS 已 100% 通过 Prettier conformance,真正未兑现的只是 1.0 尚未发布;这由精确锁版 + `oxfmt --check` 门禁兜住。为一个尚未发生的事件长期支付格式化耗时(oxfmt 慢于 Prettier)不划算,且 hld §2.2.3 那条"退化为 Prettier"的退路一旦写下来就会变成事实上的默认选项。0.x 期间**不设降级退路**;1.0 发布后按常规 caret 升级。
- **接入 CI/CD**:否——门禁以命名脚本手工触发就够,流水线的形态与仓库首个真实实现强相关,现在定下来只会写一份需要重写的配置。CI 环境无网络、无模型 API、无凭证这条约束(hld §2.2.7)也随之推迟到真有流水线时再兑现。
- **各包 `bin`**:否——hld §3.2 规定唯一 bin 在 `apps/cli`。工具包以 `node packages/tools/src/<entry>.ts` 的方式被门禁脚本直接调用,不占 bin 位。
- **工具包产出 dist**:否——它是被执行的工具,不是被导入的库。`exports` 指向 `./src/index.ts`,Node 的类型擦除直接跑源码;代价是全仓库语法必须可擦除,由基座的 `erasableSyntaxOnly` 兜住(见 Consequences)。

## Consequences

- **全仓库可擦除语法**,由 `erasableSyntaxOnly` 机械保证。实测两侧都会拦:`tsc` 报 `error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.`,Node 报 `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode`。状态模型一类要进回放的结构必须用 `type` 而非 `interface` 声明——`interface` 没有隐式索引签名,不能赋给 schema 的 `JsonValue`。
- **TypeScript 7 的两个默认值会咬人**:`types` 默认 `[]`(`@types/node` 不再自动带入),`rootDir` 默认配置目录。共享基座统一写 `"types": ["node"]`,各包显式写 `"rootDir": "src"`,两者都不靠记忆。
- **`exports` 必须自带 `types` 条件**:一旦存在 `exports`,顶层 `types` 字段对解析就被忽略(`.d.ts` 不与 `.js` 同级时实测 TS7016:顶层 `types` 与 `exports.types` 都没有,模块被当成隐式 any)。本仓库 dist/ 里 `.js` 与 `.d.ts` 同级,当前不会因此报错——但显式条件是双保险,去掉它就等于依赖布局巧合。每个包都写 `{ "types": "./dist/index.d.ts", "default": "./dist/index.js" }`,顶层 `types` 只留给不读 `exports` 的工具。
- **工具包是 referenced project,必须产出**:`tsc -b --noEmit` 对被引用项目禁用(TS6310),而根 tsconfig 又是 solution 形态、必须引用每个包。折中:工具包 `emitDeclarationOnly`,只往包内 `dist/` 写 `.d.ts`(已 gitignore),运行时面仍是 `./src/index.ts`。那份 `.d.ts` 只服务于 composite 构建,没人解析它、没人发布它。
- **tsgolint 与 TypeScript 的版本耦合没有任何工具替你检查**。oxlint 的 peer 只保证 tsgolint 的下界,不比对 TypeScript 版本;错位是静默的。由门禁脚本显式断言承担。
- **门禁是命名脚本 + 手工触发**,分快速 / 带类型感知 / 全量三层;每道门禁都要有一个能被弄红的反例,否则不知道它是不是摆设。
- **升级工具链的顺序**:`typescript` 与 `oxlint-tsgolint` 同时升;升 `quickjs-wasi` 必须重跑沙箱行为复测(见 [0001](./0001-sandbox-quickjs-wasi.md))。在那条实现在沙箱 ticket 落地之前,这个条款还没有可执行的东西支撑它——这一点是已知并被接受的。
