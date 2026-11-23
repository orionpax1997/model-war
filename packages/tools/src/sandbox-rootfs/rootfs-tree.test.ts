/**
 * 树口径与静态 ELF 判据的自测(纯函数 + 一处临时目录)。
 *
 * ── 为什么静态 ELF 要自己解析 ──
 * `ldd` 会**执行**目标文件,`file` 的输出随版本漂——两者都不适合当门禁的判据。判据要的是
 * 一次确定性解析:ELF 魔数 + **没有 `PT_INTERP`**。「没有程序解释器」正是「不向宿主要动态
 * 链接器」的可执行含义,而沙箱里连宿主 `/usr` 的一个 inode 都没有,带解释器的二进制在那个根里
 * 根本起不来——它只会先在本机看起来「能跑」。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  sandboxRootfsConstantsFrom,
  SCHEMA_CONSTANTS_SOURCE,
  staticBinariesOf,
} from "./rootfs-drift.ts";
import {
  ROOTFS_PROVENANCE_DOC,
  rootfsFilePaths,
  staticElfVerdict,
  treeDigest,
  type TreeEntry,
} from "./rootfs-tree.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const PT_LOAD = 1;
const PT_INTERP = 3;
const PROGRAM_HEADER_SIZE = 56;

/** 造一份最小 ELF64 头 + 若干程序头(`p_type` 只写这一个字段,判据也只读它)。 */
const elfWith = (programTypes: readonly number[]): Buffer => {
  const bytes = Buffer.alloc(64 + programTypes.length * PROGRAM_HEADER_SIZE);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(bytes, 0); // \x7fELF,64 位,小端
  bytes.writeBigUInt64LE(64n, 0x20); // e_phoff:程序头紧跟 ELF 头
  bytes.writeUInt16LE(PROGRAM_HEADER_SIZE, 0x36); // e_phentsize
  bytes.writeUInt16LE(programTypes.length, 0x38); // e_phnum
  for (const [index, type] of programTypes.entries()) {
    bytes.writeUInt32LE(type, 64 + index * PROGRAM_HEADER_SIZE);
  }
  return bytes;
};

const write = (root: string, path: string, contents: string): void => {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
};

describe("整棵树哈希", () => {
  const entries: readonly TreeEntry[] = [
    { path: "bin/bash", bytes: Buffer.from("bash") },
    { path: "contract/rules.md", bytes: Buffer.from("rules") },
  ];

  it("对顺序不敏感:同一个文件集换个枚举顺序还是同一个数", () => {
    expect(treeDigest([...entries].reverse())).toBe(treeDigest(entries));
    expect(treeDigest(entries)).toBe(treeDigest([entries[1]!, entries[0]!]));
  });

  it("对内容与路径都敏感:改一个字节、动一个名字都换一个数", () => {
    const base = treeDigest(entries);
    expect(treeDigest([{ ...entries[0]!, bytes: Buffer.from("bash!") }, entries[1]!])).not.toBe(
      base,
    );
    expect(treeDigest([{ ...entries[0]!, path: "bin/sh" }, entries[1]!])).not.toBe(base);
  });

  it("路径与字节之间有分隔符:挪一个 `/` 不会撞成同一个数", () => {
    // 没有 `\0` 的话 `("ab","c")` 与 `("a","bc")` 串接后完全一样。
    expect(treeDigest([{ path: "ab", bytes: Buffer.from("c") }])).not.toBe(
      treeDigest([{ path: "a", bytes: Buffer.from("bc") }]),
    );
  });
});

describe("静态 ELF 判据", () => {
  it("无 PT_INTERP 的 ELF 是静的(静态 PIE 也满足)", () => {
    expect(staticElfVerdict(elfWith([PT_LOAD]))).toEqual({ static: true, reason: "" });
    expect(staticElfVerdict(elfWith([]))?.static).toBe(true);
  });

  it("有 PT_INTERP 就是「会向宿主要动态链接器」,并把理由说出来", () => {
    const verdict = staticElfVerdict(elfWith([PT_LOAD, PT_INTERP]));
    expect(verdict?.static).toBe(false);
    expect(verdict?.reason).toContain("PT_INTERP");
  });

  it("不是 ELF / 被截断时返回 undefined:解析失败不当「静态」用", () => {
    expect(staticElfVerdict(Buffer.from("#!/bin/bash\necho hi\n"))).toBeUndefined();
    expect(staticElfVerdict(Buffer.alloc(0))).toBeUndefined();
    // 程序头越过文件尾:截断,判不了(`p_type` 那 4 个字节落在 64..68,切到 66 就缺一半)。
    const truncated = elfWith([PT_LOAD]).subarray(0, 66);
    expect(staticElfVerdict(truncated)).toBeUndefined();
  });
});

describe("文件枚举", () => {
  it("递归、排序、且把来路说明书排除在树外", () => {
    const dir = mkdtempSync(join(tmpdir(), "model-war-rootfs-tree-"));
    try {
      write(dir, "bin/bash", "b");
      write(dir, ROOTFS_PROVENANCE_DOC, "说明");
      write(dir, "contract/examples/minimal.ts", "m");
      expect(rootfsFilePaths(dir)).toEqual(["bin/bash", "contract/examples/minimal.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("真实 rootfs:清单里每个 bin/ 都在,且真的没有 PT_INTERP", () => {
    const rootfsDir = join(repoRoot, "packages/gen/sandbox-rootfs");
    const paths = rootfsFilePaths(rootfsDir);
    // 哪几个要过这条判断由 schema 的清单推出来,本文件不另写一张:上一轮给 `cp` 补清单时,
    // 第二张手写表(`ROOTFS_STATIC_BINARIES`)就是漏写也不会红的那个位置。
    const parsed = sandboxRootfsConstantsFrom(
      readFileSync(`${repoRoot}${SCHEMA_CONSTANTS_SOURCE}`, "utf8"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const binaries = staticBinariesOf(parsed.constants.files);
    expect(binaries.length, "推导出 0 个二进制:清单抽空了").toBeGreaterThan(0);
    for (const path of binaries) {
      expect(paths, `${path} 不在入库 rootfs 里`).toContain(path);
      expect(
        staticElfVerdict(readFileSync(join(rootfsDir, path)))?.static,
        `${path} 不是静态 ELF`,
      ).toBe(true);
    }
    expect(paths).not.toContain(ROOTFS_PROVENANCE_DOC);
  });
});
