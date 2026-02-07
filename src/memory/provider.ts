/**
 * Memory Provider Interface
 *
 * Abstract interface for memory operations with pluggable backends.
 * Implements graceful degradation when Membrane is unavailable.
 */

import { type Logger, pino } from "pino";
import {
  MembraneClient,
  type MembraneClientConfig,
  MembraneConnectionError,
  type MemoryRecord,
  type MemoryType,
  type Sensitivity,
  type TrustContext,
  type IngestEventRequest,
  type IngestToolOutputRequest,
  type IngestObservationRequest,
  type IngestWorkingStateRequest,
  type IngestOutcomeRequest,
  type RetrieveResponse,
  type MetricsResponse,
} from "./membrane-client.js";

// Re-export types for convenience
export type { MemoryRecord, MemoryType, Sensitivity, TrustContext };

/**
 * Options for memory retrieval
 */
export interface RetrieveOptions {
  /** Trust context for access control */
  trust?: TrustContext;
  /** Filter by specific memory types */
  memoryTypes?: MemoryType[];
  /** Minimum salience threshold (0-1) */
  minSalience?: number;
  /** Maximum number of records to return */
  limit?: number;
  /** Maximum tokens for retrieved context (for token budgeting) */
  maxTokens?: number;
}

/**
 * Result of a memory retrieval operation
 */
export interface RetrieveResult {
  /** Retrieved memory records */
  records: MemoryRecord[];
  /** Whether the result came from cache or fallback */
  source: "membrane" | "cache" | "fallback";
  /** Error message if degraded */
  error?: string;
}

/**
 * Memory provider backend configuration
 */
export interface MemoryProviderConfig {
  /** Whether memory is enabled */
  enabled: boolean;
  /** Backend type */
  backend: "membrane" | "file" | "none";
  /** Membrane-specific configuration */
  membrane?: MembraneClientConfig;
  /** Maximum tokens for retrieved memory context */
  maxTokens?: number;
  /** Minimum salience for retrieval */
  minSalience?: number;
  /** Default memory types to retrieve */
  defaultMemoryTypes?: MemoryType[];
}

/**
 * Abstract memory provider interface
 */
export interface MemoryProvider {
  /**
   * Retrieve relevant memory for a task
   * @param query Task description or query string
   * @param options Retrieval options
   */
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult>;

  /**
   * Ingest a new memory record
   * @param record Memory record to ingest
   */
  ingest(record: IngestEventRequest | IngestToolOutputRequest | IngestObservationRequest | IngestWorkingStateRequest): Promise<MemoryRecord | null>;

  /**
   * Reinforce a memory record (boost salience on successful use)
   * @param recordId ID of the record to reinforce
   * @param rationale Reason for reinforcement
   */
  reinforce(recordId: string, rationale?: string): Promise<void>;

  /**
   * Check if the provider is available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get provider status and metrics
   */
  getStatus(): Promise<{
    available: boolean;
    backend: string;
    metrics?: MetricsResponse;
    error?: string;
  }>;
}

/**
 * Membrane-backed memory provider implementation
 */
export class MembraneProvider implements MemoryProvider {
  private readonly client: MembraneClient;
  private readonly config: MemoryProviderConfig;
  private readonly logger: Logger;
  private lastAvailableCheck: number = 0;
  private cachedAvailability: boolean = false;
  private readonly availabilityTtlMs = 10000; // 10 seconds

  // Simple LRU cache for graceful degradation
  private readonly recentRecords: Map<string, { records: MemoryRecord[]; timestamp: number }> =
    new Map();
  private readonly cacheTtlMs = 300000; // 5 minutes

  constructor(config: MemoryProviderConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? pino({ name: "membrane-provider" });
    this.client = new MembraneClient(config.membrane);
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrieveResult> {
    if (!this.config.enabled) {
      return { records: [], source: "fallback", error: "Memory disabled" };
    }

    const memoryTypes = options.memoryTypes ?? this.config.defaultMemoryTypes ?? [
      "semantic",
      "competence",
      "working",
      "episodic",
    ];
    const minSalience = options.minSalience ?? this.config.minSalience ?? 0.3;
    const limit = options.limit ?? 20;

    // Build trust context
    const trust: TrustContext = options.trust ?? {
      maxSensitivity: "medium",
      authenticated: true,
      actorId: "openclaw",
      scopes: [],
    };

    try {
      const response = await this.client.retrieve({
        taskDescriptor: query,
        trust,
        memoryTypes,
        minSalience,
        limit,
      });

      // Apply token budget if specified
      let records = response.records;
      if (options.maxTokens) {
        records = this.applyTokenBudget(records, options.maxTokens);
      }

      // Update cache
      this.recentRecords.set(query, { records, timestamp: Date.now() });
      this.pruneCache();

      return { records, source: "membrane" };
    } catch (error) {
      this.logger.warn({ error, query }, "Membrane retrieval failed, checking cache");

      // Try cache fallback
      const cached = this.recentRecords.get(query);
      if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
        return {
          records: cached.records,
          source: "cache",
          error: `Membrane unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Full fallback - return empty
      return {
        records: [],
        source: "fallback",
        error: `Membrane unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async ingest(
    record: IngestEventRequest | IngestToolOutputRequest | IngestObservationRequest | IngestWorkingStateRequest,
  ): Promise<MemoryRecord | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      // Determine record type and call appropriate method
      if ("eventKind" in record) {
        return await this.client.ingestEvent(record as IngestEventRequest);
      } else if ("toolName" in record) {
        return await this.client.ingestToolOutput(record as IngestToolOutputRequest);
      } else if ("subject" in record && "predicate" in record) {
        return await this.client.ingestObservation(record as IngestObservationRequest);
      } else if ("threadId" in record) {
        return await this.client.ingestWorkingState(record as IngestWorkingStateRequest);
      } else {
        this.logger.warn({ record }, "Unknown record type for ingestion");
        return null;
      }
    } catch (error) {
      this.logger.warn({ error, record }, "Failed to ingest memory record");
      // Graceful degradation: don't throw, just return null
      return null;
    }
  }

  async reinforce(recordId: string, rationale?: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      await this.client.reinforce(recordId, "openclaw", rationale);
    } catch (error) {
      this.logger.warn({ error, recordId }, "Failed to reinforce memory record");
      // Graceful degradation: don't throw
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastAvailableCheck < this.availabilityTtlMs) {
      return this.cachedAvailability;
    }

    try {
      this.cachedAvailability = await this.client.isConnected();
      this.lastAvailableCheck = now;
      return this.cachedAvailability;
    } catch {
      this.cachedAvailability = false;
      this.lastAvailableCheck = now;
      return false;
    }
  }

  async getStatus(): Promise<{
    available: boolean;
    backend: string;
    metrics?: MetricsResponse;
    error?: string;
  }> {
    const available = await this.isAvailable();

    if (!available) {
      return {
        available: false,
        backend: this.config.backend,
        error: "Membrane not connected",
      };
    }

    try {
      const metrics = await this.client.getMetrics();
      return {
        available: true,
        backend: this.config.backend,
        metrics,
      };
    } catch (error) {
      return {
        available: true,
        backend: this.config.backend,
        error: `Failed to get metrics: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Ingest an outcome for an existing episodic record
   */
  async ingestOutcome(request: IngestOutcomeRequest): Promise<MemoryRecord | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      return await this.client.ingestOutcome(request);
    } catch (error) {
      this.logger.warn({ error, request }, "Failed to ingest outcome");
      return null;
    }
  }

  /**
   * Retrieve a specific record by ID
   */
  async retrieveById(id: string, trust?: TrustContext): Promise<MemoryRecord | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      return await this.client.retrieveById(id, trust);
    } catch (error) {
      this.logger.warn({ error, id }, "Failed to retrieve record by ID");
      return null;
    }
  }

  /**
   * Apply token budget by estimating token count and truncating
   */
  private applyTokenBudget(records: MemoryRecord[], maxTokens: number): MemoryRecord[] {
    // Simple token estimation: ~4 characters per token
    const estimateTokens = (record: MemoryRecord): number => {
      const payloadStr = JSON.stringify(record.payload);
      return Math.ceil(payloadStr.length / 4);
    };

    let totalTokens = 0;
    const result: MemoryRecord[] = [];

    for (const record of records) {
      const tokens = estimateTokens(record);
      if (totalTokens + tokens > maxTokens) {
        break;
      }
      totalTokens += tokens;
      result.push(record);
    }

    return result;
  }

  /**
   * Prune old cache entries
   */
  private pruneCache(): void {
    const now = Date.now();
    const maxEntries = 100;

    // Remove expired entries
    for (const [key, value] of this.recentRecords.entries()) {
      if (now - value.timestamp > this.cacheTtlMs) {
        this.recentRecords.delete(key);
      }
    }

    // Limit size
    if (this.recentRecords.size > maxEntries) {
      const sortedEntries = [...this.recentRecords.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      );
      const toDelete = sortedEntries.slice(0, this.recentRecords.size - maxEntries);
      for (const [key] of toDelete) {
        this.recentRecords.delete(key);
      }
    }
  }
}

/**
 * No-op memory provider for when memory is disabled
 */
export class NoOpMemoryProvider implements MemoryProvider {
  async retrieve(): Promise<RetrieveResult> {
    return { records: [], source: "fallback", error: "Memory disabled" };
  }

  async ingest(): Promise<MemoryRecord | null> {
    return null;
  }

  async reinforce(): Promise<void> {
    // No-op
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async getStatus(): Promise<{ available: boolean; backend: string; error?: string }> {
    return { available: false, backend: "none", error: "Memory disabled" };
  }
}

/**
 * Create a memory provider based on configuration
 */
export function createMemoryProvider(config: MemoryProviderConfig, logger?: Logger): MemoryProvider {
  if (!config.enabled || config.backend === "none") {
    return new NoOpMemoryProvider();
  }

  if (config.backend === "membrane") {
    return new MembraneProvider(config, logger);
  }

  // Default to no-op for unknown backends
  return new NoOpMemoryProvider();
}

/**
 * Default memory provider configuration
 */
export const DEFAULT_MEMORY_CONFIG: MemoryProviderConfig = {
  enabled: true,
  backend: "membrane",
  membrane: {
    address: "localhost:19090",
    connectTimeoutMs: 5000,
    requestTimeoutMs: 30000,
    useTls: false,
  },
  maxTokens: 2000,
  minSalience: 0.3,
  defaultMemoryTypes: ["semantic", "competence", "working", "episodic"],
};
