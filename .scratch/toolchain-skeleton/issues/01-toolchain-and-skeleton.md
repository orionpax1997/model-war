# 01: 工具链与骨架落地

**What to build:** 仓库能被一次装下、能编译、能跑起来。从零到可执行的完整路径:锁定的工具链装好并被钉死,六个包加一个工具包的拓扑就位且包间类型引用按 workspace exports 与 project references 解析,类型闸门在空壳上通过并被证明不是摆设,命令行产物可执行且未实现的子命令显式失败,数据目录占位使磁盘结构与设计文档的拓扑图一致,冻结脚本与对局产物的版本库边界清晰且有断言覆盖。工具链选型连同被否方案与版本耦合约束一并落成 ADR。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 一次安装装齐全部工具;依赖的构建脚本采用白名单,未列入者不执行
      → `pnpm-workspace.yaml` 顶层 `allowBuilds: { esbuild: true }`(pnpm 12 不再读 `package.json#pnpm`);`corepack pnpm install --frozen-lockfile` 退出 0
- [x] 全部工具锁定在可用的最新稳定版;影响对局复现的依赖精确锁版,其余由 lockfile 固定,CI 以 frozen-lockfile 安装
      → 精确:`typescript@7.0.2`、`quickjs-wasi@3.6.2`、`oxlint-tsgolint@7.0.2003`;其余 caret;`pnpm-lock.yaml` 入库
- [x] 类型定义与运行时的 Node 主版本匹配,不使用 dist-tag 的 latest
      → `@types/node: ^24.19.0`(latest 是 26.x)
- [x] 六个包(命令行 app + 五个库包)加一个工具包就位,每个包的包描述、导出形态与入口完整
      → `apps/cli` + `packages/{schema,replay,engine,runner,gen}` + `packages/tools`;每包一个真实可用的运行时导出
- [x] 包间类型引用经 workspace exports 与 project references 解析;既不使用 `paths`,也不使用已被 TypeScript 7 移除的 `baseUrl`
      → 全仓库无 `paths` / `baseUrl`;偏离原因与实测错误码见 `docs/adr/0002-toolchain.md`
- [x] 根 tsconfig 为 solution 形态且不吞掉全仓源码;各包的输出目录保持在包内
      → 根 `files: []` + 7 条 references;各包 `rootDir: src` / `outDir: dist`
- [x] 类型闸门在空壳上退出 0
      → `corepack pnpm run typecheck`(= `tsc -b --pretty false`)退出 0
- [x] 故意引入一处类型不匹配时类型闸门非零退出,还原后恢复 0(反例须现做现验,不留脚本)
      → 现做现验:把 `packages/runner/src/index.ts` 的 `fourSeatsAt` 返回元组第 4 位改成 `number` → `tsc -b` 退出 2 并报 TS2322 ×2,还原后退出 0;未留任何脚本
- [x] 命令行产物可执行,帮助信息列出六个子命令
      → `corepack pnpm --filter @model-war/cli run build`;`./apps/cli/dist/modelwar.mjs --help` 列出 `gen/run/match/replay/verify/map-lint`
- [x] 调用尚未实现的子命令显式失败(非零退出),不静默成功
      → 六个子命令当前全部退出 1,stderr 报「未实现——<包> 尚未导出 <符号>」
- [x] 数据目录占位使磁盘结构与设计文档的拓扑图一致
      → `benchmarks/`、`prompts/`、`rulesets/`、`maps/`、`docs/rules-v1/`、`archive/`、`runs/` 各带 `.gitkeep`(只放目录,不造取值)
- [x] 冻结脚本未被忽略、对局运行产物被忽略,且有 git 层断言覆盖这两条边界
      → `.gitignore` 的 `runs/**` + `!runs/.gitkeep`;`packages/tools/src/version-control-boundary.test.ts` 用 `git check-ignore --no-index` 两个方向都断言
- [x] ADR 记录:锁定版本表、被否方案(含「并装 TypeScript 6.x 以取回编程 API」「等待格式化工具 1.0」「接入 CI/CD」)、以及不使用 `paths` 的实测错误码与成因
      → `docs/adr/0002-toolchain.md`
