/**
 * Memory configuration schema for OpenClaw
 *
 * This schema defines the configuration options for the Memory Mark One
 * integration with OpenClaw.
 */

import { z } from "zod";

/**
 * Sensitivity levels for memory records
 */
const SensitivitySchema = z.enum(["public", "low", "medium", "high", "hyper"]);

/**
 * Memory types for filtering retrieval
 */
const MemoryTypeSchema = z.enum(["episodic", "working", "semantic", "competence", "plan_graph"]);

/**
 * Membrane client configuration
 */
const MembraneConfigSchema = z
  .object({
    /** Membrane server address (host:port) */
    address: z.string().default("localhost:19090"),

    /** Connection timeout in milliseconds */
    connectTimeoutMs: z.number().int().positive().default(5000),

    /** Request timeout in milliseconds */
    requestTimeoutMs: z.number().int().positive().default(30000),

    /** API key for authentication (optional) */
    apiKey: z.string().optional(),

    /** Whether to use TLS for connection */
    useTls: z.boolean().default(false),
  })
  .strict();

/**
 * Ingestion configuration
 */
const IngestionConfigSchema = z
  .object({
    /** Enable automatic event ingestion */
    enabled: z.boolean().default(true),

    /** Use async ingestion (non-blocking) */
    async: z.boolean().default(true),

    /** Path for event sourcing log (optional) */
    eventLogPath: z.string().optional(),

    /** Tool patterns to filter from ingestion */
    filterToolPatterns: z.array(z.string()).default([]),

    /** Session types to exclude from competence learning */
    excludeSessionTypes: z.array(z.string()).default(["heartbeat"]),
  })
  .strict();

/**
 * Retrieval configuration
 */
const RetrievalConfigSchema = z
  .object({
    /** Maximum number of records to retrieve */
    maxRecords: z.number().int().positive().default(20),

    /** Maximum tokens for retrieved memory context */
    maxTokens: z.number().int().positive().default(2000),

    /** Minimum salience threshold for retrieval */
    minSalience: z.number().min(0).max(1).default(0.3),

    /** Memory types to include in retrieval */
    includeTypes: z.array(MemoryTypeSchema).default(["semantic", "competence", "working", "episodic"]),

    /** Default maximum sensitivity level */
    defaultMaxSensitivity: SensitivitySchema.default("medium"),
  })
  .strict();

/**
 * Session configuration for memory
 */
const SessionMemoryConfigSchema = z
  .object({
    /** Session ID format template */
    idFormat: z.string().default("{channel}:{type}:{uuid}"),

    /** Working memory TTL in hours (gradual decay) */
    workingMemoryTtlHours: z.number().positive().default(48),
  })
  .strict();

/**
 * Full memory configuration schema
 */
export const MemoryConfigSchema = z
  .object({
    /** Enable memory system */
    enabled: z.boolean().default(true),

    /** Backend type */
    backend: z.enum(["membrane", "file", "none"]).default("membrane"),

    /** Membrane-specific configuration */
    membrane: MembraneConfigSchema.optional(),

    /** Ingestion configuration */
    ingestion: IngestionConfigSchema.optional(),

    /** Retrieval configuration */
    retrieval: RetrievalConfigSchema.optional(),

    /** Session configuration */
    session: SessionMemoryConfigSchema.optional(),
  })
  .strict()
  .optional();

/**
 * Type inference for memory configuration
 */
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type MembraneConfig = z.infer<typeof MembraneConfigSchema>;
export type IngestionConfig = z.infer<typeof IngestionConfigSchema>;
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;
export type SessionMemoryConfig = z.infer<typeof SessionMemoryConfigSchema>;

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: NonNullable<MemoryConfig> = {
  enabled: true,
  backend: "membrane",
  membrane: {
    address: "localhost:19090",
    connectTimeoutMs: 5000,
    requestTimeoutMs: 30000,
    useTls: false,
  },
  ingestion: {
    enabled: true,
    async: true,
    filterToolPatterns: [],
    excludeSessionTypes: ["heartbeat"],
  },
  retrieval: {
    maxRecords: 20,
    maxTokens: 2000,
    minSalience: 0.3,
    includeTypes: ["semantic", "competence", "working", "episodic"],
    defaultMaxSensitivity: "medium",
  },
  session: {
    idFormat: "{channel}:{type}:{uuid}",
    workingMemoryTtlHours: 48,
  },
};
