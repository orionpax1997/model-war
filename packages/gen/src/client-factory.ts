/**
 * `ModelClient` 的工厂:按一条模型配置造出对应的客户端。
 *
 * 票 01 只把缝钉在这里——真实 HTTP 适配器(三端点族、`.env`、本地假端点契约测试)是**票 08**
 * 的活,会整体替换本文件。此刻它抛一个**明确**的错误,而不是造一个占位客户端:
 * 占位客户端会让「还没接真端点」被读成「跑了一次、没报错」,而这正是本仓对 silence 假绿的禁忌。
 */

import type { ModelConfig } from "./config.js";
import type { ModelClient } from "./model-client.js";

/** 造一条模型配置对应的客户端。票 08 之前,真实实现不存在,直接抛错。 */
export const createModelClient = (_config: ModelConfig): ModelClient => {
  throw new Error("HTTP 模型客户端未实现(见票 08):生成管线暂不能对真实端点发请求");
};
