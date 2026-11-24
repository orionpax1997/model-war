/**
 * CI 流水线的纯函数层:把 `.github/workflows/*.yml` 里「写了什么」解析成可断言的事实。
 *
 * ── 为什么要有这一层(而不是一条重一点的测试) ──
 * 这一层的验收是「改错即红的冒烟验证」:workflow 里只要出现**直调入口**(`node ...`)或**引用了
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

/**
 * `pnpm run <字面脚本名>`,脚本名允许 `:` 与 `-`(`gate:cross-process` 这种形态)。
 *
 * 允许尾随 `-- <flag>`:收口是 `pnpm run check -- --full`(ADR-0038「一条命令,没有档位」),
 * 而 `--` 之后只许出现**开关**——带空格或引号的实参一旦放进来,这一步就又变回"yaml 里写命令",
 * 链定义会分叉。
 *
 * 开关之外只多许一种词:`$NAME` / `${NAME}`——同一 step 的 `env` 里那条值的引用。它之所以不算
 * "在 yaml 里写命令":值本身仍然是一个开关(`check` 的 `--since=origin/<base>`),而**算这个值**
 * 需要的事实(`github.base_ref`)只有 workflow 知道。引用的解析与校验在 `checkStepArgs`:没声明的
 * 引用解不出实参,于是断言红——而不是在 shell 里静默变成一个消失的词。
 */
const LITERAL_RUN =
  /^pnpm run ([A-Za-z0-9:_-]+)(?: --(?: (?:--[A-Za-z0-9:_-]+|-[A-Za-z]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?))*)?$/u;

/** `uses: actions/checkout@<版本>` 那一行(只认 step 的 `uses`,版本号不参与判断)。 */
const CHECKOUT_USES = /^\s*uses:\s*actions\/checkout@/u;

/**
 * 读出 `actions/checkout` 那一步的 `fetch-depth`(没这一步、或写了却没带这个键 → `undefined`)。
 *
 * 为什么值得一个纯函数:这条事实不在任何 `run:` 步里,`runStepViolations` 看不见它,而它是
 * `check` 能不能算出基准的前提(`check` 以 merge-base 为基准,浅克隆没有历史)。
 * 解析口径同本文件其余部分:不做通用 YAML,只按缩进认「同一个 step 内的键」——遇到不深于
 * `uses:` 的行(下一条 step 的 `- ` 或回到 job 级键)就收手,不把后面 step 的键认成它的。
 */
export const checkoutFetchDepth = (yaml: string): number | undefined => {
  const lines = yaml.split("\n");
  const usesIndex = lines.findIndex((line) => CHECKOUT_USES.test(line));
  if (usesIndex === -1) return undefined;
  const usesLine = lines[usesIndex] ?? "";
  const usesIndent = usesLine.length - usesLine.trimStart().length;
  for (let index = usesIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    // 下一条 step(`- ` 自占行首)或回到 job 级键:这个 step 结束了。
    if (indent < usesIndent) return undefined;
    if (indent === usesIndent && line.trimStart().startsWith("- ")) return undefined;
    const match = /^fetch-depth:\s*"?(\d+)"?\s*$/u.exec(line.trim());
    if (match !== null) return Number(match[1]);
  }
  return undefined;
};

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

// ── 一个 run 步实际收到什么实参 ──────────────────────────────────────────────

/**
 * 把 `${{ … }}` 求值成**这一条已知形态**的结果,认不出来就是 `undefined`。
 *
 * 只认一种:
 *
 * ```
 * github.event_name == 'pull_request' && format('--since=origin/{0}', github.base_ref) || ''
 * ```
 *
 * 故意不写一个通用表达式求值器:那条路要处理引号、括号、函数表、真假值,而本文件的原则是
 * "不做通用解析"。换写法时就红——因为**这个形态本身就是被判据钉住的事实**:PR 对着自己的
 * base 分支比,push 不传参退回脚本默认值。
 *
 * `undefined`(认不出)与 `""`(认得出,但这次事件不传)在调用方是两回事:前者让断言红,
 * 后者是一个**消失的词**(shell 里空变量展开后不留参数)。
 */
export const evaluateSinceExpression = (
  expression: string,
  input: { readonly event: string; readonly baseRef: string },
): string | undefined => {
  const body = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/u.exec(expression.trim());
  if (body === null) return undefined;
  const shape =
    /^github\.event_name\s*==\s*'pull_request'\s*&&\s*format\('--since=origin\/\{0\}'\s*,\s*github\.base_ref\)\s*\|\|\s*''$/u;
  if (!shape.test((body[1] ?? "").trim())) return undefined;
  return input.event === "pull_request" ? `--since=origin/${input.baseRef}` : "";
};

/** 去掉 yaml 标量两侧的引号(只处理"两边成对"这一种,不做转义解码)。 */
const unquote = (value: string): string => {
  const quoted = /^(['"])([\s\S]*)\1$/u.exec(value);
  return quoted === null ? value : (quoted[2] ?? "");
};

/**
 * 读出一个 `run:` 步自己的 `env`(键 → 值原文)。
 *
 * 解析口径同本文件其余部分:不做通用 YAML,只按**缩进**认「同一个 step 内的键」——
 * 往上找到比 `run:` 更浅的第一行(那是这一步的 `- name:`),再往下收到下一个同级行。
 * 从这个范围外读到的同名键不算这一步的:否则一个 job 级的 `SINCE` 会被读成这条命令的实参,
 * 而两者在 GitHub 上确实是不同的作用域。
 */
const envOfRunStep = (yaml: string, run: string): Readonly<Record<string, string>> => {
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  const lines = yaml.split("\n");
  const runIndex = lines.findIndex((line) => {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/u.exec(line);
    return match !== null && (match[2] ?? "").trim() === run;
  });
  if (runIndex === -1) return {};
  const runIndent = indentOf(lines[runIndex] ?? "");

  let stepIndex = runIndex;
  while (stepIndex > 0) {
    const previous = lines[stepIndex - 1] ?? "";
    stepIndex -= 1;
    if (previous.trim() !== "" && indentOf(previous) < runIndent) break;
  }
  const stepIndent = indentOf(lines[stepIndex] ?? "");
  let end = stepIndex + 1;
  for (; end < lines.length; end += 1) {
    const line = lines[end] ?? "";
    if (line.trim() === "") continue;
    if (indentOf(line) <= stepIndent) break;
  }

  const env: Record<string, string> = {};
  let envIndent: number | undefined;
  for (let cursor = stepIndex; cursor < end; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (envIndent === undefined) {
      if (/^\s*env:\s*$/u.test(line)) envIndent = indent;
      continue;
    }
    if (indent <= envIndent) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(line);
    if (match === null) continue;
    env[match[1] ?? ""] = unquote((match[2] ?? "").trim());
  }
  return env;
};

/**
 * `check` 这一步在某个事件下**实际收到的实参**(不含 `pnpm run check` 本身)。
 *
 * 为什么要把它算出来:yaml 里写的是表达式,**真实参数**要等到那个事件发生才知道。而这里要
 * 钉住的事实恰好是"PR 上比的是哪个对象"——它破了的事不会有任何东西红,只会让 CI 把 base 分支
 * 之后的历史改动当成这个 PR 的改动(多跑、且红在与本 PR 无关的地方)。
 *
 * 认不出就返回 `undefined`:没有 check 步、表达式不是已知形态、引用的变量没在同一步声明——
 * 三种都是"实参没法确定",而没法确定时不能默认为空(那正好是静默退回默认基准的形状)。
 */
export const checkStepArgs = (input: {
  readonly yaml: string;
  readonly event: string;
  readonly baseRef: string;
}): readonly string[] | undefined => {
  const run = extractRunCommands(input.yaml).find((command) =>
    /^pnpm run check(?: -- |$)/u.test(command),
  );
  if (run === undefined) return undefined;
  const head = /^pnpm run check(?: --(.*))?$/u.exec(run);
  if (head === null) return undefined;
  const tokens = (head[1] ?? "")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return [];

  const env = envOfRunStep(input.yaml, run);
  const args: string[] = [];
  for (const token of tokens) {
    const reference = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(token);
    if (reference === null) {
      args.push(token);
      continue;
    }
    const expression = env[reference[1] ?? ""];
    if (expression === undefined) return undefined;
    const value = evaluateSinceExpression(expression, input);
    if (value === undefined) return undefined;
    // 空值在 shell 里是**消失的词**,不是一个空参数:`--full` 后面不会多出一个 ""。
    if (value !== "") args.push(value);
  }
  return args;
};

/** 矩阵里的一条腿:跑哪个脚本、产物名用哪个 slug、是不是观测项(观测项红不阻断)。 */
export type MatrixLeg = {
  readonly script: string;
  readonly slug: string;
  readonly advisory: boolean;
};

/** `include:` 里的流式映射条目 `- { script: "...", slug: "...", advisory: <bool>, ... }`。 */
const MATRIX_LEG =
  /-\s*\{\s*script:\s*["']([^"']+)["']\s*,\s*slug:\s*["']([^"']+)["']\s*,\s*advisory:\s*(true|false)\b/gu;

/** 读出夜间链 matrix 的全部腿(顺序即 yaml 里的书写顺序)。 */
export const matrixLegs = (yaml: string): readonly MatrixLeg[] => {
  const legs: MatrixLeg[] = [];
  for (const match of yaml.matchAll(MATRIX_LEG)) {
    legs.push({ script: match[1] ?? "", slug: match[2] ?? "", advisory: match[3] === "true" });
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

// ── 产物名 ───────────────────────────────────────────────────────────────────

/**
 * GitHub 产物名允许的字符:字母、数字与 `._-`。
 *
 * 禁用面来自 upload-artifact 自身的校验(`:` `*` `?` `"` `<` `>` `|` `/` `\r` `\n` `\`),
 * 它按 NTFS 兼容口径拦一道。夜间矩阵的脚本名天然带 `:`(`gate:limits` 这种命名形态),
 * 所以产物名不能直接拼 `matrix.script`。
 */
const ARTIFACT_NAME = /^[A-Za-z0-9._-]+$/u;

/**
 * 校验一批**具体**产物名(模板已代入):名字非法或多个腿重名都会让上传步失败。
 *
 * 返回问题清单(空 = 干净)。名字为空也计入非法:`slug` 漏写时矩阵腿会静默丢名,
 * 与「产物传上去了但看不出是哪条腿」相比,直接红更好。
 */
export const artifactNameViolations = (names: readonly string[]): readonly string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!ARTIFACT_NAME.test(name)) {
      problems.push(`产物名含非法字符(只允许字母数字与 ._-):${name}`);
    }
    if (seen.has(name)) {
      problems.push(`产物名重复(同名会让上传步失败):${name}`);
    }
    seen.add(name);
  }
  return problems;
};
