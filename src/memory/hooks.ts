/**
 * Memory Integration Hooks
 *
 * Provides hooks for integrating memory into OpenClaw's session lifecycle.
 * These hooks are called from various parts of the system to track events,
 * retrieve context, and process feedback.
 */

import { type Logger, pino } from "pino";
import {
  createSessionMemoryManager,
  getMemoryConfig,
  getMemoryProvider,
  type MemoryLifecycleManager,
  type SessionContext,
  type MessageContext,
  type ToolCallContext,
  type ContextRetrievalOptions,
  type FeedbackContext,
} from "./lifecycle.js";
import type { MemoryRecord, TaskState } from "./membrane-types.js";
import type { RetrieveResult } from "./provider.js";

/**
 * Registry for active session memory managers
 */
const sessionManagers = new Map<string, MemoryLifecycleManager>();
const log = pino({ name: "memory-hooks" });

/**
 * Get or create a memory manager for a session
 */
export function getSessionMemoryManager(
  sessionContext: SessionContext,
): MemoryLifecycleManager | undefined {
  const key = sessionContext.sessionId;
  let manager = sessionManagers.get(key);

  if (!manager) {
    const newManager = createSessionMemoryManager(sessionContext, log);
    if (newManager) {
      sessionManagers.set(key, newManager);
      manager = newManager;
    }
  }

  return manager;
}

/**
 * Remove a session's memory manager (call on session end)
 */
export function removeSessionMemoryManager(sessionId: string): void {
  sessionManagers.delete(sessionId);
}

/**
 * Check if memory is enabled and available
 */
export async function isMemoryAvailable(): Promise<boolean> {
  const provider = getMemoryProvider();
  if (!provider) {
    return false;
  }
  return provider.isAvailable();
}

/**
 * Hook: Called when a session starts
 */
export async function onSessionStart(sessionContext: SessionContext): Promise<void> {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return;
  }

  await manager.onSessionStart();
}

/**
 * Hook: Called when a message is received or sent
 */
export async function onMessage(
  sessionContext: SessionContext,
  message: MessageContext,
): Promise<void> {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return;
  }

  await manager.onMessage(message);
}

/**
 * Hook: Called when a tool is executed
 */
export async function onToolCall(
  sessionContext: SessionContext,
  toolCall: ToolCallContext,
): Promise<void> {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return;
  }

  await manager.onToolCall(toolCall);
}

/**
 * Hook: Called when a session ends
 */
export async function onSessionEnd(
  sessionContext: SessionContext,
  params?: { outcome?: "success" | "failure" | "partial"; summary?: string },
): Promise<void> {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return;
  }

  await manager.onSessionEnd(params);
  removeSessionMemoryManager(sessionContext.sessionId);
}

/**
 * Hook: Retrieve relevant memory for context injection
 */
export async function retrieveContextMemory(
  sessionContext: SessionContext,
  options: ContextRetrievalOptions,
): Promise<RetrieveResult> {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return { records: [], source: "fallback", error: "Memory not available" };
  }

  return manager.retrieveContext(options);
}

/**
 * Hook: Format retrieved memories for system prompt injection
 */
export function formatMemoriesForPrompt(
  sessionContext: SessionContext,
  records: MemoryRecord[],
  maxChars?: number,
): string {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return "";
  }

  return manager.formatMemoriesForPrompt(records, maxChars);
}

/**
 * Hook: Called on positive user feedback
 */
export async function onPositiveFeedback(
  sessionContext: SessionContext,
  recordId: string,
  rationale?: string,
): Promise<void> {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return;
  }

  await manager.onPositiveFeedback({
    type: "positive",
    recordId,
    rationale,
  });
}

/**
 * Hook: Called on negative user feedback or correction
 */
export async function onNegativeFeedback(
  sessionContext: SessionContext,
  recordId: string,
  rationale?: string,
): Promise<void> {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return;
  }

  await manager.onNegativeFeedback({
    type: "negative",
    recordId,
    rationale,
  });
}

/**
 * Hook: Update working state for task resumption
 */
export async function updateWorkingState(
  sessionContext: SessionContext,
  params: {
    state: TaskState;
    nextActions?: string[];
    openQuestions?: string[];
    contextSummary?: string;
  },
): Promise<void> {
  const manager = getSessionMemoryManager(sessionContext);
  if (!manager) {
    return;
  }

  await manager.updateWorkingState(params);
}

/**
 * Get memory retrieval configuration
 */
export function getMemoryRetrievalConfig(): {
  enabled: boolean;
  maxTokens: number;
  minSalience: number;
  maxRecords: number;
} {
  const config = getMemoryConfig();
  if (!config?.enabled) {
    return {
      enabled: false,
      maxTokens: 0,
      minSalience: 0,
      maxRecords: 0,
    };
  }

  return {
    enabled: true,
    maxTokens: config.retrieval?.maxTokens ?? 2000,
    minSalience: config.retrieval?.minSalience ?? 0.3,
    maxRecords: config.retrieval?.maxRecords ?? 20,
  };
}

/**
 * Create session context from session parameters
 */
export function buildSessionContext(params: {
  sessionId: string;
  sessionKey?: string;
  channel?: string;
  messageProvider?: string;
  sessionType?: string;
  agentId?: string;
  actorId?: string;
  workspaceDir?: string;
  threadId?: string;
}): SessionContext {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    channel: params.channel ?? params.messageProvider,
    sessionType: params.sessionType ?? inferSessionType(params.sessionKey),
    agentId: params.agentId,
    actorId: params.actorId,
    workspaceDir: params.workspaceDir,
    threadId: params.threadId,
  };
}

/**
 * Infer session type from session key
 */
function inferSessionType(sessionKey?: string): string | undefined {
  if (!sessionKey) {
    return undefined;
  }

  if (sessionKey.includes("heartbeat")) {
    return "heartbeat";
  }
  if (sessionKey.includes("subagent")) {
    return "subagent";
  }
  if (sessionKey.includes("cron")) {
    return "cron";
  }
  if (sessionKey.includes("main")) {
    return "main";
  }

  return undefined;
}

/**
 * Async memory operations helper
 * Use this for non-blocking ingestion when config.ingestion.async is true
 */
export function asyncMemoryOp<T>(
  operation: () => Promise<T>,
  fallback?: T,
): void {
  const config = getMemoryConfig();
  if (!config?.enabled) {
    return;
  }

  // Always run async to not block the main flow
  void operation().catch((error) => {
    log.warn({ error }, "Async memory operation failed");
  });
}

/**
 * Cleanup all session managers
 * Called on gateway shutdown
 */
export function cleanupAllSessionManagers(): void {
  sessionManagers.clear();
}
