/**
 * 生成器的入口:按注册表逐件写出生成物,打印结果,按结果设退出码。
 *
 * 用 `node packages/tools/src/generate/run-generate.ts` 直接跑(本包以源码形式由 Node 的类型擦除
 * 执行,同 `gate/run-no-float-gate.ts`)。跑它得先有 `packages/schema/dist`——因为生成器 import
 * 真源包,根脚本 `generate` 因此自带一次 `tsc -b`。这是「能不能 afford 构建」的分界线在命令上
 * 的样子:低频入口前置构建,快门禁一条都不加。
 *
 * ── 两种形态怎么落到文件上 ──
 *
 * **整文件形态**写全文;**区块形态**只重填两行定界标记之间那段,区块外的散文**逐字节不动**
 * (填的机械与漂移检查抽的机械是同一份,`section.ts`)。区块形态的目标文件里没有定界标记时
 * 本入口非零退出并说明为什么——它不猜那段该落在哪,猜出来的正文会让工作树看着像跑过生成器。
 *
 * 退出码是这个入口对外的全部契约:0 = 全部写出(或已是最新),1 = 有生成物写失败。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { GENERATED_ARTIFACTS } from "./registry.ts";
import { writeSection } from "./section.ts";

/** 本文件在 `<repo>/packages/tools/src/generate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

/**
 * 读目标文件;**读不到返回 `undefined`**。
 *
 * 「还没有这个文件」与「文件是空的」在这里必须分开:整文件形态下两者等价(都要整份写出),
 * 区块形态下不一样——文件不存在就没有落点可填,那是人的活(先立好文件与两行定界标记),
 * 报成「文件里找不到标记」会把人指向一个他改不动的结论。
 */
const readIfPresent = (target: string): string | undefined => {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
};

const main = (): number => {
  for (const artifact of GENERATED_ARTIFACTS) {
    const target = resolve(repoRoot, artifact.path);
    const existing = readIfPresent(target);

    let contents: string;
    try {
      if (artifact.form === "whole-file") {
        contents = artifact.produce();
      } else {
        const section = artifact.produce();
        if (existing === undefined) {
          throw new Error(
            `读不出目标文件。区块形态的落点由人先立:手工建好 ${artifact.path},写上两行定界标记` +
              `(${section.marker.begin} / ${section.marker.end}),再重跑。`,
          );
        }
        contents = writeSection(existing, section.marker, section.content);
      }
    } catch (error) {
      process.stderr.write(
        `生成器:${artifact.id} → ${artifact.path} 失败:${(error as Error).message}\n`,
      );
      return 1;
    }
    const unchanged = existing === contents;

    try {
      if (!unchanged) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents, "utf8");
      }
    } catch (error) {
      process.stderr.write(
        `生成器:写出 ${artifact.id} → ${artifact.path} 失败:${(error as Error).message}\n`,
      );
      return 1;
    }

    // 「已是最新」也要报出来:一条什么都不打印的生成器会让人不敢确认自己跑没跑过。
    const how = unchanged ? "已是最新" : "已写出";
    process.stdout.write(`生成器:${artifact.id} → ${relative(repoRoot, target)}  ${how}\n`);
  }
  return 0;
};

process.exitCode = main();
