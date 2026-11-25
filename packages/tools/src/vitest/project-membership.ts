/**
 * 「这个测试文件住在哪个 project」——由 vitest 自己的拾取结果**算**出来,不写死 project 名。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 门禁常常要「只跑某一个测试文件」。写法有两种:`vitest run --project <名字> <文件>`,或
 * `vitest run <文件>`。
 *
 * 前一种把**配置事实**抄进了门禁。`a8c1de3`(测试分层)把 `probe-harness.test.ts` 从 `unit`
 * 挪进 `vm`,预算复算门禁却还拿着 `--project unit` 去跑那个文件:vitest 收 0 个文件、退 0,
 * 门禁的空转检测只看到「一条用例名都没出现」——红的是「用例数」,错的是「project 是谁」。
 * 这不是一次手误,是把"文件归属"这种配置事实写进判据的必然下场:配置一搬,判据就撒谎。
 *
 * 后一种(`vitest run <文件>`,不带 `--project`)不会错,但**会把同一个文件跑多遍**:配置里
 * `all` 是收口用的全集池,`unit` / `vm` / `e2e` 是子集,一个文件同时被 `all` 与它的窄池收着,
 * 按文件过滤就会在两个池里各跑一次。门禁为同一件事付两遍价钱,而多跑的那一遍不产生新证据。
 *
 * 所以这里问 vitest 自己:`vitest list --filesOnly --json` 一次打印**每个 project 收了哪些
 * 文件**(形如 `[{ file, projectName }, …]`,同一个文件在多池里出现则多条),再由下面的纯函数
 * 回答「它住在哪」。配置怎么搬,答案跟着搬——包括搬进 `slow` / `nightly` 这类昂贵池。
 *
 * ── 为什么选「最窄的那个池」 ────────────────────────────────────────────────
 * 一个文件常常同时出现在多个 project 里(`all` 收全部 160+ 个,`vm` 只收它那 6 个)。挑**收文件
 * 数最少**的那个,等价于挑「最具体的那一档」:全集池只是收口用的副本,窄池才是文件的归属。
 * 这条规则有两处自证:
 *
 * - 若把 `probe-harness.test.ts` 放回 `unit`(a8c1de3 之前的样子),算出来的就是 `unit`——
 *   与从前写死的那条命令逐字相同;今天它算出 `vm`,命令跟着搬。**同一条规则覆盖前后两种配置。**
 * - 都不收时返回「没有 project 收它」,而不是挑一个默认值硬跑——「文件被谁收着」本身成了
 *   可断言的观测,而不是一个打听不到的假设。
 *
 * 并列时按名字排序兜底,保证同一份配置每次算出同一个答案:门禁的输出要可比,不能今天在 `a`
 * 明天在 `b`。
 *
 * 这个模块只做纯计算、不 spawn(`vitest list` 由调用方跑),所以它的反例不必起子进程。
 */

/** `vitest list --filesOnly --json` 的一条:某个 project 收了某个文件(绝对路径)。 */
export type ListedFile = {
  readonly file: string;
  readonly projectName: string;
};

const isListedFile = (value: unknown): value is ListedFile =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { file?: unknown }).file === "string" &&
  typeof (value as { projectName?: unknown }).projectName === "string";

/**
 * 解析 `vitest list --filesOnly --json` 的输出。
 *
 * 只截 `[`…`]` 之间那一段:这条命令平时是纯 JSON,但它会加载项目配置,而配置链上的任何东西
 * (插件、globalSetup)都可能往 stdout 写一行自己的话。为一行噪音把整道门禁变成崩溃不值当;
 * 反过来,形状不对时必须**抛错而不是当空数组**——空数组会一路走到「没有 project 收这个文件」,
 * 把「解析失败」说成「这文件没人收」,两种处方完全不同。
 */
export const parseListedFiles = (output: string): readonly ListedFile[] => {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error(`vitest list 的输出里没有 JSON 数组:${output.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(parsed) || !parsed.every(isListedFile)) {
    throw new Error(
      `vitest list 的 JSON 形状不是 [{file, projectName}, …]:${output.slice(0, 200)}`,
    );
  }
  return parsed;
};

/** 一次归属判定的结果:`resolved` 给出 project,`unlisted` 给出为什么判不出来。 */
export type ProjectResolution =
  | {
      /** 文件被这个 project 收着,就在这里跑。 */
      readonly kind: "resolved";
      readonly project: string;
      /** 所有收着它的 project(按收文件数从窄到宽),写进输出让人看得见判据。 */
      readonly candidates: readonly string[];
    }
  | {
      readonly kind: "unlisted";
      /** 中文理由,直接进门的红字。 */
      readonly reason: string;
    };

/**
 * 归一化路径比较:列表里是绝对路径,调用方给的是仓库相对路径。
 *
 * 按「以 `/<相对路径>` 结尾」比,而不是拼 `repoRoot`——调用方已经站在仓库根上,而这里只做
 * 字符串判断的话,反例可以喂假路径进来,不必造一棵真的目录树。
 */
const matches = (listedPath: string, relativePath: string): boolean =>
  listedPath.replaceAll("\\", "/").endsWith(`/${relativePath.replaceAll("\\", "/")}`);

/** 某个 project 收了多少个文件——「窄」的度量。 */
const widthOf = (listed: readonly ListedFile[], project: string): number =>
  listed.filter((entry) => entry.projectName === project).length;

/**
 * 判「这个文件住在哪个 project」:收它的 project 里取**最窄**的那个(并列按名字)。
 *
 * 返回理由而不是抛错(与 `gate/vacuous.ts` 同一条分层纪律):调用方要把这句话直接说成红字。
 */
export const resolveProject = (
  listed: readonly ListedFile[],
  relativePath: string,
): ProjectResolution => {
  const collecting = [
    ...new Set(
      listed.filter((entry) => matches(entry.file, relativePath)).map((entry) => entry.projectName),
    ),
  ].sort((a, b) => widthOf(listed, a) - widthOf(listed, b) || a.localeCompare(b));
  const [narrowest] = collecting;
  if (narrowest === undefined) {
    return {
      kind: "unlisted",
      reason: `没有任何 project 收 ${relativePath}:文件改了名、被排除了,还是配置漏了?这条判据得先找得到被试对象。`,
    };
  }
  return { kind: "resolved", project: narrowest, candidates: collecting };
};
