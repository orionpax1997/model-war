/**
 * gen 包:脚本生成管线(hld §2.1 离线侧、§2.2.6)。
 * 唯一允许联网的包,**永不进对局进程**(NFR-4 AC2);禁 import 任何 result 类型(FR-5 AC1)。
 * 依赖方向单向:gen → schema。
 *
 * 对外面按域分文件,本文件是唯一入口(spec《真源包的导出面》的同款纪律):
 * 契约读入(`contract`)、prompt 模板(`prompt`)、模型配置(`config`)、模型客户端端口与桩
 * (`model-client` / `stub-client`)、真实 HTTP 客户端(`http/client`)、编排与 CLI 处理器(`run`)。
 * CLI 从 `@model-war/gen` 取 `generateAndFreeze`;后续各票只**追加**导出,不改既有名字。
 */

export { readRuleDocs, type RuleDocs } from "./contract.js";
export {
  ENDPOINT_FAMILIES,
  loadModelsConfig,
  type EndpointFamily,
  type ModelConfig,
  type ModelsConfig,
} from "./config.js";
export {
  type ChatMessage,
  type ChatRole,
  type ModelClient,
  type ModelParams,
  type ModelResponse,
} from "./model-client.js";
export { assemblePrompt, loadBaseTemplate, renderBaseTemplate } from "./prompt.js";
export {
  fail,
  reply,
  replies,
  stubClient,
  type StubCall,
  type StubClient,
  type StubReply,
  type StubStep,
} from "./stub-client.js";
export { createHttpModelClient } from "./http/client.js";
export {
  compileScript,
  deriveScriptTsconfig,
  parseTscVersion,
  readTscVersion,
  type CompileResult,
  type ScriptTsconfig,
} from "./compile.js";
export {
  scriptSizeLimit,
  validateScript,
  type ScriptLintPhase,
  type ValidateResult,
} from "./validate.js";
export {
  ARCHIVE_META_NAME,
  STAGING_DIR_PREFIX,
  SCRIPT_PRODUCT_NAME,
  SCRIPT_SOURCE_NAME,
  buildArchiveMeta,
  commitArchive,
  discardStagingDir,
  openStagingDir,
  sha256Hex,
  type BuildArchiveMetaInput,
  type CommitResult,
} from "./archive.js";
export {
  generateOneModel,
  type FailureClassification,
  type GenerationLogEntry,
  type ModelFailure,
  type ModelOutcome,
} from "./pipeline.js";
export {
  generateAndFreeze,
  runGeneration,
  type GenerationOptions,
  type GenerationRequest,
} from "./run.js";
export {
  buildFailureRecord,
  failureRecordPath,
  writeFailureRecord,
  type BuildFailureRecordInput,
  type WriteFailureRecordInput,
  type WriteFailureRecordResult,
} from "./failure.js";
// 失败记录的形状家已下沉到真源包(§2.2.5):对外名字一个不少,只换来源。
export { FAILURE_RECORD_PREFIX, type FailureIdentity, type FailureRecord } from "@model-war/schema";
