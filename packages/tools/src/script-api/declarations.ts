/**
 * 读**类型面**那份声明(`packages/schema/script-api/index.d.ts`),取出它的三样东西:
 * 声明出来的值名、函数签名、类型名。
 *
 * ── 为什么需要一个读法 ───────────────────────────────────────────────────────
 * 类型面是编译期的东西,类型被擦除之后不留任何运行时痕迹,而下游有两处必须在运行期拿到它的
 * 形状才能干活:契约文档的 API 表要把签名那一栏渲染出来(`generate/api-surface.ts`),
 * 基准编译面要按签名给出注入面桩的返回值(`benchmarks/compile.ts`)。
 * 在那之前这两处读的是符号表里手抄的 `signature` 字符串;现在那份抄本被删掉了(签名是类型面的事实),
 * 于是这里补上从真源读的那一段。**读法只有一个消费者方向:声明 → 下游**,反向不成立。
 *
 * ── 为什么是「读文本」而不是「跑编译器拿 AST」 ──────────────────────────────
 * 工具包以源码形态由 Node 的类型擦除执行、不产 JS(hld §3.2),要一份 AST 就得把 TypeScript
 * 编译器拉进它的运行时依赖;而这个文件读的是**一份我们自己写的、语句之间只用 `;` 分隔**的
 * ambient 声明,严格逐句匹配已经足够。为了「语法更严谨」把整个编译器拖进常跑门禁里不值当。
 *
 * ── 为什么解析失败一律非零退出 ──────────────────────────────────────────────
 * 这个读法是「类型面 → 下游」那条边上的唯一环节,而那条边的分叉形态正是**分叉得静悄悄**:
 * 读不出某个声明时如果默默跳过,API 表上就少一行签名、少一个名字,而漂移检查与编译门禁都还是绿的。
 * 所以形态是「不认识就抛」:声明的形态变了(加了 `declare namespace`、加了行尾注释、
 * 改了引号)而读法没跟上时,当场炸并把那一句原文打出来,而不是产出一份少了几行的下游。
 */

/** 读出来的整份类型面。三个清单都是**按声明序**,不排序——排序会让「表长什么样」取决于排序实现。 */
export type ScriptApiDeclarations = {
  /**
   * 值名:函数名与错误码字符串常量名。注入面的 22 个名字逐条落在这一份里。
   *
   * **重载算一个名字**:一个函数名下有几条 `declare function` 是同**一个**全局值(TS 的重载签名
   * 不产生新的运行时实体),而它要占注入面符号表里的**一行**。所以这里按首次出现去重,
   * 而重载那几条全部留在 `functionSignatures` 里。
   */
  readonly valueNames: readonly string[];
  /** 函数名 → 它那一条(或几条)`declare function` 的签名文本。同名多行是重载。 */
  readonly functionSignatures: ReadonlyMap<string, readonly string[]>;
  /** 类型名。它们擦掉类型标注后不剩运行时值,所以不在 `valueNames` 里。 */
  readonly typeNames: readonly string[];
};

/** 类型面那份声明的路径,相对仓库根。全仓库只有这一份声明。 */
export const SCRIPT_API_DECLARATION = "packages/schema/script-api/index.d.ts";

/**
 * `declare function 名字(参数): 返回值` → `名字(参数): 返回值`。
 *
 * 契约文档的签名那一栏就是这个形态(它本来也是从同一份东西投影出来的),所以这里只做
 * 「去掉 `declare function ` 与末尾分号、压掉折行」这一件事,不重排参数、不改引号:
 * 读法一旦开始"整理"文本,渲染出来的东西与真源之间就多了一层会走样的转换。
 *
 * `s` 标志是必需的:排版器会把长的参数表与返回类型折行,而 `.` 默认不跨行,少了它就会把一条
 * 折过行的声明判成「不认」——那正是折行会变成一次假红的原因。
 */
const FUNCTION = /^declare function ([A-Za-z_$][\w$]*)\((.*)\):\s*(.+)$/s;

/** `declare const 名字: "字面量"`。错误码字符串常量是字面量类型,所以收窄到只剩这一种形态。 */
const CONST = /^declare const ([A-Za-z_$][\w$]*):\s*"([^"]*)"$/;

/** `type 名字 = …`。 */
const TYPE = /^type ([A-Za-z_$][\w$]*) =/;

/** 块注释。声明里的散文全在块注释里,读法只看代码。 */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * 压掉折行,并去掉折行带来的行末逗号:排版器给多行参数表补的那个逗号逐字渲染进文档的话,
 * 模型会以为 `findPath` 有第五个参数。
 */
const collapse = (text: string): string => text.replace(/\s+/g, " ").replace(/,\s*$/, "").trim();

/**
 * 去掉注释。**先整体去块注释,再逐行去行注释**:顺序反了会把块注释之外的那些行切开。
 *
 * 行注释逐行去而不是全局正则:全局正则会把字符串字面量里的 `//` 也吃掉。声明里只允许整行注释,
 * 行尾注释会在语句中间截断,而截断后的语句读法一定报不认识——那正是它该报的。
 */
const withoutComments = (source: string): string =>
  source
    .replace(BLOCK_COMMENT, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

/**
 * 按**语句**切开:分号只在括号深度为零的地方算句末。
 *
 * 深度这一层是必需的:声明里有内联的对象类型(`type SiteProduction = { … ; … }`),而那些分号
 * 不是句末。按字符扫一遍比「先扫 `{` 再按行猜」少一处会走样的地方,代价只是十行。
 * 字符串字面量里的括号不参与计数——本文件的字符串字面量只有错误码名,里面没有括号。
 */
const statements = (source: string): readonly string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of source) {
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (char === ";" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
};

/**
 * 读一份类型面声明。**形态不认识就抛**,绝不返回一份缺了几行的读数。
 *
 * `source` 由调用方读进来(本文件不假定自己在磁盘上的位置):反向用例要把另一份声明读进同一个
 * 读法,而生成器与基准编译面各自算路径。
 */
export const readScriptApiDeclarations = (_file: string, source: string): ScriptApiDeclarations => {
  const valueNames: string[] = [];
  const typeNames: string[] = [];
  const signatures = new Map<string, readonly string[]>();

  for (const statement of statements(withoutComments(source))) {
    const fn = FUNCTION.exec(statement);
    if (fn !== null) {
      const name = fn[1] ?? "";
      if (!valueNames.includes(name)) {
        valueNames.push(name);
      }
      const rendered = `${name}(${collapse(fn[2] ?? "")}): ${collapse(fn[3] ?? "")}`;
      signatures.set(name, [...(signatures.get(name) ?? []), rendered]);
      continue;
    }
    const constant = CONST.exec(statement);
    if (constant !== null) {
      valueNames.push(constant[1] ?? "");
      continue;
    }
    const type = TYPE.exec(statement);
    if (type !== null) {
      typeNames.push(type[1] ?? "");
      continue;
    }
    throw new Error(`类型面声明里有一句这个读法不认(声明形态变了就改读法,不要跳过): ${statement}`);
  }

  return {
    valueNames,
    typeNames,
    functionSignatures: new Map([...signatures].map(([name, list]) => [name, [...list]])),
  };
};
