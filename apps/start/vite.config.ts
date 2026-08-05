import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { resolve } from "node:path";

const config = defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@kanbanly/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@kanbanly/server": resolve(__dirname, "../../packages/server/src/index.ts"),
    },
  },
  ssr: {
    // Keep server packages external-ish for spawnSync git
    noExternal: [
      "@kanbanly/core",
      "@kanbanly/server",
      "@atlaskit/pragmatic-drag-and-drop",
      "@atlaskit/pragmatic-drag-and-drop-hitbox",
    ],
  },
  plugins: [
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    tanstackStart(),
    viteReact(),
  ],
  server: {
    port: 3000,
  },
});

export default config;
