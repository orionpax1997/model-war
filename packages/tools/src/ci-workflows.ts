/**
 * CI 流水线的纯函数层:把 `.github/workflows/*.yml` 里「写了什么」解析成可断言的事实。
 *
 * ── 为什么要有这一层(而不是一条重一点的测试) ──
 * 票 07 的验收是「改错即红的冒烟验证」:workflow 里只要出现**直调入口**(`node ...`)或**引用了
 * 不存在的命名脚本**,就必须有一条测试红。仓库没有 yaml 库,不为这一次校验新引入依赖;于是把
 * 「哪些约束要成立」收进这一层的纯函数,`ci.test.ts` 只负责把约束接到真实的 workflow 文本上。
 *
 * ── 被断言的纪律(ADR-0010) ──
 * 流水线内只调命名脚本(`pnpm run <script>`),不直调 `node` 入口;失败等价于命名脚本失败。
 * 两条链各跑哪些脚本(主链成员、夜间硬门禁、夜间观测项)同样是事实,不靠肉眼数 yaml——
 * 成员清单在测试文件里,这里只提供读取手段。
 *
 * ── 解析口径 ──
 * 不做通用 YAML 解析,只认两种 `run:` 形态:同行标量(`run: ...`)与块标量(`run: |` 后跟更深缩进
 * 的行)。`run:` 既可以自占一行、也可以跟在列表项标记 `- ` 之后,两种都认。
 * 本文件不读文件系统:同一份文本永远解析出同一份事实。
 */

/** 块标量指示符(`run: |` / `run: >` 及其带裁剪/保留修饰的变体)。 */
const BLOCK_SCALARS = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

/**
 * 命令位置上的直调入口:词首(行首、或 `;`/`&`/`|` 之后)出现 `node`/`npx`/`tsx`/`vitest` 等
 * 项目工具名即判违规。`\b` 之后必须是非单词字符,所以 `node_modules` 不会被误伤。
 */
const DIRECT_ENTRY = /(?:^|[;&|]\s*)(?:node|npx|tsx|tsc|vitest|stryker|scc|bun|deno)(?![\w-])/mu;

/**
 * 记录用 shell 管道的行首:只做 `mkdir -p` / `printf` / `cat` 这类落盘动作,不执行任何项目代码。
 * 这是「非命名脚本命令」白名单里唯一的一档,窄到只够写 `reports/legs/<script>.txt`。
 */
const SHELL_PLUMBING = /^(?:set -[a-z]+|mkdir -p|printf |cat |echo )/u;

/** `pnpm run <字面脚本名>`;脚本名允许 `:` 与 `-`(`check:cross-process` 这种形态)。 */
const LITERAL_RUN = /^pnpm run ([A-Za-z0-9:_-]+)$/u;

/** `pnpm run ${{ matrix.script }}`:矩阵模板,真实成员由 `matrixLegs` 校验。 */
const TEMPLATE_RUN = /^pnpm run \$\{\{\s*matrix\.script\s*\}\}$/u;

/**
 * 抽出一个 workflow 文本里每个 `run:` 步的命令。
 *
 * 块标量按「缩进比 `run:` 键更深」收集,遇到缩进不深于键的行即停;空行保留(它们属于块内)。
 * 命令按原样返回(块内各行已去公共缩进),不做 YAML 引号解折——校验只看行首命令词。
 */
export const extractRunCommands = (yaml: string): readonly string[] => {
  const lines = yaml.split("\n");
  const commands: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/u.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }
    const indent = (match[1] ?? "").length;
    const inline = (match[2] ?? "").trim();
    if (inline !== "" && !BLOCK_SCALARS.has(inline)) {
      commands.push(inline);
      index += 1;
      continue;
    }
    const block: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? "";
      if (next.trim() === "") {
        block.push("");
        continue;
      }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) {
        break;
      }
      block.push(next.trim());
    }
    commands.push(block.join("\n"));
    index = cursor;
  }
  return commands;
};

/**
 * 校验一个 workflow 文本里的每个 `run:` 步:合法的只有三档——`pnpm install`(装依赖)、
 * `pnpm run <已知脚本>`(字面或 `matrix.script` 模板)、以及记录用的 shell 管道。其余一律违规。
 *
 * 返回违规清单(空 = 干净)。`scripts` 是 `package.json.scripts` 的键集合:直调入口与未知脚本
 * 都在这里被拦下,所以「改错即红」的反例可以只喂一段坏 yaml 给这条纯函数。
 */
export const runStepViolations = (
  yaml: string,
  scripts: ReadonlySet<string>,
): readonly string[] => {
  const violations: string[] = [];
  for (const command of extractRunCommands(yaml)) {
    if (DIRECT_ENTRY.test(command)) {
      violations.push(`直调入口(应为命名脚本):${command.split("\n")[0] ?? ""}`);
      continue;
    }
    for (const raw of command.split("\n")) {
      const line = raw.trim();
      if (line === "" || SHELL_PLUMBING.test(line)) {
        continue;
      }
      if (line.startsWith("pnpm install")) {
        continue;
      }
      const literal = LITERAL_RUN.exec(line);
      if (literal !== null) {
        if (!scripts.has(literal[1] ?? "")) {
          violations.push(`引用了不存在的脚本:${line}`);
        }
        continue;
      }
      if (TEMPLATE_RUN.test(line)) {
        continue;
      }
      violations.push(`非命名脚本命令:${line}`);
    }
  }
  return violations;
};

/** 一条链里被 `pnpm run` 直接点名的字面脚本(不含 `matrix.script` 模板)。 */
export const namedScripts = (yaml: string): readonly string[] => {
  const scripts: string[] = [];
  for (const command of extractRunCommands(yaml)) {
    for (const raw of command.split("\n")) {
      const match = LITERAL_RUN.exec(raw.trim());
      if (match !== null) {
        scripts.push(match[1] ?? "");
      }
    }
  }
  return scripts;
};

/** 矩阵里的一条腿:跑哪个脚本、是不是观测项(观测项红不阻断)。 */
export type MatrixLeg = { readonly script: string; readonly advisory: boolean };

/** `include:` 里的流式映射条目 `- { script: "...", advisory: <bool>, ... }`。 */
const MATRIX_LEG = /-\s*\{\s*script:\s*["']([^"']+)["']\s*,\s*advisory:\s*(true|false)\b/gu;

/** 读出夜间链 matrix 的全部腿(顺序即 yaml 里的书写顺序)。 */
export const matrixLegs = (yaml: string): readonly MatrixLeg[] => {
  const legs: MatrixLeg[] = [];
  for (const match of yaml.matchAll(MATRIX_LEG)) {
    legs.push({ script: match[1] ?? "", advisory: match[2] === "true" });
  }
  return legs;
};

/** 硬门禁腿的脚本名(advisory: false)。 */
export const hardGateScripts = (yaml: string): readonly string[] =>
  matrixLegs(yaml)
    .filter((leg) => !leg.advisory)
    .map((leg) => leg.script);

/** 观测项腿的脚本名(advisory: true)。 */
export const observationalScripts = (yaml: string): readonly string[] =>
  matrixLegs(yaml)
    .filter((leg) => leg.advisory)
    .map((leg) => leg.script);
