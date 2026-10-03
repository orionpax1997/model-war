/**
 * vitest 的全局 setup:**在任何测试模块被加载之前**补一次 `tsc -b`。
 *
 * 为什么需要:工作区各包的 `exports` 指向 `dist/`,而 vitest 不构建。所以新克隆上直接跑
 * `pnpm run test:props` 会死在解析 `@model-war/schema` 上。门禁是按命名脚本手工触发的
 * (hld §2.2.7),`test:props` 是一条**独立**入口,不能靠「前面恰好跑过 `check:types`」
 * 才站得住——那种依赖在有人只跑那一条命令时就变成一堵墙。
 *
 * 为什么是 globalSetup 而不是测试文件里的 `beforeAll`:ESM 的模块加载先于 hook,
 * 一个需要 dist 的 `import` 在 `beforeAll` 跑之前就已经解析完了,补不上。
 * `apps/cli/src/cli.test.ts` 里那个 `beforeAll` 之所以管用,是因为它要 dist 是为了
 * 在 hook **之后**打 bundle;本文件那两条(校验器单测与属性测试)要 dist 是在 import 时刻,
 * 属于另一回事,别照抄那个位置。
 *
 * 代价:每次 vitest 启动多一次 `tsc -b`。全量门禁 `check` 里 `check:types` 已经构建过,
 * 增量构建是空操作。构建失败即让整个 vitest 运行失败——这正是要的行为:
 * 类型门禁已经红过一次,这里只是不让它以「模块找不到」的样子再红一次。
 *
 * 本文件不在任何 tsc project 的范围内(根 tsconfig 的 `files` 是空的,理由见那里),
 * 与 `.dependency-cruiser.js` 同一处境:靠 `fmt` 脚本的显式路径被格式化。
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default (): void => {
  const build = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./node_modules/typescript/bin/tsc", import.meta.url)),
      "-b",
      "--pretty",
      "false",
    ],
    { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(`tsc -b 失败(测试需要 dist 里的工作区包):\n${build.stdout}${build.stderr}`);
  }
};
