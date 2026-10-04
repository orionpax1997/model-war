/**
 * `modelwar map-lint` 的入口:校验**一个地图池目录**,打印面向作者的文本,按结果设退出码。
 *
 * ── 为什么入参是目录而不是单文件 ──────────────────────────────────────────────
 * 这一层现在判的东西大半是跨图的(`size` 一致、张数下限、最近一圈归属、矿路红线、两两 Jaccard),
 * 对着一张图问不出这些问题。所以 hld §9 登记的用法就是 `modelwar map-lint <maps/>`,本文件也照它收目录。
 * 单图的判据仍然逐张跑——它们是池里的成员,一张图画错了整池就不能进赛季。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 * 0 = 放行,1 = 有违规、参数不对、目录读不到、某张地图形状不过,或工具自身失效。
 * 不区分多种失败:调用方只需要知道「这组图能不能进赛季」。
 *
 * **退出码是返回值,不是 `process.exitCode`**:后者会被 `index.ts` 顶层的
 * `process.exitCode = await main(...)` 无条件覆盖(实测:违规文本照打而退出码是 0)。
 * 理由与 `CommandHandler` 上那段注释同源。
 *
 * ── 薄壳的边界 ──────────────────────────────────────────────────────────────
 * 这里只做四件事:读目录、读文件、把 JSON 交给 `validateMap`、把结果交给规则层与渲染层。
 * **规则一概不在本文件实现**(与禁浮点门禁 / 声明依赖门禁的薄壳同一纪律)——
 * 连「目录里哪些文件名算地图」也是纯函数(`poolMapFileNames`),规则本体在 `pool.ts`。
 *
 * ── 形状不过时就不跑跨图规则 ─────────────────────────────────────────────────
 * 某张地图形状错了,池级的结论就不可信(它的 `size`、terrain 都还没被认过)。
 * 而且那件事已经有一个家了——`validateMap` 的两层诊断,原样转发,不在这里再造一份。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { MapDefinition } from "@model-war/schema";

import { validateMap } from "../validator.js";
import { poolMapFileNames, poolViolations } from "./pool.js";
import { renderPoolViolations } from "./render.js";
import { mapViolations } from "./rules.js";

const USAGE = "用法:modelwar map-lint <maps/>";

/**
 * 子命令处理器。参数是子命令名之后的一切:`modelwar map-lint maps`。
 * 参数表**没有默认值**——缺参数按失败处理(退出码 1 + 用法),不悄悄取当前目录顶上:
 * 一条校验命令若能在缺参数时照样返回 0,调用方就会把「没查」误读成「通过」。
 */
export const lintMaps = async (args: readonly string[]): Promise<number> => {
  if (args.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const path = args[0] ?? "";
  let fileNames: readonly string[];
  try {
    fileNames = poolMapFileNames(readdirSync(path));
  } catch (error) {
    process.stderr.write(
      `map-lint: 读不到目录 ${path}:${error instanceof Error ? error.message : String(error)}\n` +
        `${USAGE}(map-lint 校验一个地图池目录,不是单张地图文件。)\n`,
    );
    return 1;
  }

  const maps: MapDefinition[] = [];
  for (const fileName of fileNames) {
    const filePath = join(path, fileName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      process.stderr.write(
        `map-lint: 读不到或读不懂 ${filePath}:${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 1;
    }
    const shape = validateMap(parsed as never);
    if (!shape.ok) {
      // 形状层的面向作者文本已经是「同类合并成一行」的那一份(`validateMap` 渲染),
      // 这里原样转发:同一件事不留第二个渲染器。
      process.stdout.write(`地图装载失败:${filePath}(${shape.modelDiagnostics.length} 处)。\n`);
      for (const line of shape.modelDiagnostics) {
        process.stdout.write(`- ${line}\n`);
      }
      return 1;
    }
    maps.push(shape.map);
  }

  // 两层各跑一遍再合并:单图判据逐张跑,池判据对整组跑一次。合并后的文本里两类违规带标签。
  const violations = [...maps.flatMap(mapViolations), ...poolViolations(maps)];
  process.stdout.write(renderPoolViolations(violations));
  return violations.length === 0 ? 0 : 1;
};
