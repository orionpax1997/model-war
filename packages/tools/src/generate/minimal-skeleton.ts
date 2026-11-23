/**
 * 契约里那份最小骨架的抽取件:`docs/rules-v2/api.md` §6 的 ` ```ts ` 围栏块 →
 * `/contract/examples/minimal.ts`。
 *
 * ── 为什么是**抽**而不是**再存一份** ──
 *
 * 骨架在契约里已经有一处家:API 文档 §6。另存一份 `.ts` 就是给同一段字节造第二个家,而两份
 * 之间的偏差没有任何东西能判——「能编译」是**两份各自**的性质,它证明不了两份相同。ADR-0030
 * 原本以为「已有的编译测试保证它与文档中的示例一致」,实测不成立:那道测试
 * (`api-example-compile.test.ts`)扫的是 api.md 全文、验的是每个可运行块零诊断,
 * 它压根不知道 `examples/minimal.ts` 存在。所以一致性只能由**构造**保证:骨架是抽出来的,
 * 判据就是「产出的字节 == §6 那一块」,一个字都不多不少。
 *
 * ── 因此生成物里**不带生成头注释** ──
 *
 * 别的整文件生成物都带 `emit.ts` 的生成头(`勿手改` / 真源在哪 / 为什么规则层读生成物),这一件
 * 不能带:它要逐字节等于 §6,而多一行注释就不再相等。代价是这份文件里没有「勿手改」的警告,
 * 补偿有两处——`GENERATED_ARTIFACTS` 里的登记(机器可读的真源声明),以及契约目录说明里
 * 那一条(模型读得到)。手改它由两道判据抓:漂移检查(全量门禁)与契约挂载门禁(快门禁)。
 *
 * ── 零构建 ──
 *
 * 只 import node 内置模块与 `artifact.ts`(纯类型)。契约挂载门禁挂在 `quick` 上,而快门禁
 * 必须零构建(hld §2.2.8、ADR-0003),所以本模块不得 import `@model-war/schema`——这也正是它
 * 不复用 `registry.ts` 的原因(那张表要一路 import 到真源包)。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { GeneratedArtifact } from "./artifact.ts";

/** 真源:面向模型那份 API 文档(当前 active 契约)。 */
export const SKELETON_API_DOC = "docs/rules-v2/api.md";

/** 骨架的挂载落点。它同时是 `/contract` 四条里的第四条,与 `contract-package.ts` 那份清单一致。 */
export const SKELETON_ARTIFACT_PATH = "docs/rules-v2/examples/minimal.ts";

/** 骨架所在小节。它同时是一句判据:**小节标题被改写**就让抽取失败,而不是悄悄抽到别处的块。 */
const SKELETON_SECTION_HEADING = /^##[\t ]+6\.[\t ]/;

/** 下一节的起点:小节从标题之后到下一个二级标题之前。 */
const NEXT_SECTION_HEADING = /^##[\t ]/;

/** 围栏行:三个反引号 + 可选信息串,行内不许有别的东西。 */
const FENCE = /^(?:`{3})([A-Za-z0-9_+-]*)[\t ]*$/;

/** 可运行脚本的判据:块内行首声明了顶层入口。与 `api-example-compile.test.ts` 那条正则同一形态。 */
const ENTRY_DECLARATION = /^function loop\(/m;

/** 一个围栏块:它的信息串与正文行。 */
type FencedBlock = {
  readonly info: string;
  readonly lines: readonly string[];
};

/** 抽 §6 那一节的正文行(不含小节标题)。抽不到标题时返回 `undefined`。 */
const skeletonSectionLines = (doc: string): readonly string[] | undefined => {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => SKELETON_SECTION_HEADING.test(line));
  if (start < 0) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => NEXT_SECTION_HEADING.test(line));
  return end < 0 ? rest : rest.slice(0, end);
};

/** 一节里的全部围栏块。**围栏不闭合按错误报**:半段正文当骨架用是抽取失败最坏的形态。 */
const fencedBlocksIn = (lines: readonly string[]): readonly FencedBlock[] => {
  const blocks: FencedBlock[] = [];
  let open: { readonly info: string; readonly lines: string[] } | undefined;
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence === null) {
      open?.lines.push(line);
      continue;
    }
    if (open === undefined) {
      open = { info: fence[1] ?? "", lines: [] };
      continue;
    }
    blocks.push({ info: open.info, lines: open.lines });
    open = undefined;
  }
  if (open !== undefined) {
    throw new Error(
      `§6 里有一个没闭合的围栏块(信息串 "${open.info}",已收 ${String(open.lines.length)} 行)。` +
        `抽取按「成对的围栏」判定,半段正文不能当骨架用。`,
    );
  }
  return blocks;
};

/**
 * 从 API 文档全文抽出那份最小骨架,返回**逐字节**要落进 `examples/minimal.ts` 的内容(末尾带换行)。
 *
 * 判据是「§6 里恰好一个含顶层入口声明的 ts 围栏块」。**一个不是失败,两个也是失败**:
 * 前者说明骨架被移走或小节标题被改写,后者说明 §6 里又贴了一段完整脚本——两种情况下
 * 「哪个才是骨架」都不该由抽取器替人猜,猜错的后果是模型 `cp` 到一份别的示例。
 */
export const skeletonFromApiDoc = (doc: string): string => {
  const lines = skeletonSectionLines(doc);
  if (lines === undefined) {
    throw new Error(
      `${SKELETON_API_DOC} 里找不到 §6 的小节标题(行首的 "## 6.")。` +
        `小节编号是骨架的定位锚:标题被改写时抽取按失败处理,不去猜「大概是后一节」。`,
    );
  }

  const candidates = fencedBlocksIn(lines).filter(
    (block) => block.info === "ts" && ENTRY_DECLARATION.test(block.lines.join("\n")),
  );
  if (candidates.length === 1) {
    return `${(candidates[0]?.lines ?? []).join("\n")}\n`;
  }

  const how =
    candidates.length === 0
      ? "一个都没有"
      : `${String(candidates.length)} 个(第 ${candidates
          .map((candidate, index) => String(index + 1))
          .join(" / ")} 个)`;
  throw new Error(
    `${SKELETON_API_DOC} §6 里含顶层入口声明(\`function loop(\`)的 ts 围栏块${how},` +
      `抽取按「恰好一个」判定。骨架被移走、被拆成两段、或 §6 里又贴了一段完整脚本,` +
      `都要人来定哪个才是骨架——抽错的那一份会被模型 \`cp\` 走。`,
  );
};

/**
 * 生成物登记:骨架以**逐字节等于 §6** 的形态入库。
 *
 * 形态选整文件而不是区块,是因为它的落点是一份**纯生成物**(`examples/minimal.ts` 里没有一个字节
 * 是人的):区块形态服务于「散文占七成篇幅的混合文件」,这里没有散文可留。
 */
export const contractMinimalSkeleton: GeneratedArtifact = {
  id: "contract-minimal-skeleton",
  form: "whole-file",
  path: SKELETON_ARTIFACT_PATH,
  produce: () =>
    skeletonFromApiDoc(
      readFileSync(resolve(import.meta.dirname, "../../../..", SKELETON_API_DOC), "utf8"),
    ),
};
