/**
 * 入口的**对外契约**自测:一个子进程以什么退出码结束、往 stdout 打印了什么。
 *
 * 断言对象只有这两样——生成管线也只读这两样(spec《调用的形状:子进程 + 退出码》)。
 * 没有任何一处断言入口内部的函数形状、参数解析的中间结构或模块边界。
 *
 * 产物文件落在**仓库之外**的临时目录里,不在 `os.tmpdir()` 之外的任何地方:
 * 放在源码树里会被 oxfmt / oxlint 的目录扫描捡到,那两道门禁会先于本文件红一次,
 * 报的却不是这里要证明的那件事(与 `gates.test.ts` 头注里「探针落哪棵树」是同一条纪律)。
 *
 * **本文件不进 `gates` project**:门禁自测跑的是「仓库自身的门禁」,而本工具不是仓库门禁
 * (它不进 `check`,理由见 `validate/run-validate-script.ts` 的头注)。
 * 它进 `unit`,因为它验的是本 feature 的交付物,不是仓库的门禁配置。
 * 同理这里 spawn 的是 `node`,不是 `pnpm run …`,不存在 check → 测试 → check 的套娃。
 */

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const entry = here("./run-validate-script.ts");

/** 产物文件的落脚点。建在系统临时目录里,`afterAll` 整棵删掉。 */
const workDir = mkdtempSync(join(tmpdir(), "script-validator-01-"));
let counter = 0;

const artifact = (source: string): string => {
  counter += 1;
  const file = resolve(workDir, `artifact-${counter}.js`);
  writeFileSync(file, source, "utf8");
  return file;
};

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

type Outcome = { readonly status: number; readonly stdout: string; readonly stderr: string };

/** 按契约的方式调入口:产物文件 + 必填的两个旋钮。 */
const run = (file: string, args: readonly string[] = []): Outcome => {
  const result = spawnSync(
    process.execPath,
    [entry, file, "--max-bytes", "100000", "--phase", "freeze", ...args],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

const CLEAN = `function loop() {
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    n += Math.floor(i / 2);
  }
  return n;
}
loop();
`;

it("干净产物放行:退出码 0,stdout 说通过", () => {
  const outcome = run(artifact(CLEAN));
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toContain("脚本静态校验通过");
});

it("禁列违规被拦:退出码 1,stdout 点名那条链", () => {
  const outcome = run(artifact("function loop() { return Date.now(); }\nloop();\n"));
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).toContain("Date");
  expect(outcome.stdout).toContain("禁列全局名");
});

it("锁死顺序漏洞:禁列里的成员路径挂在白名单内的全局名下,仍然被拦", () => {
  // `Math` 在内置全局白名单里而 `Math.random` 在禁列表里。这份产物只差 `Math.floor` 是合规的:
  // 修掉违规那一句之后同一个文件回到退出码 0,两者只差这一个名字。
  const bad = run(artifact("const a = Math.random();\nconst b = Math.floor(1);\n"));
  expect(bad.status).toBe(1);
  expect(bad.stdout).toContain("Math.random");
  const fixed = run(artifact("const a = Math.floor(1);\nconst b = Math.floor(2);\n"));
  expect(fixed.status).toBe(0);
});

it("同类合并:五处同类违规在 stdout 上并成一行", () => {
  const body = Array.from({ length: 5 }, () => "  n += Date.now();").join("\n");
  const outcome = run(
    artifact(`function loop() {\n  let n = 0;\n${body}\n  return n;\n}\nloop();\n`),
  );
  expect(outcome.status).toBe(1);
  const merged = outcome.stdout.split("\n").filter((line) => line.includes("禁列全局名"));
  expect(merged).toHaveLength(1);
  expect(merged[0]).toContain("5 处");
});

it("解析不过:退出码 1,且只报一条解析失败", () => {
  const outcome = run(artifact("function loop() { const a = Date.now(); const b = ; }\n"));
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).toContain("源码无法解析");
  expect(outcome.stdout).not.toContain("禁列全局名");
});

/**
 * 未编译的 TS 源码被拒时,那一条诊断必须说「去编译」,不能说「去掉 import/export」。
 *
 * 这一条钉的是**文案会不会说谎**:解析层按 script 源形态(编译产物)判定,所以带 `as` 断言的
 * 源码落进的是解析失败那一支。而此刻最可能的原因只有一个——交上来的东西还没编译。
 * 文案若沿用旧的「单文件、无 import/export 的 script-mode 模块」,模型会去改模块语法:
 * 那既改不动真正的病因(hld §6.2「编译」那一行:入口形态由编译步骤判),又烧掉一轮迭代预算。
 * stdout 是面向模型的文本(本文件头注),所以这句要说对的地方就在这里。
 */
it("未编译的 TS 源码:诊断指向「先编译」,不指向「改模块语法」", () => {
  const outcome = run(artifact("function loop(): void {\n  return Math.floor(1);\n}\n"));
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).toContain("编译");
  expect(outcome.stdout).not.toContain("script-mode");
  expect(outcome.stdout).not.toContain("import/export");
});

it("缺少必填的 --max-bytes:退出码 1 + 用法说明", () => {
  // 校验器**不给默认值**:写一个默认值就是给一个未定值编答案(取值归规则集文件)。
  const result = spawnSync(process.execPath, [entry, artifact(CLEAN), "--phase", "freeze"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("用法");
});

it("--max-bytes 不是非负整数:退出码 1 + 用法说明", () => {
  const result = spawnSync(
    process.execPath,
    [entry, artifact(CLEAN), "--max-bytes", "3k", "--phase", "freeze"],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("用法");
});

it("--phase 不是那两个值之一:退出码 1 + 用法说明", () => {
  const result = spawnSync(
    process.execPath,
    [entry, artifact(CLEAN), "--max-bytes", "10", "--phase", "whatever"],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("用法");
});

it("读不到产物文件:退出码 1,不是假绿", () => {
  const outcome = run(resolve(workDir, "not-there.js"));
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).not.toContain("脚本静态校验通过");
});

/** 按契约的方式调入口,但让调用方自己给上限与时机——体积级的两档要在入口这一侧钉一遍。 */
const runWith = (file: string, maxBytes: number, phase: "iteration" | "freeze"): Outcome => {
  const result = spawnSync(
    process.execPath,
    [entry, file, "--max-bytes", String(maxBytes), "--phase", phase],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

it("体积超上限、iteration:退出码 0,提示里带「改算法,不要拆直线代码」", () => {
  // 迭代期只提示不拦:提前把模型拦下会逼它去压体积,而最自然的压法(拆直线代码)恰好是
  // 这条规则要封的盲区的另一面。所以提示路径上必须同样带那句话,而不只是拦的时候才说。
  const outcome = runWith(artifact(CLEAN), 10, "iteration");
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toContain("脚本体积");
  expect(outcome.stdout).toContain("改算法,不要拆直线代码");
  expect(outcome.stdout).toContain("提示");
});

it("体积超上限、freeze:退出码 1,拦截里带同一句并说清超出多少字节", () => {
  const outcome = runWith(artifact(CLEAN), 10, "freeze");
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).toContain("改算法,不要拆直线代码");
  expect(outcome.stdout).toContain("多出");
});

it("上限是入参:等于字节数放行,减一就拦", () => {
  const size = Buffer.byteLength(CLEAN, "utf8");
  expect(runWith(artifact(CLEAN), size, "freeze").status).toBe(0);
  expect(runWith(artifact(CLEAN), size - 1, "freeze").status).toBe(1);
});
