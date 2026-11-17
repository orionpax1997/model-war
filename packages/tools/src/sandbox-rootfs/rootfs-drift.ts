/**
 * 入库 rootfs 的漂移判据(**纯函数层**):盘上的那棵树还是不是常量里说的那棵树。
 *
 * 入口是 `run-rootfs-drift-gate.ts`(根脚本 `check:sandbox-rootfs`),这里只把「哪里不对」
 * 写成可读的中文;读盘与退出码归入口。分层理由同 `gate/budget-gate.ts`:入口能用假世界喂,
 * 反例不必改真实文件。
 *
 * ── 六条判据,守的是六种不同的漂 ──
 *
 * 1. **整棵树哈希 == 常量**:字节被改过(哪怕只改一个字节)就是另一份世界。
 * 2. **磁盘文件集 == 清单**:多一个(上一次组装的残骸、顺手放的调试文件)与少一个(漏拷)
 *    都红。「多一个」尤其重要——它不会被挂载,却看起来像是内容物的一部分。
 * 3. **四个二进制是静态 ELF**:不带 `PT_INTERP`。判据自己解析 ELF,不靠 `ldd`(它执行目标
 *    文件)也不靠 `file`(输出随版本漂)。这条是「不从宿主借动态库」的可执行形式。
 * 4. **`contract/*` 与 `docs/rules-v2/*` 逐字节相同**:契约的真源只有一份。运行期不 bind
 *    宿主 checkout,所以副本一旦与真源分叉,模型读到的就是一份没人维护的契约。
 * 5. **薄壳与 `packages/gen/src/agent/shim/shim.sh` 逐字节相同**:同上一条,薄壳的源码真源
 *    在 gen,rootfs 里那三个名字是它的副本。
 * 6. **顶层只许 `bin/`、`contract/` 与来路说明书**:挂载面之外的任何东西都不该出现在产物
 *    目录里(构建残骸、tarball、`*.o`)。这条是「产物目录本身」的判据,不是文件的判据。
 *
 * ── 常量从 schema 的**源码文本**里取,不 import 真源包 ──
 * 本门禁挂在 `check:quick` 上,而快门禁必须零构建(`@model-war/schema` 的 `exports` 指向
 * `dist/`,import 它就让这条链依赖一次 `tsc -b`)。做法与 `run-prose-gate.ts` 读键清单源码、
 * `run-quickjs-coupling-gate.ts` 读冻结常量同源:读源码文本,按形态取字面量。抽不出来时
 * **按失败处理**并说明原因,不静默放行——那正是「判据失明但门禁全绿」的形态。
 */

/** schema 源码里被读的那三个常量名与那一处文件。 */
export const SCHEMA_CONSTANTS_SOURCE = "packages/schema/src/sandbox-rootfs.ts";

/** 从 schema 源码文本里抽出来的三个常量。 */
export type SandboxRootfsConstants = {
  readonly dir: string;
  readonly files: readonly string[];
  readonly treeHash: string;
};

/**
 * 取一个 `export const NAME = <字面量>` 的正文;取不到返回 `undefined`。
 *
 * 允许跨行(值另起一行)与可选类型标注:常量表是给人读的,排版会变,判据不该跟着变脆。
 */
const literalBody = (source: string, name: string): string | undefined => {
  const pattern = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*`, "u");
  const match = pattern.exec(source);
  if (match === null) return undefined;
  return source.slice(match.index + match[0].length);
};

/** 取一个**字符串**字面量的值(第一个 `"..."`)。 */
const stringConstant = (source: string, name: string): string | undefined => {
  const body = literalBody(source, name);
  if (body === undefined) return undefined;
  const match = /^"([^"\\]*)"\s*;/u.exec(body);
  return match?.[1];
};

/** 取一个字符串**数组**字面量的值(`as const` 后缀无妨)。 */
const stringArrayConstant = (source: string, name: string): readonly string[] | undefined => {
  const body = literalBody(source, name);
  if (body === undefined) return undefined;
  const end = body.indexOf("]");
  if (!body.startsWith("[") || end < 0) return undefined;
  return [...body.slice(0, end).matchAll(/"([^"\\]*)"/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
};

/** 抽三个常量。任一个抽不出来就返回理由,调用方按失败处理(不猜、不跳过)。 */
export const sandboxRootfsConstantsFrom = (
  source: string,
):
  | { readonly ok: true; readonly constants: SandboxRootfsConstants }
  | { readonly ok: false; readonly reason: string } => {
  const dir = stringConstant(source, "SANDBOX_ROOTFS_DIR");
  const files = stringArrayConstant(source, "SANDBOX_ROOTFS_FILES");
  const treeHash = stringConstant(source, "SANDBOX_ROOTFS_TREE_HASH");
  const missing = [
    dir === undefined ? "SANDBOX_ROOTFS_DIR" : "",
    files === undefined || files.length === 0 ? "SANDBOX_ROOTFS_FILES" : "",
    treeHash === undefined ? "SANDBOX_ROOTFS_TREE_HASH" : "",
  ].filter((name) => name !== "");
  if (missing.length > 0 || dir === undefined || files === undefined || treeHash === undefined) {
    return {
      ok: false,
      reason:
        `从 ${SCHEMA_CONSTANTS_SOURCE} 的源码文本里抽不出 ${missing.join(" / ")}:` +
        "本门禁零构建、只能读源码文本(不 import 真源包)。改过常量的写法就同步改本门禁的取法。",
    };
  }
  return { ok: true, constants: { dir, files, treeHash } };
};

/** 一条违规:先指位置,再说它为什么是问题、处方是什么。 */
export type RootfsFinding = { readonly where: string; readonly detail: string };

/** 判据 2:期望清单与盘上文件集的差(两个方向都报)。 */
export const manifestFindings = (
  expected: readonly string[],
  actual: readonly string[],
): readonly RootfsFinding[] => {
  const have = new Set(actual);
  const want = new Set(expected);
  const findings: RootfsFinding[] = [];
  for (const path of [...want].sort()) {
    if (!have.has(path)) {
      findings.push({
        where: path,
        detail:
          "清单里点名了这份内容,盘上没有:挂载点会少一块。跑 `pnpm run sandbox:rootfs:build`。",
      });
    }
  }
  for (const path of [...have].sort()) {
    if (!want.has(path)) {
      findings.push({
        where: path,
        detail:
          "盘上多了一份不在清单里的文件。它不会被挂载,却看起来像内容物的一部分——" +
          "要么把它加进清单与哈希,要么从产物目录挪走。",
      });
    }
  }
  return findings;
};

/** 判据 1:现算的整棵树哈希与常量不符。 */
export const treeHashFinding = (expected: string, actual: string): RootfsFinding | undefined =>
  expected === actual
    ? undefined
    : {
        where: SCHEMA_CONSTANTS_SOURCE,
        detail:
          `整棵 rootfs 现算的 sha256 是 ${actual},而 SANDBOX_ROOTFS_TREE_HASH 写的是 ${expected}。` +
          "内容物被改过(或被重新组装过):确认这次改动是想要的,再跑 `pnpm run sandbox:rootfs:build` " +
          "把新哈希手写回去。",
      };

/** 判据 3:一份二进制不是「静态 ELF」。`verdict` 为 `undefined` 表示解析失败。 */
export const staticBinaryFinding = (
  path: string,
  verdict: { readonly static: boolean; readonly reason: string } | undefined,
): RootfsFinding | undefined => {
  if (verdict === undefined) {
    return {
      where: path,
      detail: "解析不出 ELF 头/程序头:它不是 ELF,或被截断了。rootfs 里的四个必须是静态 ELF。",
    };
  }
  return verdict.static
    ? undefined
    : {
        where: path,
        detail:
          `${verdict.reason}。沙箱不从宿主借动态库(宿主的 /usr 一个 inode 都不挂),` +
          "带程序解释器的二进制在里面根本起不来,而它会先在本机看起来「能跑」。",
      };
};

/** 判据 4 / 5:副本与真源逐字节比较。 */
export const byteCopyFinding = (
  copyPath: string,
  sourcePath: string,
  copy: Buffer,
  source: Buffer,
): RootfsFinding | undefined =>
  copy.equals(source)
    ? undefined
    : {
        where: copyPath,
        detail:
          `与真源 ${sourcePath} 不一致(副本 ${String(copy.byteLength)} 字节 / 真源 ` +
          `${String(source.byteLength)} 字节)。这一份是生成物:改真源,再跑 ` +
          "`pnpm run sandbox:rootfs:build`。",
      };

/** 判据 6:顶层条目只许挂载面那两个目录与来路说明书。 */
export const topLevelFindings = (
  entries: readonly string[],
  allowed: readonly string[],
): readonly RootfsFinding[] =>
  entries
    .filter((entry) => !allowed.includes(entry))
    .sort()
    .map((entry) => ({
      where: entry,
      detail:
        "产物目录顶层只许 bin/、contract/ 与来路说明书。构建残骸(tarball、deb、*.o、build 目录)" +
        "一律不入库——入库的是内容物,不是它的来路。",
    }));

/** 判据 5 的另一半:薄壳与二进制必须可执行,否则挂进去也跑不起来。 */
export const executableFinding = (path: string, executable: boolean): RootfsFinding | undefined =>
  executable
    ? undefined
    : {
        where: path,
        detail: "不可执行(没有 +x)。rootfs 里的 bin/* 全部要被直接执行,权限位也是产物的一部分。",
      };
