/**
 * Memory Session Hooks
 *
 * Provides optional memory lifecycle hooks for the pi-embedded-runner.
 * These hooks are fire-and-forget to avoid blocking agent execution.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildMemorySessionContext,
  memoryOnSessionStart,
  memoryOnUserMessage,
  memoryOnAssistantMessage,
  memoryOnToolExecution,
  memoryOnSessionEnd,
  retrieveMemoryContext,
  getMemoryState,
} from "./integration.js";

/**
 * Session parameters for memory hooks
 */
export interface MemorySessionParams {
  sessionId: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  workspaceDir?: string;
  threadId?: string;
}

/**
 * Create memory hooks for a session
 *
 * Returns optional callbacks that can be used in pi-embedded-runner.
 * All hooks are async but fire-and-forget to not block execution.
 */
export function createMemorySessionHooks(
  params: MemorySessionParams,
  config?: OpenClawConfig,
): {
  enabled: boolean;
  onSessionStart: () => void;
  onUserMessage: (content: string, messageId?: string) => void;
  onAssistantMessage: (content: string, messageId?: string) => void;
  onToolCall: (toolName: string, toolCallId: string, args?: Record<string, unknown>, result?: unknown, isError?: boolean) => void;
  onSessionEnd: (outcome?: "success" | "failure" | "partial", summary?: string) => void;
  retrieveContext: (query: string) => Promise<string>;
} {
  const memoryState = getMemoryState();

  if (!memoryState.enabled) {
    return {
      enabled: false,
      onSessionStart: () => {},
      onUserMessage: () => {},
      onAssistantMessage: () => {},
      onToolCall: () => {},
      onSessionEnd: () => {},
      retrieveContext: async () => "",
    };
  }

  const sessionParams = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    messageChannel: params.messageChannel ?? params.messageProvider,
    messageProvider: params.messageProvider,
    agentAccountId: params.agentAccountId,
    workspaceDir: params.workspaceDir,
  };

  return {
    enabled: true,

    onSessionStart: () => {
      void memoryOnSessionStart(sessionParams).catch(() => {
        // Fire-and-forget, silently ignore errors
      });
    },

    onUserMessage: (content: string, messageId?: string) => {
      void memoryOnUserMessage(sessionParams, {
        content,
        messageId,
        timestamp: new Date().toISOString(),
      }).catch(() => {
        // Fire-and-forget
      });
    },

    onAssistantMessage: (content: string, messageId?: string) => {
      void memoryOnAssistantMessage(sessionParams, {
        content,
        messageId,
        timestamp: new Date().toISOString(),
      }).catch(() => {
        // Fire-and-forget
      });
    },

    onToolCall: (
      toolName: string,
      toolCallId: string,
      args?: Record<string, unknown>,
      result?: unknown,
      isError?: boolean,
    ) => {
      void memoryOnToolExecution(sessionParams, {
        toolName,
        toolCallId,
        args,
        result,
        isError,
      }).catch(() => {
        // Fire-and-forget
      });
    },

    onSessionEnd: (outcome?: "success" | "failure" | "partial", summary?: string) => {
      void memoryOnSessionEnd(sessionParams, { outcome, summary }).catch(() => {
        // Fire-and-forget
      });
    },

    retrieveContext: async (query: string): Promise<string> => {
      try {
        const result = await retrieveMemoryContext({
          ...sessionParams,
          query,
          maxTokens: memoryState.retrievalMaxTokens,
        });
        return result.formattedSection;
      } catch {
        return "";
      }
    },
  };
}

/**
 * Extract the last user message content from agent messages
 */
export function extractLastUserMessage(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        const textContent = msg.content.find(
          (c): c is { type: "text"; text: string } =>
            c != null && typeof c === "object" && c.type === "text" && typeof c.text === "string",
        );
        if (textContent) {
          return textContent.text;
        }
      }
    }
  }
  return undefined;
}

/**
 * Extract the last assistant message content from agent messages
 */
export function extractLastAssistantMessage(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        const textContent = msg.content.find(
          (c): c is { type: "text"; text: string } =>
            c != null && typeof c === "object" && c.type === "text" && typeof c.text === "string",
        );
        if (textContent) {
          return textContent.text;
        }
      }
    }
  }
  return undefined;
}

/**
 * Check if memory hooks should be enabled for a session
 */
export function shouldEnableMemoryHooks(
  config: OpenClawConfig | undefined,
  sessionKey?: string,
): boolean {
  if (!config?.memory?.enabled) {
    return false;
  }

  // Check if session type is excluded
  const excludeTypes = config.memory.ingestion?.excludeSessionTypes ?? ["heartbeat"];
  if (sessionKey) {
    for (const excludeType of excludeTypes) {
      if (sessionKey.includes(excludeType)) {
        return false;
      }
    }
  }

  return true;
}
