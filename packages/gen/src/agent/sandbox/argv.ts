/**
 * 一步的**形状**:bwrap 的参数表与那层 `ulimit` 包装。纯函数,不 spawn 任何东西。
 *
 * ── 每一步都是一次 `bwrap` 调用,不是「进一个沙箱」 ──
 * 根文件系统从空开始(`--tmpfs /`),宿主根目录一个 inode 都不出现;只 `--ro-bind` 进入库
 * rootfs 的 `bin/` 与 `contract/`,再 `--bind` 进这一步的工作区。于是「可见面」不是「把宿主的
 * `/bin` 裁掉」,而是从空根里长出白名单——「绝对路径能绕过 PATH 白名单」这个问题结构上不存在。
 * 依据见 `docs/adr/0033-sandbox-executor.md`。
 *
 * ── `/dev` 与 `/proc` 为什么在挂载面上 ──
 * 这两条是 ADR 里「内容物入库、不从宿主借」的**例外**,理由是它们不是宿主的内容物,是内核提供
 * 的伪文件系统:
 *
 * - `--dev /dev`:模型写的命令里 `2>/dev/null` 极其常见(ADR-0032 的观测形态决定了它会出现),
 *   没有 `/dev/null` 的命令会**因为沙箱缺一个空设备而失败**,失败原因与模型的策略无关——那是
 *   最难归类的一类噪声。bwrap 的 `--dev` 建的是一份最小设备集(null/zero/full/random/tty…),
 *   不 bind 宿主 `/dev` 的任何东西。
 * - `--proc /proc`:挂的是**为这个新 PID 命名空间新建的 procfs**,宿主进程在里面不可见
 *   (看不到宿主 pid,`/proc/1` 是沙箱自己的 init)。它给的是 `ulimit` 包装、`bash` 与 coreutils
 *   的常规自查(`/proc/self/*`)所需的那一层;不给的话,有些命令会以「机器坏了」的样子失败。
 *
 * 两条都不引入任何宿主字节,所以「内容物可钉」这条性质不受影响;它们也不提供第二个可写面
 * (`/proc` 是只读语义的伪文件系统,`/dev` 由内核管)。**故意不挂 `/tmp`**:可写面只许
 * `/workspace` 一个,多一个临时目录就多一条「成绩取最后一次 evaluate 的版本」失效的路径。
 *
 * ── 为什么 `ulimit` 是必须项,而不是加固项 ──
 * PID 命名空间只限制进程的**可见性**,不限制**数量**:一个 fork bomb 在沙箱里照样能把宿主吃穿。
 * bwrap 本身没有任何资源限制选项(上游的结论是「用 prlimit」),所以每步 shell 外面必须包一层
 * `ulimit`。它的边界要说清:rlimit 是**逐进程**额度,不是聚合额度,`N` 个子进程各有一份额度——
 * 它把「一次炸穿」降级成「炸得慢一点」,不是根除(ADR-0033 残余风险 1)。
 */

/** 单步的资源额度。三个都是「逐进程」额度,see 头注。 */
export type StepLimits = {
  /** `ulimit -u`:同一 uid 的进程数上限。挡 fork bomb 的第一层。 */
  readonly processes: number;
  /** `ulimit -v`:地址空间上限(KiB)。挡「一次吃满内存」。 */
  readonly addressSpaceKib: number;
  /** `ulimit -t`:CPU 秒上限。挡「一步里算满整台机器」。 */
  readonly cpuSeconds: number;
};

/**
 * 取值。三者都是**上限**而不是预算:模型正常使用远低于它们,撞上它们说明这一步在做不该做的事。
 *
 * - `processes = 256`:一次 `bash -c` 正常起不到十个进程;256 足够管道与子 shell,又远小于
 *   「把宿主 fork 穿」的量级。
 * - `addressSpaceKib = 1 GiB`:静态 bash + 三个 coreutils 的常驻是 MB 级;1 GiB 给足
 *   `sort`/`grep` 处理大文件的余量,又挡住「一次 malloc 把宿主换页打满」。
 * - `cpuSeconds = 60`:单进程 CPU 秒。它的作用是「一步里不许算满 60 秒的 CPU」,与宿主侧的
 *   墙钟上限互补(墙钟挡的是 IO 等待与多个子进程,CPU 秒挡的是单进程死算)。
 */
export const STEP_LIMITS: StepLimits = {
  processes: 256,
  addressSpaceKib: 1_048_576,
  cpuSeconds: 60,
};

/** 设置限额失败时这一步的退出码:与「命令自己失败」分开,便于报告把基础设施问题挑出来。 */
export const LIMIT_FAILURE_EXIT_CODE = 125;

/**
 * 包住每步 shell 的那层 `bash -c` 前言。
 *
 * 三条 `ulimit` 任一失败即退出 `LIMIT_FAILURE_EXIT_CODE`——**不 `|| true`**:限额是必须项,
 * 静默降级等于让「沙箱有资源上限」这句话在某台机器上悄悄变成假话,而门禁看不出来。
 *
 * `exec` 换掉外层 shell:多留一层 `bash` 会让 `ulimit -u` 的额度被外层进程占去一份,而且
 * 信号会多一跳(`--new-session` 下的进程组语义要尽量简单)。
 */
export const stepPrelude = (limits: StepLimits): string =>
  [
    `ulimit -u ${String(limits.processes)} || { printf 'sandbox: 无法设置单步进程数上限\\n' >&2; exit ${String(LIMIT_FAILURE_EXIT_CODE)}; }`,
    `ulimit -v ${String(limits.addressSpaceKib)} || { printf 'sandbox: 无法设置单步地址空间上限\\n' >&2; exit ${String(LIMIT_FAILURE_EXIT_CODE)}; }`,
    `ulimit -t ${String(limits.cpuSeconds)} || { printf 'sandbox: 无法设置单步 CPU 秒上限\\n' >&2; exit ${String(LIMIT_FAILURE_EXIT_CODE)}; }`,
    `exec /bin/bash -c "$1"`,
  ].join("\n");

/** 一步要执行什么、在哪儿执行、rootfs 在哪。 */
export type StepCommand = {
  /** 模型写的那段 shell 原文,整块交给 `bash -c`。 */
  readonly command: string;
  /** 这一步 bind 成 `/workspace` 的宿主目录(一个会话一份,由宿主持有)。 */
  readonly workspaceDir: string;
  /** 入库 rootfs 的宿主路径(它的 `bin/` 与 `contract/` 被挂成 `/bin` 与 `/contract`)。 */
  readonly rootfsDir: string;
  /** 覆盖单步额度(默认 `STEP_LIMITS`)。 */
  readonly limits?: StepLimits;
};

/**
 * 一步的 bwrap 参数表(不含 `bwrap` 自己那个路径)。
 *
 * 顺序有意义:先 `--tmpfs /` 把根换成空 tmpfs,再往里 bind;`--dev`/`--proc` 必须排在 tmpfs
 * 之后。命名空间那几条排在挂载之后只是为了读起来像一句「先有世界、再隔离世界」,对 bwrap 而言
 * 顺序无关。
 */
export const bwrapArgv = (command: StepCommand): readonly string[] => [
  // ── 空根,再长出白名单 ──
  "--tmpfs",
  "/",
  "--ro-bind",
  `${command.rootfsDir}/bin`,
  "/bin",
  "--ro-bind",
  `${command.rootfsDir}/contract`,
  "/contract",
  // 唯一可写面:这一步的工作区(同一个会话的所有步共用同一个宿主目录)。
  "--bind",
  command.workspaceDir,
  "/workspace",
  // 内核提供的两份伪文件系统(理由见头注):不是宿主内容物。
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--chdir",
  "/workspace",
  // ── 隔离四件:命名空间、能力、会话、随父死 ──
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-net",
  "--unshare-cgroup-try",
  "--cap-drop",
  "ALL",
  "--new-session",
  "--die-with-parent",
  // ── 环境:清空宿主环境(含凭证),只留 PATH 与 HOME ──
  "--clearenv",
  "--setenv",
  "PATH",
  "/bin",
  // bash 没有 HOME 时 `cd ~` 会落到 `/`(roots 的 home),把它指到工作区,免得模型为这件事付一步。
  "--setenv",
  "HOME",
  "/workspace",
  // ── 每步的 shell:限额包装 + `$1` 里的命令原文 ──
  "/bin/bash",
  "-c",
  stepPrelude(command.limits ?? STEP_LIMITS),
  // `bash -c <脚本> <$0> <$1>`:把命令原文走位置参数,不拼进脚本字符串——省掉一整层转义。
  "sandbox-step",
  command.command,
];

/**
 * 最小冒烟调用的参数表(preflight 用):与上面同一条形状,只是不挂工作区、不跑用户命令。
 *
 * 它刻意复用同一批隔离参数,不用一条「更简单」的调用:preflight 要证明的正是**这一套参数**
 * 在这台机器上成立;换一套去证明,证明的是另一件事。
 */
export const preflightArgv = (rootfsDir: string): readonly string[] => [
  "--tmpfs",
  "/",
  "--ro-bind",
  `${rootfsDir}/bin`,
  "/bin",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-net",
  "--unshare-cgroup-try",
  "--cap-drop",
  "ALL",
  "--new-session",
  "--die-with-parent",
  "--clearenv",
  "--setenv",
  "PATH",
  "/bin",
  "/bin/bash",
  "-c",
  "printf %s preflight-ok",
];
