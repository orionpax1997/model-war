# 05: `season.yaml` 契约与装载

**What to build:** 赛季配置的形状与加载器。`season.yaml` 声明:根种子 `masterSeed`、唯一 `ruleset` 版本、种子数 K、参赛存档引用列表;可选并发度、`rankPoints`、地图池、输出目录。加载器用 zod 校验并给出清晰报错;配一份 `season.example.yaml` 作格式范例,且与本赛季 5 条参赛模型一致。**schema 真源只在 runner 一处**,hld / srs / gdd 只写字段意图不复制细节。

**Blocked by:** None(can start immediately)

**Status:** resolved

- [x] 必填 `masterSeed` / `ruleset` / `seeds(K)` / 参赛存档引用列表;选填 `concurrency`(默认 `min(cpus, 8)`)/ `rankPoints`(默认 `[3,2,1,0]`)/ `maps` / `outputDir`(默认 `runs/<新 runId>`)。
- [x] 校验:缺必填、类型错、`M×K` 不满足均摊条件、参赛者少于 4、引用了不存在的存档 → 各自清晰报错。
- [x] `season.example.yaml` 能被加载器读通,并与本赛季 5 条参赛集一致。
- [x] `rankPoints` 的默认与「不进 `rulesets/`」在本票固化。

## Answer

### 落点 / 文件

| 文件 | 内容 |
|---|---|
| `packages/runner/src/season-config.ts`(新) | `SeasonConfig` 类型 + 纯装载器 `loadSeasonConfig(filePath)` + 手写逐字段汇总校验 |
| `packages/runner/src/yaml-lite.ts`(新) | runner 私有的 YAML 子集读取器;正文与 `packages/gen/src/yaml-lite.ts` **逐字相同**(见「裁决 2」) |
| `packages/runner/src/season-config.test.ts`(新) | 19 例,照 `packages/gen/src/config.test.ts` 的形态(临时目录 + `toThrow(/正则/s)` + 一次看完 + 可选键非 undefined 键) |
| `packages/runner/src/yaml-lite.test.ts`(新) | 复制 gen 的 7 例 |
| `season.example.yaml`(新,仓库根) | 格式范例,写死本赛季 5 条参赛集 |
| `packages/runner/src/index.ts`(改) | `export * from "./season-config.js";` + 头注同步 |
| `packages/runner/src/ranker.ts`(改) | 把 `rankPoints` 校验抽成导出 `rankPointsIssue`(`rankSeason` 内部照用),供装载器复用同一处判据,不新开第二条校验栈 |

### 裁决 1 —— 不引 zod,手写逐字段汇总

理由:全仓零 zod、零 YAML 库;唯一的运行时第三方依赖是 `apps/cli` 的 `ajv`,而校验器只有一处(ADR-0003「校验栈只有一份」);`models.yaml` 的既有惯例(`packages/gen/src/config.ts`)正是手写逐字段汇总。故照抄其风格:先收集 `issues[]`,末尾一次抛 `赛季配置无效(<path>):\n  - …`,改配置的人可「一次看完」。**未改 `packages/runner/package.json`、未 `pnpm install`。**

### 裁决 2 —— YAML:runner 私有第二份(方案 a)+ 块序列范例

- `runner` 不得 import `gen`(spec《模块与接口》明写 `runner → schema` 单向、不新增 `runner → gen` 的边),`schema` 又被 ADR-0003 / hld §3.1 限定为「无运行时代码」,故 `yaml-lite` 只能由 runner 自带一份。复制 gen 的 `parseYamlSubset`(`source, filePath)` 签名、错误文案、受支持子集逐字相同),头注写明「为什么存在第二份」,便于日后 diff / 将来抽取。
- gen 那份**拒绝非空流式序列**(`[3, 2, 1, 0]`)。因此 `season.example.yaml` 的 `rankPoints` / `maps` 一律写**块序列**(多行 `- x`),不使用 spec 范例里的内联流式形态;这条已写进 example 的头注。

### 接口

```ts
type SeasonConfig = {
  masterSeed: string;                 // 必填
  ruleset: RulesetVersion;            // 必填,须 === RULESET_VERSION("v1")
  seeds: number;                      // 必填,K,≥1 整数
  participants: readonly string[];    // 必填,archive/<slug>/<runId>,下标即 playerIndex,≥4 条
  concurrency?: number;               // 选填,≥1 整数;默认 min(cpus, 8) 由调用方注入
  rankPoints?: RankPoints;            // 选填;默认 DEFAULT_RANK_POINTS = [3, 2, 1, 0]
  maps?: readonly string[];           // 选填;默认 maps/ 下全部,由调用方注入
  outputDir?: string;                 // 选填;默认 runs/<新 runId>,由调用方注入
};
loadSeasonConfig(filePath: string): SeasonConfig;
```

**装载器是纯函数**:不碰时钟、不看 `cpus()`、不探 `maps/`、不读 `root`。凡依赖环境才能定的默认值(`concurrency` / `maps` / `outputDir` / `rankPoints`)一律由薄壳 `runSeason` 注入,这点写死进 JSDoc。可选字段**缺席即不落键**(`Object.hasOwn` 为 false),把「没写」与「写了 undefined」分开。

### 校验 / 错误(聚合,一次看完)

- 读不到文件 → `读不到赛季配置 <path>:<reason>`;YAML 语法错 → `赛季配置 YAML 解析失败(<path>):<reason>`;顶层非映射 → `顶层必须是一个键值对映射…`。
- 缺 `masterSeed` / `ruleset` / `seeds` / `participants` → 逐字段点名;类型 / 取值域不符逐条给出。
- `ruleset` ≠ 当前版本 → 明确报错(带实际取值与期望版本)。
- `participants` 少于 4 条 / 非数组 / 含非字符串项 → 报错(带下标)。
- **显式给出 `maps`** 且 `M × K ≢ 0 (mod 4)` → 报错(带 M、K、mod 余数)。
- `rankPoints` 长度 ≠ 4 / 非有限数 → 报错(判据复用 `./ranker.js` 的 `rankPointsIssue`,不重复实现)。

### 两处「留给别的票」

- **存档存在性**:校验引用是否存在需要 `root`,纯装载器不接;按 spec 交由**票 06 的装载期检查**(连规则版本三处一致一起)。本票只校验形状与取值域。
- **缺省 `maps` 时的均摊条件**:M 未知,装载器判不了 `M × K`;缺省 maps 的兜底由 `enumerateMatchUps` 在枚举期负责。已写进 JSDoc 并有测试钉住(缺省 maps + K=3 不误报)。

### 验收对照

- 字段 / 默认语义见上表;`rankPoints` 默认 = `DEFAULT_RANK_POINTS`(`[3, 2, 1, 0]`)且**不进 `rulesets/`** —— 测试同时断言 `DEFAULT_RANK_POINTS` 的值与 `rulesets/v1.json` 不含 `rankPoints`。
- `season.example.yaml` 经 `loadSeasonConfig` 读通;`participants` = 本赛季 5 条(`archive/deepseek-v4-flash/2026-10-08T05-12-42-057Z` 为本季唯一实有存档,其余四条为 `archive/<slug>/<runId>` 占位);M=3、K=4、12 ≡ 0 (mod 4)。
- 各条清晰报错(缺必填 / 类型错 / `M×K` / 少于 4 / `rankPoints` 长度或非有限):测试逐条覆盖。

### 验证

- `pnpm run check:quick` ✅(fmt / lint / coupling / coupling:quickjs / no-float / budget 全绿)
- `pnpm vitest run --project unit --project property packages/runner` ✅ 55 passed

### 给票 10(文档收口)的精确措辞

1. **hld §8.1 第一条 bullet**(「输入:`season.yaml`(参赛脚本存档目录列表、地图池、种子数 K、并发度、ruleset 版本)。」)句尾追加:
   > (`season.yaml` 的字段、取值域与默认值的真源 = `packages/runner/src/season-config.ts` 的 `SeasonConfig` / `loadSeasonConfig`;本节只写字段意图,不复制细节。)
2. **hld §9 CLI 表 `modelwar run` 行**的「说明」列由「整轮赛季 + 报告」改为:
   > 整轮赛季 + 报告;根目录解析同 `gen` / `match`(默认 cwd),`--config` 相对根;`season.yaml` 字段真源见 `packages/runner/src/season-config.ts`。
3. **(与票 03 遗留的同一处矛盾)hld §8.1** 现文「不满足时各座位的对局数最多差 1,差额落在同一相对位次——该残留不对称由 §12 的座位胜率统计验证,不做逐座位校正」与票 03/本票的**硬错误**口径冲突,应改为:
   > **精确均摊要求 `M × K ≡ 0 (mod 4)`**;不满足时直接报错(不静默产生偏移清单)。
