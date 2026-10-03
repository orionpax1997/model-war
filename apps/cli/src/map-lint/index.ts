/**
 * `modelwar map-lint` 的入口:校验一张地图文件,打印面向作者的文本,按结果设退出码。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 * 0 = 放行,1 = 有违规、参数不对、文件读不到、JSON 形状不过,或工具自身失效。
 * 不区分多种失败:调用方只需要知道「这张图能不能进地图池」。
 *
 * **退出码是返回值,不是 `process.exitCode`**:后者会被 `index.ts` 顶层的
 * `process.exitCode = await main(...)` 无条件覆盖(实测:违规文本照打而退出码是 0)。
 * 理由与 `CommandHandler` 上那段注释同源。
 *
 * ── 薄壳的边界 ──────────────────────────────────────────────────────────────
 * 这里只做三件事:读文件、把 JSON 交给 `validateMap`、把地图交给纯规则、把违规交给渲染。
 * **规则一概不在本文件实现**(与禁浮点门禁 / 声明依赖门禁的薄壳同一纪律)。
 *
 * ── 形状不过时就不跑跨字段规则 ───────────────────────────────────────────────
 * 形状错了的地图,跨字段判据的结论不可信(terrain 可能根本不是 `size` 行)。
 * 而且那件事已经有一个家了——`validateMap` 的两层诊断,原样转发,不在这里再造一份。
 */

import { readFileSync } from "node:fs";

import { validateMap } from "../validator.js";
import { renderMapViolations } from "./render.js";
import { mapViolations } from "./rules.js";

const USAGE = "用法:modelwar map-lint <maps.json>";

/**
 * 子命令处理器。参数是子命令名之后的一切:`modelwar map-lint maps/open-clash.json`。
 * 参数表**没有默认值**——缺参数按失败处理(退出码 1 + 用法),不悄悄取当前目录顶上:
 * 一条校验命令若能在缺参数时照样返回 0,调用方就会把「没查」误读成「通过」。
 */
export const lintMaps = async (args: readonly string[]): Promise<number> => {
  if (args.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const path = args[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    process.stderr.write(
      `map-lint: 读不到或读不懂 ${path}:${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const shape = validateMap(parsed as never);
  if (!shape.ok) {
    // 形状层的面向作者文本已经是「同类合并成一行」的那一份(`validateMap` 渲染),
    // 这里原样转发:同一件事不留第二个渲染器。
    process.stdout.write(`地图装载失败:${shape.modelDiagnostics.length} 处。\n`);
    for (const line of shape.modelDiagnostics) {
      process.stdout.write(`- ${line}\n`);
    }
    return 1;
  }

  const violations = mapViolations(shape.map);
  process.stdout.write(renderMapViolations(violations));
  return violations.length === 0 ? 0 : 1;
};
