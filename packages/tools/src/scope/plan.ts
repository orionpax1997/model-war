/**
 * **计划代数**:把"要跑什么"变成可以比较的集合,以及"完整验证 ⊇ 默认验证"这条性质的机器表达。
 *
 * 起因是一个真实的洞(实测):`packages/tools` 的改动会让**默认** `check` 选中 `test:gates`
 * (166s),而 `--full` 只跑 `FULL_CHAIN = verify + gate:types`,里面没有 `gates` project。
 * 于是"更严格的验证"反而少跑了一族——收口命令不可能比它想收口的那个东西更弱。
 *
 * 这一层把可比性建立在**可计算**的东西上:把每个命名脚本递归展开成叶子命令,再从叶子命令里
 * 抽 `vitest` 的 `--project` 集合(`node --run x && node --run y` 会跟进去),于是
 *
 * ```
 * 链覆盖的 project 集 = ⋃ scriptProjects(chain 里的每个脚本)
 * 一条 run 需要的 project 集 = 它自己的 project / 它那个脚本展开出的 project
 * 没被覆盖 ⇒ 进 extras
 * ```
 *
 * 三条纪律:
 *
 * 1. **不知道就当没覆盖。** 展开不出任何 project 的 run(脚本形态变了、或它压根不是 vitest)
 *    一律进 extras——多跑几秒比"以为覆盖了"便宜。空集不等于"不需要"。
 * 2. **不重复执行。** 已被链覆盖的 run 不再单独跑;project 的包含关系也认(`all` 的 include
 *    就是 `unit ∪ e2e ∪ vm` 那一批文件,见 `PROJECT_CONTAINS`)。
 * 3. **判据可计算,不可声明。** 这张表不写在文档里:默认计划 ⊆ 链 ∪ extras 由
 *    `plan.test.ts` 对五个代表性改动逐个用真实 `decide()` 断言。
 *
 * 本模块**不读文件、不起进程**:脚本表由调用方传入(`package.json` 的 `scripts`),于是同一份
 * 逻辑既能在 `check.ts` 里用真的,也能在测试里喂假的。
 */

export type Scripts = Readonly<Record<string, string>>;

/** `node --run <name>` 形式的引用:脚本组合的唯一合法写法(`pnpm run <name>` 也认)。 */
const SCRIPT_REF = /^(?:node --run|pnpm run) ([A-Za-z0-9:_-]+)$/u;

/** 脚本体按 `&&` 切段:仓库里所有组合脚本都只用这一种连接符。 */
const partsOf = (body: string): readonly string[] =>
  body
    .split("&&")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** 一段命令若是"跑另一个命名脚本"的引用,返回那个名字;否则 `undefined`(它就是叶子)。 */
const refOf = (part: string, scripts: Scripts): string | undefined => {
  const name = SCRIPT_REF.exec(part)?.[1];
  return name !== undefined && scripts[name] !== undefined ? name : undefined;
};

/**
 * 把一个脚本展开成**叶子命令**(递归跟随 `node --run` 引用)。
 *
 * 环引用不死循环:脚本表是手写的,写下 `a = node --run b` / `b = node --run a` 不是不可能。
 * 遇到走过的名字就停,此时那一支贡献 0 条叶子——于是"展开不出来"的后果是**多跑**(进 extras),
 * 不是挂死。
 */
export const leavesOf = (scripts: Scripts, name: string): readonly string[] => {
  const leaves: string[] = [];
  const walked = new Set<string>();
  const walk = (script: string): void => {
    if (walked.has(script)) return;
    walked.add(script);
    const body = scripts[script];
    if (body === undefined) return;
    for (const part of partsOf(body)) {
      const ref = refOf(part, scripts);
      if (ref === undefined) leaves.push(part);
      else walk(ref);
    }
  };
  walk(name);
  return leaves;
};

/**
 * 一条叶子命令里的 `--project`。`--project x` 与 `--project=x` 两种写法都认:仓库里两种都在用
 * (`vitest run --project all --project property` 与 `--project=gates` 之类的手工调用),只认一种
 * 就会在另一种形态上静默得出空集。
 */
export const projectsIn = (command: string): readonly string[] => {
  const tokens = command.split(/\s+/u).filter((token) => token !== "");
  const projects: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === "--project") {
      const next = tokens[index + 1];
      // `--project` 后面跟着另一个开关 = 这一处没给值;缺值不是"全部 project"。
      if (next !== undefined && !next.startsWith("-")) projects.push(next);
    } else if (token.startsWith("--project=")) {
      const value = token.slice("--project=".length);
      if (value !== "") projects.push(value);
    }
  }
  return projects;
};

/** 一个命名脚本最终会跑哪些 vitest project。 */
export const scriptProjects = (scripts: Scripts, name: string): ReadonlySet<string> => {
  const projects = new Set<string>();
  for (const leaf of leavesOf(scripts, name)) {
    for (const project of projectsIn(leaf)) projects.add(project);
  }
  return projects;
};

/**
 * 一条要执行的条目。三种形态对应三种真实的跑法:
 *
 * - `script`:`node --run <名字>`,名字是 `package.json` 里真实存在的;
 * - `related`:`vitest related`,由依赖图决定具体文件(项目集取自 `test:related` 的定义);
 * - `gates`:门禁自测的**子集**,`node --run test:gates -- -t <pattern>`;`patterns` 为空表示整族。
 */
export type RunItem =
  | { readonly kind: "script"; readonly script: string }
  | {
      readonly kind: "related";
      readonly projects: readonly string[];
      readonly files: readonly string[];
    }
  | { readonly kind: "gates"; readonly patterns: readonly string[] };

/**
 * project 的**包含关系**(父 → 被它吞掉的子)。
 *
 * `all` 这个 project 的 include 就是 `unit ∪ e2e ∪ vm` 那一批文件——它只排除了 `gates` /
 * `slow` / `sandbox` / `gen-cli`(见 `vitest.config.ts` 的注释,同一份事实由
 * `test-layers.test.ts` 的「收口用的 all 项目没有排除 e2e / vm」盯着)。于是链跑了 `all` 之后
 * 再跑 `vm`,是把同一批文件跑第二遍:"不重复执行"必须认这条关系。
 *
 * `gates` **不在**任何父 project 里:它被 `all` 显式排除,这正是本模块存在的理由。
 */
export const PROJECT_CONTAINS: Readonly<Record<string, readonly string[]>> = {
  all: ["unit", "e2e", "vm"],
};

/** `covered` 是否收下了 `project`(自身命中,或命中一个把它包含在内的父 project)。 */
const covers = (covered: ReadonlySet<string>, project: string): boolean => {
  if (covered.has(project)) return true;
  return Object.entries(PROJECT_CONTAINS).some(
    ([parent, children]) => covered.has(parent) && children.includes(project),
  );
};

/** 一条 run 需要的 project 集。空集 = 无法判断 = 保守地当作"没被覆盖"。 */
export const runProjects = (scripts: Scripts, run: RunItem): ReadonlySet<string> => {
  switch (run.kind) {
    case "script":
      return scriptProjects(scripts, run.script);
    case "related":
      return new Set(run.projects);
    case "gates":
      return new Set(["gates"]);
  }
};

/**
 * 链里出现过的**脚本名字**(递归展开的那一张)。
 *
 * `quick` / `gate:static` 这类脚本不跑 vitest,没有 project 可数,可它们确实被链跑过了。
 * 判"覆盖"要同时看名字与 project,否则收口会把 `quick` 再跑一遍(它 0.75s,但重复执行本身
 * 让输出不可读:同一个名字在"链"和"extras"里各出现一次)。
 */
export const chainScriptNames = (
  scripts: Scripts,
  chain: readonly string[],
): ReadonlySet<string> => {
  const names = new Set<string>();
  const walk = (name: string): void => {
    if (names.has(name)) return;
    const body = scripts[name];
    if (body === undefined) return;
    names.add(name);
    for (const part of partsOf(body)) {
      const ref = refOf(part, scripts);
      if (ref !== undefined) walk(ref);
    }
  };
  for (const name of chain) walk(name);
  return names;
};

/**
 * 一条 run 是否被给定的 project 集(与脚本名集)覆盖。
 *
 * **空 project 集不算覆盖**:展开不出 project 意味着"不知道它跑的是什么",不知道就不许假定。
 * 这条规则的方向是安全的——它的表现是多跑。
 */
export const isCovered = (
  scripts: Scripts,
  run: RunItem,
  covered: ReadonlySet<string>,
  coveredScripts: ReadonlySet<string> = new Set(),
): boolean => {
  // 同一个命名脚本:名字对上就是跑过了(与它有没有 vitest project 无关)。
  if (run.kind === "script" && coveredScripts.has(run.script)) return true;
  const needed = runProjects(scripts, run);
  if (needed.size === 0) return false;
  for (const project of needed) if (!covers(covered, project)) return false;
  return true;
};

/** 链覆盖的 project 集(含包含关系带来的那一部分,判断在 `covers` 里做)。 */
export const chainProjects = (scripts: Scripts, chain: readonly string[]): ReadonlySet<string> => {
  const covered = new Set<string>();
  for (const name of chain) {
    for (const project of scriptProjects(scripts, name)) covered.add(project);
  }
  return covered;
};

/**
 * 收口计划:先跑链,再补默认计划里**链没覆盖**的那部分。
 *
 * `extras` 只补差集,不重复:链里 `test:all` 已经跑了 `all` + `property`,默认计划里的
 * `related`(`--project all`)与 `test:vm` 就不再出现;而 `test:gates`(`gates` project,被
 * `all` 显式排除)一定补上——它是本模块存在的那个洞。
 */
export const fullPlan = (input: {
  readonly scripts: Scripts;
  readonly chain: readonly string[];
  readonly runs: readonly RunItem[];
}): { readonly chain: readonly string[]; readonly extras: readonly RunItem[] } => {
  const covered = chainProjects(input.scripts, input.chain);
  const coveredScripts = chainScriptNames(input.scripts, input.chain);
  const extras = input.runs.filter(
    (run) => !isCovered(input.scripts, run, covered, coveredScripts),
  );
  return { chain: input.chain, extras };
};

/**
 * `默认计划 ⊆ 链 ∪ extras` 的机器表达:返回**没被计划收下**的那些 run(空数组即成立)。
 *
 * 不传 `extras` 时它就是 `fullPlan(...).extras`:链覆盖不到的差集。传了(通常直接传
 * `fullPlan(...).extras`)就变成判 **`D ⊆ F`**——完整计划跑完之后,默认计划里的每一步都有
 * 人执行它。这是本模块最重要的那条判据,`plan.test.ts` 对五个代表性改动逐个断言。
 */
export const uncoveredRuns = (input: {
  readonly scripts: Scripts;
  readonly chain: readonly string[];
  readonly runs: readonly RunItem[];
  /** 完整计划里额外要执行的项。给了它就是判 `D ⊆ F`,不给就是"链的差集"。 */
  readonly extras?: readonly RunItem[];
}): readonly RunItem[] => {
  const covered = new Set(chainProjects(input.scripts, input.chain));
  const coveredScripts = new Set(chainScriptNames(input.scripts, input.chain));
  for (const item of input.extras ?? []) {
    for (const project of runProjects(input.scripts, item)) covered.add(project);
    if (item.kind === "script") coveredScripts.add(item.script);
  }
  return input.runs.filter((run) => !isCovered(input.scripts, run, covered, coveredScripts));
};
