/**
 * Memory Mark One - OpenClaw Integration
 *
 * This module wires memory lifecycle hooks into the OpenClaw runtime:
 * - Gateway startup/shutdown
 * - Session lifecycle (start, messages, tool calls, end)
 * - System prompt injection with retrieved memories
 */

import type { OpenClawConfig } from "../config/config.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Logger interface compatible with both pino and OpenClaw's SubsystemLogger
 */
export interface MemoryLogger {
  info: (msg: string | object, ...args: unknown[]) => void;
  warn: (msg: string | object, ...args: unknown[]) => void;
  error?: (msg: string | object, ...args: unknown[]) => void;
  debug?: (msg: string | object, ...args: unknown[]) => void;
}
import {
  initializeMemory,
  shutdownMemory,
  getMemoryProvider,
  getMemoryConfig,
  type SessionContext,
  type MessageContext,
  type ToolCallContext,
} from "./lifecycle.js";
import {
  onSessionStart,
  onMessage,
  onToolCall,
  onSessionEnd,
  retrieveContextMemory,
  formatMemoriesForPrompt,
  buildSessionContext,
  isMemoryAvailable,
  cleanupAllSessionManagers,
  getMemoryRetrievalConfig,
} from "./hooks.js";
import type { MemoryRecord } from "./membrane-types.js";

/**
 * Initialize the memory subsystem during gateway startup
 *
 * Call this early in gateway initialization. It handles:
 * - Loading config
 * - Creating the memory provider
 * - Checking backend availability (non-blocking)
 * - Graceful degradation if Membrane unavailable
 */
export async function initializeMemorySubsystem(
  config: OpenClawConfig | undefined,
  logger?: MemoryLogger,
): Promise<{ enabled: boolean; available: boolean; error?: string }> {
  const memoryConfig = config?.memory;

  if (!memoryConfig?.enabled) {
    return { enabled: false, available: false };
  }

  try {
    // Note: initializeMemory uses pino internally; we don't pass the gateway logger
    // to avoid type compatibility issues. Memory uses its own dedicated logger.
    await initializeMemory(memoryConfig);

    // Check availability without blocking startup
    const available = await isMemoryAvailable();

    return {
      enabled: true,
      available,
      error: available ? undefined : "Memory backend not available",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger?.warn({ error: errorMessage }, "Memory subsystem initialization failed");

    return {
      enabled: true,
      available: false,
      error: errorMessage,
    };
  }
}

/**
 * Shutdown the memory subsystem during gateway shutdown
 *
 * Call this during graceful gateway shutdown to:
 * - Cleanup session managers
 * - Release any resources
 */
export async function shutdownMemorySubsystem(): Promise<void> {
  cleanupAllSessionManagers();
  await shutdownMemory();
}

/**
 * Build session context from OpenClaw session parameters
 */
export function buildMemorySessionContext(params: {
  sessionId: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  workspaceDir?: string;
  threadId?: string;
}): SessionContext {
  return buildSessionContext({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    channel: params.messageChannel ?? params.messageProvider,
    agentId: params.sessionKey?.split(":")[0],
    actorId: params.agentAccountId,
    workspaceDir: params.workspaceDir,
    threadId: params.threadId,
  });
}

/**
 * Hook: Call when a session starts
 */
export async function memoryOnSessionStart(params: {
  sessionId: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  workspaceDir?: string;
}): Promise<void> {
  const context = buildMemorySessionContext(params);
  await onSessionStart(context);
}

/**
 * Hook: Call when a user message is received
 */
export async function memoryOnUserMessage(
  sessionParams: {
    sessionId: string;
    sessionKey?: string;
    messageChannel?: string;
    messageProvider?: string;
  },
  message: {
    content: string;
    messageId?: string;
    timestamp?: string;
  },
): Promise<void> {
  const context = buildMemorySessionContext(sessionParams);
  const messageContext: MessageContext = {
    role: "user",
    content: message.content,
    messageId: message.messageId,
    timestamp: message.timestamp,
  };
  await onMessage(context, messageContext);
}

/**
 * Hook: Call when an assistant message is generated
 */
export async function memoryOnAssistantMessage(
  sessionParams: {
    sessionId: string;
    sessionKey?: string;
    messageChannel?: string;
    messageProvider?: string;
  },
  message: {
    content: string;
    messageId?: string;
    timestamp?: string;
  },
): Promise<void> {
  const context = buildMemorySessionContext(sessionParams);
  const messageContext: MessageContext = {
    role: "assistant",
    content: message.content,
    messageId: message.messageId,
    timestamp: message.timestamp,
  };
  await onMessage(context, messageContext);
}

/**
 * Hook: Call when a tool is executed
 */
export async function memoryOnToolExecution(
  sessionParams: {
    sessionId: string;
    sessionKey?: string;
    messageChannel?: string;
    messageProvider?: string;
  },
  toolCall: {
    toolName: string;
    toolCallId: string;
    args?: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
  },
): Promise<void> {
  const context = buildMemorySessionContext(sessionParams);
  const toolContext: ToolCallContext = {
    toolName: toolCall.toolName,
    toolCallId: toolCall.toolCallId,
    args: toolCall.args,
    result: toolCall.result,
    isError: toolCall.isError,
  };
  await onToolCall(context, toolContext);
}

/**
 * Hook: Call when a session ends
 */
export async function memoryOnSessionEnd(
  sessionParams: {
    sessionId: string;
    sessionKey?: string;
    messageChannel?: string;
    messageProvider?: string;
  },
  outcome?: {
    outcome?: "success" | "failure" | "partial";
    summary?: string;
  },
): Promise<void> {
  const context = buildMemorySessionContext(sessionParams);
  await onSessionEnd(context, outcome);
}

/**
 * Retrieve context memories for system prompt injection
 *
 * Returns formatted memory section ready for system prompt injection.
 * Respects token budget from config.
 */
export async function retrieveMemoryContext(params: {
  sessionId: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  query: string;
  maxTokens?: number;
  maxChars?: number;
}): Promise<{
  memories: MemoryRecord[];
  formattedSection: string;
  source: string;
  error?: string;
}> {
  const retrievalConfig = getMemoryRetrievalConfig();

  if (!retrievalConfig.enabled) {
    return {
      memories: [],
      formattedSection: "",
      source: "disabled",
    };
  }

  const context = buildMemorySessionContext(params);

  const result = await retrieveContextMemory(context, {
    query: params.query,
    maxTokens: params.maxTokens ?? retrievalConfig.maxTokens,
    minSalience: retrievalConfig.minSalience,
    limit: retrievalConfig.maxRecords,
  });

  const formattedSection = formatMemoriesForPrompt(
    context,
    result.records,
    params.maxChars ?? (params.maxTokens ?? retrievalConfig.maxTokens) * 4, // rough char estimate
  );

  return {
    memories: result.records,
    formattedSection,
    source: result.source,
    error: result.error,
  };
}

/**
 * Check if memory is available for the current configuration
 */
export async function checkMemoryAvailable(): Promise<boolean> {
  return isMemoryAvailable();
}

/**
 * Get the current memory configuration state
 */
export function getMemoryState(): {
  enabled: boolean;
  backend: string | undefined;
  ingestionEnabled: boolean;
  retrievalMaxTokens: number;
} {
  const config = getMemoryConfig();
  const retrievalConfig = getMemoryRetrievalConfig();

  return {
    enabled: retrievalConfig.enabled,
    backend: config?.backend,
    ingestionEnabled: config?.ingestion?.enabled ?? false,
    retrievalMaxTokens: retrievalConfig.maxTokens,
  };
}

/**
 * Integration helper: Extract messages from agent session for memory ingestion
 */
export function extractMessagesForMemory(
  messages: AgentMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
}

/**
 * Re-export hooks for direct use
 */
export {
  onSessionStart,
  onMessage,
  onToolCall,
  onSessionEnd,
  retrieveContextMemory,
  formatMemoriesForPrompt,
  buildSessionContext,
  isMemoryAvailable,
  getMemoryRetrievalConfig,
  cleanupAllSessionManagers,
} from "./hooks.js";

export { initializeMemory, shutdownMemory } from "./lifecycle.js";

export type { SessionContext, MessageContext, ToolCallContext } from "./lifecycle.js";
export type { MemoryRecord } from "./membrane-types.js";
