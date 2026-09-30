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
 */
const GATES_TEST = "packages/tools/src/gates.test.ts";

/** 各 project 通用的排除项:`tsc -b` 会把测试一并编译进各包的 dist,产物绝不能被二次拾取。 */
const NEVER_TEST = ["**/node_modules/**", "**/dist/**"];

export default defineConfig({
  test: {
    // 两个 project 的 include 都限定在源码目录:`tsc -b` 会把测试一并编译进各包的 dist,
    // 编译产物绝不能被二次拾取(hld §2.2.4 的禁令同样适用于测试范围)。
    projects: [
      {
        test: {
          name: "unit",
          include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          exclude: [...NEVER_TEST, GATES_TEST],
        },
      },
      {
        test: {
          name: "property",
          include: ["packages/*/src/**/*.prop.ts"],
          exclude: NEVER_TEST,
          testTimeout: 30_000,
        },
      },
      {
        // 门禁本身的退出码。与 unit/property 分开不是为了好看,而是为了不递归(见 GATES_TEST)。
        // `check` 显式只跑 unit 与 property;`gates` 由 `pnpm test` / `test:gates` 跑。
        test: {
          name: "gates",
          include: [GATES_TEST],
          exclude: NEVER_TEST,
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
