/**
 * 极小的 YAML 子集读取器:**runner 私有的一份**(`season.yaml` 用它读入)。
 *
 * ── 为什么这里存在第二份,而不复用 `packages/gen` 的那份 ──
 *
 * runner 与 gen 之间不得有依赖边:spec《模块与接口》明写 `runner → schema` 单向、
 * 「不新增 `runner → gen` 的边」;`packages/runner` 的 `package.json` 也只声明 `@model-war/schema`。
 * 下沉到 `@model-war/schema` 同样不行——ADR-0003 与 hld §3.1 把 schema 限定为「无运行时代码」。
 * 于是唯一的家只有 runner 自己。本文件与 `packages/gen/src/yaml-lite.ts` **行为逐字相同**
 * (同样的 `parseYamlSubset(source, filePath)` 签名、同样的错误文案、同样的受支持子集),
 * 便于日后读者直接 diff 两份、也便于将来有一次真正的抽取时合并。
 *
 * ── 为什么不用 YAML 库 ──
 *
 * 唯一用户面是 `apps/cli` 打包出的**单文件** bin(`dist/modelwar.mjs`),esbuild 以 ESM 形态
 * bundle 一切。现成的 YAML 库(含 `yaml`)是 CJS,内部 `require('process')` 之类在 ESM 产物里
 * 会触发 esbuild 的 "Dynamic require ... is not supported" —— 真实 bin 会在**运行期**崩,
 * 而不是测试里红。为一份五六个字段的配置引入这个运行期风险不划算。
 *
 * ── 支持的子集(严格;超出即报错,不猜)──
 *
 * - 块映射 `key: value` 与块序列 `- value`(序列项可以是标量,也可以是内联 `- key: value`
 *   起始的映射);
 * - 嵌套靠**缩进**;只允许空格,不允许制表符;
 * - 标量:纯量、单引号串、双引号串(按 JSON 语义解转义)、整数、小数、`true` / `false`、
 *   `null` / `~`;空值即 `null`;
 * - `[]` 与 `{}` 两个空流式字面量;**非空**流式数组/映射不支持(报错);
 * - 整行或行尾的 `#` 注释(引号内的 `#` 不算)。
 *
 * 不支持即**报错并给出行号**,而不是静默当成字符串——静默会把配置错误推迟成运行期怪象。
 * 因此 `season.example.yaml` 里的 `rankPoints` / `maps` 一律写**块序列**(多行 `- x`),
 * 而非 spec 范例里的内联流式形态。
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue };

type Line = {
  readonly indent: number;
  readonly text: string;
  readonly lineNo: number;
};

const lineError = (filePath: string, lineNo: number, message: string): Error =>
  new Error(`${filePath}:${lineNo}: ${message}`);

/** 去掉行尾注释:引号内的 `#`、以及前面不是空白的 `#` 都不算注释。 */
const stripComment = (line: string): string => {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote !== null && char === quote) {
      quote = null;
      continue;
    }
    if (quote === null && char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
};

const isDash = (text: string): boolean => text === "-" || text.startsWith("- ");

/** 找 `key:` 的分隔冒号位置(仅当其后是空白或行尾),跳过引号内的冒号。 */
const separatorIndex = (text: string): number => {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote !== null && char === quote) {
      quote = null;
      continue;
    }
    if (quote !== null) {
      continue;
    }
    if (char === ":" && (index + 1 === text.length || text[index + 1] === " ")) {
      return index;
    }
  }
  return -1;
};

const parseScalar = (text: string, filePath: string, lineNo: number): YamlValue => {
  if (text === "[]") {
    return [];
  }
  if (text === "{}") {
    return {};
  }
  if (text.startsWith("[") || text.startsWith("{")) {
    throw lineError(filePath, lineNo, "不支持非空的流式数组/映射,请改用块形态");
  }
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) {
      throw lineError(filePath, lineNo, "双引号未闭合");
    }
    try {
      return JSON.parse(text) as YamlValue;
    } catch {
      throw lineError(filePath, lineNo, "双引号串无法解析");
    }
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) {
      throw lineError(filePath, lineNo, "单引号未闭合");
    }
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text === "null" || text === "~") {
    return null;
  }
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  if (/^-?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    return Number.parseFloat(text);
  }
  return text;
};

const unquoteKey = (text: string, filePath: string, lineNo: number): string => {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text) as string;
    } catch {
      throw lineError(filePath, lineNo, "键的双引号串无法解析");
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
};

const tokenize = (source: string, filePath: string): Line[] => {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNo = index + 1;
    if (rawLine.includes("\t")) {
      throw lineError(filePath, lineNo, "不支持制表符缩进,请用空格");
    }
    const cleaned = stripComment(rawLine).replace(/\s+$/, "");
    if (cleaned.trim().length === 0) {
      return;
    }
    const indent = cleaned.length - cleaned.trimStart().length;
    lines.push({ indent, text: cleaned.slice(indent), lineNo });
  });
  return lines;
};

const parseMapping = (
  lines: readonly Line[],
  start: number,
  indent: number,
  filePath: string,
): [Record<string, YamlValue>, number] => {
  const map: Record<string, YamlValue> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw lineError(filePath, line.lineNo, "缩进不一致(此处不该更深)");
    }
    if (isDash(line.text)) {
      break;
    }
    const separator = separatorIndex(line.text);
    if (separator === -1) {
      throw lineError(filePath, line.lineNo, '不是 "key: value" 形式');
    }
    const key = unquoteKey(line.text.slice(0, separator).trim(), filePath, line.lineNo);
    const rest = line.text.slice(separator + 1).trim();
    index += 1;
    if (rest.length > 0) {
      map[key] = parseScalar(rest, filePath, line.lineNo);
      continue;
    }
    const child = lines[index];
    if (
      child !== undefined &&
      (child.indent > indent || (child.indent === indent && isDash(child.text)))
    ) {
      const [value, next] = parseNode(lines, index, child.indent, filePath);
      map[key] = value;
      index = next;
    } else {
      map[key] = null;
    }
  }
  return [map, index];
};

const parseSequence = (
  lines: readonly Line[],
  start: number,
  indent: number,
  filePath: string,
): [YamlValue[], number] => {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent !== indent || !isDash(line.text)) {
      break;
    }
    const afterDash = line.text.slice(1);
    const lead = afterDash.length - afterDash.trimStart().length;
    const contentIndent = indent + 1 + lead;
    const content = afterDash.trim();
    index += 1;
    if (content.length === 0) {
      const child = lines[index];
      if (child !== undefined && child.indent > indent) {
        const [value, next] = parseNode(lines, index, child.indent, filePath);
        items.push(value);
        index = next;
      } else {
        items.push(null);
      }
      continue;
    }
    if (separatorIndex(content) !== -1) {
      const sub: Line[] = [{ indent: contentIndent, text: content, lineNo: line.lineNo }];
      while (index < lines.length) {
        const child = lines[index];
        if (child === undefined || child.indent <= indent) {
          break;
        }
        sub.push(child);
        index += 1;
      }
      const [value] = parseNode(sub, 0, contentIndent, filePath);
      items.push(value);
      continue;
    }
    items.push(parseScalar(content, filePath, line.lineNo));
  }
  return [items, index];
};

const parseNode = (
  lines: readonly Line[],
  start: number,
  indent: number,
  filePath: string,
): [YamlValue, number] => {
  const line = lines[start];
  if (line === undefined) {
    throw new Error(`${filePath}: 空文档`);
  }
  if (line.indent !== indent) {
    throw lineError(filePath, line.lineNo, "缩进不一致");
  }
  return isDash(line.text)
    ? parseSequence(lines, start, indent, filePath)
    : parseMapping(lines, start, indent, filePath);
};

/**
 * 解析一份 YAML 子集文档。语法错误抛 `Error`,消息带 `<文件>:<行号>`。
 * 空文档返回 `null`。
 */
export const parseYamlSubset = (source: string, filePath: string): YamlValue => {
  const lines = tokenize(source, filePath);
  const first = lines[0];
  if (first === undefined) {
    return null;
  }
  const [value, next] = parseNode(lines, 0, first.indent, filePath);
  const leftover = lines[next];
  if (leftover !== undefined) {
    throw lineError(filePath, leftover.lineNo, "无法解析的剩余内容");
  }
  return value;
};
