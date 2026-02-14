import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

/**
 * Force memory/* and config/* modules into a shared chunk so the bundler does
 * not create a circular import between a "memory-cli" chunk and a "config"
 * chunk.  Without this, rolldown places the __exportAll runtime helper in
 * the memory-cli chunk, but config needs it and memory-cli needs config
 * → circular → __exportAll is undefined at evaluation time.
 */
const sharedOutputOptions = {
  manualChunks(moduleId: string) {
    // Normalise Windows paths for matching.
    const id = moduleId.replace(/\\/g, "/");
    if (id.includes("/src/memory/") || id.includes("/src/config/")) {
      return "config-memory";
    }
    return undefined;
  },
};

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
    outputOptions: sharedOutputOptions,
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
    outputOptions: sharedOutputOptions,
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
    env,
    fixedExtension: false,
    platform: "node",
  },
]);
