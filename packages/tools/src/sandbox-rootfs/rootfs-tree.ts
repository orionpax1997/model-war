/**
 * 入库 rootfs 的**树口径**:文件枚举、整棵树哈希、以及「这五个是不是静态 ELF」。
 *
 * ── 哈希口径与票 02 的契约树哈希同源,但**范围不同,两者不能互换** ──
 * 两边都是「按路径排序、`path\0bytes` 串接后的 sha256」。这边算的是**整棵 rootfs**
 * (`packages/gen/sandbox-rootfs/`):静态 bash、四个 coreutils、三个薄壳、`contract/` 四条。
 * 契约包身份(`docs/rules-v2/` 那四条)是另一个数,它由契约包自己算。把两个数当同一个用,
 * 会在「只改了 bash 版本、契约没动」时把契约身份也换掉——那是两种完全不同的断代。
 *
 * ── 为什么 `PROVENANCE.md` 不在树里 ──
 * 它是产物旁边的**来路说明书**,不是模型能看见的世界内容:沙箱挂载只 `--ro-bind`
 * `bin/` 与 `contract/` 两个目录。把它算进整棵树哈希,会让「改一句说明」变成「改模型世界」,
 * 于是哈希不再等于「模型看见的东西」。所以树 = 被挂载的那部分,判据清晰:
 * **整棵树哈希就是模型可见世界的哈希**。
 *
 * ── 静态 ELF 为什么自己解析,而不是 `ldd` / `file` ──
 * `ldd` 会**执行**目标文件(它本质上是跑 `ld.so --verify`,对不可信二进制是危险动作,
 * 这里虽然可信但形状不对),而且它报「not a dynamic executable」时与「文件坏了」同一档输出;
 * `file` 是外部命令,版本不同输出不同,门禁会跟着机器漂。判据要的是一次确定性的解析:
 * `ELF` 魔数 + 无 `PT_INTERP`——「没有程序解释器」正是「不向宿主借动态库」的可执行含义
 * (静态 PIE 也满足:它有 `PT_DYNAMIC` 但没有 `PT_INTERP`)。
 *
 * ── 本模块不碰 vitest、不抛错 ──
 * 与 `gate/vacuous.ts` 同一条分层纪律:判据层只把「哪里不对」写成可读的中文,由入口决定退出码。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * rootfs 产物的落点(相对仓库根)。与 `@model-war/schema` 的 `SANDBOX_ROOTFS_DIR` 是同一个
 * 路径——那边是给消费者读的常量,这边是组装脚本与门禁用的字面量,门禁核对两者一致。
 */
export const ROOTFS_DIR = "packages/gen/sandbox-rootfs";

/** 薄壳的唯一源码真源(相对仓库根)。三个名字是同一份字节的三个副本(工具名取自 `$0`)。 */
export const SHIM_SOURCE = "packages/gen/src/agent/shim/shim.sh";

/** 产物旁边的来路说明书。它不在挂载面上,也不算进整棵树哈希(理由见头注)。 */
export const ROOTFS_PROVENANCE_DOC = "PROVENANCE.md";

/** 被挂载的两个顶层目录:沙箱里的 `/bin` 与 `/contract`。 */
export const ROOTFS_MOUNTED_DIRS = ["bin", "contract"] as const;

/** 五个必须是静态 ELF 的二进制(路径相对 rootfs 根)。 */
export const ROOTFS_STATIC_BINARIES = [
  "bin/bash",
  "bin/cat",
  "bin/cp",
  "bin/grep",
  "bin/ls",
] as const;

/** 三个薄壳:rootfs 里那一份必须是 `packages/gen/src/agent/shim/shim.sh` 的逐字节副本。 */
export const ROOTFS_SHIM_NAMES = ["check", "done", "evaluate"] as const;

/** 一棵树里的一份内容:路径(相对 rootfs 根、`/` 分隔)+ 字节。 */
export type TreeEntry = { readonly path: string; readonly bytes: Buffer };

/**
 * 递归列出 rootfs 里**算进树里**的全部文件,按路径排序。
 *
 * 排序用默认的 UTF-16 码元序:rootfs 里的路径全是 ASCII,两种序在这一域内一致。
 * 显式说明是因为哈希口径依赖它——换一种排序就换一个数。
 */
export const rootfsFilePaths = (rootfsDir: string): readonly string[] => {
  const found: string[] = [];
  const walk = (relative: string): void => {
    const absolute = relative === "" ? rootfsDir : join(rootfsDir, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (relative === "" && entry.name === ROOTFS_PROVENANCE_DOC) {
        continue;
      }
      found.push(path);
    }
  };
  walk("");
  return found.sort();
};

/** 读一棵树的全部内容。路径清单与字节都取自磁盘,不抄清单。 */
export const readRootfsEntries = (rootfsDir: string): readonly TreeEntry[] =>
  rootfsFilePaths(rootfsDir).map((path) => ({ path, bytes: readFileSync(join(rootfsDir, path)) }));

/**
 * 整棵树哈希:`按路径排序 → 每份拼 `path\0bytes` → sha256`。
 *
 * `\0` 是分隔符,不是内容的一部分:路径里不可能出现 NUL,所以 `("a/b","c")` 与 `("a","b/c")`
 * 不会撞成同一串字节。空树得到 `sha256("")`——调用方必须把「0 份内容」当空转判红,别拿这个数
 * 当通过(`gate/vacuous.ts`)。
 */
export const treeDigest = (entries: readonly TreeEntry[]): string => {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    hash.update(entry.path, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
};

/** 一份静态 ELF 的解析结论。`static` 为假时 `reason` 说的是「它为什么不是」。 */
export type ElfVerdict = { readonly static: boolean; readonly reason: string } | undefined;

const PT_INTERP = 3;

/**
 * 解析 ELF 头与程序头,判「有没有程序解释器」。
 *
 * 不是 ELF(魔数不对、长度不够、程序头越过文件尾)一律返回 `undefined`——那是**解析失败**,
 * 与「是 ELF 但动态链接」是两件事,调用方要分别报。`undefined` 不当「静态」用。
 */
export const staticElfVerdict = (bytes: Buffer): ElfVerdict => {
  if (bytes.length < 64) return undefined;
  if (bytes.readUInt32BE(0) !== 0x7f454c46) return undefined; // \x7fELF
  const elfClass = bytes.readUInt8(4);
  const data = bytes.readUInt8(5);
  if (elfClass !== 2 || data !== 1) return undefined; // 只认 64 位小端
  const programOffset = Number(bytes.readBigUInt64LE(0x20));
  const programSize = bytes.readUInt16LE(0x36);
  const programCount = bytes.readUInt16LE(0x38);
  if (programSize < 4) return undefined;
  for (let index = 0; index < programCount; index += 1) {
    const at = programOffset + index * programSize;
    if (at + 4 > bytes.length) return undefined;
    if (bytes.readUInt32LE(at) === PT_INTERP) {
      return { static: false, reason: "有 PT_INTERP:它会向宿主要动态链接器" };
    }
  }
  return { static: true, reason: "" };
};

/** 文件在磁盘上是否可执行(薄壳与二进制都必须可执行,否则挂进去也跑不起来)。 */
export const isExecutableFile = (path: string): boolean => (statSync(path).mode & 0o111) !== 0;
