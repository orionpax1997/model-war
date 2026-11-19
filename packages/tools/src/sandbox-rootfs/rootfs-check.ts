/**
 * 入库 rootfs 的**判据接线**:把读盘与纯判据(`rootfs-drift.ts`)接起来,交回一份结论。
 *
 * 两处消费者:`run-rootfs-drift-gate.ts`(`check:sandbox-rootfs`,快门禁上的一条独立门禁)与
 * `run-sandbox-gate.ts`(`check:sandbox` 四件事里的「rootfs 漂移」那一条)。判据只有一份,
 * 两个入口读同一份——分别实现会让「两条腿都说自己查了 rootfs」而实际口径不同。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_DIR, CONTRACT_FILES } from "../contract-package.ts";
import {
  byteCopyFinding,
  executableFinding,
  manifestFindings,
  provenanceFindings,
  provenanceRows,
  sandboxRootfsConstantsFrom,
  SCHEMA_CONSTANTS_SOURCE,
  shimPathsOf,
  staticBinariesOf,
  staticBinaryFinding,
  topLevelFindings,
  treeHashFinding,
  type RootfsFinding,
} from "./rootfs-drift.ts";
import {
  ROOTFS_MOUNTED_DIRS,
  ROOTFS_PROVENANCE_DOC,
  SHIM_SOURCE,
  isExecutableFile,
  readRootfsEntries,
  rootfsFilePaths,
  sha256Of,
  staticElfVerdict,
  treeDigest,
} from "./rootfs-tree.ts";

/** 一次 rootfs 检查的结论。空转(`files === 0`)由入口按共享件判,本模块不替它下判决。 */
export type RootfsCheck = {
  /** 违规清单;空 = 七条判据全过。 */
  readonly findings: readonly RootfsFinding[];
  /** 被查的内容物份数。0 时七条判据全部没有对象可判,入口必须按空转判红(`gate/vacuous.ts`)。 */
  readonly files: number;
  /** 现算的整棵树哈希(报告用)。 */
  readonly treeHash: string;
  /** 过了静态 ELF 判据的二进制份数(从清单派生,报告用)。 */
  readonly staticBinaries: number;
  /** 过了逐字节判据的薄壳份数(同上)。 */
  readonly shims: number;
  /** 产物目录(仓库相对路径)。常量抽不出来时为空串。 */
  readonly dir: string;
};

/** 跑一遍全部判据。`repoRoot` 传仓库根。 */
export const checkRootfsTree = (repoRoot: string): RootfsCheck => {
  const schemaSource = readFileSync(join(repoRoot, SCHEMA_CONSTANTS_SOURCE), "utf8");
  const parsed = sandboxRootfsConstantsFrom(schemaSource);
  if (!parsed.ok) {
    // 常量抽不出来时七条判据一条都无从判起:按失败交回,理由就是为什么无力判。
    return {
      findings: [{ where: SCHEMA_CONSTANTS_SOURCE, detail: parsed.reason }],
      files: 0,
      treeHash: "",
      staticBinaries: 0,
      shims: 0,
      dir: "",
    };
  }
  const { dir, files, treeHash, shims } = parsed.constants;
  // 「谁是什么」全部从清单推出来(本文件不另写一张):`bin/*` 减掉薄壳 = 必须静态 ELF 的那些。
  const shimPaths = shimPathsOf(shims);
  const staticBinaries = staticBinariesOf(files, shims);
  const rootfsDir = join(repoRoot, dir);
  const entries = readRootfsEntries(rootfsDir);
  const actualPaths = rootfsFilePaths(rootfsDir);
  const findings: RootfsFinding[] = [];
  const push = (finding: RootfsFinding | undefined): void => {
    if (finding !== undefined) findings.push(finding);
  };

  // 一棵树里 0 个文件时,哈希只是 sha256("")、清单比对两边都是空集,七条判据全部「通过」而
  // 什么都没断言。判决归入口的 `vacuousReason`(共享件),这里只把计数交出去。
  if (actualPaths.length === 0) {
    return { findings, files: 0, treeHash: "", staticBinaries: 0, shims: 0, dir };
  }

  // ① 整棵树哈希 == 常量。
  const actualHash = treeDigest(entries);
  push(treeHashFinding(treeHash, actualHash));

  // ② 磁盘文件集 == 清单(多一个少一个都红)。
  findings.push(...manifestFindings(files, actualPaths));

  // ③ `bin/` 里除薄壳之外都是静态 ELF(清单里缺的文件由 ② 报,这里不重复)。
  //    顺手收下每份的字节 sha256:判据 ⑦ 要用它来核对来路说明书上那串 hex。
  const staticBinaryBytes: { path: string; sha256: string }[] = [];
  for (const path of staticBinaries) {
    if (!actualPaths.includes(path)) continue;
    const bytes = readFileSync(join(rootfsDir, path));
    staticBinaryBytes.push({ path, sha256: sha256Of(bytes) });
    push(staticBinaryFinding(path, staticElfVerdict(bytes)));
  }

  // ④ 契约副本 == 真源(`docs/rules-v2/`)。盘上缺的那份由 ② 报(它是清单的双向比对),
  // 这里跳过只是不拿两次同样的红去吵——不是说缺了没关系。
  for (const file of CONTRACT_FILES) {
    const copyPath = `contract/${file}`;
    if (!actualPaths.includes(copyPath)) continue;
    push(
      byteCopyFinding(
        copyPath,
        `${CONTRACT_DIR}/${file}`,
        readFileSync(join(rootfsDir, copyPath)),
        readFileSync(join(repoRoot, CONTRACT_DIR, file)),
      ),
    );
  }

  // ⑤ 薄壳 == 源码真源;`bin/*` 全部可执行(缺的那几份同样由 ② 报)。
  const shimSource = readFileSync(join(repoRoot, SHIM_SOURCE));
  for (const copyPath of shimPaths) {
    if (!actualPaths.includes(copyPath)) continue;
    push(
      byteCopyFinding(copyPath, SHIM_SOURCE, readFileSync(join(rootfsDir, copyPath)), shimSource),
    );
  }
  for (const path of actualPaths.filter((path) => path.startsWith("bin/"))) {
    push(executableFinding(path, isExecutableFile(join(rootfsDir, path))));
  }

  // ⑥ 产物目录顶层只许 bin/、contract/ 与来路说明书。
  findings.push(
    ...topLevelFindings(readdirSync(rootfsDir), [...ROOTFS_MOUNTED_DIRS, ROOTFS_PROVENANCE_DOC]),
  );

  // ⑦ 来路说明书:表里每份二进制都有一行,那串 sha256 与盘上字节相符,且没有多出来的行。
  //    这份文件不在挂载面上、也不算进树哈希(理由见 `rootfs-tree.ts` 头注),所以改它不会让
  //    任何别的判据红——它自己的判据只能在这里。
  const provenancePath = join(rootfsDir, ROOTFS_PROVENANCE_DOC);
  if (!existsSync(provenancePath)) {
    findings.push({
      where: ROOTFS_PROVENANCE_DOC,
      detail:
        "产物目录里没有来路说明书。它不入树哈希、也不上挂载面,缺了不会有别的判据发现:" +
        "跑 `pnpm run sandbox:rootfs:build` 重新生成。",
    });
  } else {
    findings.push(
      ...provenanceFindings(
        provenanceRows(readFileSync(provenancePath, "utf8")),
        staticBinaryBytes,
      ),
    );
  }

  return {
    findings,
    files: actualPaths.length,
    treeHash: actualHash,
    staticBinaries: staticBinaries.length,
    shims: shimPaths.length,
    dir,
  };
};

/** 一条结论的人话摘要(两个入口共用,免得两处措辞分叉)。 */
export const rootfsCheckSummary = (check: RootfsCheck, greenPrefix: string): string =>
  `${greenPrefix}${check.dir} 的 ${String(check.files)} 份内容物` +
  `(sha256 ${check.treeHash.slice(0, 12)}…)与常量一致;文件集不多不少;` +
  // 计数从清单派生,不写字面量:加了一个二进制之后这里还写着上一个数,是一句读起来毫无异样的假话。
  `${String(check.staticBinaries)} 个二进制是静态 ELF 且 ${ROOTFS_PROVENANCE_DOC} 的来路与字节相符;` +
  `contract/ 与 ${CONTRACT_DIR}/ 逐字节相同;${String(check.shims)} 个薄壳与 ${SHIM_SOURCE} 逐字节相同。`;
