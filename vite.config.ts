import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const agentEntry = here("./src/model/index.ts");
const handlersEntry = here("./src/server/handlers.ts");

/**
 * The agent endpoint.
 *
 * It runs in the dev server, never in the browser, so the API key stays on the
 * machine: the client only ever receives the frames the agent chooses to emit.
 */
function agentApi(env: Record<string, string>): Plugin {
  return {
    name: "nomin-agent-api",
    config() {
      // Every credential the model layer reads, server-side only.
      for (const [key, value] of Object.entries(env)) {
        if (!value) continue;
        if (key.startsWith("NVIDIA_") || key.startsWith("NOMIN_") || key === "VERCEL") {
          process.env[key] = value;
        }
      }
    },
    configureServer(server: ViteDevServer) {
      // The same handlers production runs. Mounting them here is what keeps
      // "works on my machine" from meaning "missing in production".
      const routes = ["chat", "review", "vision", "evidence", "files", "health"] as const;
      for (const route of routes) {
        server.middlewares.use(`/api/${route}`, async (req: IncomingMessage, res: ServerResponse) => {
          // A syntax error anywhere under `handlers` used to reject here with
          // nobody listening, and an unhandled rejection takes the dev server
          // down with it — so one bad character meant restarting the server
          // rather than saving the file again. It is reported to the caller
          // instead, and the next request picks up the fixed module.
          try {
            const handlers = (await server.ssrLoadModule(
              handlersEntry,
            )) as typeof import("./src/server/handlers.js");
            const handler = {
              chat: handlers.handleChat,
              review: handlers.handleReview,
              vision: handlers.handleVision,
              evidence: handlers.handleEvidence,
              files: handlers.handleFiles,
              health: handlers.handleHealth,
            }[route];
            await handler(req, res);
          } catch (error) {
            const message = error instanceof Error ? error.message : "The handler failed to load.";
            server.config.logger.error(`[nomin] /api/${route}: ${message}`);
            if (!res.writableEnded) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: message.slice(0, 500) }));
            }
          }
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), agentApi(env)],
    resolve: {
      alias: {
        "@nomin/work-tree/react": here("./src/work-tree/react/index.tsx"),
        "@nomin/work-tree": here("./src/work-tree/index.ts"),
        "@nomin/model": agentEntry,
      },
    },
    server: {
      port: 5180,
      open: true,
      // Cross-origin isolation — WebContainer needs it. "credentialless" keeps
      // third-party webfonts loading, which "require-corp" would block.
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
    },
    optimizeDeps: { exclude: ["@webcontainer/api"] },
  };
});
