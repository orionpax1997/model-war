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

### 已知缺口

`packages/tools` 以源码形态执行(`emitDeclarationOnly`,dist 里没有 `.js`),
因此**不在依赖门的巡航范围内**;它的第三方依赖面由「pnpm 隔离 node_modules + `tsc -b` 的 TS2307」兜住,
但 `node:*` 禁令对它暂不生效。

### 与并行的 03 号票合并时需要注意

- `check:quick` 由本票创建(03 号票若也改它,需合并成「含双方检查」的一份)。
- 本票新增 `packages/tools/src/toolchain-coupling.ts` 与 `gates.test.ts`,**未改动 `packages/tools/src/index.ts`**,
  以避开 03 号票大概率也要动的那一个文件。
- `check:deps` 借道 `packages/runner/dist/` 注入反例(构建产物、不入库);
  03 号票的禁浮点校验器若要进 `check:quick`,注意不要与 coupling 重复调用。
