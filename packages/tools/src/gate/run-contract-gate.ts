/**
 * 契约挂载门禁(`gate:contract`)的入口:`/contract` 四条与它们的真源是不是同一批字节。
 *
 * 用 `node packages/tools/src/gate/run-contract-gate.ts` 直接跑——本包以源码形态由 Node 的类型
 * 擦除执行,不产出 dist、也不设 bin(hld §3.2),因此本包内部的相对 import 一律写 `.ts` 扩展名。
 *
 * ── 为什么它必须在 `quick` 里,而生成物漂移检查不在 ──
 *
 * 漂移检查(`gate:drift`)要 `packages/schema/dist`,只能挂在全量门禁末尾(快门禁
 * 零构建)。本道门禁判的东西恰好**一个构建都不需要**:读两份文本、抽一个围栏块、比对、
 * 再查两条正则。而它守的是本次唯一新增的、最容易被当成普通文件手改的那份生成物
 * (`examples/minimal.ts` 没有生成头注释——它必须逐字节等于 API 文档 §6,多一行注释就不再相等)。
 * 日常入口是 `pnpm run verify`,抓不到它等于没有。
 *
 * ── 判据分三块,报告合在一处列 ──
 *
 * - **字节**:骨架 == `api.md` §6 那一块。抽不出来(小节标题被改写 / 骨架被移走)、抽出两块
 *   (又贴了一段完整脚本),都按失败报——抽取器不替人猜「哪个才是骨架」。
 * - **身份**:那四条的整树 sha256 == `packages/schema/src/contract-identity.ts` 的入库常量
 *   (口径与算法都在同包的 `contract-tree.ts`)。它守的是「档案里记的身份还指不指得到眼前的
 *   字节」——改契约字节、改挂载清单都会让它红,而它红是**对的**。它读真源包的**源码文本**而不是
 *   import 它:快门禁零构建(`@model-war/schema` 的 exports 指向 `dist`)。
 * - **散文**:详见 `contract-package.ts` 头注的三条。它们守的是「模型读到的目录说明」,
 *   而它同时是首条消息的全部内容,档案里只存这一条。
 *
 * **防假绿**:契约目录读到 0 个文件、目录说明为空、挂载清单为空、入库身份常量读不出来,四条都按
 * 失败处理——此时报「干净」什么也没断言(空转检测的共享件在 `gate/vacuous.ts`)。
 *
 * 退出码是这个门禁对外的全部契约:0 = 干净,1 = 有违规(或门禁本身失效)。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  CONTRACT_DIR,
  CONTRACT_FILES,
  CONTRACT_INDEX_PATH,
  type ContractFinding,
  directoryFindings,
  indexCoverageFindings,
  writableWorldFindings,
} from "../contract-package.ts";
import {
  CONTRACT_IDENTITY_SOURCE,
  contractTreeFindings,
  type ContractTreeEntry,
} from "../contract-tree.ts";
import {
  SKELETON_API_DOC,
  SKELETON_ARTIFACT_PATH,
  skeletonFromApiDoc,
} from "../generate/minimal-skeleton.ts";
import { vacuousReason } from "./vacuous.ts";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), "utf8");

/**
 * 契约目录下**递归**收出来的文件,路径相对 `CONTRACT_DIR`。
 *
 * 递归而不是只看一层:`examples/minimal.ts` 在子目录里,只收一层会让「清单四条、目录三条」的
 * 断法漏掉最要紧的那一条。读不到目录时返回空数组而不是抛错——那是「读到 0 个文件」,
 * 处方是空转判失败,不是进程崩溃(崩溃看起来像工具坏了,而不是像判据失明)。
 */
const contractFilesPresent = (): readonly string[] => {
  const found: string[] = [];
  const visit = (relative: string): void => {
    const absolute = resolve(repoRoot, CONTRACT_DIR, relative);
    if (!existsSync(absolute)) {
      return;
    }
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        visit(relative === "" ? entry.name : `${relative}/${entry.name}`);
      }
      return;
    }
    found.push(relative);
  };
  visit("");
  return found.sort();
};

/** 判据「字节」:骨架与 API 文档 §6 是同一份。抽不出来按失败报,不折算成一致。 */
const skeletonFindings = (): readonly ContractFinding[] => {
  const target = resolve(repoRoot, SKELETON_ARTIFACT_PATH);
  if (!existsSync(target)) {
    return [
      {
        where: SKELETON_ARTIFACT_PATH,
        detail: "骨架不在盘上。跑 `pnpm run generate` 生成它并提交。",
      },
    ];
  }
  let expected: string;
  try {
    expected = skeletonFromApiDoc(read(SKELETON_API_DOC));
  } catch (error) {
    return [{ where: SKELETON_API_DOC, detail: (error as Error).message }];
  }
  return readFileSync(target, "utf8") === expected
    ? []
    : [
        {
          where: SKELETON_ARTIFACT_PATH,
          detail:
            `骨架与 ${SKELETON_API_DOC} §6 那一块不是同一份字节。这份文件是**抽出来的**:` +
            "改它等于手改生成物(下一次生成会覆盖),要改骨架该改 §6。" +
            "跑 `pnpm run generate` 后提交。",
        },
      ];
};

/**
 * 那四条在盘上的字节。任一条读不到就返回 `undefined`——不是抛错:读不到文件是「身份无从计算」,
 * 该按违规报,而不是让进程带着栈退出(那看起来像工具坏了,而不是判据失明)。
 */
const contractTreeEntries = (): readonly ContractTreeEntry[] | undefined => {
  const entries: ContractTreeEntry[] = [];
  for (const path of CONTRACT_FILES) {
    try {
      entries.push({ path, bytes: readFileSync(resolve(repoRoot, CONTRACT_DIR, path)) });
    } catch {
      return undefined;
    }
  }
  return entries;
};

/** 判据「身份」:现算的整树哈希 == 入库常量。口径与算法在 `contract-tree.ts`。 */
const identityFindings = (): readonly ContractFinding[] => {
  const entries = contractTreeEntries();
  if (entries === undefined) {
    return [
      {
        where: CONTRACT_DIR,
        detail:
          "挂载清单里的某一条读不到字节,整树身份无从计算。先修 `pnpm run gate:contract` 报的缺文件。",
      },
    ];
  }
  const identitySource = existsSync(resolve(repoRoot, CONTRACT_IDENTITY_SOURCE))
    ? read(CONTRACT_IDENTITY_SOURCE)
    : "";
  try {
    return contractTreeFindings({ entries, identitySource });
  } catch (error) {
    return [{ where: CONTRACT_IDENTITY_SOURCE, detail: (error as Error).message }];
  }
};

const main = (): number => {
  const present = contractFilesPresent();
  const readme = existsSync(resolve(repoRoot, CONTRACT_INDEX_PATH))
    ? read(CONTRACT_INDEX_PATH)
    : "";

  const vacuous = [
    vacuousReason(present.length, { subject: "契约目录里的文件", scope: CONTRACT_DIR }),
    vacuousReason(CONTRACT_FILES.length, {
      subject: "挂载清单条目",
      scope: "contract-package.ts 的 CONTRACT_FILES",
    }),
    vacuousReason(readme.trim().length, {
      subject: "目录说明的正文",
      scope: CONTRACT_INDEX_PATH,
    }),
  ].filter((reason) => reason !== "");
  if (vacuous.length > 0) {
    process.stderr.write(`契约挂载门禁:${vacuous.join("")}\n`);
    return 1;
  }

  const findings: readonly ContractFinding[] = [
    ...skeletonFindings(),
    ...identityFindings(),
    ...directoryFindings(present),
    ...indexCoverageFindings(readme),
    ...writableWorldFindings(readme),
  ];

  for (const finding of findings) {
    process.stdout.write(`契约挂载门禁不通过:${finding.where} —— ${finding.detail}\n`);
  }
  const scale = `${String(CONTRACT_FILES.length)} 条挂载、目录 ${String(present.length)} 个文件`;
  const summary =
    findings.length === 0
      ? `契约挂载门禁:${scale},骨架与 §6 逐字节相同、整树身份与入库常量一致,无违规。`
      : `契约挂载门禁:${scale},${String(findings.length)} 处违规。`;
  process.stdout.write(`${summary}\n`);
  return findings.length === 0 ? 0 : 1;
};

process.exitCode = main();
