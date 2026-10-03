import { expect, it } from "vitest";
import {
  FORBIDDEN_GLOBAL_NAMES,
  forbiddenGlobalViolations,
  isForbiddenGlobalName,
} from "../index.ts";

/**
 * 断言对象只有一件事:一段源码进,一组违规出。
 *
 * 内部实现(遍历方式、链怎么拼、后缀怎么比)都可以整块换掉而让这些断言继续成立——
 * 换掉了也不影响本文件测的东西。快照测试与覆盖率门禁在 hld §2.2.4 里被禁,这里两条都不碰。
 */

/** 把违规收成「类别 @ 行列」,比逐字段断言短,且违规文本的措辞改动不必连带改测试。 */
const where = (source: string): readonly string[] =>
  forbiddenGlobalViolations(source).map(
    (violation) => `${violation.rule} @ ${violation.line}:${violation.column}`,
  );

it("干净源码无违规", () => {
  const source = `function loop() {
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    n += Math.floor(i / 2) + Math.abs(n);
  }
  return n;
}
loop();
`;
  expect(forbiddenGlobalViolations(source)).toEqual([]);
});

it.each([
  ["Date", "const a = Date.now();\n", "forbidden-global @ 1:11"],
  ["performance", "const a = performance.now();\n", "forbidden-global @ 1:11"],
  ["queueMicrotask", "queueMicrotask(noop);\n", "forbidden-global @ 1:1"],
  ["裸引用也算", "let t = 0;\nt = t + 1;\nDate;\n", "forbidden-global @ 3:1"],
  ["声明处就判,不问之后怎么用", "const r = Math.random;\n", "forbidden-global @ 1:11"],
  ["链指向禁列里的成员路径", "const a = Math.random();\n", "forbidden-global @ 1:11"],
  ["计算属性里的成员名照样判", 'const a = Math["random"]();\n', "forbidden-global @ 1:11"],
  [
    "globalThis 等价写法,位置落在真正要改的那个名字上",
    "const a = globalThis.Math.random();\n",
    "forbidden-global @ 1:22",
  ],
  ["globalThis 包着裸全局名", "const a = globalThis.Date;\n", "forbidden-global @ 1:22"],
  ["带调用的链", "const a = Math.random().toFixed(2);\n", "forbidden-global @ 1:11"],
  ["脚本自己声明一个同名函数也判", "function Date() { return 0; }\n", "forbidden-global @ 1:10"],
  ["解构里的默认值表达式仍然是引用", "const { a = Date.now() } = g;\n", "forbidden-global @ 1:13"],
  ["对象字面量简写里那个名字是引用", "const o = { performance };\n", "forbidden-global @ 1:13"],
])("禁列里的标识符链判违规:%s", (_case, source, expected) => {
  expect(where(source)).toEqual([expected]);
});

it.each([
  ["同名属性不是全局", "const a = x.Date;\n"],
  ["同名对象字面量的键", "const o = { Date: 1, Math: 2 };\n"],
  ["解构简写里那个名字是被绑定的局部名,不是全局引用", "const { performance } = g;\n"],
  ["白名单内的 Math 成员放行", "const a = Math.floor(x) + Math.max(0, y);\n"],
  ["光秃秃的 Math 放行", "const a = Math;\n"],
  ["带桥前缀的名字不归本规则判", "const a = __host.eval('1');\n"],
  ["动态下标取不到成员名,按不在禁列内处理", "const a = Math[k]();\n"],
  ["解构把链拆成两条独立的名字", "const { random } = Math;\n"],
])("合规写法放行:%s", (_case, source) => {
  expect(forbiddenGlobalViolations(source)).toEqual([]);
});

it("禁列表里没有的名字一个都不报:判据就是这张表本身", () => {
  // 这条是**同源断言**的另一半(另一半是下面那条「逐条都报」):把一个明显不在名单里的名字
  // 写进源码,规则若凭空禁了它,说明它自己偷偷存了一份名单。
  expect(where("const a = Symbol.iterator;\n")).toEqual([]);
  expect(where("const a = setTimeout;\n")).toEqual([]);
});

it("同源断言:名单里的每一条,单独用一次都判违规", () => {
  // 与禁浮点规则消费 `ALLOWED_MATH_MEMBERS` 的那条同形:真源改了名单、重跑 `pnpm run generate`,
  // 规则的行为随之改变——因为它**一个名字都不自己存**,问的就是 `isForbiddenGlobalName`。
  // 名单与源码形状的合成在这里现做,不另造一张样本表(那张表会变成第二份名单)。
  for (const name of FORBIDDEN_GLOBAL_NAMES) {
    // `const a = ` 恰好十个字符,于是名单里的名字一律落在第 11 列——不为每个名字手算列号。
    expect(where(`const a = ${name};\n`), `名单里的 ${name} 用在源码里应当判违规`).toEqual([
      "forbidden-global @ 1:11",
    ]);
  }
});

it("同源断言:判据与读取点是同一个查询", () => {
  // 等价性而不是逐条断言:对一批**从名单合成的**标识符链,「报违规」与「在名单里」必须同真假。
  // 哪一条判错(漏放或误伤)都会让这条红,而它覆盖了名单里所有前缀组合,不只是上面那几条样本。
  const names = [...FORBIDDEN_GLOBAL_NAMES, "Object", "Math.floor", "console.log", ""];
  const expressions = names.map((name) => `const a = ${name === "" ? "x" : name};\n`);
  const reported = expressions.map(
    (expression) => forbiddenGlobalViolations(expression).length > 0,
  );
  expect(reported).toEqual(
    expressions.map((_expression, index) => isForbiddenGlobalName(names[index] ?? "")),
  );
});

it("违规文本面向模型:点名那条链,并说清改什么", () => {
  const [violation] = forbiddenGlobalViolations("const a = Math.random();\n");
  expect(violation?.message).toContain("Math.random");
  expect(violation?.message).toContain("改用");
  expect(violation?.blocking).toBe(true);
});

it("解析不过时本规则不报违规:那条结论归判定链独占", () => {
  // 「解析失败独占」是判定链的职责;规则层若在这里也产出一条,调用方拿到的会是两条互相矛盾的说法。
  expect(forbiddenGlobalViolations("function loop() { const a = ; }\n")).toEqual([]);
});
