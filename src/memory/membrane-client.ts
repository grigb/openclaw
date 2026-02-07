/**
 * Membrane gRPC Client
 *
 * TypeScript client for the Membrane memory substrate.
 * Uses native gRPC via @grpc/grpc-js and @grpc/proto-loader.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import type {
  IngestEventRequest,
  IngestToolOutputRequest,
  IngestObservationRequest,
  IngestOutcomeRequest,
  IngestWorkingStateRequest,
  RetrieveRequest,
  RetrieveResponse,
  SupersedeRequest,
  ForkRequest,
  MergeRequest,
  ContestRequest,
  MetricsResponse,
  MemoryRecord,
  TrustContext,
} from "./membrane-types.js";

// Re-export types for convenience
export * from "./membrane-types.js";

/**
 * Configuration for the Membrane client
 */
export interface MembraneClientConfig {
  /** Membrane server address (default: localhost:19090) */
  address?: string;

  /** Connection timeout in milliseconds (default: 5000) */
  connectTimeoutMs?: number;

  /** Request timeout in milliseconds (default: 30000) */
  requestTimeoutMs?: number;

  /** API key for authentication (optional) */
  apiKey?: string;

  /** Whether to use TLS (default: false for localhost) */
  useTls?: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<MembraneClientConfig> = {
  address: "localhost:19090",
  connectTimeoutMs: 5000,
  requestTimeoutMs: 30000,
  apiKey: "",
  useTls: false,
};

/**
 * Error types for Membrane operations
 */
export class MembraneError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MembraneError";
  }
}

export class MembraneConnectionError extends MembraneError {
  constructor(message: string, details?: unknown) {
    super(message, "CONNECTION_ERROR", details);
    this.name = "MembraneConnectionError";
  }
}

export class MembraneNotFoundError extends MembraneError {
  constructor(id: string) {
    super(`Record not found: ${id}`, "NOT_FOUND");
    this.name = "MembraneNotFoundError";
  }
}

export class MembraneAccessDeniedError extends MembraneError {
  constructor(id?: string) {
    super(id ? `Access denied for record: ${id}` : "Access denied", "ACCESS_DENIED");
    this.name = "MembraneAccessDeniedError";
  }
}

// gRPC service type (loaded dynamically)
interface MembraneServiceClient extends grpc.Client {
  IngestEvent(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  IngestToolOutput(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  IngestObservation(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  IngestOutcome(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  IngestWorkingState(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  Retrieve(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  RetrieveByID(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  Supersede(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  Fork(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  Retract(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  Merge(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  Reinforce(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  Penalize(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  GetMetrics(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
  Contest(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): void;
}

// Helper to get proto path relative to this module
function getProtoPath(): string {
  // ESM: use import.meta.url
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, "proto", "membrane", "v1", "membrane.proto");
}

/**
 * Membrane gRPC Client
 *
 * Provides a TypeScript interface to the Membrane memory substrate.
 * Uses native gRPC transport.
 */
export class MembraneClient {
  private readonly config: Required<MembraneClientConfig>;
  private client: MembraneServiceClient | null = null;
  private connected = false;
  private lastHealthCheck: number = 0;
  private healthCheckIntervalMs = 30000;
  private protoLoaded = false;
  private ServiceConstructor: grpc.ServiceClientConstructor | null = null;

  constructor(config: MembraneClientConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load proto definitions (lazy initialization)
   */
  private async loadProto(): Promise<void> {
    if (this.protoLoaded) return;

    const protoPath = getProtoPath();
    const packageDefinition = await protoLoader.load(protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    const membrane = protoDescriptor.membrane as { v1: { MembraneService: grpc.ServiceClientConstructor } };
    this.ServiceConstructor = membrane.v1.MembraneService;
    this.protoLoaded = true;
  }

  /**
   * Get or create the gRPC client
   */
  private async getClient(): Promise<MembraneServiceClient> {
    if (this.client) return this.client;

    await this.loadProto();

    if (!this.ServiceConstructor) {
      throw new MembraneConnectionError("Failed to load proto definitions");
    }

    const credentials = this.config.useTls
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    this.client = new this.ServiceConstructor(
      this.config.address,
      credentials,
    ) as unknown as MembraneServiceClient;

    return this.client;
  }

  /**
   * Create metadata with auth if configured
   */
  private getMetadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    if (this.config.apiKey) {
      metadata.set("authorization", `Bearer ${this.config.apiKey}`);
    }
    return metadata;
  }

  /**
   * Create call options with deadline
   */
  private getCallOptions(timeoutMs?: number): grpc.CallOptions {
    const deadline = new Date(Date.now() + (timeoutMs ?? this.config.requestTimeoutMs));
    return { deadline };
  }

  /**
   * Promisified RPC call
   */
  private async rpc<TReq, TRes>(
    method: keyof MembraneServiceClient,
    request: TReq,
    timeoutMs?: number,
  ): Promise<TRes> {
    const client = await this.getClient();
    const metadata = this.getMetadata();
    const options = this.getCallOptions(timeoutMs);

    return new Promise((resolve, reject) => {
      const fn = client[method] as (
        req: TReq,
        meta: grpc.Metadata,
        opts: grpc.CallOptions,
        cb: (err: grpc.ServiceError | null, res: TRes) => void,
      ) => void;

      if (typeof fn !== "function") {
        reject(new MembraneError(`Unknown method: ${String(method)}`));
        return;
      }

      fn.call(client, request, metadata, options, (error, response) => {
        if (error) {
          reject(this.mapGrpcError(error));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Map gRPC errors to Membrane errors
   */
  private mapGrpcError(error: grpc.ServiceError): MembraneError {
    switch (error.code) {
      case grpc.status.NOT_FOUND:
        return new MembraneNotFoundError(error.details || "unknown");
      case grpc.status.PERMISSION_DENIED:
      case grpc.status.UNAUTHENTICATED:
        return new MembraneAccessDeniedError();
      case grpc.status.UNAVAILABLE:
      case grpc.status.DEADLINE_EXCEEDED:
        return new MembraneConnectionError(error.message, error);
      default:
        return new MembraneError(error.message, String(error.code), error);
    }
  }

  /**
   * Check if the client is connected to Membrane
   */
  async isConnected(): Promise<boolean> {
    const now = Date.now();
    if (this.connected && now - this.lastHealthCheck < this.healthCheckIntervalMs) {
      return true;
    }

    try {
      await this.healthCheck();
      this.connected = true;
      this.lastHealthCheck = now;
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  /**
   * Perform a health check against the Membrane server
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Use GetMetrics as health check since there's no dedicated health RPC
      await this.rpc("GetMetrics", {}, this.config.connectTimeoutMs);
      return true;
    } catch (error) {
      throw new MembraneConnectionError(
        `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  /**
   * Connect to the Membrane server
   */
  async connect(): Promise<void> {
    if (await this.isConnected()) {
      return;
    }
    await this.healthCheck();
    this.connected = true;
    this.lastHealthCheck = Date.now();
  }

  /**
   * Disconnect from the Membrane server
   */
  disconnect(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.connected = false;
    this.lastHealthCheck = 0;
  }

  // ===========================================================================
  // Ingestion Methods
  // ===========================================================================

  /**
   * Ingest an event as an episodic memory record
   */
  async ingestEvent(request: IngestEventRequest): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("IngestEvent", {
      source: request.source,
      eventKind: request.eventKind,
      ref: request.ref ?? "",
      summary: request.summary ?? "",
      timestamp: request.timestamp ?? new Date().toISOString(),
      tags: request.tags ?? [],
      scope: request.scope ?? "",
      sensitivity: request.sensitivity ?? "low",
    });
    return JSON.parse(response.record.toString());
  }

  /**
   * Ingest a tool output as an episodic memory record with tool graph
   */
  async ingestToolOutput(request: IngestToolOutputRequest): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("IngestToolOutput", {
      source: request.source,
      toolName: request.toolName,
      args: request.args ? Buffer.from(JSON.stringify(request.args)) : Buffer.alloc(0),
      result: request.result ? Buffer.from(JSON.stringify(request.result)) : Buffer.alloc(0),
      dependsOn: request.dependsOn ?? [],
      timestamp: request.timestamp ?? new Date().toISOString(),
      tags: request.tags ?? [],
      scope: request.scope ?? "",
      sensitivity: request.sensitivity ?? "low",
    });
    return JSON.parse(response.record.toString());
  }

  /**
   * Ingest an observation as a semantic memory record
   */
  async ingestObservation(request: IngestObservationRequest): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("IngestObservation", {
      source: request.source,
      subject: request.subject,
      predicate: request.predicate,
      object: Buffer.from(JSON.stringify(request.object)),
      timestamp: request.timestamp ?? new Date().toISOString(),
      tags: request.tags ?? [],
      scope: request.scope ?? "",
      sensitivity: request.sensitivity ?? "low",
    });
    return JSON.parse(response.record.toString());
  }

  /**
   * Update an existing episodic record with outcome data
   */
  async ingestOutcome(request: IngestOutcomeRequest): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("IngestOutcome", {
      source: request.source,
      targetRecordId: request.targetRecordId,
      outcomeStatus: request.outcomeStatus,
      timestamp: request.timestamp ?? new Date().toISOString(),
    });
    return JSON.parse(response.record.toString());
  }

  /**
   * Ingest working memory state for task resumption
   */
  async ingestWorkingState(request: IngestWorkingStateRequest): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("IngestWorkingState", {
      source: request.source,
      threadId: request.threadId,
      state: request.state,
      nextActions: request.nextActions ?? [],
      openQuestions: request.openQuestions ?? [],
      contextSummary: request.contextSummary ?? "",
      activeConstraints: request.activeConstraints
        ? Buffer.from(JSON.stringify(request.activeConstraints))
        : Buffer.alloc(0),
      timestamp: request.timestamp ?? new Date().toISOString(),
      tags: request.tags ?? [],
      scope: request.scope ?? "",
      sensitivity: request.sensitivity ?? "low",
    });
    return JSON.parse(response.record.toString());
  }

  // ===========================================================================
  // Retrieval Methods
  // ===========================================================================

  /**
   * Retrieve relevant memory records for a task
   */
  async retrieve(request: RetrieveRequest): Promise<RetrieveResponse> {
    const response = await this.rpc<unknown, { records: Buffer[]; selection?: Buffer }>("Retrieve", {
      taskDescriptor: request.taskDescriptor,
      trust: request.trust
        ? {
            maxSensitivity: request.trust.maxSensitivity,
            authenticated: request.trust.authenticated,
            actorId: request.trust.actorId ?? "",
            scopes: request.trust.scopes ?? [],
          }
        : undefined,
      memoryTypes: request.memoryTypes ?? [],
      minSalience: request.minSalience ?? 0,
      limit: request.limit ?? 20,
    });

    // Records come as JSON-encoded bytes
    const records: MemoryRecord[] = response.records.map((r: Buffer) => JSON.parse(r.toString()));
    const selection = response.selection ? JSON.parse(response.selection.toString()) : undefined;

    return { records, selection };
  }

  /**
   * Retrieve a single record by ID
   */
  async retrieveById(id: string, trust?: TrustContext): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("RetrieveByID", {
      id,
      trust: trust
        ? {
            maxSensitivity: trust.maxSensitivity,
            authenticated: trust.authenticated,
            actorId: trust.actorId ?? "",
            scopes: trust.scopes ?? [],
          }
        : undefined,
    });

    return JSON.parse(response.record.toString());
  }

  // ===========================================================================
  // Reinforcement Methods
  // ===========================================================================

  /**
   * Reinforce a record (boost its salience)
   */
  async reinforce(id: string, actor: string, rationale?: string): Promise<void> {
    await this.rpc("Reinforce", {
      id,
      actor,
      rationale: rationale ?? "",
    });
  }

  /**
   * Penalize a record (reduce its salience)
   */
  async penalize(id: string, amount: number, actor: string, rationale?: string): Promise<void> {
    await this.rpc("Penalize", {
      id,
      amount,
      actor,
      rationale: rationale ?? "",
    });
  }

  // ===========================================================================
  // Revision Methods
  // ===========================================================================

  /**
   * Supersede an existing record with a new one
   */
  async supersede(request: SupersedeRequest): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("Supersede", {
      oldId: request.oldId,
      newRecord: Buffer.from(JSON.stringify(request.newRecord)),
      actor: request.actor,
      rationale: request.rationale ?? "",
    });
    return JSON.parse(response.record.toString());
  }

  /**
   * Fork a record to create a conditional variant
   */
  async fork(request: ForkRequest): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("Fork", {
      sourceId: request.sourceId,
      forkedRecord: Buffer.from(JSON.stringify(request.forkedRecord)),
      actor: request.actor,
      rationale: request.rationale ?? "",
    });
    return JSON.parse(response.record.toString());
  }

  /**
   * Retract a record (mark as no longer valid)
   */
  async retract(id: string, actor: string, rationale?: string): Promise<void> {
    await this.rpc("Retract", {
      id,
      actor,
      rationale: rationale ?? "",
    });
  }

  /**
   * Merge multiple records into one
   */
  async merge(request: MergeRequest): Promise<MemoryRecord> {
    const response = await this.rpc<unknown, { record: Buffer }>("Merge", {
      ids: request.ids,
      mergedRecord: Buffer.from(JSON.stringify(request.mergedRecord)),
      actor: request.actor,
      rationale: request.rationale ?? "",
    });
    return JSON.parse(response.record.toString());
  }

  /**
   * Contest a record when conflicting evidence appears
   */
  async contest(request: ContestRequest): Promise<void> {
    await this.rpc("Contest", {
      id: request.id,
      contestingRef: request.contestingRef,
      actor: request.actor,
      rationale: request.rationale ?? "",
    });
  }

  // ===========================================================================
  // Metrics
  // ===========================================================================

  /**
   * Get observability metrics snapshot
   */
  async getMetrics(): Promise<MetricsResponse> {
    const response = await this.rpc<unknown, { snapshot: Buffer }>("GetMetrics", {});
    return { snapshot: JSON.parse(response.snapshot.toString()) };
  }
}

/**
 * Create a new Membrane client instance
 */
export function createMembraneClient(config?: MembraneClientConfig): MembraneClient {
  return new MembraneClient(config);
}
