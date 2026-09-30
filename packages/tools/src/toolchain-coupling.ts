/**
 * 工具版本耦合断言:TypeScript 与类型感知 lint(tsgolint)必须配套。
 *
 * 背景:oxlint 只保证 tsgolint 的版本**下界**,不比对 TypeScript 版本。两者一旦错位,
 * 类型感知 lint 不会报错、不会警告,只是**静默地不再基于正确的类型信息运行**——
 * 也就是 hld §2.2.3 那条「类型感知 lint 需要已解析的类型信息」在一个没人看的地方悄悄失守。
 * 因此这条断言必须由我们自己写在 CI 里。
 *
 * 配套关系怎么编码(oxlint-tsgolint 自带 README 的 "Versioning" 一节):
 *   `7.0.2001` ⇒ `7.0.2` 是 TypeScript 版本,`001` 是 tsgolint 自己的 patch。
 *   末三位是 tsgolint 的 patch,前面剩下的就是它所配套的 TypeScript patch。
 *   TypeScript 版本一变,前面那段跟着变,末三位归零。
 *
 * 运行形态:门禁脚本,`node packages/tools/src/toolchain-coupling.ts`。
 * 刻意做成**带顶层副作用的脚本**而不是库函数:它是门禁的一等公民,和 oxfmt/oxlint 同级。
 * 唯一的外部接口是退出码——配套为 0,错位为 1。
 *
 * 可选的第二个形式参数是给反例用的:传两个假版本号进去,应当稳定地非零退出。
 * 反例因此不必改动 package.json 就能在测试里现做现验。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const rootPackageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));

type Manifest = {
  devDependencies?: Record<string, string>;
};

/** 一条已经查清原因的不通过。 */
type Misalignment = { readonly check: string; readonly detail: string };

/** node_modules 里实际装着的版本,键是包名。 */
type InstalledVersions = Readonly<Record<string, string>>;

/**
 * 从 oxlint-tsgolint 的版本号反解出它所配套的 TypeScript 版本。
 *
 * 形如 `7.0.2003`:major/minor 直接取用,patch 段的末三位是 tsgolint 自己的 patch,
 * 余下的是 TypeScript 的 patch。解不出(0.x 系列、非数字、段数不对)时返回 null——
 * 0.x 那批是 TS 7 之前的 tsgolint,与本仓库的 TypeScript 7 不配套。
 */
export const typescriptVersionBackedBy = (tsgolintVersion: string): string | null => {
  const parts = tsgolintVersion.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  if (!/^\d{4,}$/.test(patch)) {
    return null;
  }
  return `${major}.${minor}.${patch.slice(0, -3)}`;
};

/** 精确锁版:spec 里不许出现任何范围运算符。 */
const isExactPin = (spec: string): boolean => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec);

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;

/** node_modules 里实际装着的版本(键是包名),用来抓「manifest 改了但没重装」这种陈旧安装。 */
const installedVersion = (packageName: string): string => {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = readJson(manifestPath) as { version?: string };
  if (manifest.version === undefined) {
    throw new Error(`${packageName} 的 package.json 没有 version 字段:${manifestPath}`);
  }
  return manifest.version;
};

/** 跑一次断言,收集全部不通过项;空数组即配套。 */
export const findMisalignments = (
  typescriptSpec: string,
  tsgolintSpec: string,
  installed: InstalledVersions | null,
): readonly Misalignment[] => {
  const found: Misalignment[] = [];

  if (!isExactPin(typescriptSpec)) {
    found.push({
      check: "typescript 精确锁版",
      detail: `devDependencies.typescript = ${JSON.stringify(typescriptSpec)},含范围运算符`,
    });
  }
  if (!isExactPin(tsgolintSpec)) {
    found.push({
      check: "oxlint-tsgolint 精确锁版",
      detail: `devDependencies.oxlint-tsgolint = ${JSON.stringify(tsgolintSpec)},含范围运算符`,
    });
  }

  const backed = typescriptVersionBackedBy(tsgolintSpec);
  if (backed === null) {
    found.push({
      check: "版本号编码",
      detail: `oxlint-tsgolint ${tsgolintSpec} 解不出配套的 TypeScript 版本(期望 7.0.<tsPatch><golintPatch>)`,
    });
  } else if (backed !== typescriptSpec) {
    found.push({
      check: "版本配套",
      detail: `typescript ${typescriptSpec} ≠ oxlint-tsgolint ${tsgolintSpec} 所配套的 ${backed}`,
    });
  }

  if (installed !== null) {
    for (const [name, spec] of [
      ["typescript", typescriptSpec],
      ["oxlint-tsgolint", tsgolintSpec],
    ] as const) {
      if (installed[name] !== spec) {
        found.push({
          check: "安装与 manifest 一致",
          detail: `${name}: node_modules 里是 ${installed[name]},manifest 写的是 ${spec}(需要重装)`,
        });
      }
    }
  }

  return found;
};

const readManifestSpecs = (): { typescript: string; tsgolint: string } => {
  const manifest = readJson(rootPackageJsonPath) as Manifest;
  const deps = manifest.devDependencies;
  if (deps === undefined) {
    throw new Error(`根 package.json 没有 devDependencies:${rootPackageJsonPath}`);
  }
  const typescript = deps["typescript"];
  const tsgolint = deps["oxlint-tsgolint"];
  if (typescript === undefined || tsgolint === undefined) {
    throw new Error(
      "根 package.json 的 devDependencies 必须同时声明 typescript 与 oxlint-tsgolint",
    );
  }
  return { typescript, tsgolint };
};

const main = (): number => {
  const argv = process.argv.slice(2);
  const specs =
    argv.length === 0
      ? readManifestSpecs()
      : argv.length === 2 && argv.every((value) => value !== undefined)
        ? { typescript: argv[0] as string, tsgolint: argv[1] as string }
        : (() => {
            throw new Error(
              "用法:node packages/tools/src/toolchain-coupling.ts [typescript版本] [tsgolint版本]",
            );
          })();

  // 反例形式(显式传版本号)不查 node_modules:它断言的是配对关系本身。
  const installed: InstalledVersions | null =
    argv.length === 0
      ? {
          typescript: installedVersion("typescript"),
          "oxlint-tsgolint": installedVersion("oxlint-tsgolint"),
        }
      : null;

  const misalignments = findMisalignments(specs.typescript, specs.tsgolint, installed);
  if (misalignments.length === 0) {
    process.stdout.write(
      `toolchain coupling ok: typescript ${specs.typescript} ⇄ oxlint-tsgolint ${specs.tsgolint}\n`,
    );
    return 0;
  }
  for (const { check, detail } of misalignments) {
    process.stderr.write(`工具版本耦合断言不通过 [${check}]:${detail}\n`);
  }
  return 1;
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  process.exitCode = main();
}
