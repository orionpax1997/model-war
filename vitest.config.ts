import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 两个 project 的 include 都限定在源码目录:`tsc -b` 会把测试一并编译进各包的 dist,
    // 编译产物绝不能被二次拾取(hld §2.2.4 的禁令同样适用于测试范围)。
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      {
        test: {
          name: "property",
          include: ["packages/*/src/**/*.prop.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
