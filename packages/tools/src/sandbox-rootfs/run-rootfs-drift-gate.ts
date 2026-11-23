/**
 * 门禁:入库沙箱 rootfs 的**现算 == 入库**(根脚本 `gate:rootfs`)。
 *
 * 用法:`node packages/tools/src/sandbox-rootfs/run-rootfs-drift-gate.ts`
 *
 * ── 它守的是什么 ──
 * 沙箱里模型能看见的每一个字节都来自 `packages/gen/sandbox-rootfs/`。这份产物入库、以字节为准
 * (ADR-0033;形状照 ADR-0007 对 runtime bundle 的处理),因为「内容物可钉」正是把容器方案里
 * 唯一真实的优势搬了过来:钉住之后,两台机器上的成绩差异不再需要先排除「bash 版本不同」。
 * 钉住的前提是**有人盯着**——产物入库后,改了内容不重算哈希会让库里的产物停在旧版,而它照样
 * 挂得进去、照样跑得起来。这条门禁就是那个盯着的人。
 *
 * ── 六条判据(实现在 `rootfs-check.ts`,纯判据在 `rootfs-drift.ts`) ──
 * ① 整棵树哈希 == `SANDBOX_ROOTFS_TREE_HASH`;② 磁盘文件集 == `SANDBOX_ROOTFS_FILES`
 * (多一个少一个都红);③ `bin/` 里**每一份**都是静态 ELF(自解析 ELF,不靠 `ldd` / `file`),
 * 且都可执行;④ `contract/*` 与 `docs/rules-v2/*` 逐字节相同;
 * ⑤ 产物目录顶层只许 `bin/`、`contract/` 与来路说明书;
 * ⑥ `PROVENANCE.md` 的来路表与入库的静态二进制一一对应,且它声称的 sha256 就是盘上那串
 * (它不在挂载面上、也不算进树哈希,所以这条是它唯一会红的地方)。
 *
 * 旧的第五条(「三个薄壳副本与源码真源逐字节相同」)**已删除**:真源与副本一起消失(票 03,
 * 见 `docs/adr/0029-bash-mini-harness-identity.md`:模型没有那条路径)。
 *
 * ── 为什么在 `quick` 上(而 `verify:kernel` 不在) ──
 * 这一条**零构建**:它读二进制但不编译任何东西,也不碰内核能力,所以放得进快门禁——PR 上就能
 * 拦住「顺手升级 bash」。常量从 `packages/schema/src/sandbox-rootfs.ts` 的**源码文本**里取
 * (不 import 真源包:它的 `exports` 指向 `dist/`,import 就让快门禁依赖一次 `tsc -b`)。
 * `verify:kernel` 要真跑 bwrap(装包、命名空间、无网络),那是环境能力,归 nightly 的硬腿与
 * 自己那条命名脚本;把它塞进 `check` 会让没有 bwrap 的机器上「全量门禁」变红,而那条红在说
 * 「这台机器没装 bubblewrap」,不是在说提交内容有问题。
 *
 * 退出码:0 = 六条全过;1 = 任一条不成立(含「一个文件都没读到」这种空转)。
 */

import { resolve } from "node:path";

import { vacuousReason } from "../gate/vacuous.ts";
import { checkRootfsTree, rootfsCheckSummary } from "./rootfs-check.ts";

/** 本文件在 `<repo>/packages/tools/src/sandbox-rootfs/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

const main = (): number => {
  const check = checkRootfsTree(repoRoot);

  const vacuous = vacuousReason(check.files, {
    subject: "入库 rootfs 的内容物文件",
    scope: check.dir === "" ? "packages/gen/sandbox-rootfs" : check.dir,
  });
  if (vacuous !== "") {
    process.stderr.write(`✗ ${vacuous}\n`);
    process.stdout.write("rootfs 漂移门禁:红(rootfs 是空的,七条判据一条都没有对象可判)\n");
    return 1;
  }

  if (check.findings.length > 0) {
    for (const finding of check.findings) {
      process.stderr.write(`✗ ${finding.where}:${finding.detail}\n`);
    }
    process.stdout.write(
      `rootfs 漂移门禁:红(${String(check.findings.length)} 处)。产物是生成物,别手改:` +
        "改真源 → `pnpm run build:rootfs` → 把新哈希与清单手写回 schema。\n",
    );
    return 1;
  }

  process.stdout.write(`✓ ${rootfsCheckSummary(check, "rootfs 漂移门禁:")}\n`);
  process.stdout.write("rootfs 漂移门禁:绿(门禁跑的就是入库的那棵树)\n");
  return 0;
};

process.exitCode = main();
