import { expect, it } from "vitest";
import {
  SCRIPT_LINT_STAGES,
  forbiddenGlobalStage,
  moduleSystemStage,
  validateScriptSource,
} from "../index.ts";

/**
 * 断言对象只有一件事:一段源码进,一组**有序**的违规出(空数组 = 放行)。
 *
 * 这一层测的是判定链自己的三条性质——顺序固定、解析失败独占、全序稳定——
 * 规则本身的判据在 `rules/forbidden-globals.test.ts` 里。
 */

/**
 * 体积上限随便给一个大数:体积级还没有落地(票 04),这里不让一个未定值参与判定。
 * `maxBytes` / `phase` / `byteLength` 三个旋钮要到票 04 才有可观察的后果,那时才断言它们。
 */
const OPTS = { maxBytes: 1_000_000, phase: "freeze" } as const;

/** 收成「类别@行列」,违规文本的措辞改动不必连带改这里。 */
const where = (source: string, options = OPTS): readonly string[] =>
  validateScriptSource(source, options).map((v) => `${v.rule} @ ${v.line}:${v.column}`);

it("干净源码放行,空数组", () => {
  expect(where("function loop() { return Math.floor(1); }\nloop();\n")).toEqual([]);
});

it("解析失败独占结果:只一条语法错误,零条规则违规", () => {
  const violations = validateScriptSource("function loop() { const a = ; }\n", OPTS);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe("syntax-error");
  expect(violations[0]?.blocking).toBe(true);
});

it("解析失败时连同名的禁列违规一起报不出来", () => {
  // 残树上的结论不可复现(spec《违规输出》)。这份源码里既有语法错误也有 `Date`,
  // 若两级都跑,输出会是「解析失败 + 若干禁列违规」——那样模型拿到的是一棵残树上的猜测。
  const violations = validateScriptSource(
    "function loop() { const a = Date; const b = ; }\n",
    OPTS,
  );
  expect(violations.map((v) => v.rule)).toEqual(["syntax-error"]);
});

it("解析失败时只留第一条诊断", () => {
  const violations = validateScriptSource("const a = ;\nconst b = ;\n", OPTS);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.line).toBe(1);
});

it("违规按源码位置排序,可直接 diff", () => {
  const source = `function loop() {
  const a = performance.now();
  const b = Date.now();
  const c = Math.random();
  return a + b + c;
}
`;
  expect(where(source)).toEqual([
    "forbidden-global @ 2:13",
    "forbidden-global @ 3:13",
    "forbidden-global @ 4:13",
  ]);
});

it("全序稳定:同一份源码两次校验得到逐项相同的序列", () => {
  const source = `function loop() {
  const a = Date.now();
  const b = Math.random();
  const c = performance.now();
  return a + b + c;
}
`;
  expect(validateScriptSource(source, OPTS)).toEqual(validateScriptSource(source, OPTS));
});

it("顺序漏洞的锁死用例:禁列里的成员路径挂在白名单内的全局名下,判为禁列违规", () => {
  // `Math` 在内置全局白名单里,而 `Math.random` 在禁列表里。按白名单先判就会把它放行。
  // 这条用例的作用就是把那条链钉死:哪一级先判它都仍然是 forbidden-global。
  const violations = validateScriptSource(
    "const a = Math.random();\nconst b = Math.floor(1);\n",
    OPTS,
  );
  expect(violations.map((v) => v.rule)).toEqual(["forbidden-global"]);
  expect(violations[0]?.line).toBe(1);
  expect(violations[0]?.column).toBe(11);
});

it("禁列是判定链的第一级", () => {
  // 这条是白盒的,却必须留:五级顺序是裁决而不是实现细节,而顺序没有任何外部可观察的等价物
  // ——后面几张票(桥前缀 / 模块系统 / 体积)落地时,各自会在这里再加一条钉住自己那个槽位。
  expect(SCRIPT_LINT_STAGES[0]).toBe(forbiddenGlobalStage);
});

it("模块系统落在第三级:禁列在前、桥前缀在前、体积在后", () => {
  // 同样是一条白盒断言,理由同上:模块系统这一格在五级顺序里的位置是裁决。
  // 桥前缀(票 03)与体积(票 04)此刻仍是注释占位,所以这里钉的是**索引**而不是那几个槽位的内容。
  expect(SCRIPT_LINT_STAGES[1]).toBe(moduleSystemStage);
});

it("违规都是拦截项,退出码那一侧因此只有一个 0/1", () => {
  const violations = validateScriptSource("const a = Date.now();\n", OPTS);
  expect(violations.every((violation) => violation.blocking)).toBe(true);
});
