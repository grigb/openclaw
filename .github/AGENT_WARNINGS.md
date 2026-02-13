# ⚠️ Agent Warning: Do Not Modify Memory Configuration

## CRITICAL: DO NOT ATTEMPT TO ADD `memory.enabled`

The `memory.enabled` configuration option **ALREADY EXISTS** and defaults to `true`.

### Where It's Defined
File: `src/memory/config-schema.ts`
```typescript
export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),  // ← ALREADY HERE!
  backend: z.enum(["membrane", "file", "none", "builtin", "qmd"]).default("membrane"),
  // ...
}).strict().optional();
```

### Why You Should NOT Touch This

1. **It already works** - Memory is enabled by default
2. **Adding it again causes build failures** - Duplicate schema entries conflict
3. **Recent incident** - Agent added `memory.enabled` to schema on 2026-02-12, breaking OpenClaw for hours
4. **Type conflicts** - Adding duplicate types breaks TypeScript compilation

### What Memory Config Looks Like

Minimal (works immediately):
```json
{
  "memory": {}
}
```

Or with explicit backend:
```json
{
  "memory": {
    "backend": "membrane"
  }
}
```

Full configuration:
```json
{
  "memory": {
    "enabled": true,        // Optional - defaults to true
    "backend": "membrane",  // Options: membrane, file, none, builtin (legacy), qmd (legacy)
    "membrane": {
      "address": "localhost:19090",
      "connectTimeoutMs": 5000,
      "requestTimeoutMs": 30000
    },
    "ingestion": {
      "enabled": true,
      "async": true
    },
    "retrieval": {
      "maxRecords": 20,
      "maxTokens": 2000
    }
  }
}
```

### Legacy QMD Support

For backward compatibility, legacy QMD fields are also accepted:
```json
{
  "memory": {
    "backend": "qmd",
    "citations": "auto",
    "qmd": {
      "command": "qmd",
      "paths": [...],
      "sessions": {...},
      "update": {...},
      "limits": {...}
    }
  }
}
```

## Files You Should NOT Modify for Memory

| File | Why |
|------|-----|
| `src/config/zod-schema.ts` | Memory schema is imported, not defined inline |
| `src/config/types.memory.ts` | Legacy types - use `memory/config-schema.ts` instead |
| `src/memory/config-schema.ts` | Only modify if you understand the full schema |

## If You Think Memory Needs Fixing

1. Check if memory is already working: `openclaw status`
2. Look at existing config: `cat ~/.openclaw/openclaw.json | grep -A10 memory`
3. Read the build fix report: `~/.agents/openclaw/.dev/BUILD-FIX-REPORT-2026-02-13.md`
4. Ask the user before making ANY changes to memory configuration

## Related Documentation

- Build fix report: `~/.agents/openclaw/.dev/BUILD-FIX-REPORT-2026-02-13.md`
- Memory schema: `src/memory/config-schema.ts`
- Custom commits: `~/.agents/openclaw/LOCAL-CUSTOMIZATIONS.md`

---
**Last Updated:** 2026-02-13  
**Author:** Kimi AI Agent  
**Status:** ACTIVE WARNING
