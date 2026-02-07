/**
 * Memory Module Exports
 *
 * This module exports both:
 * 1. OpenClaw's existing vector memory search (MemoryIndexManager, getMemorySearchManager)
 * 2. Memory Mark One integration (Membrane-based semantic/episodic memory)
 */

// ============================================================
// Original OpenClaw Memory Search Exports (vector similarity)
// ============================================================
export { MemoryIndexManager } from "./manager.js";
export type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySearchResult,
} from "./types.js";
export { getMemorySearchManager, type MemorySearchManagerResult } from "./search-manager.js";

// ============================================================
// Memory Mark One Exports (Membrane integration)
// ============================================================

// Types
export * from "./membrane-types.js";
export type { MemoryConfig, IngestionConfig, RetrievalConfig } from "./config-schema.js";
export type {
  MemoryProvider,
  MemoryProviderConfig,
  RetrieveOptions,
  RetrieveResult,
} from "./provider.js";
export type {
  SessionContext,
  MessageContext,
  ToolCallContext,
  FeedbackContext,
  ContextRetrievalOptions,
} from "./lifecycle.js";

// Config
export { MemoryConfigSchema, DEFAULT_MEMORY_CONFIG } from "./config-schema.js";

// Client
export { MembraneClient, createMembraneClient } from "./membrane-client.js";
export { MembraneError, MembraneConnectionError, MembraneNotFoundError, MembraneAccessDeniedError } from "./membrane-client.js";

// Provider
export { createMemoryProvider, MembraneProvider, NoOpMemoryProvider } from "./provider.js";

// Lifecycle
export {
  MemoryLifecycleManager,
  initializeMemory,
  getMemoryProvider,
  getMemoryConfig,
  createSessionMemoryManager,
  shutdownMemory,
} from "./lifecycle.js";

// Hooks
export {
  getSessionMemoryManager,
  removeSessionMemoryManager,
  isMemoryAvailable,
  onSessionStart,
  onMessage,
  onToolCall,
  onSessionEnd,
  retrieveContextMemory,
  formatMemoriesForPrompt,
  onPositiveFeedback,
  onNegativeFeedback,
  updateWorkingState,
  buildSessionContext,
  getMemoryRetrievalConfig,
  asyncMemoryOp,
  cleanupAllSessionManagers,
} from "./hooks.js";

// Integration
export {
  initializeMemorySubsystem,
  shutdownMemorySubsystem,
  buildMemorySessionContext,
  memoryOnSessionStart,
  memoryOnUserMessage,
  memoryOnAssistantMessage,
  memoryOnToolExecution,
  memoryOnSessionEnd,
  retrieveMemoryContext,
  checkMemoryAvailable,
  getMemoryState,
  extractMessagesForMemory,
} from "./integration.js";

// Session Hooks
export {
  createMemorySessionHooks,
  extractLastUserMessage,
  extractLastAssistantMessage,
  shouldEnableMemoryHooks,
  type MemorySessionParams,
} from "./session-hooks.js";
