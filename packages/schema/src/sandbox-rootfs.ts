/**
 * 入库沙箱 rootfs 的**工程常量**:产物路径、期望文件清单、整棵树的哈希、挂载面。
 *
 * ── 为什么要这三个常量、家为什么在这里 ──
 * rootfs 是**入库产物**:沙箱里模型能看见的每一个字节都是它,所以它必须「以字节为准、可被
 * 第三方核对」。核对需要三样东西——去哪儿找(`SANDBOX_ROOTFS_DIR`)、应该有哪些文件
 * (`SANDBOX_ROOTFS_FILES`)、那些字节合起来是什么(`SANDBOX_ROOTFS_TREE_HASH`)。
 * 它们被两侧读:`packages/gen` 的执行器(把 rootfs 挂成 `/`)与 `packages/tools` 的漂移门禁
 * (现算 == 入库)。本包是两边都已能 import 的共享常量之家,形状与 `sandbox-runtime.ts` 同款
 * (ADR-0007)。
 *
 * ── 这个哈希与契约包身份不是同一个数 ──
 * 两边口径同源(`按路径排序 → path\0bytes 串接 → sha256`),但**范围不同**:这里是
 * **整棵 rootfs**(bash + 三个 coreutils + 三个薄壳 + `contract/` 四条),契约包身份只算
 * `docs/rules-v2/` 那四条。别把两个数当同一个用:只换 bash 版本时,模型世界的哈希应该变,
 * 契约身份不应该变——合成一个数就把两种断代混成一种。
 *
 * ── 为什么是手写常量,而不是「运行时现算」 ──
 * 与 runtime bundle 同一条纪律:判据锚定确切字节,不锚运行目录。改产物后跑
 * `pnpm run sandbox:rootfs:build` 重算并手写回这里,门禁(`check:sandbox-rootfs`)负责证明
 * 两者一致,并顺带证明清单不多不少、四个二进制确实是静态 ELF、`contract/` 与 `docs/rules-v2/`
 * 逐字节相同、薄壳与 `packages/gen/src/agent/shim/shim.sh` 逐字节相同。
 *
 * ── `PROVENANCE.md` 不在清单里 ──
 * 它是产物旁边的来路说明书,不是挂载面:沙箱只 `--ro-bind` 这棵树的 `bin/` 与 `contract/`
 * 两个目录,所以整棵树哈希 = 模型可见世界的哈希,改一句说明不该改这个数。
 */

/** rootfs 产物**相对仓库根**的路径。落点刻意避开任何 `dist/`(`.gitignore` 里那条是无锚点规则)。 */
export const SANDBOX_ROOTFS_DIR = "packages/gen/sandbox-rootfs";

/**
 * 期望的文件清单(相对 rootfs 根、`/` 分隔、字典序)。
 *
 * 「多一个少一个都红」由它承担,而不是由人记:新增内容物要同时改清单、哈希与
 * `docs/adr/0033-sandbox-executor.md` 那张内容物表——三处都要改,所以它不可能悄悄长大。
 */
export const SANDBOX_ROOTFS_FILES = [
  "bin/bash",
  "bin/cat",
  "bin/check",
  "bin/done",
  "bin/evaluate",
  "bin/grep",
  "bin/ls",
  "contract/README.md",
  "contract/api.md",
  "contract/examples/minimal.ts",
  "contract/rules.md",
] as const;

/**
 * 整棵 rootfs 的树哈希:**按路径排序、每份拼 `path\0bytes`、串接后 sha256**。
 *
 * **本常量的书写真源是产物本身**:`pnpm run sandbox:rootfs:build` 打印它,人抄回这里,
 * 门禁证明「现算 == 这里写的」。它是「模型看见的世界还是不是那份字节」的唯一判据。
 */
export const SANDBOX_ROOTFS_TREE_HASH =
  "10b0e32b275e0aafb2c421b4fbc0441b8b7889c4e47af3b036cca0289ed18270";

/** 被挂载的两个顶层目录:沙箱里的 `/bin` 与 `/contract`。 */
export const SANDBOX_ROOTFS_BIN_DIR = "bin";

/** 只读契约在 rootfs 里的目录名,挂载点固定是 `/contract`(与契约包 `CONTRACT_FILES` 对齐)。 */
export const SANDBOX_ROOTFS_CONTRACT_DIR = "contract";
