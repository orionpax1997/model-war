/**
 * 契约包(`/contract`)身份的**入库常量**:那四条挂载字节的整树 sha256。
 *
 * ── 形状抄 `SANDBOX_RUNTIME_HASH`(`sandbox-runtime.ts`),因为它要解决的问题同形 ──
 *
 * 档案里记的那串身份,第三方复核时凭的是**版本库里那批确切字节**,不是「跑一次现算」。所以取值是
 * 常量,口径(范围 / 串接 / 算法)写死在 ADR-0037,由门禁证明「现算 == 入库」——
 * 算法在 `packages/tools/src/contract-tree.ts`(它要 `node:crypto`,而本包 hld §3.2 不许有依赖),
 * 判据挂在 `gate:contract`(`quick` 上)。
 *
 * ── 为什么它住真源包 ──
 *
 * 消费方在生成侧:首条消息的末行 `contract: <版本号> tree=sha256:<hex>` 由 `packages/gen` 渲染,
 * 它读本常量而不是现读盘重算(ADR-0031 的档案要能对上「模型当时看到的那批字节」)。真源包是
 * gen 与 tools 两侧都读得到的那一处(`SANDBOX_RUNTIME_HASH` 同一条理由)。
 *
 * ── 怎么改 ──
 *
 * 改契约字节(含目录说明、含骨架)、改挂载清单 ⇒ 跑 `pnpm run gate:contract`,它会红并把**现算值**
 * 打出来,把那个值写回下面这一行。手写而不是自动生成:它是入库事实,改它应该是一次有意的动作。
 */
export const CONTRACT_TREE_HASH =
  "37290242a1df358e26068096c006e4d5e0fde578d5decebe45da80d1fc36a2a2";
