/**
 * 允许名单的**读取点**——名单本身不在本包里。
 *
 * 真源在 `@model-war/schema`(hld §6.2、ADR-0003)。本文件 import 的是**生成物**
 * (`generated/builtin-globals.ts`,由 `pnpm run generate` 从真源产出)。
 * 「生成物与手写表不得并存」自此兑现:曾经躺在这里的那张手写表已退役,本包内**零手写副本**,
 * 名单只有一个出处。
 *
 * 为什么规则层读生成物、而生成器直接 import 真源包:分界线是「能不能 afford 构建」——
 * 完整论证与实测数字见 `generate/registry.ts` 的头注。一句话:规则层在快门禁的路径上,
 * 每条提交都跑,不能有 `tsc -b` 前置;生成器偶尔跑一次,前置构建无所谓。
 *
 * 本模块**刻意不依赖 `rules/` 也不依赖 `gate/`**:名单要先于两个消费者存在,才谈得上「一份真源」。
 * 消费者都只经由这里读名单:禁浮点规则 `rules/no-float.ts` 读 `Math` 成员那一半;
 * `BUILTIN_GLOBAL_NAMES` 这一半的消费者是规则文档生成(`generate/builtin-globals.ts`,
 * 它 import 真源包而非本文件),白名单反转由编译器的名字解析执行、不读名单。
 */

import { ALLOWED_MATH_MEMBERS, BUILTIN_GLOBAL_NAMES } from "./generated/builtin-globals.ts";

export { ALLOWED_MATH_MEMBERS, BUILTIN_GLOBAL_NAMES };

/** 查询用集合。与名单同源,不另存一份——两个消费者都走这里,免得各自缓存出偏差。 */
const LOOKUP = new Set(ALLOWED_MATH_MEMBERS);

/** 某个 `Math` 成员是否在允许名单内。名单之外的成员一律判违规,不在调用处开例外。 */
export const isAllowedMathMember = (member: string): boolean => LOOKUP.has(member);
