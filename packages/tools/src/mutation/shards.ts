/**
 * 变异分片清单:一个分片一行,记录**接线**(配置文件 ↔ 入口脚本 ↔ 入库基线 ↔ 报告路径)。
 *
 * ── 这里不是分片名的真源 ────────────────────────────────────────────────────
 * 分片名、mutate 范围与 testFiles 的真源是 `stryker/*.mjs`(一文件 = 一次 `stryker run`),
 * 分片名就写在每份配置的 `name:` 里,它同时决定报告路径(`stryker/base.mjs` 的 `fragment`)。
 * 这份清单只补三样配置里没有的东西:入口脚本名、入库基线的位置、默认去读哪份报告。
 * 两份真源会不会漂?由 `gates.test.ts` 的「Stryker 分片清单与配置同名」那条盯着:
 * 配置里的 `name:` 集合与这份清单必须逐个相等,少一片、多一片、改一个名都当场红。
 *
 * ── 为什么基线的家在 `stryker/baseline/` 而不是 `reports/` ────────────────────
 * `reports/` 是观测产物,整目录被 `.gitignore` 忽略;而基线是棘轮的组成部分,不是产物
 * (ADR-0026:「不入库的棘轮不是棘轮」)。放在分片配置旁边,是因为「哪一个分片的基线」
 * 这件事与「哪一个分片的配置」是同一个问题。
 *
 * ── 为什么 `engine-processor` 的入口脚本叫 `mutate` ────────────────────────
 * 它是分片改造之前的默认分片,`pnpm run mutate` 与夜间链一直走它;
 * `stryker.config.mjs` 至今只是转发到 `stryker/engine-processor.mjs`。
 * 于是这个分片的入口就是 `mutate`——不另立一个同内容的 `mutate:engine:processor`,
 * 同一个作用域有两条入口是又一处会漂的真源。
 *
 * ── 未播种的分片 ──────────────────────────────────────────────────────────
 * `engine` 与 `gen` 两片现在**没有**基线文件(没有覆盖各自 `mutate` 范围的真实报告,
 * 拿单文件标定跑的数字冒充整片是错的)。它们的 `baseline` 路径照旧写在这里——那是「播种后会落在哪」。
 * 缺文件 = 棘轮报「首次」不判红;人类可读的说明在 `stryker/baseline/README.md`,
 * 门禁自测(`gates.test.ts`)盯着「列在 `UNSEEDED_SHARDS` 里的分片确实没有基线文件」这一条。
 */

/** 一个分片的接线。路径一律是仓库根相对路径(门禁按仓库根解析)。 */
export type MutationShard = {
  /** 分片名。必须与 `stryker/<config>` 里的 `name:` 逐字相等。 */
  readonly name: string;
  /** 分片配置(仓库根相对路径)。 */
  readonly config: string;
  /** `package.json` 里的入口脚本名;它跑完变异后必须串上棘轮门禁。 */
  readonly script: string;
  /** 入库基线的落点。缺这个文件 = 该分片首次运行(不判红),见文件头注「未播种的分片」。 */
  readonly baseline: string;
  /** 默认读的报告。报告不入库(`reports/` 被忽略),所以它只是「这一次」的落盘点。 */
  readonly report: string;
};

/** 12 个分片,与 `stryker/*.mjs`(不含共享底座 `base.mjs`)一一对应。 */
export const MUTATION_SHARDS: readonly MutationShard[] = [
  {
    name: "engine",
    config: "stryker/engine.mjs",
    script: "mutate:engine",
    baseline: "stryker/baseline/engine.json",
    report: "reports/mutation/engine.json",
  },
  {
    name: "engine-core",
    config: "stryker/engine-core.mjs",
    script: "mutate:engine:core",
    baseline: "stryker/baseline/engine-core.json",
    report: "reports/mutation/engine-core.json",
  },
  {
    name: "engine-processor",
    config: "stryker/engine-processor.mjs",
    script: "mutate",
    baseline: "stryker/baseline/engine-processor.json",
    report: "reports/mutation/engine-processor.json",
  },
  {
    name: "engine-runtime",
    config: "stryker/engine-runtime.mjs",
    script: "mutate:engine:runtime",
    baseline: "stryker/baseline/engine-runtime.json",
    report: "reports/mutation/engine-runtime.json",
  },
  {
    name: "gen",
    config: "stryker/gen.mjs",
    script: "mutate:gen",
    baseline: "stryker/baseline/gen.json",
    report: "reports/mutation/gen.json",
  },
  {
    name: "gen-core",
    config: "stryker/gen-core.mjs",
    script: "mutate:gen:core",
    baseline: "stryker/baseline/gen-core.json",
    report: "reports/mutation/gen-core.json",
  },
  {
    name: "gen-io",
    config: "stryker/gen-io.mjs",
    script: "mutate:gen:io",
    baseline: "stryker/baseline/gen-io.json",
    report: "reports/mutation/gen-io.json",
  },
  {
    name: "gen-pipeline",
    config: "stryker/gen-pipeline.mjs",
    script: "mutate:gen:pipeline",
    baseline: "stryker/baseline/gen-pipeline.json",
    report: "reports/mutation/gen-pipeline.json",
  },
  {
    name: "replay",
    config: "stryker/replay.mjs",
    script: "mutate:replay",
    baseline: "stryker/baseline/replay.json",
    report: "reports/mutation/replay.json",
  },
  {
    name: "runner",
    config: "stryker/runner.mjs",
    script: "mutate:runner",
    baseline: "stryker/baseline/runner.json",
    report: "reports/mutation/runner.json",
  },
  {
    name: "schema",
    config: "stryker/schema.mjs",
    script: "mutate:schema",
    baseline: "stryker/baseline/schema.json",
    report: "reports/mutation/schema.json",
  },
  {
    name: "tools",
    config: "stryker/tools.mjs",
    script: "mutate:tools",
    baseline: "stryker/baseline/tools.json",
    report: "reports/mutation/tools.json",
  },
];

/** 按名字查分片;不认识的返回 `undefined`,由门禁入口判红(拼错分片名不能当成「首次」)。 */
export const shardByName = (name: string): MutationShard | undefined =>
  MUTATION_SHARDS.find((shard) => shard.name === name);

/** 全部分片名,按清单顺序。门禁入口用它把「不认识的分片」说得具体一点。 */
export const shardNames = (): readonly string[] => MUTATION_SHARDS.map((shard) => shard.name);
