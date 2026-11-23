/**
 * rootfs 漂移判据的自测:常量抽取、六条判据的**每条两个方向**,以及「真实这棵树现在是绿的」。
 *
 * ── 为什么最后那条最重要 ──
 * 其余用例证明判据会红、也会绿;只有「真实这棵树绿」把判据接到了入库产物上——它让默认的
 * `pnpm run test`(常跑链)也能拦住「顺手升级 bash」,而不是等到 nightly 的
 * `check:sandbox-rootfs` 才拦。反过来说,如果哪天这条红了,那不是测试坏了,是产物真的变了。
 *
 * ── 常量为什么从源码文本抽 ──
 * `check:sandbox-rootfs` 挂在 `check:quick` 上,快门禁必须零构建(`@model-war/schema` 的
 * `exports` 指向 `dist/`)。所以抽取器也在这里测:抽不出来必须是**明确的失败**,不能静默放行。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  byteCopyFinding,
  executableFinding,
  manifestFindings,
  provenanceFindings,
  provenanceRows,
  sandboxRootfsConstantsFrom,
  SCHEMA_CONSTANTS_SOURCE,
  staticBinariesOf,
  staticBinaryFinding,
  topLevelFindings,
  treeHashFinding,
} from "./rootfs-drift.ts";
import { checkRootfsTree } from "./rootfs-check.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const schemaSource = readFileSync(`${repoRoot}${SCHEMA_CONSTANTS_SOURCE}`, "utf8");

describe("从 schema 源码文本里抽常量", () => {
  it("三个常量都抽得到:路径、清单、哈希", () => {
    const parsed = sandboxRootfsConstantsFrom(schemaSource);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.constants.dir).toBe("packages/gen/sandbox-rootfs");
    expect(parsed.constants.files).toContain("bin/bash");
    expect(parsed.constants.treeHash).toMatch(/^[0-9a-f]{64}$/u);
    // 薄壳那三个名字**不在**清单里:它们是宿主工具,不是沙箱内容物(票 03)。
    expect(parsed.constants.files).not.toContain("bin/check");
    expect(parsed.constants.files).not.toContain("bin/evaluate");
    expect(parsed.constants.files).not.toContain("bin/finish");
  });

  it("抽不出来时点名缺的是哪一个,并按失败交回(不猜、不跳过)", () => {
    const parsed = sandboxRootfsConstantsFrom('export const SANDBOX_ROOTFS_DIR = "x";\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("SANDBOX_ROOTFS_FILES");
    expect(parsed.reason).toContain("SANDBOX_ROOTFS_TREE_HASH");
    // 抽不到的那一个不报,抽到的也不报:报告要能直接指出改哪儿。
    expect(parsed.reason).not.toContain("SANDBOX_ROOTFS_DIR /");
    expect(parsed.reason).toContain("零构建");
  });

  it("空数组按「抽不出来」处理:0 份内容物的清单什么也钉不住", () => {
    const source = [
      'export const SANDBOX_ROOTFS_DIR = "x";',
      "export const SANDBOX_ROOTFS_FILES = [] as const;",
      'export const SANDBOX_ROOTFS_TREE_HASH = "abc";',
      "",
    ].join("\n");
    expect(sandboxRootfsConstantsFrom(source).ok).toBe(false);
  });
});

describe("「谁是什么」从清单推出来,不另写一张表", () => {
  it("清单里新加一个 bin/,当场进静态 ELF 判据(没有例外这一类了)", () => {
    // 上一轮给 `cp` 补清单时,门禁侧的手写二进制表漏写它不会有任何红:判据只遍历那张表。
    // 现在是反过来的——新增内容物写进清单,它自动被静态 ELF 判据覆盖。
    //
    // 这里曾经还有一个「减掉薄壳」的参数:`bin/` 里有三个名字不是 ELF。那三个副本随通道删除
    // (票 03),"例外"这一类因此消失——分类退化成一条,而它仍然是从清单推的。
    const binaries = staticBinariesOf(["bin/bash", "bin/cp", "contract/rules.md"]);
    expect(binaries).toEqual(["bin/bash", "bin/cp"]);
  });
});

describe("六条判据各自两个方向", () => {
  it("① 树哈希:相符时没有话说,不符时把现算值与处方一起给", () => {
    expect(treeHashFinding("same", "same")).toBeUndefined();
    const finding = treeHashFinding("expected", "actual");
    expect(finding?.detail).toContain("actual");
    expect(finding?.detail).toContain("expected");
    expect(finding?.detail).toContain("sandbox:rootfs:build");
  });

  it("② 文件集:多一个与少一个各报一条,顺序稳定", () => {
    expect(manifestFindings(["a", "b"], ["b", "a"])).toEqual([]);
    const extra = manifestFindings(["a"], ["a", "z-extra"]);
    expect(extra).toHaveLength(1);
    expect(extra[0]?.where).toBe("z-extra");
    expect(extra[0]?.detail).toContain("多了一份不在清单里");
    const missing = manifestFindings(["a", "z-missing"], ["a"]);
    expect(missing[0]?.where).toBe("z-missing");
    expect(missing[0]?.detail).toContain("盘上没有");
  });

  it("③ 静态 ELF:非静态解释原因;解析不出时说的是「解析不出」而不是「动态链接」", () => {
    expect(staticBinaryFinding("bin/bash", { static: true, reason: "" })).toBeUndefined();
    const dynamic = staticBinaryFinding("bin/bash", { static: false, reason: "有 PT_INTERP" });
    expect(dynamic?.detail).toContain("有 PT_INTERP");
    expect(dynamic?.detail).toContain("不从宿主借动态库");
    const broken = staticBinaryFinding("bin/bash", undefined);
    expect(broken?.detail).toContain("解析不出");
  });

  it("④ 逐字节副本:相同没有话说,不同则把两边字节数与真源路径都写出来", () => {
    const same = Buffer.from("x");
    expect(
      byteCopyFinding("contract/README.md", "docs/rules-v2/README.md", same, same),
    ).toBeUndefined();
    const finding = byteCopyFinding(
      "contract/README.md",
      "docs/rules-v2/README.md",
      same,
      Buffer.from("yy"),
    );
    expect(finding?.where).toBe("contract/README.md");
    expect(finding?.detail).toContain("docs/rules-v2/README.md");
    expect(finding?.detail).toContain("1 字节");
    expect(finding?.detail).toContain("2 字节");
  });

  it("④' 可执行位也是产物的一部分", () => {
    expect(executableFinding("bin/bash", true)).toBeUndefined();
    expect(executableFinding("bin/bash", false)?.detail).toContain("+x");
  });

  it("⑥ 来路说明书:三向都判——缺行、hex 不符、多出来的行", () => {
    const binaries = [
      { path: "bin/bash", sha256: "a".repeat(64) },
      { path: "bin/sed", sha256: "b".repeat(64) },
    ];
    const rows = [
      { name: "bin/bash", sha256: "a".repeat(64) },
      { name: "bin/sed", sha256: "b".repeat(64) },
    ];
    expect(provenanceFindings(rows, binaries)).toEqual([]);
    const missing = provenanceFindings(rows.slice(0, 1), binaries);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.detail).toContain("bin/sed");
    const wrong = provenanceFindings(
      [rows[0]!, { name: "bin/sed", sha256: "c".repeat(64) }],
      binaries,
    );
    expect(wrong).toHaveLength(1);
    expect(wrong[0]?.where).toBe("bin/sed");
    expect(wrong[0]?.detail).toContain("c".repeat(64));
    const extra = provenanceFindings(
      [...rows, { name: "bin/gone", sha256: "d".repeat(64) }],
      binaries,
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]?.where).toBe("bin/gone");
  });

  it("⑥ 来路表的形态:只认「产物 | 版本 | sha256」三列且前两列是 bin/ 路径与 hex 的行", () => {
    const markdown = [
      "| 产物 | 版本 | 字节 sha256 |",
      "|---|---|---|",
      `| \`bin/sed\` | GNU sed 4.9 | \`${"f".repeat(64)}\` |`,
      "| `bin/x` | 版本 | 不是 hex |",
      "正文里出现 `bin/not-a-row` 不算",
    ].join("\n");
    expect(provenanceRows(markdown)).toEqual([{ name: "bin/sed", sha256: "f".repeat(64) }]);
  });

  it("⑤ 顶层只许两个挂载目录与来路说明书", () => {
    expect(
      topLevelFindings(["bin", "contract", "PROVENANCE.md"], ["bin", "contract", "PROVENANCE.md"]),
    ).toEqual([]);
    const findings = topLevelFindings(
      ["bin", "contract", "coreutils-9.12.tar.xz"],
      ["bin", "contract"],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where).toBe("coreutils-9.12.tar.xz");
    expect(findings[0]?.detail).toContain("构建残骸");
  });
});

describe("真实入库产物", () => {
  it("现在这棵树是绿的:六条判据全过,且查到了内容物", () => {
    const check = checkRootfsTree(repoRoot);
    expect(check.findings).toEqual([]);
    // 空转的反面:真的读到了东西。份数由清单决定,这里只要求非零——写死数字会让「加一份内容物」
    // 变成一次与本次改动无关的测试修正。
    expect(check.files).toBeGreaterThan(0);
    expect(check.treeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(check.dir).toBe("packages/gen/sandbox-rootfs");
  });
});
