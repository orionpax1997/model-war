/**
 * 第二件生成物的生产函数:参赛脚本可见面的三张名单 → 工具包内的生成源文件。
 *
 * 与第一件走**同一套分发机制**(同一个注册表、同一批排版零件、同一条零构建分界线),
 * 本票因此只是往注册表里加一行——骨架没动,这是 ADR-0003 里那条纪律成立的证据本身。
 *
 * 真源是 `packages/schema/src/script-surface.ts`:宿主桥前缀、禁列全局名、沙箱注入 API 符号表。
 * 三者都是「名字」,所以同属一件生成物;脚本体积上限**不在其中**——它是数值,取值在规则集文件里。
 *
 * 本文件与它的产物都**不实现任何规则**:禁 `export`/`import`、禁 `__*` 前缀、禁列、脚本体积上限
 * 全属 D。这里交付的只是它们要读的名字表。
 */

import {
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  SANDBOX_INJECTED_API_SYMBOLS,
} from "@model-war/schema";
import { documentedArray, documentedString, generatedHeader } from "./emit.ts";
import type { GeneratedArtifact } from "./artifact.ts";

/** 生成物 id。它同时出现在生成头注释里,所以改了它等于改了入库文件的正文,漂移检查会照出来。 */
const ID = "script-surface-names";

export const scriptSurfaceNames: GeneratedArtifact = {
  id: ID,
  form: "whole-file",
  path: "packages/tools/src/generated/script-surface.ts",
  produce: () =>
    [
      generatedHeader(
        ID,
        "packages/schema/src/script-surface.ts",
        "收录判据与逐个「为什么收」都随真源走,不在此复述。",
      ),
      `// 生成物 id:${ID}`,
      documentedString(
        "宿主桥的命名前缀。真源:`HOST_BRIDGE_PREFIX`。它与「桥函数初始化后被删除」是同一套约定。",
        "HOST_BRIDGE_PREFIX",
        HOST_BRIDGE_PREFIX,
      ),
      documentedArray(
        "禁列的确定性污染源。真源:`FORBIDDEN_GLOBAL_NAMES`。收录判据见真源侧注释。",
        "FORBIDDEN_GLOBAL_NAMES",
        FORBIDDEN_GLOBAL_NAMES,
      ),
      documentedArray(
        "沙箱注入的 API 符号表。真源:`SANDBOX_INJECTED_API_SYMBOLS`。这里交出的只是**名字**——" +
          "「怎么注入」由沙箱执行器定,与这张表无关;要改名改真源并重跑生成器。",
        "SANDBOX_INJECTED_API_SYMBOLS",
        SANDBOX_INJECTED_API_SYMBOLS,
      ),
    ].join("\n\n") + "\n",
};
