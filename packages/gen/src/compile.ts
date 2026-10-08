/**
 * 参赛脚本的编译步骤:派生临时 tsconfig → `tsc -p` → script-mode JS(hld §6.2「编译」那一行)。
 *
 * ── 为什么派生一份临时配置,而不是直接 `tsc -p tsconfig.scripts.json` ──
 *
 * 仓库根的 `tsconfig.scripts.json` 是**编译选项的基座**:它的 `files` 刻意置空(否则默认
 * `include` 是 `**\/*`,`tsc -p` 会把整个仓库吞进一个 program 并报 TS18002)。而每次编译的源
 * 路径都不同(冻结脚本落在临时组装目录),`tsc -p` 又不能与源文件同命令行出现(TS5042)。
 * 所以派生一份只覆盖 `files` / `outDir` / `rootDir` 的运行配置,`extends` 指仓库根的绝对路径
 * 那份基座——类型环境(`typeRoots` / `types`,沙箱脚本 API 声明)因此原样继承,不在这里复述。
 *
 * ── 为什么产物直接落在源旁边,以及为什么必须删掉派生配置 ──
 *
 * 临时组装目录 `archive/<slug>/.tmp-xxx/` 最终会被整体 `rename` 成存档目录,里面只该有
 * 三件套。产物目录名**不能**叫 `dist/`(`.gitignore` 里那条是无锚点规则),所以 `outDir`
 * 取 `.`(产物 `script.js` 与源 `script.ts` 同目录),派生配置编译完即删——它不该随 rename
 * 进存档。
 *
 * ── `tscVersion` 取实际调到的版本 ──
 *
 * `meta.tscVersion` 要的是**真跑起来的那版编译器**,不是写死的一个数(ADR-0002 锁 7.0.2,
 * 但那是可变的约定)。所以每次编译现场问一次 `tsc --version`,把输出里的版本号填进 meta。
 */

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SCRIPT_PRODUCT_NAME, SCRIPT_SOURCE_NAME } from "./archive.js";

/** 派生运行配置的文件名(编译完即删,不随存档发布)。 */
const DERIVED_CONFIG_NAME = "run.json";

/** 派生运行配置的形状:**只覆盖** `files` / `outDir` / `rootDir`,其余一律继承仓库根基座。 */
export type ScriptTsconfig = {
  readonly extends: string;
  readonly compilerOptions: {
    readonly rootDir: string;
    readonly outDir: string;
  };
  readonly files: readonly string[];
};

/** 仓库根的 tsc 可执行入口。 */
const tscPath = (root: string): string => join(root, "node_modules", ".bin", "tsc");

/** 仓库根的脚本编译基座。 */
const baseConfigPath = (root: string): string => join(root, "tsconfig.scripts.json");

/**
 * 派生一份参赛脚本的运行配置(纯函数,不落盘)。
 *
 * `outDir` 与 `rootDir` 都取 `.`:源与产物同目录,且那个目录名不能是 `dist`。
 */
export const deriveScriptTsconfig = (root: string): ScriptTsconfig => ({
  extends: baseConfigPath(root),
  compilerOptions: { rootDir: ".", outDir: "." },
  files: [SCRIPT_SOURCE_NAME],
});

/** 解析 `tsc --version` 的输出(`Version 7.0.2` → `7.0.2`)。 */
export const parseTscVersion = (output: string): string => {
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(output);
  const version = match?.[1];
  if (version === undefined) {
    throw new Error(`解析不出 tsc 版本(期望 "Version x.y.z",收到 ${JSON.stringify(output)})`);
  }
  return version;
};

/** 现场问一次实际调到的 tsc 版本。取不到可执行文件即抛错,不编一个默认版本顶上去。 */
export const readTscVersion = (root: string): string => {
  const result = spawnSync(tscPath(root), ["--version"], { encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  return parseTscVersion(`${result.stdout ?? ""}${result.stderr ?? ""}`);
};

export type CompileResult = {
  readonly ok: boolean;
  /** 编译产物的路径(即便编译失败也返回预期路径,便于诊断里指位置)。 */
  readonly jsPath: string;
  /** tsc 的合并诊断(stdout + stderr);成功时通常为空串。 */
  readonly diagnostics: string;
  readonly tscVersion: string;
};

/**
 * 把一段参赛脚本文本编译成 script-mode JS,落在 `stagingDir/script.js`。
 *
 * 源写进 `stagingDir/script.ts`,派生配置写进 `stagingDir/run.json`,以 `stagingDir` 为 cwd
 * spawn `<root>/node_modules/.bin/tsc -p <配置> --pretty false`;编译后删掉派生配置。
 * 返回退出码对应的 `ok`、合并诊断与现场读到的 tsc 版本——不抛异常,失败也交回诊断。
 */
export const compileScript = (options: {
  readonly root: string;
  readonly stagingDir: string;
  readonly source: string;
}): CompileResult => {
  const { root, stagingDir, source } = options;
  const tscVersion = readTscVersion(root);
  const sourcePath = join(stagingDir, SCRIPT_SOURCE_NAME);
  const configPath = join(stagingDir, DERIVED_CONFIG_NAME);

  writeFileSync(sourcePath, source, "utf8");
  writeFileSync(configPath, `${JSON.stringify(deriveScriptTsconfig(root))}\n`, "utf8");

  const result = spawnSync(tscPath(root), ["-p", configPath, "--pretty", "false"], {
    cwd: stagingDir,
    encoding: "utf8",
  });

  // 派生配置不随存档发布:编译一结束就删。
  rmSync(configPath, { force: true });

  const jsPath = join(stagingDir, SCRIPT_PRODUCT_NAME);
  if (result.error !== undefined) {
    return { ok: false, jsPath, diagnostics: `spawn tsc 失败:${result.error.message}`, tscVersion };
  }
  return {
    ok: (result.status ?? -1) === 0,
    jsPath,
    diagnostics: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    tscVersion,
  };
};
