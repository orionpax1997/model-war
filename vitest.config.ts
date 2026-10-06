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
 * 那一条不变量由 `慢的那一半(slow project)不被任何常跑入口拾取` 盯着。
 */
const GATES_TEST = "packages/tools/src/gates.test.ts";

/** 门禁自测里慢的那一半:契约自证的四问与三个反例。见该文件的头注。 */
const SLOW_TEST = "packages/tools/src/gates-slow.test.ts";

/** 各 project 通用的排除项:`tsc -b` 会把测试一并编译进各包的 dist,产物绝不能被二次拾取。 */
const NEVER_TEST = ["**/node_modules/**", "**/dist/**"];

export default defineConfig({
  test: {
    // 任何测试模块被加载**之前**先补一次 `tsc -b`(理由与代价见 vitest.global-setup.ts 的头注)。
    // 这一条是 `test:props` 这类独立入口能自己站住的前提:工作区包的 exports 指向 dist/,
    // 而门禁是按命名脚本手工触发的,不能假定「前面恰好跑过 check:types」。
    globalSetup: ["./vitest.global-setup.ts"],
    // 两个 project 的 include 都限定在源码目录:`tsc -b` 会把测试一并编译进各包的 dist,
    // 编译产物绝不能被二次拾取(hld §2.2.4 的禁令同样适用于测试范围)。
    projects: [
      {
        test: {
          name: "unit",
          include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          exclude: [...NEVER_TEST, GATES_TEST, SLOW_TEST],
        },
      },
      {
        test: {
          name: "property",
          // 属性测试不限于包内:`apps/cli` 的校验器有一条「任意 JSON 值都不抛未捕获异常」
          // 的属性(手写 schema 最容易漏的那类崩),它按同样的纪律归到这里。
          include: ["packages/*/src/**/*.prop.ts", "apps/*/src/**/*.prop.ts"],
          exclude: NEVER_TEST,
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
    ],
  },
});
