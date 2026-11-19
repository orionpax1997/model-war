# 沙箱 rootfs 的来路

这份文件是 `pnpm run sandbox:rootfs:build` 的产物,**不要手改**:它由
`packages/tools/src/sandbox-rootfs/build-rootfs.ts` 按下面那张表逐字生成。改表、重跑脚本、
再按脚本打印的新值手写回 `@model-war/schema` 的 `SANDBOX_ROOTFS_TREE_HASH`。

## 它是什么

模型在沙箱里能看见的**全部**内容物:静态 `bash`、8 个静态 coreutils(`cat` / `ls` / `cp` / `grep` / `head` / `sed` / `tail` / `wc`)、
三个受限工具的薄壳(`check` / `evaluate` / `done`)与只读契约 `/contract` 四条。
沙箱的根是空的(`bwrap --tmpfs /`),**只** `--ro-bind` 进这里的 `bin/` 与 `contract/`:
宿主根目录一个 inode 都不出现,所以「绝对路径能绕过 PATH 白名单」这个问题结构上不存在。
依据见 `docs/adr/0033-sandbox-executor.md`。

## 为什么内容物入库、为什么不从宿主借

宿主借来的二进制让 `bash` 与 glibc 的版本随机器漂移,后果直接打在等价基线上:同一模型在两台
机器上跑出不同成绩时,你先得排除「bash 版本不同」。内容物钉成确切字节之后,这条不确定性消失,
`ldd` 闭包门禁也整条不需要。产物入库、以字节为准,配 `check:sandbox-rootfs` 的「现算 == 入库」
漂移门禁——与 ADR-0007 对 runtime bundle 的处理同款。

## 9 个二进制

| 产物 | 版本 | 字节 sha256 |
|---|---|---|
| `bin/bash` | 5.3-2ubuntu1 | `0c281f56c3cf92c46c3247fba94a3e9831a948f377b166e44d45dff856e158ef` |
| `bin/cat` | coreutils 9.12 | `fe81b0d1255a8813fb56cc1cb226405e3111db87926f28a6bc59e22de4542233` |
| `bin/ls` | coreutils 9.12 | `e3fb203387b1685b61d645f93a3d08f6f5381c22fa7ac6710ee721eab9513abe` |
| `bin/cp` | coreutils 9.12 | `53859f703f5991919b75403d17b73e916020f476db89127d0320911e1b39ca2a` |
| `bin/grep` | grep 3.12 | `5e9b74e48985c2150f438b3dfa6ee98984d4d7622adb38da89876267164fe407` |
| `bin/head` | coreutils 9.12 | `acde1eb0bf4747d5b854c05c19cb2391cd4117d0a5a091cabd07d71e6b52c012` |
| `bin/sed` | GNU sed 4.9 | `a4fa1ca78a7f39f00ca83d297a69757458d8c23f7b536f24c927a7d6556ce03a` |
| `bin/tail` | coreutils 9.12 | `97f0d2232637febe15b2cdecc0811d82dc63084fadb943399c3260e13baf422c` |
| `bin/wc` | coreutils 9.12 | `6af0e7d9a8d07b1dd28e147805879efcef604353bd08e13e12c21efbc64a5dde` |

有一件事这张表**不**保证:字节可重放。同一份源码、同一条命令行,换一套工具链(gcc 版本、
build-id)就会得到另一份字节——本仓实测过:照表里的命令重建 `cat` / `ls`,得到的 sha256 与入库
的那两份不同。所以这张表的语义是「**入库的这份字节**是什么、它是照哪条命令得到的」,不是
「照着跑一遍必然得到同一份字节」。稳定性由入库字节 + 漂移门禁提供,不由可重复构建提供。

这 9 份都已核对是**静态 ELF**(无 `PT_INTERP`):不向宿主要动态链接器,也不需要任何 `.so`。
门禁用自带的 ELF 解析判这一条,不靠 `ldd`(它会执行目标文件)也不靠 `file`(输出随版本漂)。

取它们的方式不只一条(同一个 tarball 里的几个命令共用一套 `configure` 参数),都不涉及
「从这台机器上顺手抄一个」:

### `bin/bash`(5.3-2ubuntu1)

来源:`https://mirrors.aliyun.com/ubuntu/pool/universe/b/bash/bash-static_5.3-2ubuntu1_amd64.deb`

```sh
apt-get download bash-static=5.3-2ubuntu1 && dpkg-deb -x bash-static_5.3-2ubuntu1_amd64.deb <dir>  # 取 <dir>/usr/bin/bash-static
```

得到的字节 sha256 = `0c281f56c3cf92c46c3247fba94a3e9831a948f377b166e44d45dff856e158ef`。

### `bin/cat`(coreutils 9.12)

来源:`https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz`

```sh
tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/cat
```

得到的字节 sha256 = `fe81b0d1255a8813fb56cc1cb226405e3111db87926f28a6bc59e22de4542233`。

### `bin/ls`(coreutils 9.12)

来源:`https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz`

```sh
tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/ls
```

得到的字节 sha256 = `e3fb203387b1685b61d645f93a3d08f6f5381c22fa7ac6710ee721eab9513abe`。

### `bin/cp`(coreutils 9.12)

来源:`https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz`

```sh
tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/cp
```

得到的字节 sha256 = `53859f703f5991919b75403d17b73e916020f476db89127d0320911e1b39ca2a`。

### `bin/grep`(grep 3.12)

来源:`https://mirrors.aliyun.com/gnu/grep/grep-3.12.tar.xz`

```sh
tar xf grep-3.12.tar.xz && cd grep-3.12 && ./configure --disable-nls --without-selinux LDFLAGS=-static && make -j"$(nproc)" && strip src/grep
```

得到的字节 sha256 = `5e9b74e48985c2150f438b3dfa6ee98984d4d7622adb38da89876267164fe407`。

### `bin/head`(coreutils 9.12)

来源:`https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz`

```sh
tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/head
```

得到的字节 sha256 = `acde1eb0bf4747d5b854c05c19cb2391cd4117d0a5a091cabd07d71e6b52c012`。

### `bin/sed`(GNU sed 4.9)

来源:`https://mirrors.aliyun.com/gnu/sed/sed-4.9.tar.xz`

```sh
tar xf sed-4.9.tar.xz && cd sed-4.9 && ./configure --disable-nls --without-selinux LDFLAGS=-static && make -j"$(nproc)" && strip sed/sed
```

得到的字节 sha256 = `a4fa1ca78a7f39f00ca83d297a69757458d8c23f7b536f24c927a7d6556ce03a`。

### `bin/tail`(coreutils 9.12)

来源:`https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz`

```sh
tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/tail
```

得到的字节 sha256 = `97f0d2232637febe15b2cdecc0811d82dc63084fadb943399c3260e13baf422c`。

### `bin/wc`(coreutils 9.12)

来源:`https://mirrors.aliyun.com/gnu/coreutils/coreutils-9.12.tar.xz`

```sh
tar xf coreutils-9.12.tar.xz && cd coreutils-9.12 && ./configure --disable-nls --without-selinux --disable-libcap LDFLAGS=-static && make -j"$(nproc)" && strip src/wc
```

得到的字节 sha256 = `6af0e7d9a8d07b1dd28e147805879efcef604353bd08e13e12c21efbc64a5dde`。


上游源码包的 sha256(复核「拉下来的源码是不是那份源码」):

- `coreutils-9.12.tar.xz` —— `a480198559733e9b3da999e90543ac6f888a2caa544d8d664c5a1f17e528e210`
- `grep-3.12.tar.xz` —— `2649b27c0e90e632eadcd757be06c6e9a4f48d941de51e7c0f83ff76408a07b9`
- `sed-4.9.tar.xz` —— `6e226b732e1cd739464ad6862bd1a1aba42d7982922da7a53519631d24975181`

## 怎么更新它(谁更新、怎么验)

1. 按上面的命令行取到新的字节(deb 用 `apt-get download` 取钉死的包版本;tarball 先核对
   `SOURCE_ARCHIVE_PINS`,再 `configure` + `make` + `strip`)。
2. 改这个文件里对应的 `STATIC_BINARY_PINS` 条目(版本、来源、命令、sha256)。
3. `pnpm run sandbox:rootfs:build --static-bin-dir <dir>`,把脚本打印的文件清单与整棵树哈希
   手写回 `@model-war/schema` 的 `SANDBOX_ROOTFS_FILES` / `SANDBOX_ROOTFS_TREE_HASH`。
4. `pnpm run check:sandbox-rootfs`(零构建,读二进制但不需编译)`+ pnpm run check:sandbox`
   (真跑 bwrap:可用性、无网络、后台进程不回收即红)。

**换二进制是一次断代。** `check` / `evaluate` 的行为会随 coreutils 与 bash 的版本变,所以它
不能是「顺手升级一下」:改之前先问「这一次换完,旧档案与旧成绩还能不能比」。ADR-0033 的残余
风险第 6 条点名了这条——它比代码产物更容易被悄悄改掉。

## 不在这个目录里的东西

- `PROVENANCE.md`(本文件)不在挂载面上,也不算进整棵树哈希:树哈希的口径是**模型可见世界的
  哈希**,改一句说明不该改变模型看见的字节。
- 薄壳的源码真源在 `packages/gen/src/agent/shim/shim.sh`;这里的三个名字是它的逐字节副本。
- 契约的真源是 `docs/rules-v2/`;这里的 `contract/` 是它的逐字节副本(运行期不 bind 宿主 checkout)。
