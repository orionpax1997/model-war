/**
 * 生成器的入口:按注册表逐件写出生成物,打印结果,按结果设退出码。
 *
 * 用 `node packages/tools/src/generate/run-generate.ts` 直接跑(本包以源码形式由 Node 的类型擦除
 * 执行,同 `gate/run-no-float-gate.ts`)。跑它得先有 `packages/schema/dist`——因为生成器 import
 * 真源包,根脚本 `generate` 因此自带一次 `tsc -b`。这是「能不能 afford 构建」的分界线在命令上
 * 的样子:低频入口前置构建,快门禁一条都不加。
 *
 * 退出码是这个入口对外的全部契约:0 = 全部写出(或已是最新),1 = 有生成物写失败。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { GENERATED_ARTIFACTS } from "./registry.ts";

/** 本文件在 `<repo>/packages/tools/src/generate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

const main = (): number => {
  for (const artifact of GENERATED_ARTIFACTS) {
    const target = resolve(repoRoot, artifact.path);
    const contents = artifact.produce();

    let unchanged = false;
    try {
      unchanged = readFileSync(target, "utf8") === contents;
    } catch {
      // 目标还不存在:那正是「第一件生成物」的状态,走写出分支,不是错误。
    }

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
