/**
 * 盲写产物的静态校验（票 12 的一次性留档工具）。
 *
 * 它不发明名单：注入面符号表取 `packages/schema/src/script-surface.ts` 的
 * `SANDBOX_INJECTED_API_SYMBOLS`，禁列取同文件的 `FORBIDDEN_GLOBAL_NAMES` 与 `HOST_BRIDGE_PREFIX`，
 * 内置全局名与 `Math` 成员取 `packages/schema/src/builtin-globals.ts`，解析层用
 * `packages/tools/src/parse-source.ts`（oxc 之上那层薄壳，`lang: "ts"`）。
 *
 * 「可见面」这一条是**白名单反转**：脚本里出现的每一个自由标识符，要么在注入面里，要么是
 * 标准 ECMAScript 纯函数，任何第三方名字（Node 全局、宿主注入桥、拼错的名字）都判红。
 *
 * 用法：node .scratch/rules-landing/blind/static-check.ts <舱名> [<舱名> ...]
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  SANDBOX_INJECTED_API_SYMBOLS,
} from "../../../packages/schema/src/script-surface.ts";
import {
  ALLOWED_MATH_MEMBERS,
  BUILTIN_GLOBAL_NAMES,
} from "../../../packages/schema/src/builtin-globals.ts";
import { parseToAst } from "../../../packages/tools/src/parse-source.ts";

const BLIND = new URL(".", import.meta.url).pathname;

/** 一条违规：`severity` 分 err（契约硬约束破了）与 warn（契约点名但要判读者语境）。 */
type Finding = { severity: "err" | "warn"; rule: string; detail: string };

const VISIBLE = new Set<string>([
  ...SANDBOX_INJECTED_API_SYMBOLS,
  ...BUILTIN_GLOBAL_NAMES,
  ...ALLOWED_MATH_MEMBERS,
]);

/** 标准 ECMAScript 里另有几十个纯函数（Array/Object/String 的原型成员等），它们不逐个列。 */
const MEMBER_ALLOWLIST = new Set([
  // 纯函数原型成员：读数组/字符串/数字的值与做纯计算，不碰宿主能力。
  "length",
  "push",
  "pop",
  "slice",
  "splice",
  "indexOf",
  "lastIndexOf",
  "includes",
  "join",
  "concat",
  "map",
  "filter",
  "forEach",
  "some",
  "every",
  "find",
  "findIndex",
  "sort",
  "reverse",
  "keys",
  "values",
  "entries",
  "has",
  "get",
  "set",
  "add",
  "delete",
  "size",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "substring",
  "substr",
  "toUpperCase",
  "toLowerCase",
  "trim",
  "split",
  "repeat",
  "padStart",
  "padEnd",
  "startsWith",
  "endsWith",
  "replace",
  "replaceAll",
  "toString",
  "valueOf",
  "abs",
  "min",
  "max",
  "floor",
  "ceil",
  "trunc",
  "sign",
]);

const check = (cell: string): { cell: string; findings: Finding[]; stats: Record<string, number> } => {
  const path = join(BLIND, cell, "work", "script.v1.ts");
  const source = readFileSync(path, "utf8");
  const findings: Finding[] = [];
  const parsed = parseToAst(source, "script");
  if (!parsed.ok) {
    for (const e of parsed.errors) {
      findings.push({ severity: "err", rule: "语法", detail: `${e.line}:${e.column} ${e.message}` });
    }
    return { cell, findings, stats: {} };
  }

  // ---- 收集：全部声明名（粗粒度，宁多勿漏）与全部自由引用 ----
  const declared = new Set<string>();
  const used = new Map<string, number>(); // 名字 → 出现次数
  const mathMembers = new Map<string, number>();
  let loopDecl: { line: number; params: number } | null = null;
  let floatLiteral = 0;
  let divide = 0;
  let typeofCount = 0;
  let truthyGuard = 0;

  // 类型标注整棵子树不是运行期名字（`{ id: number }` 里的 `id` 是字段声明不是引用），跳过它。
  const TYPE_KEYS = new Set(["typeAnnotation", "returnType", "typeParameters", "superTypeArguments"]);

  const walk = (node: any, parent: any, key: string | null): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parent, key);
      return;
    }
    if (key !== null && TYPE_KEYS.has(key)) return;
    const type: string = node.type ?? "";

    // 形态红线：模块语法与动态取码
    if (type === "ImportDeclaration" || type === "ExportNamedDeclaration" || type === "ExportDefaultDeclaration") {
      findings.push({ severity: "err", rule: "禁模块语法", detail: `${type} @${node.loc?.start?.line ?? "?"}` });
    }
    if (type === "CallExpression") {
      const callee = node.callee;
      const name =
        callee?.type === "Identifier"
          ? callee.name
          : callee?.type === "MemberExpression" && callee.object?.name === "module"
            ? "module.require"
            : "";
      if (name === "require" || name === "module.require") {
        findings.push({ severity: "err", rule: "禁模块语法", detail: `require() @${node.loc?.start?.line ?? "?"}` });
      }
      if (name === "eval") {
        findings.push({ severity: "err", rule: "禁动态 eval", detail: `eval() @${node.loc?.start?.line ?? "?"}` });
      }
    }
    if (type === "NewExpression" && node.callee?.name === "Function") {
      findings.push({ severity: "err", rule: "禁动态 eval", detail: `new Function() @${node.loc?.start?.line ?? "?"}` });
    }
    // typeof 与真值猜返回值：契约 §2.3 点名禁的那两种判别
    if (type === "UnaryExpression" && node.operator === "typeof") typeofCount += 1;
    if (
      type === "IfStatement" &&
      node.test?.type === "Identifier" &&
      /^result$|^res$|^order$|^moved$|^spawned$/.test(node.test.name)
    ) {
      truthyGuard += 1;
    }

    // 声明
    if (
      (type === "VariableDeclaration" || type === "FunctionDeclaration") &&
      (node.id?.name !== undefined || node.declarations !== undefined)
    ) {
      if (type === "VariableDeclaration") {
        for (const d of node.declarations) if (d.id?.type === "Identifier") declared.add(d.id.name);
      } else if (node.id?.name) {
        declared.add(node.id.name);
        if (node.id.name === "loop") {
          loopDecl = { line: node.loc?.start?.line ?? 0, params: node.params?.length ?? 0 };
        }
      }
    }
    if (type === "FunctionDeclaration" || type === "FunctionExpression" || type === "ArrowFunctionExpression") {
      for (const p of node.params ?? []) if (p?.type === "Identifier") declared.add(p.name);
    }
    if (type === "CatchClause" && node.param?.name) declared.add(node.param.name);

    // 引用（排除 MemberExpression 的非计算属性名与对象字面量的键）
    if (type === "Identifier") {
      const isMemberProp =
        parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      // 简写属性 `{ dist }` 的 key 与 value 是同一个名字：key 位跳过、value 位算引用。
      const isObjKey =
        (parent?.type === "Property" || parent?.type === "PropertyDefinition") &&
        parent.key === node &&
        !parent.computed &&
        key === "key";
      const isLabel = parent?.type === "LabeledStatement" || parent?.type === "BreakStatement";
      if (!isMemberProp && !isObjKey && !isLabel) {
        used.set(node.name, (used.get(node.name) ?? 0) + 1);
        if (node.name === "Math" && parent?.type === "MemberExpression" && !parent.computed) {
          const m = parent.property?.name;
          if (m) mathMembers.set(m, (mathMembers.get(m) ?? 0) + 1);
        }
      }
    }
    if (type === "Literal") {
      if (typeof node.value === "number" && node.raw && /[.eE]/.test(node.raw)) floatLiteral += 1;
    }
    if (type === "BinaryExpression" && node.operator === "/") divide += 1;

    for (const [k, v] of Object.entries(node)) {
      if (k === "loc" || k === "range" || k === "parent") continue;
      walk(v, node, k);
    }
  };
  walk(parsed.program, null, null);

  // ---- 入口 ----
  if (loopDecl === null) {
    findings.push({ severity: "err", rule: "入口", detail: "顶层没有 function loop() 声明" });
  } else if (loopDecl.params > 0) {
    findings.push({ severity: "err", rule: "入口", detail: `loop() 带了 ${loopDecl.params} 个参数` });
  }

  // ---- 可见面白名单反转 ----
  for (const [name, n] of [...used].sort()) {
    if (declared.has(name) || MEMBER_ALLOWLIST.has(name)) continue;
    if (VISIBLE.has(name)) continue;
    findings.push({ severity: "err", rule: "可见面", detail: `自由标识符 \`${name}\`（${n} 处）不在注入面里` });
  }
  for (const name of FORBIDDEN_GLOBAL_NAMES) {
    const head = name.split(".")[0];
    if (name.includes(".")) {
      if (mathMembers.has(name.split(".")[1] ?? "")) {
        findings.push({ severity: "err", rule: "禁列", detail: `用了 \`${name}\`` });
      }
    } else if (used.has(name)) {
      findings.push({ severity: "err", rule: "禁列", detail: `用了 \`${name}\`` });
    }
    void head;
  }
  for (const [m, n] of mathMembers) {
    if (!ALLOWED_MATH_MEMBERS.includes(m)) {
      findings.push({ severity: "err", rule: "禁列", detail: `Math.${m} 不在允许成员里（${n} 处）` });
    }
  }
  for (const [name] of used) {
    if (name.startsWith(HOST_BRIDGE_PREFIX)) {
      findings.push({ severity: "err", rule: "禁列", detail: `用了宿主桥 \`${name}\`` });
    }
  }
  if (floatLiteral > 0) {
    findings.push({ severity: "err", rule: "全整数", detail: `${floatLiteral} 处浮点字面量` });
  }
  if (divide > 0) {
    findings.push({ severity: "warn", rule: "全整数", detail: `${divide} 处除法（须整除）` });
  }
  if (typeofCount > 0) {
    findings.push({ severity: "warn", rule: "错误判别", detail: `${typeofCount} 处 typeof（契约 §2.3 点名禁）` });
  }
  if (truthyGuard > 0) {
    findings.push({ severity: "warn", rule: "错误判别", detail: `${truthyGuard} 处疑似真值猜返回值` });
  }

  return {
    cell,
    findings,
    stats: {
      行数: source.split("\n").length,
      自由标识符: used.size,
      Math成员: [...mathMembers.keys()].join(",") || "—",
      typeof: typeofCount,
      除法: divide,
      浮点字面量: floatLiteral,
    },
  };
};

const cells = process.argv.slice(2);
if (cells.length === 0) {
  console.error("用法：node static-check.ts <舱名> [...]");
  process.exit(1);
}
let errs = 0;
for (const cell of cells) {
  const r = check(cell);
  const e = r.findings.filter((f) => f.severity === "err").length;
  errs += e;
  console.log(`\n## ${cell}（${basename(join(BLIND, cell))}）`);
  console.log(`   ${JSON.stringify(r.stats)}`);
  if (r.findings.length === 0) {
    console.log("   零违规（err 0 / warn 0）");
  } else {
    for (const f of r.findings) console.log(`   [${f.severity}] ${f.rule}：${f.detail}`);
  }
}
console.log(`\n合计 err：${errs}`);