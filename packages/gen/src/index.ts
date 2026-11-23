/**
 * gen 包:脚本生成管线(hld §2.1 离线侧、§2.2.6)。
 * 唯一允许联网的包,**永不进对局进程**;禁 import 任何 result 类型。
 * 依赖方向单向:gen → schema。
 *
 * 对外面按域分文件,本文件是唯一入口(同 ADR-0003 的纪律):
 * 契约读入(`contract`)、prompt 模板(`prompt`)、模型配置(`config`)、模型客户端端口与桩
 * (`model-client` / `stub-client`)、真实 HTTP 客户端(`http/client`)、编排与 CLI 处理器(`run`)。
 * CLI 从 `@model-war/gen` 取 `generateAndFreeze`;后续只**追加**导出,不改既有名字。
 */

export { readRuleDocs, ruleDocsDir, type RuleDocs } from "./contract.js";
export {
  AGENT_SYSTEM_TEMPLATE_NAME,
  AGENT_TEMPLATE_NAME,
  CONTRACT_INDEX_NAME,
  DEFAULT_CONTRACT_IDENTITY,
  contractIdentityTrailer,
  loadAgentPrompt,
  loadAgentSystemTemplate,
  loadAgentTemplate,
  readContractIndex,
  renderAgentTemplate,
  type AgentPrompt,
  type ContractIdentity,
} from "./agent-prompt.js";
export {
  ENDPOINT_FAMILIES,
  loadModelsConfig,
  type EndpointFamily,
  type ModelConfig,
  type ModelsConfig,
} from "./config.js";
export {
  generationParams,
  generationRequestEvidence,
  type GenerationPolicy,
  type ReasoningControl,
  type OutputField,
  type SupportEvidence,
  type SupportStatus,
} from "./generation-policy.js";
export { type AttemptEvidence } from "./generation-evidence.js";
export {
  type ChatMessage,
  type ChatRole,
  type ModelClient,
  type ModelParams,
  type ModelResponse,
} from "./model-client.js";
export {
  fail,
  reply,
  replies,
  stubClient,
  toolCall,
  type StubCall,
  type StubClient,
  type StubReply,
  type StubStep,
} from "./stub-client.js";
export { createHttpModelClient } from "./http/client.js";
export {
  HARNESS_DIGEST,
  HARNESS_VERSION,
  harnessIdentity,
  harnessManifest,
  type HarnessManifest,
} from "./agent/identity.js";
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
export { prepareTrialPlan, runTrialScript, type TrialProbe, type TrialResult } from "./trial.js";
// 假执行器(`withHostBash` / `withRealBash`)**不从这里出去**:它是测试替身,不是生产 API。
// 跨包使用走测试支持入口 `@model-war/gen/testing`(理由见 `testing.ts` 的头注),本包自己的测试
// 相对 import 同一个文件。
// 评测网格的测试夹具与桩(`stubClient` 同一条纪律:测试要用的东西由本包交出来,不各自手抄)。
export { fixtureScripts, gridPlanFixture } from "./trial-plan.fixture.js";
export {
  FIXTURE_AVERAGE_POINTS,
  completeGridTrial,
  fixtureGridSummary,
  fixtureObservationsText,
  fixtureReadings,
  type CompleteGridTrialOptions,
} from "./trial-grid.fixture.js";
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
  scoreFromCandidateEvidence,
  type AgentArchiveFields,
  type EvaluateScoring,
  type EvaluateSubmission,
  type FailureClassification,
  type GenerationLogEntry,
  type GenerationTransportLogEntry,
  type ModelFailure,
  type ModelOutcome,
} from "./pipeline.js";
// `TransportError` 是 `ModelClient.send` 的失败契约（重试层按 `instanceof` / `status` 分派适应哪种退避），
// 所以它进生产面：写一个适配器或者一个「会吹 429」的桩都需要它。拿普通 `Error` 冒充不是同一个事
// ——那在重试层是「不可重试」，于是一条想验退避的用例会静静地验成另一条路。
export { TransportError, type TransportErrorOptions } from "./transport-error.js";
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
