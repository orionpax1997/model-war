/**
 * 冻结脚本存档的组装与**原子落盘**(hld §7.4)。
 *
 * ── 三件套的名字与写盘纪律归本文件 ──
 *
 * 存档 `archive/<modelSlug>/<runId>/` 的拓扑是三件套 `script.ts` / `script.js` / `meta.json`
 * (hld §7.4)。编译步骤(怎么从 `script.ts` 得到 `script.js`)归 `compile.ts`;本文件只认
 * 「三件套叫什么、以什么顺序、落到哪里」,并把这条拓扑做成常量供编译步骤与测试共用。
 *
 * ── 为什么临时目录必须建在 `archive/<slug>/` 下 ──
 *
 * `fs.rename` 只在**同一文件系统**内是原子的。若临时目录建在 `os.tmpdir()`(在容器里常是
 * 另一个挂载点),rename 到 `archive/` 会抛 `EXDEV`,恰好破坏「目录存在 ⇔ 三件套完整」这条
 * 不变量。所以临时目录开在 `archive/<slug>/` 的兄弟路径下,与目标同盘。
 *
 * ── 为什么先写 `meta.json` 再 rename、失败一律清理 ──
 *
 * 三件套在临时目录里组装齐(缺一件都不可能进入 rename 那一步),rename 是唯一的「发布」动作:
 * 它要么不发生(临时目录被清理,`archive/<slug>/<runId>/` 不存在),要么一次把完整三件套
 * 呈现出来。于是装载段永远不会看到一个只有 `script.js` 没有 `meta.json` 的半截目录。
 *
 * ── 为什么 `ruleset` 与 `sandboxRuntimeHash` 不进入参 ──
 *
 * 这两个值不是「调用方给的」,而是**本仓常量**:`ruleset` = `RULESET_VERSION`、
 * `sandboxRuntimeHash` = `SANDBOX_RUNTIME_HASH`(契约 §3)。把它们做成入参等于给「填错」
 * 留一条口子,所以由本文件从真源常量直接填——生成管线连传都传不进来。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  RULESET_VERSION,
  SANDBOX_RUNTIME_HASH,
  type ArchiveMeta,
  type ArchiveValidation,
} from "@model-war/schema";

/** 存档三件套的定名(hld §7.4)。编译步骤与测试都从这里取,不各写一份字面量。 */
export const SCRIPT_SOURCE_NAME = "script.ts";
export const SCRIPT_PRODUCT_NAME = "script.js";
export const ARCHIVE_META_NAME = "meta.json";

/** 临时组装目录的前缀;失败清理后 `archive/<slug>/` 下不应残留任何以它开头的条目。 */
export const STAGING_DIR_PREFIX = ".tmp-";

/** `script.js` / meta 里那些哈希的表示:小写十六进制,由本函数一处算。 */
export const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * 组装 `meta.json` 的十一项(形状真源:`packages/schema/src/archive-meta.ts`,一字不改)。
 *
 * 只填值:字段序即 schema 的书写序,`protocolRounds` 由 `prompts.length` 推得(两者相等是
 * 装载期不变量),`ruleset` / `sandboxRuntimeHash` 从本仓常量填,`scriptSha256` 由调用方现场
 * 读 `script.js` 字节算出后传入。
 */
export type BuildArchiveMetaInput = {
  readonly model: string;
  readonly modelVersion: string;
  readonly generatedAt: string;
  readonly prompts: readonly string[];
  readonly generationLog: readonly string[];
  readonly validation: ArchiveValidation;
  readonly tscVersion: string;
  readonly scriptSha256: string;
};

export const buildArchiveMeta = (input: BuildArchiveMetaInput): ArchiveMeta => ({
  model: input.model,
  modelVersion: input.modelVersion,
  generatedAt: input.generatedAt,
  protocolRounds: input.prompts.length,
  prompts: input.prompts,
  generationLog: input.generationLog,
  ruleset: RULESET_VERSION,
  validation: input.validation,
  tscVersion: input.tscVersion,
  scriptSha256: input.scriptSha256,
  sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
});

/** 在 `archive/<slug>/` 下开一个同文件系统的临时组装目录,返回它的绝对路径。 */
export const openStagingDir = (root: string, slug: string): string => {
  const archiveDir = join(root, "archive", slug);
  mkdirSync(archiveDir, { recursive: true });
  return mkdtempSync(join(archiveDir, STAGING_DIR_PREFIX));
};

/** 失败清理:整棵删掉临时目录。目标不存在时是空操作(`force`),可在 `finally` 里无条件调。 */
export const discardStagingDir = (stagingDir: string): void => {
  rmSync(stagingDir, { recursive: true, force: true });
};

export type CommitResult =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 原子发布:写 `meta.json` → `rename` 到 `archive/<slug>/<runId>/`。
 *
 * 调用前临时目录里必须已有 `script.ts` 与 `script.js`(编译步骤落下的);目标目录已存在
 * (秒级 `runId` 撞车)即拒绝,不覆盖。失败时调用方负责 `discardStagingDir`。
 */
export const commitArchive = (options: {
  readonly root: string;
  readonly slug: string;
  readonly runId: string;
  readonly stagingDir: string;
  readonly meta: ArchiveMeta;
}): CommitResult => {
  const targetDir = join(options.root, "archive", options.slug, options.runId);
  if (existsSync(targetDir)) {
    return { ok: false, reason: `目标存档目录已存在,拒绝覆盖:${targetDir}` };
  }
  writeFileSync(
    join(options.stagingDir, ARCHIVE_META_NAME),
    `${JSON.stringify(options.meta, null, 2)}\n`,
    "utf8",
  );
  renameSync(options.stagingDir, targetDir);
  return { ok: true, dir: targetDir };
};
