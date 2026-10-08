# 06: 第一场端到端赛季(fixture,串行)

**What to build:** `modelwar run --config season.yaml` 第一次真的跑起来——在 fixture 根上把一整轮赛季串行跑通(零并发)。这一票走通整条窄路:读 `season.yaml` → 枚举对局 → 逐局把输入**物化**成 `input.json` → spawn 一个 `modelwar match <input.json>` 子进程执行该局 → 读回放末行拿到名次 → 产出**最小** `report.json`(每局的输入引用 + 结果)。同时把 `run` 子命令接到真实处理器,并从 CLI 的「未实现」名单里移除 `run`。赛季启动即做**规则版本前置拒绝**:任一存档的 `meta.ruleset` 与赛季声明不一致 → 报错退出,而不是在报告里分版本分节。

**Blocked by:** 02(读回放末行取名次)、03(对局枚举与座位)、05(赛季配置装载)

**Status:** resolved

- [x] `modelwar run` 退出码 0 并产出最小 `report.json`(每局输入引用 + 结果),不再打印「未实现」;CLI 的未实现名单里不再含 `run`。
- [x] 每局 `input.json` 的键集**恰为**对局输入的五项(存档引用 / 地图 / 地图 hash / ruleset / 种子),多一个赛季字段即被自查拒绝;座位由存档引用列表的下标承载。
- [x] 每局目录按 `<组合>-<地图>-<种子>` 确定性命名;种子由 `masterSeed` 确定性派生并写进 `input.json`,使任意一局可独立复算。
- [x] 规则版本不一致 → 退出码 1 报错退出(复用 FR-10 AC2 的拒跑口径),复用既有存档校验路径、不另写。
- [x] fixture 赛季全程**不联网、不需凭证**,可进 CI。

## Answer

### 落点 / 文件

| 文件 | 内容 |
|---|---|
| `packages/runner/src/scheduler.ts`(新) | `scheduleSeason`(可测核心)+ `runSeason`(CLI 薄壳处理器)+ `parseRunArgs` + 默认 `spawnMatchProcess`;物化 `input.json`、`readResult`、`findRulesetMismatch`、`defaultMapPool`、报告写出 |
| `packages/runner/src/enumerate.ts`(新) | 把原住在 `index.ts` 的枚举主体(`MatchUp` / `EnumerateMatchUpsOptions` / `enumerateMatchUps` / `deriveSeed` / `rotateSeats`)**原样搬到这里**——唯一目的是拆掉 `index → scheduler → index` 的包内环(depcruise `no-circular`);枚举仍只此一处 |
| `packages/runner/src/index.ts`(改) | 收成纯再导出 barrel(`enumerate` / `ranker` / `season-config` / `scheduler`),头注同步 |
| `packages/runner/src/scheduler.test.ts`(新) | 3 例:串行跑通整季(键集恰 5 项 + 目录命名确定 + 报告内容)、规则版本前置拒绝退 1、非零退出码分流(1/4 透出、2/3 暂退 1) |
| `apps/cli/src/commands.ts`(改) | `run` 的 `usage` 补 `[--root <仓库根>]`(与 `gen` 同款) |
| `apps/cli/src/cli.test.ts`(改) | 删 `UNIMPLEMENTED = ["run"]` 及其 `it.each`;补 `run --help` 含 `--config`、`run` 缺 `--config` 非零;新增 fixture 赛季 e2e(退 0 + `report.json` + 每局 `input.json` 键集恰 5 项 + 目录命名确定)与规则版本不一致 e2e(退 1、不物化) |

### 关键设计裁决

1. **bin 路径可注入(§9)**:`runSeason(args)` 是薄壳——解析 `--config` / `--root`、`root = resolve(rootArg ?? cwd)`、注入 `binPath = process.argv[1]` 与真实 `spawnMatch(process.execPath, [binPath, "match", inputPath, "--root", root])`,调可测的 `scheduleSeason(options, deps)`。单测经 `deps.spawnMatch` 桩注入,不依赖真实 CLI 路径(在 vitest 里 `argv[1]` 是 vitest 自身)。
2. **`run` 不加载 `.env`**:与 `gen` 的唯一差别(`run` 不联网、不需凭证,spec 明写)。`--config` 相对 `root`;`run` 不接受位置参数。
3. **`input.json` 键序即契约序**:`archives` / `map` / `mapSha256` / `seed` / `ruleset`,序列化前自查键集恰为五项(多一个赛季字段即抛)。`sha256Hex` / `runIdOf` 在 runner 内各留一份私有实现(不 import gen,不新增包边)。地图哈希取 `maps/<map>.json` 原始字节。
4. **规则版本隔离 = 前置拒绝**:逐参赛者读 `<root>/<archivePath>/meta.json` 的 `ruleset` 一个字段,任一不等于赛季声明 → stderr + 退 1,**先于任何物化与子进程**。完整校验(逐座位哈希 / 缺档 / 规则集三处一致)仍由 `match` 子进程装载段承担(runner 拿不到 `apps/cli` 的 ajv 校验栈),本文件只做「前置拒绝」那一道。
5. **串行 + 只认退出码**:`for … of await` 逐局 spawn;子进程成败只看退出码,不解析 stdout。票 06 的最小口径——码 0 读回放末行 `result` 入报告;码 `1` / `4` 原样透出(赛季级失败);码 `2` / `3` 的重跑/剔除归票 07,这里先按赛季中止退 1,**绝不静默忽略非零**(代码里 `TODO(票 07)` 标出后续三段)。
6. **枚举拆分**:枚举主体从 `index.ts` 搬到 `enumerate.ts`,避免 `index → scheduler → index` 的包内环;`index.ts` 改纯再导出,`enumerate-match-ups.test.ts` 从 `./index.js` 导入的路径不变。

### 验证

- `pnpm run check:quick` 通过(fmt / lint / coupling / coupling:quickjs / no-float / budget)。
- `vitest run --project unit packages/runner apps/cli`:**217 passed**(runner 55 + cli 162),含 fixture 赛季 e2e(真沙箱 4 局串行,~13s)。
- `depcruise packages/runner/dist apps/cli/dist`:`no dependency violations found`(无环、无越界依赖)。

### 留给票 07 / 08 的接口

- 票 07:把 `scheduleSeason` 的串行循环换成并发池(`concurrency = season.concurrency ?? min(cpus, 8)`),把码 2/3 从「中止」改成「重跑一次 → 再触发进问题清单、排除出排名」,1/4 固定为赛季级中止;报告按 `comboId/mapIndex/seedIndex` 排序后再写(并发与串行逐字节一致)。
- 票 08:`report.json` 扩展为含每模型总分 / 有效局数 / 对局均分(接 `ranker`)与两份失败名单;本票的 `SeasonReport` 形状(minimal)随之扩展。
