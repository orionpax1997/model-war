/**
 * 契约包**身份**:`/contract` 那四条挂载字节的整树 sha256。
 *
 * ── 为什么是内容哈希,不是版本号 ──
 *
 *  让版本号只锚规则集取值、不锚文字,于是同一个 `v2` 之下 `rules.md` 的字节是会变的。
 * 「契约 v2」因此不足以定位「档案当时读的是哪份文本」。身份由**整棵挂载树的哈希**承担,口径写死:
 * 范围 = 挂载清单(`CONTRACT_FILES`)里的四条、按 `path` 排序;串接 = 逐条 `path` + `\0` + 该文件字节;
 * 算法 = sha256,小写十六进制。
 *
 * 为什么含目录说明与骨架:前者**就是**首条消息的全部内容,后者是模型复制的起点;把它们的字节排除在
 * 指纹外,等于档案记不住「模型当时看到什么」(之后这是唯一的复核依据)。
 *
 * ── 为什么 `path` 取清单里的字面值(相对契约目录),而不是挂载点 `/contract/...` ──
 *
 * 清单是「四条」这个名字的唯一一份真源,排序与串接都吃它的字面值,于是哈希不依赖任何第二份名字表。
 * 挂载点前缀是个常量,加上去不改变排序(`README.md` 仍排在 `api.md` 前),只改变那串 hex 的取值;
 * 两边都是自洽口径,选清单字面值的理由是「少一份要知道的事实」。
 *
 * ── 为什么算法住这里,而入库常量住真源包 ──
 *
 * 两件事,两个家。**算法**的口径只被门禁消费(它现算);**取值**要被生成侧在渲染首条消息时读到
 * (票 05 的接线在 `packages/gen`),所以它按 `SANDBOX_RUNTIME_HASH` 的形状住在 `@model-war/schema`
 * (`packages/schema/src/contract-identity.ts`):常量是入库事实,门禁证明「现算 == 入库」。
 * 算法不能跟着常量住真源包——hld §3.2 的 `schema-has-no-dependencies` 不许它 import `node:crypto`
 * (`.dependency-cruiser.js` 里有这条规则)。
 *
 * ── 纯度 ──
 *
 * `contractTreeDigest` 只吃字节:不读盘、不看环境、不碰文件名大小写,排序在函数内做。文件顺序不同的
 * 两份输入必须得到同一串 hex,这一点由单测钉住(它不是实现细节,是口径的一部分)。
 */

import { createHash } from "node:crypto";

import type { ContractFinding } from "./contract-package.ts";

/** 挂在契约树上的一份字节,加上它在挂载清单里的路径。 */
export type ContractTreeEntry = {
  readonly path: string;
  readonly bytes: Uint8Array;
};

/** 分隔符。用 NUL 而不是换行:路径与正文里都可能出现换行,`\0` 不会。 */
const SEPARATOR = Buffer.from([0]);

/** 入库常量的源码文件(仓库相对)。门禁**零构建**读不到真源包的 dist,只能读它的源码文本。 */
export const CONTRACT_IDENTITY_SOURCE = "packages/schema/src/contract-identity.ts";

/** 入库常量的名字。抽取与报告都从这里取,不各写一遍。 */
export const CONTRACT_TREE_HASH_CONSTANT = "CONTRACT_TREE_HASH";

/**
 * 按路径的**码位**比较,不用 `localeCompare`:后者随 locale 变,而排序是身份口径的一部分,
 * 身份不能随环境漂移。
 */
const byPath = (left: ContractTreeEntry, right: ContractTreeEntry): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/**
 * 整棵挂载树的身份:`path` + `\0` + 字节,按 `path` 排序串接,sha256 小写十六进制。
 *
 * 抛错的两条都是「身份不成立」,不折算成某个值:
 * - 空清单:空输入的 sha256 是个合法十六进制串,但它指的不是任何一棵树;
 * - 重复路径:同一棵树有两种字节,先拼后拼都说不通。
 */
export const contractTreeDigest = (entries: readonly ContractTreeEntry[]): string => {
  if (entries.length === 0) {
    throw new Error("契约挂载清单为空,整树身份无从计算(空的 sha256 指的不是任何一棵树)");
  }
  const hash = createHash("sha256");
  let previous: string | undefined;
  for (const entry of [...entries].sort(byPath)) {
    if (entry.path === previous) {
      throw new Error(`契约挂载清单里出现了重复路径 ${entry.path}:同一棵树有两种字节,身份不成立`);
    }
    previous = entry.path;
    hash.update(Buffer.from(entry.path, "utf8"));
    hash.update(SEPARATOR);
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
};

/**
 * 从真源包**源码文本**里取出入库常量。抽不出来返回 `undefined`,不猜。
 *
 * 为什么读源码文本:这道判据挂在 `gate:contract`(`quick` 上),而快门禁必须零构建
 * (hld §2.2.8),`@model-war/schema` 的 exports 指向 `dist`,此刻未必存在。
 * 这条缝的脆弱处(改写常量声明会让抽取失效)由两条兜住:抽不出来按**失败**报(不按「无事可查」
 * 放过),以及 `contract-tree.test.ts` 里那条「抽取结果 == 真源包的常量」断言。
 */
export const pinnedContractTreeHash = (source: string): string | undefined =>
  new RegExp(`export const ${CONTRACT_TREE_HASH_CONSTANT}\\s*=\\s*"([0-9a-f]{64})"`).exec(
    source,
  )?.[1];

export type ContractTreeInput = {
  /** 挂载清单里每一条的路径与字节。空数组由 `contractTreeDigest` 判失败。 */
  readonly entries: readonly ContractTreeEntry[];
  /** `packages/schema/src/contract-identity.ts` 的源码文本。 */
  readonly identitySource: string;
};

/**
 * 判据:现算的整树哈希 == 入库常量。
 *
 * 红了的处方是**把现算值写回常量**并提交——改契约字节、改清单一类动作都会让这行红,而它红的意思
 * 正是「档案里那串身份已经指不到眼前的字节了」。
 */
export const contractTreeFindings = ({
  entries,
  identitySource,
}: ContractTreeInput): readonly ContractFinding[] => {
  const pinned = pinnedContractTreeHash(identitySource);
  if (pinned === undefined) {
    return [
      {
        where: CONTRACT_IDENTITY_SOURCE,
        detail:
          `读不出 \`${CONTRACT_TREE_HASH_CONSTANT}\` 的 64 位小写十六进制取值。` +
          "此刻「现算 == 入库」这条判据无从判定,按失败报——不按「无事可查」放过。",
      },
    ];
  }
  const actual = contractTreeDigest(entries);
  if (actual === pinned) {
    return [];
  }
  return [
    {
      where: CONTRACT_IDENTITY_SOURCE,
      detail:
        `契约整树身份与入库常量不一致:现算 ${actual},入库 ${pinned}。` +
        `把现算值写回 ${CONTRACT_TREE_HASH_CONSTANT} 并提交——它红了的意思是` +
        "「档案里那串身份已经指不到眼前的字节了」,不是「门禁太严」。",
    },
  ];
};
