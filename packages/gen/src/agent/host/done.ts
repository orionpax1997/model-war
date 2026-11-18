/**
 * `done` 哨兵:宿主侧的**执行准备**——一块命令在执行之前先被切开。
 *
 * ── 语义是「块级」的,不是「命令行级」的(ADR-0032) ──
 * 一块内遇到独占一行的 `done` 就停止执行该块剩余部分并结束会话,它前面的命令照常执行。这比
 * mini 的「检测输出首行」更安全:模型写 `evaluate && done` 是自然写法,我们执行 `evaluate`
 * 然后停下,`done` 之后写的东西不会被执行。
 *
 * ── 正确形态是「切掉后半段,整块一次 `bash -c`」 ──
 * 不是「执行两段」。ADR-0032 的动作边界是「一整块交给一次 `bash -c`」:切成两段执行会让
 * shell 状态(变量、`cd`、函数定义、heredoc)在 `done` 那一行断掉——而 `done` 在模型眼里只是
 * 一条命令,它前面那半段的 `set -e`、`cd` 之类理应对整块生效。所以这里只交回「要执行的那段
 * 命令」与「这块是不是以 done 结束」,执行仍然是一次。
 *
 * ── 判据是「独占一行」 ──
 * `done` 在行首行尾带空白仍算(模型常缩进);出现在 `printf 'done'`、`echo done` 或
 * `done=1` 里都不算。判据刻意只认**整行去空白之后恰好等于 `done`**,不做 shell 解析——
 * 解析器必然漏,而漏的那一面是「该停没停」。
 */

/** 一次切分的两端。 */
export type DoneSplit = {
  /** 要执行的那段命令(`done` 之前的全部字节;没有 `done` 时就是原文)。 */
  readonly body: string;
  /** 这块是不是以 `done` 结束(切到了哨兵)。 */
  readonly ended: boolean;
};

/** 哨兵行:整行去空白之后恰好是它。 */
const DONE_LINE = "done";

/**
 * 把整块命令按**第一个**独占一行的 `done` 切开。
 *
 * 纯函数,不碰磁盘、不起进程:它是「宿主侧的执行准备」,调用方拿到 `body` 之后照常整块
 * `sandbox.run({ command: body })` 一次。
 *
 * `done` 是块内第一行时 `body` 是空串(用 `bash -c ""` 跑一下没有副作用,调用方也可以直接跳过)。
 */
export const splitDoneBlock = (command: string): DoneSplit => {
  const lines = command.split("\n");
  const index = lines.findIndex((line) => line.trim() === DONE_LINE);
  if (index < 0) {
    return { body: command, ended: false };
  }
  return { body: lines.slice(0, index).join("\n"), ended: true };
};
