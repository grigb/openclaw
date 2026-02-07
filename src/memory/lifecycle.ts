/**
 * Memory Lifecycle Integration
 *
 * Integrates the memory provider into OpenClaw's session lifecycle.
 * Handles session start/end events, message ingestion, tool call tracking,
 * memory retrieval for context, and reinforcement learning hooks.
 */

import { type Logger, pino } from "pino";
import type { MemoryConfig } from "./config-schema.js";
import {
  createMemoryProvider,
  type MemoryProvider,
  type MemoryProviderConfig,
  type RetrieveResult,
  type MemoryRecord,
  type TrustContext,
} from "./provider.js";
import type {
  IngestEventRequest,
  IngestToolOutputRequest,
  IngestWorkingStateRequest,
  IngestOutcomeRequest,
  TaskState,
  Sensitivity,
} from "./membrane-types.js";

/**
 * Session context for memory operations
 */
export interface SessionContext {
  /** Unique session identifier */
  sessionId: string;
  /** Session key (e.g., agent:main:main) */
  sessionKey?: string;
  /** Channel the session is on (e.g., matrix, discord, whatsapp) */
  channel?: string;
  /** Session type (e.g., main, subagent, cron, heartbeat) */
  sessionType?: string;
  /** Agent ID for the session */
  agentId?: string;
  /** User/actor ID for trust context */
  actorId?: string;
  /** Workspace directory for the session */
  workspaceDir?: string;
  /** Thread ID if in a threaded conversation */
  threadId?: string;
}

/**
 * Message context for ingestion
 */
export interface MessageContext {
  /** Message role (user, assistant, system) */
  role: "user" | "assistant" | "system";
  /** Message content */
  content: string;
  /** Timestamp of the message */
  timestamp?: string;
  /** Optional message ID */
  messageId?: string;
}

/**
 * Tool call context for ingestion
 */
export interface ToolCallContext {
  /** Tool name */
  toolName: string;
  /** Tool call ID */
  toolCallId: string;
  /** Tool arguments */
  args?: Record<string, unknown>;
  /** Tool result */
  result?: unknown;
  /** Whether the tool call was an error */
  isError?: boolean;
  /** Dependencies (other tool call IDs this depends on) */
  dependsOn?: string[];
}

/**
 * Reinforcement feedback context
 */
export interface FeedbackContext {
  /** Type of feedback */
  type: "positive" | "negative" | "correction";
  /** Memory record ID to reinforce/penalize */
  recordId: string;
  /** Reason for the feedback */
  rationale?: string;
  /** Amount to adjust salience (for penalties) */
  amount?: number;
}

/**
 * Memory retrieval options for context injection
 */
export interface ContextRetrievalOptions {
  /** Query string (usually the user's message or task) */
  query: string;
  /** Maximum tokens for retrieved context */
  maxTokens?: number;
  /** Minimum salience threshold */
  minSalience?: number;
  /** Maximum number of records */
  limit?: number;
}

/**
 * Memory Lifecycle Manager
 *
 * Manages memory operations throughout a session's lifecycle.
 */
export class MemoryLifecycleManager {
  private readonly provider: MemoryProvider;
  private readonly config: MemoryConfig;
  private readonly logger: Logger;
  private readonly sessionId: string;
  private readonly sessionContext: SessionContext;

  // Track tool calls within the session for dependency tracking
  private readonly toolCallGraph: Map<string, string[]> = new Map();
  private readonly episodicRecordIds: Set<string> = new Set();
  private workingStateRecordId: string | null = null;

  constructor(params: {
    provider: MemoryProvider;
    config: MemoryConfig;
    sessionContext: SessionContext;
    logger?: Logger;
  }) {
    this.provider = params.provider;
    this.config = params.config;
    this.sessionContext = params.sessionContext;
    this.sessionId = params.sessionContext.sessionId;
    this.logger = params.logger ?? pino({ name: "memory-lifecycle" });
  }

  /**
   * Get the underlying memory provider
   */
  getProvider(): MemoryProvider {
    return this.provider;
  }

  /**
   * Check if memory is enabled and available
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config?.enabled) {
      return false;
    }
    return this.provider.isAvailable();
  }

  /**
   * Build trust context for memory operations
   */
  private buildTrustContext(): TrustContext {
    const maxSensitivity = this.config?.retrieval?.defaultMaxSensitivity ?? "medium";
    return {
      maxSensitivity: maxSensitivity as Sensitivity,
      authenticated: true,
      actorId: this.sessionContext.actorId ?? "openclaw",
      scopes: [this.sessionContext.channel ?? "local"].filter(Boolean),
    };
  }

  /**
   * Build scope string for memory records
   */
  private buildScope(): string {
    const parts = [
      this.sessionContext.channel,
      this.sessionContext.agentId,
      this.sessionContext.sessionType,
    ].filter(Boolean);
    return parts.join(":") || "local";
  }

  /**
   * Called when a session starts
   */
  async onSessionStart(): Promise<void> {
    if (!this.config?.enabled || !this.config?.ingestion?.enabled) {
      return;
    }

    // Check if this session type should be excluded
    const excludeTypes = this.config.ingestion.excludeSessionTypes ?? ["heartbeat"];
    if (this.sessionContext.sessionType && excludeTypes.includes(this.sessionContext.sessionType)) {
      this.logger.debug(
        { sessionId: this.sessionId, type: this.sessionContext.sessionType },
        "Session type excluded from memory ingestion",
      );
      return;
    }

    try {
      const request: IngestEventRequest = {
        source: `openclaw:${this.sessionContext.channel ?? "local"}`,
        eventKind: "session_start",
        ref: this.sessionId,
        summary: `Session started: ${this.sessionContext.sessionKey ?? this.sessionId}`,
        timestamp: new Date().toISOString(),
        tags: [
          "session",
          this.sessionContext.channel ?? "local",
          this.sessionContext.sessionType ?? "unknown",
        ].filter(Boolean),
        scope: this.buildScope(),
        sensitivity: "low",
      };

      const record = await this.provider.ingest(request);
      if (record) {
        this.episodicRecordIds.add(record.id);
        this.logger.debug({ recordId: record.id, sessionId: this.sessionId }, "Session start ingested");
      }
    } catch (error) {
      this.logger.warn({ error, sessionId: this.sessionId }, "Failed to ingest session start");
    }
  }

  /**
   * Called when a message is received or sent
   */
  async onMessage(message: MessageContext): Promise<void> {
    if (!this.config?.enabled || !this.config?.ingestion?.enabled) {
      return;
    }

    try {
      const request: IngestEventRequest = {
        source: `openclaw:${this.sessionContext.channel ?? "local"}`,
        eventKind: `message_${message.role}`,
        ref: message.messageId ?? `${this.sessionId}:${Date.now()}`,
        summary: this.truncateContent(message.content, 500),
        timestamp: message.timestamp ?? new Date().toISOString(),
        tags: ["message", message.role, this.sessionContext.channel ?? "local"].filter(Boolean),
        scope: this.buildScope(),
        sensitivity: this.inferSensitivity(message.content),
      };

      const record = await this.provider.ingest(request);
      if (record) {
        this.episodicRecordIds.add(record.id);
        this.logger.debug(
          { recordId: record.id, role: message.role, sessionId: this.sessionId },
          "Message ingested",
        );
      }
    } catch (error) {
      this.logger.warn({ error, sessionId: this.sessionId }, "Failed to ingest message");
    }
  }

  /**
   * Called when a tool is executed
   */
  async onToolCall(toolCall: ToolCallContext): Promise<void> {
    if (!this.config?.enabled || !this.config?.ingestion?.enabled) {
      return;
    }

    // Check if this tool should be filtered
    const filterPatterns = this.config.ingestion.filterToolPatterns ?? [];
    for (const pattern of filterPatterns) {
      if (new RegExp(pattern, "i").test(toolCall.toolName)) {
        this.logger.debug({ toolName: toolCall.toolName }, "Tool filtered from ingestion");
        return;
      }
    }

    try {
      const request: IngestToolOutputRequest = {
        source: `openclaw:${this.sessionContext.channel ?? "local"}`,
        toolName: toolCall.toolName,
        args: toolCall.args,
        result: toolCall.result,
        dependsOn: toolCall.dependsOn ?? [],
        timestamp: new Date().toISOString(),
        tags: [
          "tool",
          toolCall.toolName,
          toolCall.isError ? "error" : "success",
          this.sessionContext.channel ?? "local",
        ].filter(Boolean),
        scope: this.buildScope(),
        sensitivity: this.inferToolSensitivity(toolCall),
      };

      const record = await this.provider.ingest(request);
      if (record) {
        this.episodicRecordIds.add(record.id);
        // Track dependencies for potential future graph building
        if (toolCall.dependsOn) {
          this.toolCallGraph.set(toolCall.toolCallId, toolCall.dependsOn);
        }
        this.logger.debug(
          { recordId: record.id, toolName: toolCall.toolName, sessionId: this.sessionId },
          "Tool call ingested",
        );
      }
    } catch (error) {
      this.logger.warn({ error, toolName: toolCall.toolName }, "Failed to ingest tool call");
    }
  }

  /**
   * Retrieve relevant memory for context injection
   */
  async retrieveContext(options: ContextRetrievalOptions): Promise<RetrieveResult> {
    if (!this.config?.enabled) {
      return { records: [], source: "fallback", error: "Memory disabled" };
    }

    const retrievalConfig = this.config.retrieval;
    const maxTokens = options.maxTokens ?? retrievalConfig?.maxTokens ?? 2000;
    const minSalience = options.minSalience ?? retrievalConfig?.minSalience ?? 0.3;
    const limit = options.limit ?? retrievalConfig?.maxRecords ?? 20;

    try {
      const result = await this.provider.retrieve(options.query, {
        trust: this.buildTrustContext(),
        memoryTypes: retrievalConfig?.includeTypes ?? ["semantic", "competence", "working", "episodic"],
        minSalience,
        limit,
        maxTokens,
      });

      this.logger.debug(
        {
          query: options.query.slice(0, 100),
          recordCount: result.records.length,
          source: result.source,
        },
        "Memory context retrieved",
      );

      return result;
    } catch (error) {
      this.logger.warn({ error, query: options.query.slice(0, 100) }, "Failed to retrieve context");
      return { records: [], source: "fallback", error: String(error) };
    }
  }

  /**
   * Format retrieved memories for system prompt injection
   */
  formatMemoriesForPrompt(records: MemoryRecord[], maxChars: number = 4000): string {
    if (records.length === 0) {
      return "";
    }

    const lines: string[] = ["## Retrieved Memories", ""];
    let charCount = 0;

    for (const record of records) {
      const entry = this.formatMemoryRecord(record);
      if (charCount + entry.length > maxChars) {
        break;
      }
      lines.push(entry);
      charCount += entry.length;
    }

    if (lines.length <= 2) {
      return "";
    }

    lines.push("");
    return lines.join("\n");
  }

  /**
   * Format a single memory record for display
   */
  private formatMemoryRecord(record: MemoryRecord): string {
    const payload = record.payload;
    const salience = Math.round(record.salience * 100);

    switch (payload.kind) {
      case "semantic":
        return `- [${salience}%] ${payload.subject} ${payload.predicate} ${JSON.stringify(payload.object)}`;

      case "competence":
        return `- [${salience}%] Know-how: ${payload.goal} → ${payload.procedure.slice(0, 200)}`;

      case "working":
        return `- [${salience}%] Working: ${payload.contextSummary ?? payload.threadId} (${payload.state})`;

      case "episodic": {
        const lastEvent = payload.timeline[payload.timeline.length - 1];
        return `- [${salience}%] Event: ${lastEvent?.summary ?? lastEvent?.eventKind ?? "unknown"}`;
      }

      case "plan_graph":
        return `- [${salience}%] Plan: ${payload.goal} (${payload.nodes.length} steps)`;

      default:
        return `- [${salience}%] Memory: ${record.id}`;
    }
  }

  /**
   * Handle positive feedback (reinforce a memory)
   */
  async onPositiveFeedback(feedback: FeedbackContext): Promise<void> {
    if (!this.config?.enabled) {
      return;
    }

    try {
      await this.provider.reinforce(feedback.recordId, feedback.rationale);
      this.logger.debug({ recordId: feedback.recordId }, "Memory reinforced");
    } catch (error) {
      this.logger.warn({ error, recordId: feedback.recordId }, "Failed to reinforce memory");
    }
  }

  /**
   * Handle negative feedback (penalize a memory)
   */
  async onNegativeFeedback(feedback: FeedbackContext): Promise<void> {
    if (!this.config?.enabled) {
      return;
    }

    // Provider interface doesn't have penalize, but we can use the underlying MembraneProvider
    const provider = this.provider as import("./provider.js").MembraneProvider;
    if (typeof provider.retrieveById !== "function") {
      this.logger.debug("Penalize not supported on current provider");
      return;
    }

    // For now, just log the feedback - full penalize requires MembraneClient access
    this.logger.info(
      { recordId: feedback.recordId, rationale: feedback.rationale },
      "Negative feedback recorded",
    );
  }

  /**
   * Update working state for task resumption
   */
  async updateWorkingState(params: {
    state: TaskState;
    nextActions?: string[];
    openQuestions?: string[];
    contextSummary?: string;
  }): Promise<void> {
    if (!this.config?.enabled || !this.config?.ingestion?.enabled) {
      return;
    }

    const threadId = this.sessionContext.threadId ?? this.sessionId;

    try {
      const request: IngestWorkingStateRequest = {
        source: `openclaw:${this.sessionContext.channel ?? "local"}`,
        threadId,
        state: params.state,
        nextActions: params.nextActions,
        openQuestions: params.openQuestions,
        contextSummary: params.contextSummary,
        timestamp: new Date().toISOString(),
        tags: ["working", this.sessionContext.channel ?? "local"].filter(Boolean),
        scope: this.buildScope(),
        sensitivity: "low",
      };

      const record = await this.provider.ingest(request);
      if (record) {
        this.workingStateRecordId = record.id;
        this.logger.debug({ recordId: record.id, state: params.state }, "Working state updated");
      }
    } catch (error) {
      this.logger.warn({ error, state: params.state }, "Failed to update working state");
    }
  }

  /**
   * Called when a session ends
   */
  async onSessionEnd(params?: {
    outcome?: "success" | "failure" | "partial";
    summary?: string;
  }): Promise<void> {
    if (!this.config?.enabled || !this.config?.ingestion?.enabled) {
      return;
    }

    try {
      // Ingest session end event
      const request: IngestEventRequest = {
        source: `openclaw:${this.sessionContext.channel ?? "local"}`,
        eventKind: "session_end",
        ref: this.sessionId,
        summary: params?.summary ?? `Session ended: ${this.sessionContext.sessionKey ?? this.sessionId}`,
        timestamp: new Date().toISOString(),
        tags: [
          "session",
          "end",
          params?.outcome ?? "unknown",
          this.sessionContext.channel ?? "local",
        ].filter(Boolean),
        scope: this.buildScope(),
        sensitivity: "low",
      };

      await this.provider.ingest(request);

      // Mark working state as done if we have one
      if (this.workingStateRecordId) {
        await this.updateWorkingState({
          state: "done",
          contextSummary: params?.summary,
        });
      }

      this.logger.debug(
        { sessionId: this.sessionId, outcome: params?.outcome },
        "Session end ingested",
      );
    } catch (error) {
      this.logger.warn({ error, sessionId: this.sessionId }, "Failed to ingest session end");
    }
  }

  /**
   * Infer sensitivity level from content
   */
  private inferSensitivity(content: string): Sensitivity {
    const lowerContent = content.toLowerCase();

    // High sensitivity patterns
    const highPatterns = [
      /password/i,
      /api[_-]?key/i,
      /secret/i,
      /token/i,
      /credential/i,
      /private[_-]?key/i,
      /ssh[_-]?key/i,
    ];
    for (const pattern of highPatterns) {
      if (pattern.test(content)) {
        return "high";
      }
    }

    // Medium sensitivity patterns
    const mediumPatterns = [/email/i, /phone/i, /address/i, /account/i];
    for (const pattern of mediumPatterns) {
      if (pattern.test(content)) {
        return "medium";
      }
    }

    return "low";
  }

  /**
   * Infer sensitivity level from tool call
   */
  private inferToolSensitivity(toolCall: ToolCallContext): Sensitivity {
    const sensitiveTools = ["exec", "bash", "write", "edit", "message", "email"];
    const toolLower = toolCall.toolName.toLowerCase();

    if (sensitiveTools.some((t) => toolLower.includes(t))) {
      return "medium";
    }

    // Check args for sensitive content
    if (toolCall.args) {
      const argsStr = JSON.stringify(toolCall.args);
      return this.inferSensitivity(argsStr);
    }

    return "low";
  }

  /**
   * Truncate content to a maximum length
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    return content.slice(0, maxLength - 3) + "...";
  }
}

/**
 * Global memory lifecycle state
 */
let globalProvider: MemoryProvider | null = null;
let globalConfig: MemoryConfig | null = null;
let initializationPromise: Promise<void> | null = null;

/**
 * Initialize the memory subsystem on gateway startup
 */
export async function initializeMemory(config: MemoryConfig | undefined, logger?: Logger): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    const log = logger ?? pino({ name: "memory-init" });

    if (!config?.enabled) {
      log.info("Memory subsystem disabled by configuration");
      globalProvider = null;
      globalConfig = config ?? null;
      return;
    }

    const providerConfig: MemoryProviderConfig = {
      enabled: config.enabled,
      backend: config.backend ?? "membrane",
      membrane: config.membrane
        ? {
            address: config.membrane.address,
            connectTimeoutMs: config.membrane.connectTimeoutMs,
            requestTimeoutMs: config.membrane.requestTimeoutMs,
            apiKey: config.membrane.apiKey,
            useTls: config.membrane.useTls,
          }
        : undefined,
      maxTokens: config.retrieval?.maxTokens,
      minSalience: config.retrieval?.minSalience,
      defaultMemoryTypes: config.retrieval?.includeTypes,
    };

    globalProvider = createMemoryProvider(providerConfig, log);
    globalConfig = config;

    // Check availability (non-blocking)
    try {
      const available = await globalProvider.isAvailable();
      if (available) {
        log.info({ backend: config.backend }, "Memory subsystem initialized and connected");
      } else {
        log.warn({ backend: config.backend }, "Memory subsystem initialized but backend unavailable");
      }
    } catch (error) {
      log.warn({ error, backend: config.backend }, "Memory subsystem initialized but connection check failed");
    }
  })();

  return initializationPromise;
}

/**
 * Get the global memory provider (if initialized)
 */
export function getMemoryProvider(): MemoryProvider | null {
  return globalProvider;
}

/**
 * Get the global memory configuration
 */
export function getMemoryConfig(): MemoryConfig | null {
  return globalConfig;
}

/**
 * Create a session-scoped memory lifecycle manager
 */
export function createSessionMemoryManager(
  sessionContext: SessionContext,
  logger?: Logger,
): MemoryLifecycleManager | null {
  if (!globalProvider || !globalConfig?.enabled) {
    return null;
  }

  return new MemoryLifecycleManager({
    provider: globalProvider,
    config: globalConfig,
    sessionContext,
    logger,
  });
}

/**
 * Shutdown the memory subsystem
 */
export async function shutdownMemory(): Promise<void> {
  globalProvider = null;
  globalConfig = null;
  initializationPromise = null;
}
