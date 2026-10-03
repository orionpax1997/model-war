import { Buffer } from "node:buffer";

import { expect, it } from "vitest";
import {
  SCRIPT_LINT_STAGES,
  renderViolations,
  scriptSizeStage,
  scriptSizeViolations,
  validateScriptSource,
} from "../index.ts";

/**
 * 断言对象只有外部可观察的两件:一段源码被接受还是被带诊断拒绝、以及诊断里那句话在不在。
 *
 * 内部实现(超标怎么算、措辞怎么拼、字段谁先谁后)都可以整块换掉而让这些断言继续成立。
 * 快照测试与覆盖率门禁在 hld §2.2.4 里被禁,这里两条都不碰。
 *
 * 上限一律**显式传**:取值归规则集文件(生成管线的交付物,现在不存在),校验器不给默认值,
 * 所以这里也不许拿某个数当「反正超不超都行」的默认值糊过去。
 */

/** 那半条规则信息本身。断言它出现,就是断言「这句话是规则的一部分」而不是润色。 */
const ADVICE = "改算法,不要拆直线代码";

/** 一份干净的产物(编译后的样子:单文件 script-mode、顶层 `function loop`)。 */
const CLEAN = `function loop() {
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    n += Math.floor(i / 2);
  }
  return n;
}
loop();
`;

const bytes = (source: string): number => Buffer.byteLength(source, "utf8");

it("边界三态:低于上限通过、恰好等于上限通过、高于上限违规", () => {
  // 判据是一句「超过才算」,所以中间那一态是三态里最容易写错的一态(写成 >= 就少放了一档)。
  expect(scriptSizeViolations(99, { maxBytes: 100, phase: "freeze" })).toEqual([]);
  expect(scriptSizeViolations(100, { maxBytes: 100, phase: "freeze" })).toEqual([]);
  expect(scriptSizeViolations(101, { maxBytes: 100, phase: "freeze" })).toHaveLength(1);
});

it("量的对象是编译后产物的字节数,不是字符串长度", () => {
  // 这份产物里只有一处多字节字符,所以长度与字节数不相等;上限取「字符串长度以上、字节数以下」,
  // 按字符串长度判会放行,按字节数判才拦得住——量的到底是哪一个,这条用例就钉住了它。
  const source = `const a = "中";\n`;
  expect(bytes(source)).toBeGreaterThan(source.length);
  expect(
    validateScriptSource(source, { maxBytes: source.length, phase: "freeze" }).map(
      (violation) => violation.rule,
    ),
  ).toEqual(["script-size"]);
});

it("字节数取调用方给的那一份,不从文本重算", () => {
  // 入口读的是文件的原始字节,并把那个数交给判定链;「解码成字符串再按 UTF-8 算回去」
  // 在产物不是合法 UTF-8 时会算出另一个数(解码期替换成 U+FFFD,一个字符三位)。
  // 这里给的 5 字节远小于这份源码真实的字节数,判据若改成重算文本就会拦下来。
  expect(validateScriptSource(CLEAN, { maxBytes: 10, phase: "freeze", byteLength: 5 })).toEqual([]);
});

it("时机分两级:同一份源码、同一个上限,iteration 只提示、freeze 拦", () => {
  // 两级由一个显式的调用形态区分(`phase`),不是靠猜「现在大概是哪一轮」——
  // 下面两条用的是完全相同的字节数与上限,差的那个参数就是时机本身。
  const iteration = validateScriptSource(CLEAN, { maxBytes: 10, phase: "iteration" });
  const freeze = validateScriptSource(CLEAN, { maxBytes: 10, phase: "freeze" });
  expect(iteration.map((v) => v.blocking)).toEqual([false]);
  expect(freeze.map((v) => v.blocking)).toEqual([true]);
  expect(iteration.map((v) => v.rule)).toEqual(["script-size"]);
});

it("提示与拦截两档的诊断都带「改算法,不要拆直线代码」", () => {
  // 迭代期恰恰是模型最容易随手拆循环的时候,所以提示路径上更不能少这一句。
  const iteration = renderViolations(
    validateScriptSource(CLEAN, { maxBytes: 10, phase: "iteration" }),
  );
  const freeze = renderViolations(validateScriptSource(CLEAN, { maxBytes: 10, phase: "freeze" }));
  expect(iteration).toContain(ADVICE);
  expect(freeze).toContain(ADVICE);
  // 抬头句说清拦没拦:只有提示时仍算通过,退出码那一侧因此可以是 0。
  expect(iteration).toContain("通过");
  expect(iteration).not.toContain("未通过");
  expect(freeze).toContain("未通过");
});

it("诊断说清超出多少字节,便于模型判断要缩多少", () => {
  const [violation] = scriptSizeViolations(137, { maxBytes: 100, phase: "freeze" });
  expect(violation?.message).toContain("137");
  expect(violation?.message).toContain("100");
  expect(violation?.message).toContain("37");
});

it("违规没有位置,且落在判定链输出的末尾", () => {
  // 体积级不是 AST 规则:硬给它一个 `1:1` 只会让「这个位置是猜的」消失在数据里;
  // 排序契约把无位置的违规落在末尾,免得「第一行是什么违规」随有没有超标而变。
  const violations = validateScriptSource("const a = Date.now();\nconst b = 1;\n", {
    maxBytes: 5,
    phase: "freeze",
  });
  expect(violations.map((v) => `${v.rule}@${v.line}:${v.column}`)).toEqual([
    "forbidden-global@1:11",
    "script-size@null:null",
  ]);
});

it("体积超标不掩盖别的规则:同一份源码里两类违规各自都报", () => {
  // 体积级在链上吃字节数,其余三级吃 AST,两者互不吞掉:否则「体积超标」会把一份还用了
  // 禁列全局名的产物缩成只收到一句体量提醒,模型改完体积那一半又撞上另一半。
  const violations = validateScriptSource("const a = Date.now();\n", {
    maxBytes: 1,
    phase: "freeze",
  });
  expect(violations.map((v) => v.rule).sort()).toEqual(["forbidden-global", "script-size"]);
});

it("体积是判定链的最后一级", () => {
  // 顺序是裁决而不是实现细节(禁列 → 桥前缀 → 模块系统 → 体积),而它没有任何外部可观察的等价物,
  // 所以要在这儿钉住。取末位而不是下标 4:前面几级还没落地时,末位就已经是本级。
  expect(SCRIPT_LINT_STAGES[SCRIPT_LINT_STAGES.length - 1]).toBe(scriptSizeStage);
});

it("上限是入参:换一组上限就换一条结论", () => {
  // 同一条源码、同一套时机,上限从「等于字节数」挪到「比字节数少一」,结论从放行变成违规。
  // 这条锁住「校验器不给默认值」这件事:取值只能由调用方给。
  const size = bytes(CLEAN);
  expect(validateScriptSource(CLEAN, { maxBytes: size, phase: "iteration" })).toEqual([]);
  expect(
    validateScriptSource(CLEAN, { maxBytes: size - 1, phase: "iteration" }).map((v) => v.rule),
  ).toEqual(["script-size"]);
});
