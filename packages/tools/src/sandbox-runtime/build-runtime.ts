/**
 * 沙箱 runtime bundle 的**构建面**(根脚本 `runtime:build` 与漂移门禁共用)。
 *
 * 用法:`node packages/tools/src/sandbox-runtime/build-runtime.ts`(直接把产物写回入库路径)。
 *
 * ── 产物是什么 ──
 * `packages/engine/src/sandbox-runtime/index.ts`(guest 侧源码)经 esbuild 打成**单文件 IIFE**,
 * 落 `packages/engine/sandbox-runtime/runtime.iife.js`(路径真源在 `@model-war/schema` 的
 * `SANDBOX_RUNTIME_ARTIFACT_PATH`)。它是**入库提交物**:回放 meta 的 `sandboxRuntimeHash`
 * 必须是「版本库里那串确切字节」的 sha256,所以产物不能只在 CI / 构建缓存里现算(ADR 0007)。
 *
 * ── 为什么是 IIFE、为什么桥名由 `define` 注入 ──
 * 脚本与运行时同处一个全局环境:`iife` + `bundle` 让产物**不含任何模块语法**——带
 * `import` / `export` 的产物在 QuickJS 的载入期就是 `SyntaxError`(门禁第三条钉住这条)。
 * 源码里两个桥名声明为**未绑定标识符**,值由本模块按真源包的 `HOST_BRIDGE_PREFIX` 拼出、
 * 经 esbuild 的 `define` 一次性注入:桥名的家只有一处,产物里不手写任何 `__*` 字面量。
 *
 * ── 为什么构建面独立成模块,而不是塞进门禁 ──
 * 门禁只答「现算 == 入库 + 入库 hash == 常量 + 产物是裸脚本」;构建只答「源码→字节」。
 * 写回侧(`invokedDirectly` 那一支)与核查侧共用**同一次** esbuild 调用,所以两者不可能
 * 悄悄用上两条不同的构建命令——那正是产物与源码分叉的入口。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { HOST_BRIDGE_PREFIX, SANDBOX_RUNTIME_ARTIFACT_PATH } from "@model-war/schema";

/** 仓库根。`packages/tools/src/sandbox-runtime/` 往上四层。 */
export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** guest 侧运行时源码的入口。 */
export const RUNTIME_ENTRY = `${repoRoot}packages/engine/src/sandbox-runtime/index.ts`;

/** 产物入库路径(相对仓库根的真源见 `@model-war/schema`)。 */
export const runtimeArtifactFile = (artifactPath: string): string => `${repoRoot}${artifactPath}`;

/** 两个宿主桥名。与 `packages/engine/src/runner/index.ts` 同法:由前缀拼,不写字面量。 */
export const HOST_BRIDGE_SET_SNAPSHOT = `${HOST_BRIDGE_PREFIX}setSnapshot`;
export const HOST_BRIDGE_DRAIN_INTENTS = `${HOST_BRIDGE_PREFIX}drainIntents`;

/**
 * 现打一次 runtime bundle,交回产物的**文本**。
 *
 * `platform: "neutral"`:guest 是 QuickJS,不是 Node 也不是浏览器,不引入任何平台垫片。
 * `write: false`:交回内存里的字符串,由调用方决定是写盘还是比对(门禁拿它与入库产物逐字节比)。
 */
export const buildRuntimeCode = async (): Promise<string> => {
  const built = await build({
    entryPoints: [RUNTIME_ENTRY],
    bundle: true,
    format: "iife",
    platform: "neutral",
    write: false,
    // 钉住工作目录:esbuild 在产物里为每个源文件写一行 `// <path>` 注释,路径相对工作目录。
    // 不钉的话「在哪个目录跑构建」会改变产物字节,门禁的「现算 == 入库」就随 cwd 漂移。
    absWorkingDir: repoRoot,
    define: {
      HOST_BRIDGE_SET_SNAPSHOT: JSON.stringify(HOST_BRIDGE_SET_SNAPSHOT),
      HOST_BRIDGE_DRAIN_INTENTS: JSON.stringify(HOST_BRIDGE_DRAIN_INTENTS),
    },
  });
  const [output] = built.outputFiles ?? [];
  if (output === undefined) {
    throw new Error("esbuild 没有产出 runtime bundle");
  }
  return output.text;
};

/** 按入库路径写回产物,并打印字节数。返回写入的字节长度。 */
export const writeRuntimeArtifact = async (artifactPath: string): Promise<number> => {
  const code = await buildRuntimeCode();
  const target = runtimeArtifactFile(artifactPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code, "utf8");
  return Buffer.byteLength(code);
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const path = runtimeArtifactFile(SANDBOX_RUNTIME_ARTIFACT_PATH);
  let before = "(尚无入库产物)";
  try {
    before = `${String(Buffer.byteLength(readFileSync(path, "utf8")))} 字节`;
  } catch {
    // 首次落库:产物还不存在,不算错。
  }
  const size = await writeRuntimeArtifact(SANDBOX_RUNTIME_ARTIFACT_PATH);
  process.stdout.write(
    `runtime:build 写入 ${SANDBOX_RUNTIME_ARTIFACT_PATH}(${String(size)} 字节;旧产物 ${before})。\n` +
      "产物已改:请重算并手写 `@model-war/schema` 的 `SANDBOX_RUNTIME_HASH`,再跑 `pnpm run check:runtime`。\n",
  );
}
