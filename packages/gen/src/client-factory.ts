/**
 * `ModelClient` 的工厂:按一条模型配置造出对应的客户端。
 *
 * 票 01 在这里留了缝并抛"未实现";票 08 把真实适配器接上——委托给 `http/client.ts`(三端点族、
 * 环境变量读凭证)。工厂本身保持薄:它是"配置 → 客户端"的唯一切换点,便于测试注入桩
 * (`GenerationOptions.createClient`)而不必知道 HTTP 细节。
 */

import type { ModelConfig } from "./config.js";
import { createHttpModelClient } from "./http/client.js";
import type { ModelClient } from "./model-client.js";

/** 造一条模型配置对应的真实 HTTP 客户端(鉴权、超时、状态码分类见 `http/client.ts`)。 */
export const createModelClient = (config: ModelConfig): ModelClient =>
  createHttpModelClient(config);
