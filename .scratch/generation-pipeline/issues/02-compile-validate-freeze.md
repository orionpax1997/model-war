# 02: 编译、静态校验与原子冻结出第一份可装载的冻结脚本

**What to build:** 接上 tsc 编译与静态校验,把 01 回得的脚本文本变成第一份能被 `modelwar match` 装载的冻结脚本:一轮通过、桩客户端条件下的最细端到端。

**Blocked by:** 01(契约读入、模板与模型配置)

**Status:** ready-for-agent

- [ ] 编译走**派生临时 tsconfig**(只覆盖 `files` / `outDir` / `rootDir`,`extends` 仓库根脚本配置),不改动仓库里那份契约配置;产物是 script-mode JS。
- [ ] 校验器以**子进程**调用(判据取退出码 + stdout 面向模型文本),迭代期相位;通过判据 = 编译零错误且无 blocking 违规。
- [ ] **原子落盘**:三件套先在临时目录组装,冻结期校验全过才 rename 到 `archive/<modelSlug>/<runId>/`;目标已存在即拒绝;失败**不留半截目录**。
- [ ] `meta.json` 十一项全部填值(含 `script.js` 的 sha256、sandbox-runtime hash、`tscVersion`、`ruleset`、`prompts`、`protocolRounds === prompts.length === 1`),**形状不改**。
- [ ] `modelwar match` 装载该存档通过(过 `validateArchiveMeta`)。
- [ ] 测试:桩回合法脚本 → 断言三件套字节、meta 内容、退出码 0、`match` 装载成功;冻结期校验失败 → 目标目录不存在、无半截三件套。
