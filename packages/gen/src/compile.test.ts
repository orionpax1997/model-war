/**
 * 编译步骤的对外可观察行为:**派生的运行配置**与**实际调到的 tsc 版本**。
 *
 * 断言对象照 `packages/tools/src/script-compile-config.test.ts` 的形态:不逐字抄配置文本,
 * 而是问编译器自己(`tsc --showConfig`)「你最后看到的类型环境是什么」。那一条恰好是
 * 派生配置最容易悄悄破的不变量——`extends` 写错、`typeRoots` / `types` 被覆盖,都会让
 * 沙箱脚本 API 声明被换掉而**没有一条脚本会因此变红**。所以这里钉住:类型环境原样继承,
 * 覆盖只发生在 `files` / `outDir` / `rootDir` 三处。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

import { SCRIPT_SOURCE_NAME } from "./archive.js";
import { deriveScriptTsconfig, parseTscVersion, readTscVersion } from "./compile.js";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const repoRoot = here("../../../");
const TSC = join(repoRoot, "node_modules", ".bin", "tsc");

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** 把派生配置落进一个临时目录,返回配置路径。临时目录在仓库外,模块解析面因此是真的。 */
const writeDerivedConfig = (): { readonly dir: string; readonly configPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), "modelwar-gen-compile-"));
  workspaces.push(dir);
  const configPath = join(dir, "run.json");
  writeFileSync(configPath, `${JSON.stringify(deriveScriptTsconfig(repoRoot))}\n`, "utf8");
  return { dir, configPath };
};

it("派生配置只覆盖 files / outDir / rootDir,extends 指仓库根基座的绝对路径", () => {
  const derived = deriveScriptTsconfig(repoRoot);
  expect(derived.extends).toBe(join(repoRoot, "tsconfig.scripts.json"));
  expect(derived.compilerOptions).toEqual({ rootDir: ".", outDir: "." });
  expect(derived.files).toEqual([SCRIPT_SOURCE_NAME]);
});

it("派生配置继承基座的类型环境:types 恰好一项、typeRoots 不碰 @types", () => {
  const { dir, configPath } = writeDerivedConfig();
  const shown = spawnSync(TSC, ["--showConfig", "-p", configPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (shown.error !== undefined) {
    throw shown.error;
  }
  expect(shown.status, shown.stderr).toBe(0);

  const config = JSON.parse(shown.stdout) as {
    readonly compilerOptions: {
      readonly types?: readonly string[];
      readonly typeRoots?: readonly string[];
      readonly outDir?: string;
      readonly rootDir?: string;
    };
    readonly files?: readonly string[];
  };

  const types = config.compilerOptions.types ?? [];
  expect(types, "脚本的类型环境必须恰好只有一份声明").toHaveLength(1);
  expect(types[0], "引进来的是 Node 类型的话,宿主能力就跟着进沙箱了").not.toContain("@types");
  expect(types).not.toContain("node");

  const typeRoots = config.compilerOptions.typeRoots ?? [];
  expect(typeRoots, "typeRoots 只该有一条:多一条就多一条能塞 @types 的口子").toHaveLength(1);
  for (const root of typeRoots) {
    expect(root).not.toContain("node_modules");
    // 类型声明必须仍指向仓库里的真源包(而不是 node_modules/@types 或仓库外)。
    expect(resolve(dir, root)).toBe(resolve(repoRoot, "packages", "schema"));
  }

  // 覆盖生效:只动这三个,别的都是继承来的。
  expect(config.compilerOptions.outDir).toBe("./");
  expect(config.compilerOptions.rootDir).toBe("./");
  expect(config.files).toEqual(["./script.ts"]);
});

it("`tscVersion` 取现场调到的版本,而不是写死一个数", () => {
  const version = readTscVersion(repoRoot);
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  expect(parseTscVersion("Version 7.0.2\n")).toBe("7.0.2");
  expect(parseTscVersion(`Version ${version} (release)\n`)).toBe(version);
});
