/**
 * 宿主桥前缀规则的断言:一段源码进,一组违规出。
 *
 * 断言对象只有一件事:一段源码被接受还是被带诊断拒绝。内部实现(遍历方式、链怎么拼、
 * 键位怎么排除)都可以整块换掉而让这些断言继续成立——换掉了也不影响本文件测的东西。
 * 快照测试与覆盖率门禁在 hld §2.2.4 里被禁,这里两条都不碰。
 */

import { expect, it } from "vitest";
import {
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  compareViolations,
  hostBridgeViolations,
  hostBridgeStage,
  isHostBridgeSymbol,
  SCRIPT_LINT_STAGES,
  validateScriptSource,
} from "../index.ts";

/** 把违规收成「类别 @ 行列」,比逐字段断言短,且违规文本的措辞改动不必连带改测试。 */
const where = (source: string): readonly string[] =>
  hostBridgeViolations(source).map(
    (violation) => `${violation.rule} @ ${violation.line}:${violation.column}`,
  );

/** 体积上限随便给一个大数:体积级不归本规则,不让一个未定值参与判定。 */
const OPTS = { maxBytes: 1_000_000, phase: "freeze" } as const;

it("干净源码无违规", () => {
  const source = `function loop(count) {
  let n = 0;
  for (let i = 0; i < count; i += 1) {
    n += Math.floor(i / 2) + Math.abs(n);
  }
  return n;
}
loop(8);
`;
  expect(hostBridgeViolations(source)).toEqual([]);
});

it.each([
  ["裸引用", "const a = __host;\n", ["host-bridge @ 1:11"]],
  ["带调用的链", "const a = __setSnapshot(1);\n", ["host-bridge @ 1:11"]],
  ["写也是一次按名字找符号,同样拒", "__host.x = 1;\n", ["host-bridge @ 1:1"]],
  ["只判根:后续段带不带前缀都一样", "__host.eval('1').length;\n", ["host-bridge @ 1:1"]],
  ["脚本自己声明一个带前缀的名字也判", "const __thing = 1;\n", ["host-bridge @ 1:7"]],
  ["函数声明的名字同样判", "function __helper() { return 0; }\n", ["host-bridge @ 1:10"]],
  ["类声明的名字同样判", "class __Bridge {}\n", ["host-bridge @ 1:7"]],
  ["参数名带前缀也判", "function loop(__n) { return 0; }\n", ["host-bridge @ 1:15"]],
  [
    "globalThis 等价写法,位置落在真正要改的那个名字上",
    "const a = globalThis.__setSnapshot(1);\n",
    ["host-bridge @ 1:22"],
  ],
  ["前缀本身就是一个名字", `const a = ${HOST_BRIDGE_PREFIX};\n`, ["host-bridge @ 1:11"]],
])("链的根带桥前缀即违规:%s", (_case, source, expected) => {
  expect(where(source)).toEqual(expected);
});

it("跨行也按源码位置逐条给出", () => {
  expect(where("const a = __x;\nconst b = 1 + __y.z;\n")).toEqual([
    "host-bridge @ 1:11",
    "host-bridge @ 2:15",
  ]);
});

it.each([
  ["同名成员不是桥", "const a = obj.__foo;\n"],
  ["同名对象字面量的键", "const o = { __foo: 1 };\n"],
  ["同名类方法", "class A { __foo() { return 0; } }\n"],
  ["成员名走字符串下标", 'const a = obj["__foo"];\n'],
  ["字符串里出现那个名字不是标识符", 'const a = "__foo";\n'],
  ["单下划线不是桥", "const _foo = 1;\nconst a = _foo;\n"],
  ["前缀出现在中途的段上,根不带前缀", "const a = obj.__foo.__bar;\n"],
  ["禁列规则那一侧不放行的名字,本规则也不多管", "const a = Date.now();\n"],
])("合规写法放行:%s", (_case, source) => {
  expect(hostBridgeViolations(source)).toEqual([]);
});

it("解构简写里那个被绑定的名字放行:它是一次取值,不是引用", () => {
  // 判它等于把键当引用,代价是误伤;而漏报的代价只是回到现状(桥不存在,脚本拿到 ReferenceError)。
  expect(hostBridgeViolations("const { __a } = g;\n")).toEqual([]);
});

it("同源断言:判据与读取点是同一个查询,前缀不自己存", () => {
  // 与禁列规则消费 `FORBIDDEN_GLOBAL_NAMES` 的那条同形:改真源里的 `HOST_BRIDGE_PREFIX`、
  // 重跑 `pnpm run generate`,本规则的行为随之改变——因为它问的是 `isHostBridgeSymbol`。
  // 名单在这里**现合成**(它是一张前缀不是一个清单),所以这批样本覆盖的是「前缀的边界形状」。
  const names = [
    HOST_BRIDGE_PREFIX,
    `${HOST_BRIDGE_PREFIX}a`,
    `${HOST_BRIDGE_PREFIX}${HOST_BRIDGE_PREFIX}b`,
    `_a`,
    "a",
    "Date",
    "Math.random",
  ];
  const sources = names.map((name) => `const a = ${name};\n`);
  expect(sources.map((source) => hostBridgeViolations(source).length > 0)).toEqual(
    names.map((name) => isHostBridgeSymbol(name)),
  );
});

it("违规文本面向模型:点名前缀,说清这是命名约定,给出该改的动作", () => {
  // 「自己声明的也算」是本规则的裁决点,而模型最容易在这里误读成「不许声明某几个名字」,
  // 于是把整段脚本改名到一个更离谱的前缀上。这句话里必须有「改名」这个动作。
  const [violation] = hostBridgeViolations("const a = __host;\n");
  expect(violation?.message).toContain(HOST_BRIDGE_PREFIX);
  expect(violation?.message).toContain("命名约定");
  expect(violation?.message).toContain("改名");
  expect(violation?.blocking).toBe(true);
});

it("解析不过时本规则不报违规:那条结论归判定链独占", () => {
  expect(hostBridgeViolations("function loop() { const a = ; }\n")).toEqual([]);
});

it("判定链上桥前缀排在禁列之后、体积之前", () => {
  // 五级顺序是裁决;这一级排在第 2 位(紧跟禁列),插错了位置会让「禁列必须先判」那句话落空。
  expect(SCRIPT_LINT_STAGES[1]).toBe(hostBridgeStage);
});

it("判定链上两类违规都报,按源码位置有序", () => {
  // 桥前缀一级既不吞禁列的违规、也不被禁列吞掉:一份源码里两类都在,两条都在输出里。
  const violations = validateScriptSource("const a = Date.now();\nconst b = __host;\n", OPTS);
  expect(violations.map((violation) => `${violation.rule} @ ${violation.line}`)).toEqual([
    "forbidden-global @ 1",
    "host-bridge @ 2",
  ]);
});

it("重叠裁决:一个既命中禁列又带桥前缀的构造,判为禁列", () => {
  // 判定链的顺序是裁决:禁列排在桥前缀前面。今天的禁列名单里没有任何一条带前缀,所以这处重叠
  // 造不出来源样本(真源那侧有一条断言钉住这个交集为空),裁决的形状因此落在全序比较上:
  // 同一位置时按类别名兜底,`forbidden-global` < `host-bridge`,禁列那条排在前面。
  const forbidden = {
    rule: "forbidden-global",
    message: "禁列",
    line: 1,
    column: 1,
    blocking: true,
  } as const;
  const bridge = {
    rule: "host-bridge",
    message: "桥前缀",
    line: 1,
    column: 1,
    blocking: true,
  } as const;
  expect([bridge, forbidden].sort(compareViolations)).toEqual([forbidden, bridge]);
});

it("重叠裁决的另一面:禁列名单里的名字不会被本规则顺手多报一条", () => {
  // 名单与前缀今天没有交集(真源那侧钉着),而这张名单可能变化:一个带前缀的禁列名应当
  // 仍然只出一条禁列违规,类别靠 `rule` 区分,不靠位置。
  for (const name of FORBIDDEN_GLOBAL_NAMES) {
    expect(
      validateScriptSource(`const a = ${name};\n`, OPTS).map((violation) => violation.rule),
      `名单里的 ${name} 只应当判成禁列`,
    ).toEqual(["forbidden-global"]);
  }
});
