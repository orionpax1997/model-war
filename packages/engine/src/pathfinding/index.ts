/**
 * 寻路子模块的对外聚合面。
 *
 * 收窄到一个函数与一个坐标类型:调用方(移动裁决,以及将来的沙箱 runtime bundle)拿到的能力
 * 就是「问一条路」,不需要知道二叉堆与启发式的倍率写在哪个文件里。
 */

export { findPath } from "./find-path.js";
export type { Point } from "./find-path.js";
