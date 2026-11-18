/**
 * 组装入库 rootfs(根脚本 `sandbox:rootfs:build`)。
 *
 * 用法:
 *
 * ```
 * node packages/tools/src/sandbox-rootfs/build-rootfs.ts [--static-bin-dir <dir>]
 * ```
 *
 * 产物落 `packages/gen/sandbox-rootfs/`(路径真源在 `@model-war/schema` 的 `SANDBOX_ROOTFS_DIR`):
 *
 * ```
 * bin/{bash,cat,cp,grep,ls}       五个静态 ELF,不从宿主借、不带动态库闭包
 * bin/{check,evaluate,done}       `packages/gen/src/agent/shim/shim.sh` 的逐字节副本
 * contract/{README.md,rules.md,api.md,examples/minimal.ts}   `docs/rules-v2/` 的逐字节副本
 * PROVENANCE.md                   来路说明书(生成物,不在挂载面上)
 * ```
 *
 * ── 两半:能现算的,与只能对账的 ──
 * `contract/` 与三个薄壳是**纯派生**:源在仓库里,重跑一次逐字节相同。五个二进制不是——
 * 它们要么来自发行版包(`bash-static` 的 deb),要么来自钉版 tarball 的 `gcc -static` 构建过程,
 * 重跑需要网络与工具链。所以这里对它们只做一件事:**核对 sha256 与钉死的表一致再拷进来**。
 * 来路写进 `PROVENANCE.md`,`SANDBOX_ROOTFS_TREE_HASH` 钉住最终字节;两者一起回答
 * 「这份二进制是谁、从哪、怎么来的」与「它现在还是不是那份字节」。
 *
 * 为什么不入库 tarball / deb / 构建目录:那三样都不是模型能看见的世界,入库只会让仓库长大、
 * 让「整棵树哈希」不再等于「模型可见世界的哈希」。可复算的输入留在 `PROVENANCE.md` 的命令行里
 * (URL + sha256 + configure 参数),人能照着做一遍。
 *
 * ── 为什么不用 busybox 顶 coreutils、也不借宿主二进制 ──
 * ADR-0033 已裁决:busybox 的 flag 语义与 coreutils 有差,`cat`/`ls`/`grep` 换成 busybox 会把
 * 「模型失败原因」污染成不可归类的一类噪声;从宿主借二进制则让 bash/glibc 版本随机器漂移,
 * 等价基线当场失效。这一条不在这里重开。
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CONTRACT_DIR, CONTRACT_FILES } from "../contract-package.ts";
import {
  ROOTFS_DIR,
  ROOTFS_MOUNTED_DIRS,
  ROOTFS_PROVENANCE_DOC,
  ROOTFS_SHIM_NAMES,
  SHIM_SOURCE,
  readRootfsEntries,
  rootfsFilePaths,
  treeDigest,
} from "./rootfs-tree.ts";

/** 本文件在 `<repo>/packages/tools/src/sandbox-rootfs/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

/**
 * 五个静态二进制**钉死**的来源。`sha256` 是唯一判据:拷进产物前逐个核对,不一致就停。
 *
 * 表的家在这里而不是在 schema:它不是运行时事实,只有本脚本与 `PROVENANCE.md` 读它。
 */
export type StaticBinaryPin = {
  /** 产物里的文件名(也是 `--static-bin-dir` 下的文件名)。 */
  readonly name: "bash" | "cat" | "cp" | "grep" | "ls";
  /** 版本号(写进 PROVENANCE)。 */
  readonly version: string;
  /** 从哪来:包名或 tarball 的 URL(写进 PROVENANCE)。 */
  readonly source: string;
  /** 人是照着这条命令得到那份字节的(写进 PROVENANCE)。 */
  readonly command: string;
  /** 字节 sha256。拷进产物前逐个核对。 */
  readonly sha256: string;
};

export const STATIC_BINARY_PINS: readonly StaticBinaryPin[] = [
  {
    name: "bash",
    version: "5.3-2ubuntu1",
    source:
      "https://mirrors.aliyun.com/ubuntu/pool/universe/b/bash/bash-static_5.3-2ubuntu1_amd64.deb",
    command:
      "apt-get download bash-static=5.3-2ubuntu1 && dpkg-deb -x bash-static_5.3-2ubuntu1_amd64.deb <dir>  # 取 <dir>/usr/bin/bash-static",
    sha256: "0c281f56c3cf92c46c3247fba94a3e9831a948f377b166e44d45dff856e158ef",
  },
  {
    name: "cat",
    version: "coreutils 9.12",
    source: "https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz",
    command:
      'tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/cat',
    sha256: "fe81b0d1255a8813fb56cc1cb226405e3111db87926f28a6bc59e22de4542233",
  },
  {
    name: "ls",
    version: "coreutils 9.12",
    source: "https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz",
    command:
      'tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/ls',
    sha256: "e3fb203387b1685b61d645f93a3d08f6f5381c22fa7ac6710ee721eab9513abe",
  },
  {
    name: "cp",
    version: "coreutils 9.12",
    source: "https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz",
    command:
      'tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/cp',
    sha256: "53859f703f5991919b75403d17b73e916020f476db89127d0320911e1b39ca2a",
  },
  {
    name: "grep",
    version: "grep 3.12",
    source: "https://mirrors.aliyun.com/gnu/grep/grep-3.12.tar.xz",
    command:
      'tar xf grep-3.12.tar.xz && cd grep-3.12 && ./configure --disable-nls --without-selinux LDFLAGS=-static && make -j"$(nproc)" && strip src/grep',
    sha256: "5e9b74e48985c2150f438b3dfa6ee98984d4d7622adb38da89876267164fe407",
  },
] as const;

/** tarball 自身的 sha256(复核「拉下来的源码是不是那份源码」用)。 */
export const SOURCE_ARCHIVE_PINS: readonly { readonly file: string; readonly sha256: string }[] = [
  {
    file: "coreutils-9.12.tar.xz",
    sha256: "a480198559733e9b3da999e90543ac6f888a2caa544d8d664c5a1f17e528e210",
  },
  {
    file: "grep-3.12.tar.xz",
    sha256: "2649b27c0e90e632eadcd757be06c6e9a4f48d941de51e7c0f83ff76408a07b9",
  },
];

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** `PROVENANCE.md` 的正文。**确定性生成**:不含时间戳,重跑一次逐字节相同。 */
const provenanceMarkdown = (): string => {
  const binaryRows = STATIC_BINARY_PINS.map(
    (pin) => `| \`bin/${pin.name}\` | ${pin.version} | \`${pin.sha256}\` |\n`,
  ).join("");
  const archiveRows = SOURCE_ARCHIVE_PINS.map(
    (pin) => `- \`${pin.file}\` —— \`${pin.sha256}\`\n`,
  ).join("");
  const commands = STATIC_BINARY_PINS.map(
    (pin) =>
      `### \`bin/${pin.name}\`(${pin.version})\n\n` +
      `来源:\`${pin.source}\`\n\n\`\`\`sh\n${pin.command}\n\`\`\`\n\n` +
      `得到的字节 sha256 = \`${pin.sha256}\`。\n`,
  ).join("\n");

  return `# 沙箱 rootfs 的来路

这份文件是 \`pnpm run sandbox:rootfs:build\` 的产物,**不要手改**:它由
\`packages/tools/src/sandbox-rootfs/build-rootfs.ts\` 按下面那张表逐字生成。改表、重跑脚本、
再按脚本打印的新值手写回 \`@model-war/schema\` 的 \`SANDBOX_ROOTFS_TREE_HASH\`。

## 它是什么

模型在沙箱里能看见的**全部**内容物:静态 \`bash\`、四个静态 coreutils(\`cat\` / \`cp\` / \`ls\` / \`grep\`)、
三个受限工具的薄壳(\`check\` / \`evaluate\` / \`done\`)与只读契约 \`/contract\` 四条。
沙箱的根是空的(\`bwrap --tmpfs /\`),**只** \`--ro-bind\` 进这里的 \`bin/\` 与 \`contract/\`:
宿主根目录一个 inode 都不出现,所以「绝对路径能绕过 PATH 白名单」这个问题结构上不存在。
依据见 \`docs/adr/0033-sandbox-executor.md\`。

## 为什么内容物入库、为什么不从宿主借

宿主借来的二进制让 \`bash\` 与 glibc 的版本随机器漂移,后果直接打在等价基线上:同一模型在两台
机器上跑出不同成绩时,你先得排除「bash 版本不同」。内容物钉成确切字节之后,这条不确定性消失,
\`ldd\` 闭包门禁也整条不需要。产物入库、以字节为准,配 \`check:sandbox-rootfs\` 的「现算 == 入库」
漂移门禁——与 ADR-0007 对 runtime bundle 的处理同款。

## 五个二进制

| 产物 | 版本 | 字节 sha256 |
|---|---|---|
${binaryRows}
有一件事这张表**不**保证:字节可重放。同一份源码、同一条命令行,换一套工具链(gcc 版本、
build-id)就会得到另一份字节——本仓实测过:照表里的命令重建 \`cat\` / \`ls\`,得到的 sha256 与入库
的那两份不同。所以这张表的语义是「**入库的这份字节**是什么、它是照哪条命令得到的」,不是
「照着跑一遍必然得到同一份字节」。稳定性由入库字节 + 漂移门禁提供,不由可重复构建提供。

五者都已核对是**静态 ELF**(无 \`PT_INTERP\`):不向宿主要动态链接器,也不需要任何 \`.so\`。
门禁用自带的 ELF 解析判这一条,不靠 \`ldd\`(它会执行目标文件)也不靠 \`file\`(输出随版本漂)。

取它们的方式只有两条,都不涉及「从这台机器上顺手抄一个」:

${commands}

上游源码包的 sha256(复核「拉下来的源码是不是那份源码」):

${archiveRows}
## 怎么更新它(谁更新、怎么验)

1. 按上面的命令行取到新的字节(deb 用 \`apt-get download\` 取钉死的包版本;tarball 先核对
   \`SOURCE_ARCHIVE_PINS\`,再 \`configure\` + \`make\` + \`strip\`)。
2. 改这个文件里对应的 \`STATIC_BINARY_PINS\` 条目(版本、来源、命令、sha256)。
3. \`pnpm run sandbox:rootfs:build --static-bin-dir <dir>\`,把脚本打印的文件清单与整棵树哈希
   手写回 \`@model-war/schema\` 的 \`SANDBOX_ROOTFS_FILES\` / \`SANDBOX_ROOTFS_TREE_HASH\`。
4. \`pnpm run check:sandbox-rootfs\`(零构建,读二进制但不需编译)\`+ pnpm run check:sandbox\`
   (真跑 bwrap:可用性、无网络、后台进程不回收即红)。

**换二进制是一次断代。** \`check\` / \`evaluate\` 的行为会随 coreutils 与 bash 的版本变,所以它
不能是「顺手升级一下」:改之前先问「这一次换完,旧档案与旧成绩还能不能比」。ADR-0033 的残余
风险第 6 条点名了这条——它比代码产物更容易被悄悄改掉。

## 不在这个目录里的东西

- \`PROVENANCE.md\`(本文件)不在挂载面上,也不算进整棵树哈希:树哈希的口径是**模型可见世界的
  哈希**,改一句说明不该改变模型看见的字节。
- 薄壳的源码真源在 \`packages/gen/src/agent/shim/shim.sh\`;这里的三个名字是它的逐字节副本。
- 契约的真源是 \`docs/rules-v2/\`;这里的 \`contract/\` 是它的逐字节副本(运行期不 bind 宿主 checkout)。
`;
};

const parseStaticBinDir = (argv: readonly string[]): string | undefined => {
  const index = argv.indexOf("--static-bin-dir");
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error("--static-bin-dir 后面要给一个目录");
  }
  return resolve(value);
};

const main = (): number => {
  const staticBinDir = parseStaticBinDir(process.argv.slice(2));
  const rootfsDir = join(repoRoot, ROOTFS_DIR);

  // ① 先把五个二进制的字节定下来(**在清空产物目录之前**):给了 `--static-bin-dir` 就从那里
  // 取并核对 sha256;没给就沿用产物里已有的那四份。两者都没有 = 第一次落库漏了参数,当场停,
  // 不能先清空再发现——那样会把人已经组装好的产物删掉。
  const binaries = STATIC_BINARY_PINS.map((pin) => {
    const existing = join(rootfsDir, "bin", pin.name);
    if (staticBinDir === undefined) {
      if (!readableFileExists(existing)) {
        throw new Error(
          `bin/${pin.name} 还不存在:第一次落库必须给 --static-bin-dir <dir>(来路见 PROVENANCE.md)`,
        );
      }
      return { path: pin.name, bytes: readFileSync(existing) };
    }
    const bytes = readFileSync(join(staticBinDir, pin.name));
    const digest = sha256Of(bytes);
    if (digest !== pin.sha256) {
      throw new Error(
        `${join(staticBinDir, pin.name)} 的 sha256 是 ${digest},与钉死的 ${pin.sha256} 不符:` +
          "先确认版本,再改 STATIC_BINARY_PINS",
      );
    }
    return { path: pin.name, bytes };
  });

  // 清空被挂载的两个目录:组装是「重写这份产物」,不是「往上添」。留一份上次的残骸,
  // 「磁盘文件集 == 清单」那条判据就会在有残骸的机器上红、在干净的机器上绿——那种门禁
  // 判的是机器状态,不是提交内容。
  for (const dir of ROOTFS_MOUNTED_DIRS) {
    rmSync(join(rootfsDir, dir), { recursive: true, force: true });
  }
  mkdirSync(join(rootfsDir, "bin"), { recursive: true });
  for (const binary of binaries) {
    writeFileSync(join(rootfsDir, "bin", binary.path), binary.bytes, { mode: 0o755 });
  }

  // ② 三个薄壳:同一份字节的三个副本,工具名取自 `$0`。
  const shim = readFileSync(join(repoRoot, SHIM_SOURCE));
  for (const name of ROOTFS_SHIM_NAMES) {
    writeFileSync(join(rootfsDir, "bin", name), shim, { mode: 0o755 });
  }

  // ③ 契约:真源是 `docs/rules-v2/`,逐字节拷进来(运行期不 bind 宿主 checkout)。
  for (const file of CONTRACT_FILES) {
    const source = join(repoRoot, CONTRACT_DIR, file);
    const target = join(rootfsDir, "contract", file);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(source, target);
  }

  // ④ 来路说明书(确定性生成)。
  writeFileSync(join(rootfsDir, ROOTFS_PROVENANCE_DOC), provenanceMarkdown(), "utf8");

  const entries = readRootfsEntries(rootfsDir);
  const bytes = entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
  const paths = rootfsFilePaths(rootfsDir);
  process.stdout.write(
    `sandbox:rootfs:build 写入 ${ROOTFS_DIR}(${String(paths.length)} 个文件,${String(bytes)} 字节)。\n\n` +
      `把下面两段手写回 \`@model-war/schema\` 的 \`packages/schema/src/sandbox-rootfs.ts\`:\n\n` +
      `export const SANDBOX_ROOTFS_FILES = [\n${paths.map((path) => `  "${path}",\n`).join("")}] as const;\n\n` +
      `export const SANDBOX_ROOTFS_TREE_HASH =\n  "${treeDigest(entries)}";\n\n` +
      `改完跑 \`pnpm run check:sandbox-rootfs\` 与 \`pnpm run check:sandbox\`。\n`,
  );
  return 0;
};

/** `existsSync` 之外还要能读:产物缺失与「有但读不动」给的是两句不同的处方。 */
const readableFileExists = (path: string): boolean => {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`sandbox:rootfs:build 失败:${String(error)}\n`);
    process.exitCode = 1;
  }
}
