/**
 * 参赛脚本静态校验的**判定链**:一段编译后的产物源码 → 一组有序的违规。
 *
 * ── 顺序是裁决,不是实现细节 ──────────────────────────────────────────────────
 * 固定顺序:**语法失败 → 禁列 → 桥前缀 → 模块系统 → 体积**。
 * 禁列排在最前不是随意排的:禁列表里有 `Math.random`,而 `Math` 在内置全局白名单里;
 * 按白名单先判就会把 `Math.random` 放行(spec《规则清单与判定链》)。往本文件里插一级时
 * **按它在表里的位置插,不要按实现方便的顺序插**。
 *
 * ── 上下文为什么长这样 ────────────────────────────────────────────────────────
 * 一级一个纯函数,形状统一成「吃上下文、吐违规」,好处是**每级都不必知道别的级存在**,
 * 而上下文本身(三条 AST 规则吃已解析好的树、体积级吃字节数)由 `rules/script-lint.ts` 定义,
 * 不在这里——理由是依赖方向只能是 `validate/` → `rules/`,见那个文件的头注。
 *
 * ── 解析失败独占结果 ──────────────────────────────────────────────────────────
 * 解析不过时只产出一条 `syntax-error`,一条规则违规都不报:解析器失败时返回的是一棵**残缺的树**,
 * 在残树上跑规则只会得到不可复现的结论(spec《违规输出》)。顺带说明为什么只留**第一条**诊断:
 * 一棵残树上通常会连着报好几个错误,而面向模型层要改的只有最靠前的那个;
 * 其余那些是同一个笔误的回声,并成一条比逐条列出更省迭代预算。
 */

import { Buffer } from "node:buffer";

import { parseToAst } from "../parse-source.ts";
import { forbiddenGlobalStage } from "../rules/forbidden-globals.ts";
import { hostBridgeStage } from "../rules/host-bridge.ts";
import { moduleSystemStage } from "../rules/module-system.ts";
import { scriptSizeStage } from "../rules/script-size.ts";
import {
  compareViolations,
  type ScriptLintContext,
  type ScriptLintPhase,
  type ScriptLintStage,
  type ScriptViolation,
} from "../rules/script-lint.ts";

/**
 * 五级判定链,按裁决排定。**五个槽位已齐,注释占位机制就此收工**——占位服务的是
 * 「后面几张票还没写」的那段时间(免得这里引用一个还不存在的导出,那会让 `tsc -b` 直接红,
 * 后面的票无路可走)。五级都落地之后它只会让后来者误以为还有槽位没填,于是连同它那行
 * 「下面 N 级的槽位」一并删掉:新加一级直接**插在表里它该在的那一格**,顺序不许改。
 *
 * 每一格的白盒断言在 `pipeline.test.ts`(禁列 / 桥前缀 / 模块系统各一条,体积那条在
 * `rules/script-size.test.ts`):动顺序会让它们一起红,所以顺序有钉子,不必靠这份注释盯。
 * 各级的形状(`ScriptLintStage` 与它吃的上下文)归 `rules/script-lint.ts`,不在本文件。
 */
export const SCRIPT_LINT_STAGES: readonly ScriptLintStage[] = [
  forbiddenGlobalStage, // 禁列:标识符链整条命中禁列表(票 01)
  hostBridgeStage, // 桥前缀:任何标识符链的根带宿主桥前缀(票 03)
  moduleSystemStage, // 模块系统:export / import / import() / require / 动态 eval(票 02)
  scriptSizeStage, // 体积:字节数超过 maxBytes,iteration 只提示、freeze 拦(票 04)
];

export type ValidateScriptOptions = {
  /** 体积上限,字节。必填,没有默认值——缺它就是「上限未定」,而不是「不限」。 */
  readonly maxBytes: number;
  readonly phase: ScriptLintPhase;
  /**
   * 已经拿着**原始字节**的调用方(入口那一支读的是文件)可以用它覆盖字节数。
   * 默认从 `source` 文本按 UTF-8 重算;而「解码成字符串再算回去」与文件本身的字节数
   * 在源码不是合法 UTF-8 时会差(解码期替换成 U+FFFD),体积规则量的是产物的字节数,
   * 那个差值不该由规则承担。
   */
  readonly byteLength?: number;
};

/**
 * 判定链的对外缝:一段编译后的产物源码 → 一组**全序稳定**的违规(空数组 = 放行)。
 *
 * 输出顺序按 `compareViolations`:先按行列、再按规则类别名。生成管线要 diff 两轮迭代的结果,
 * 顺序不确定就 diff 不出来(spec《违规输出》)。
 */
export const validateScriptSource = (
  source: string,
  options: ValidateScriptOptions,
): readonly ScriptViolation[] => {
  const parsed = parseToAst(source, "script");
  if (!parsed.ok) {
    const first = parsed.errors[0];
    return [
      {
        rule: "syntax-error",
        // 这句话是给参赛模型读的(stdout 原样转给它),所以它必须说对病因。
        // 判定链的输入是**编译产物**,而带类型标注的 TS 源码落进的是同一条分支——最可能的
        // 病因只有一个:交上来的是源码,没编译。旧文案说的是「单文件、无 import/export 的
        // script-mode 模块」,那会把模型引向改模块语法:既改不动病因(模块语法归模块系统那一级,
        // 且那一级对 export/import 照样解析成立),又烧掉一轮迭代预算。
        message:
          `源码无法解析:${first?.message ?? "解析器没有给出原因"}。` +
          `校验器判的是编译产物(按 tsconfig.scripts.json 编译出来的单文件裸脚本):` +
          `如果这份源码里还留着类型标注、\`as\` 断言之类的 TS 写法,那是没编译,先编译再校验。`,
        line: first?.line ?? null,
        column: first?.column ?? null,
        blocking: true,
      },
    ];
  }

  const context: ScriptLintContext = {
    source,
    byteLength: options.byteLength ?? Buffer.byteLength(source, "utf8"),
    maxBytes: options.maxBytes,
    phase: options.phase,
    parsed,
  };
  const found = SCRIPT_LINT_STAGES.flatMap((stage) => stage(context));
  return [...found].sort(compareViolations);
};
