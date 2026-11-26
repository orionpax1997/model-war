import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 门禁自测所在文件。它同时是两个 project 的拾取目标,这不是笔误:
 * 门禁自测 spawn 全量门禁 `check`,而 `check` 里含 `vitest run`——
 * 同一个文件一旦被 `unit` 收进去,`check` 就会把门禁自测再跑一遍,
 * 于是变成 check → gates.test → check → gates.test 的无限套娃(叉炸弹)。
 *
 * 因此下面两处(此处、unit 的 exclude)必须引用同一个常量:谁把它改成字面量,
 * 两边就可能悄悄分叉,而分叉的后果是 `check` 把机器跑挂。
 * gates.test.ts 自身有一条用例(`gates 不在 unit 的拾取范围里`)盯着这条不变量。
 *
 * `gates-slow.test.ts` 拿的是同一张牌:它同样 spawn `check`,所以同样必须被 unit 排除
 * (SLOW_TEST 常量),只不过它多一层理由——它要 ~6 分钟,连默认 `test` 也不该带上它。
 * `agent-real-session.test.ts` 拿的是第三张:它真起 bwrap,而常跑链不装 bubblewrap——
 * 收进 `unit` 的后果是「全量门禁红了」同时意味着「提交内容有问题」与「这台机器没装
 * bubblewrap」,两种处方混成一条红。它的入口是命名脚本 `verify:kernel`,而同一套断言在
 * unit 里有假执行器的那一份(`apps/cli/src/agent-session-archive.test.ts`)。
 *
 * 三个常量都是「这里与 unit 的 exclude 引用同一份」的形状:改成字面量就会各自漂。
 */
const GATES_TEST = "packages/tools/src/gates.test.ts";

/** 门禁自测里慢的那一半:契约自证的四问与三个反例。见该文件的头注。 */
const SLOW_TEST = "packages/tools/src/gates-slow.test.ts";

/**
 * 变异棘轮的**真跑**那一半:跑一次 `mutate:replay` 验 `stryker/baseline/replay.json` 的字节不变。
 *
 * 它从前在 `gates.test.ts` 里,是本族最贵的一条(约 50s)——于是改 `packages/tools` 任何文件都
 * 要为一颗“只有改 `stryker/**` 才更新”的信息付 50s。单独一个 project 之后,它由
 * `change-radius.ts` 的半径指名(`test:mutation`),nightly 也单独跑一腿。
 */
const MUTATION_TEST = "packages/tools/src/gates-mutation.test.ts";

/** 真 bwrap 下的真会话:要内核能力(非特权 user namespace)与系统装的 bubblewrap。 */
const SANDBOX_TEST = "apps/cli/src/agent-real-session.test.ts";

/**
 * 真 bwrap 下的 CLI 冒烟:spawn 打好的 CLI 产物、假端点、**真沙箱**跑满一整张网格。
 *
 * 归 `sandbox` 而不是 `unit` 的理由与上面那条相同,只是它更晚才被抓出来:它一直以
 * `it.skipIf(!archivePresent)` 挂在 unit 上,而 `archive/` 不入库——没有冻档的机器上它是 skip,
 * 于是「它其实要真 bwrap」这件事既没被看到也没被挡住。内核探针(`vitest.kernel-guard.setup.ts`)
 * 落地后第一例就是它。
 */
const GEN_CLI_TEST = "apps/cli/src/gen-cli.test.ts";

/**
 * 进程级 e2e:**spawn 打好的 CLI 单文件产物**,跑真链路(真规则集、真 quickjs-wasi、真回放)。
 *
 * 它们不进 `unit` 的理由**不是环境**(不需要 bwrap,CI 上照跑),是**成本**:每一条都要起
 * 一个子进程、跑满 600 tick。而 `unit` 是编辑循环里被反复调用的那一档,让每次业务改动都付这
 * 200s 的账,代价是 agent 会开始"写完一起跑"(反馈回路断掉,与 `gate:types` 不进 `verify`
 * 是同一条理由)。
 *
 * 它们证的是"整条链路在一条命令行里成立",这个性质**只有这些用例能证**——所以是分层,不是删除:
 * 默认 `test` 不含它们,`test:e2e` 单独跑,`verify` 用 `test:all` 一次跑全(并行不丢)。
 */
const E2E_TESTS = [
  "apps/cli/src/cli.test.ts",
  "apps/cli/src/cli-match.test.ts",
  "apps/cli/src/cli-benchmark.test.ts",
  "apps/cli/src/cli-observation.test.ts",
  "apps/cli/src/cli-season.test.ts",
  "apps/cli/src/cli-verify.test.ts",
  "apps/cli/src/selection/selection.test.ts",
  "apps/cli/src/selection/grid-selection.test.ts",
  "apps/cli/src/trial/run-trial-script.test.ts",
  "apps/cli/src/optimization-cli.test.ts",
];

/**
 * 进程内真沙箱:**同进程里起 quickjs-wasi VM 跑整场对局**。不起子进程、不要 bwrap。
 *
 * 与 `e2e` 同一条理由分开:它们证的是引擎在**真 VM** 上的行为(确定性、预算轨、注入面),
 * 而不是"命令行能把整条链路串起来"。同样属于"贵但只有它能证",进默认 `test` 会让
 * 每次业务改动都付 90s。
 */
const VM_TESTS = [
  "packages/engine/src/sandbox.test.ts",
  "packages/engine/src/sandbox-runtime/api-surface.test.ts",
  "packages/engine/src/budget-mismatch.test.ts",
  "packages/engine/src/determinism.test.ts",
  "packages/engine/src/fixtures/fixtures.test.ts",
  "packages/engine/src/runner/probe-harness.test.ts",
];

/** 各 project 通用的排除项:`tsc -b` 会把测试一并编译进各包的 dist,产物绝不能被二次拾取。 */
const NEVER_TEST = ["**/node_modules/**", "**/dist/**"];
/**
 * 观测器的标签来源(ADR-0038):把「这段 I/O 属于哪个测试文件」写进环境变量。
 *
 * 它平时是 no-op(只有 `MODELWAR_TEST_INPUTS_FILE` 存在时动手),所以装在常跑的 project 上
 * 不需要额外的开关;反过来说,不装它,`observe:inputs` 录到的就是一堆无主数据。
 */
const RECORD_SETUP = "./vitest.record-inputs.setup.ts";

/**
 * worker 进程的启动参数:录制时把观测器 `--import` 进去。
 *
 * 为什么不能只靠 `NODE_OPTIONS`:vitest 给 worker 的 env 里会剔掉它(自己要用)。为什么不能只靠
 * 在 setup 文件里装:`import { readFileSync } from "node:fs"` 的绑定在**模块链接时**就固定了,
 * setup 跑起来时测试模块已经链接完,补丁改不到它(实测:补丁装上了,一条记录都没有)。
 * `execArgv` 是 worker 进程自己的 argv,加载任何应用模块之前就生效——这是唯一能同时满足
 * 「早于链接」与「在测试进程里」的位置。
 */
const RECORD_EXEC_ARGV =
  process.env["MODELWAR_TEST_INPUTS_FILE"] === undefined
    ? []
    : [
        "--import",
        pathToFileURL(
          fileURLToPath(new URL("./packages/tools/src/scope/recorder.ts", import.meta.url)),
        ).href,
      ];

/**
 * 常跑链的内核探针:把 `bwrap` 换成会拒绝的执行体(理由见该文件头注)。
 *
 * 只装给 `unit` 与 `property`:它们**不该**有任何用例执行真 preflight / 真 bwrap,而真 bwrap 的
 * 那几条住在 `sandbox` project(`verify:kernel`),那里必须是真二进制。两处写同一份路径(不抽
 * 常量):`packages/tools/src/vitest/kernel-guard.test.ts` 逐个 project 断言它,抽常量反而让那条
 * 断言要去读常量的值。
 */

export default defineConfig({
  test: {
    // 任何测试模块被加载**之前**先补一次 `tsc -b`(理由与代价见 vitest.global-setup.ts 的头注)。
    // 这一条是 `test:property` 这类独立入口能自己站住的前提:工作区包的 exports 指向 dist/,
    // 而门禁是按命名脚本手工触发的,不能假定「前面恰好跑过 gate:types」。
    globalSetup: ["./vitest.global-setup.ts"],
    // 两个 project 的 include 都限定在源码目录:`tsc -b` 会把测试一并编译进各包的 dist,
    // 编译产物绝不能被二次拾取(hld §2.2.4 的禁令同样适用于测试范围)。
    // 观测器的标签来源(ADR-0038):把「这段 I/O 属于哪个测试文件」写进环境变量。
    // 只在 `MODELWAR_TEST_INPUTS_FILE` 存在时生效,平时的运行里它是 no-op。
    projects: [
      {
        // 收口用的**单池**全量:与 `unit` 同一批文件,但**不**排除 e2e / vm。
        //
        // 为什么不直接把四个 project 串在一次 `vitest run` 里(`--project unit --project e2e
        // --project vm`):实测那样反而慢 7s(74.9s vs 67.9s)——分片会打乱排布,长文件挤在一起
        // 起跑。收口要的是"少花时间",不是"多一个 project"。
        // 于是分成两种跑法:`unit`/`e2e`/`vm` 服务**子集**(编辑循环/改到哪跑哪),
        // `all` + `property` 服务**收口**(`test:all`、`verify`)。
        //
        // 同一批文件在两个 project 里出现不是重复定义:`all` 与 `unit ∪ e2e ∪ vm` 是同一个集合,
        // 由 `packages/tools/src/scope/test-layers.test.ts` 盯着,谁走散就红。
        test: {
          name: "all",
          include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          exclude: [
            ...NEVER_TEST,
            GATES_TEST,
            SLOW_TEST,
            MUTATION_TEST,
            SANDBOX_TEST,
            GEN_CLI_TEST,
          ],
          setupFiles: ["./vitest.kernel-guard.setup.ts", RECORD_SETUP],
          execArgv: RECORD_EXEC_ARGV,
        },
      },
      {
        test: {
          name: "unit",
          include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          exclude: [
            ...NEVER_TEST,
            GATES_TEST,
            SLOW_TEST,
            MUTATION_TEST,
            SANDBOX_TEST,
            GEN_CLI_TEST,
            ...E2E_TESTS,
            ...VM_TESTS,
          ],
          setupFiles: ["./vitest.kernel-guard.setup.ts", RECORD_SETUP],
          execArgv: RECORD_EXEC_ARGV,
        },
      },
      {
        test: {
          name: "property",
          // 属性测试不限于包内:`apps/cli` 的校验器有一条「任意 JSON 值都不抛未捕获异常」
          // 的属性(手写 schema 最容易漏的那类崩),它按同样的纪律归到这里。
          include: ["packages/*/src/**/*.prop.ts", "apps/*/src/**/*.prop.ts"],
          exclude: NEVER_TEST,
          setupFiles: ["./vitest.kernel-guard.setup.ts", RECORD_SETUP],
          execArgv: RECORD_EXEC_ARGV,
          testTimeout: 30_000,
        },
      },
      {
        // 门禁本身的退出码。与 unit/property 分开不是为了好看,而是为了不递归(见 GATES_TEST)。
        // 默认 `test` 与 `check` 都只跑 unit 与 property;`gates` 由 `test:gates` 单独运行。
        test: {
          name: "gates",
          include: [GATES_TEST],
          exclude: NEVER_TEST,
          // 每道门禁都是 spawn 真实命令,而其中两道(漂移检查、契约自证)会跑构建 / 64 场对局。
          // 超时定得太紧的后果是「门禁跑不完」被报成「门禁失败」,两件事的处方完全不同,所以留足。
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
      {
        // 变异棘轮的真跑:跑一次 `mutate:replay`(本机约 50s),证明跑完入口后入库基线的字节不变。
        // 它自己一个 project(而不是住 `gates`)的唯一理由就是这 50s:见 `MUTATION_TEST` 的注释。
        test: {
          name: "mutation",
          include: [MUTATION_TEST],
          exclude: NEVER_TEST,
          // 一条真 Stryker 分片:超时给足,别让“跑不完”被报成“失败”。
          testTimeout: 900_000,
          hookTimeout: 900_000,
        },
      },
      {
        // 门禁自测里慢的那一半,按需由 `pnpm run test:slow` 单独运行,默认 `test` 不含它。
        // 超时给到 15 分钟:其中一条要连跑两遍全矩阵(红一次 + 还原后绿一次),单条已实测 220s,
        // 而它 220s 的那个数字还是在这台机器上不 competing 的情况下取的。
        test: {
          name: "slow",
          include: [SLOW_TEST],
          exclude: NEVER_TEST,
          testTimeout: 900_000,
          hookTimeout: 900_000,
        },
      },
      {
        // 进程级 e2e:打好的 CLI 产物 + 真链路。入口是 `test:e2e`,`verify` 用 `test:all` 带上它。
        test: {
          name: "e2e",
          include: [...E2E_TESTS],
          exclude: NEVER_TEST,
          // 一条用例要 spawn 子进程跑满 600 tick,赛季那条要跑 4 局;给足,别让"跑不完"报成"失败"。
          testTimeout: 300_000,
          hookTimeout: 300_000,
          setupFiles: ["./vitest.kernel-guard.setup.ts", RECORD_SETUP],
          execArgv: RECORD_EXEC_ARGV,
        },
      },
      {
        // 进程内真沙箱:同进程起 quickjs-wasi VM 跑整场。入口是 `test:vm`。
        test: {
          name: "vm",
          include: [...VM_TESTS],
          exclude: NEVER_TEST,
          testTimeout: 300_000,
          hookTimeout: 300_000,
          setupFiles: ["./vitest.kernel-guard.setup.ts", RECORD_SETUP],
          execArgv: RECORD_EXEC_ARGV,
        },
      },
      {
        // 真 bwrap 下的两件事:一场**真会话**(真进程隔离、真 fd 通道、真宿主服务、真档案),
        // 与一条**CLI 冒烟**(spawn 打好的单文件产物 + 假端点 + 真网格)。
        //
        // 它们不进 `unit` 的理由是**环境**而不是耗时:要非特权 user namespace 与系统装的
        // bubblewrap,而常跑链不装(与 `verify:kernel` 同一条理由:两种处方不该混成一条红)。
        // 入口是命名脚本 `verify:kernel`;同一套断言在 unit 里由假执行器的那一份盯住
        // (`apps/cli/src/agent-session-archive.test.ts` / `gen-archive.test.ts`),所以移走不等于
        // 丢掉覆盖——CLI 产物那一层的 argv 解析与退出码约定另有 `cli.test.ts` 与
        // `packages/gen/src/run.test.ts` 在常跑链上盯着。
        test: {
          name: "sandbox",
          include: [SANDBOX_TEST, GEN_CLI_TEST],
          exclude: NEVER_TEST,
          // 每条用例在真沙箱里走四步(含真 tsc 编译与真静态校验),给足。
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
