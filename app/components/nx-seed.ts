// Nx workspace seed mounted into the WebContainer at boot. All agent file and
// command operations happen inside this tree — never on the host disk.
//
// The seed is a REAL, runnable Nx + npm-workspaces monorepo, not a placeholder:
// `npm install` at the root installs every project, and `npm run dev` starts a
// Vite dev server bound to 0.0.0.0 so the WebContainer emits `server-ready` and
// the preview frame can render it. The previous seed compiled a single file with
// `tsc` and ran `node dist/index.js`, which exits immediately and binds no port,
// so no preview could ever appear no matter what the agent did.

export type SeedFile = { path: string; contents: string };

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const NX_WORKSPACE_SEED: SeedFile[] = [
  {
    path: "nx.json",
    contents: json({
      $schema: "./node_modules/nx/schemas/nx-schema.json",
      namedInputs: {
        default: ["{projectRoot}/**/*"],
        production: ["default"],
      },
      targetDefaults: {
        build: { cache: true, dependsOn: ["^build"] },
        test: { cache: true },
        lint: { cache: true },
      },
    }),
  },
  {
    path: "package.json",
    contents: json({
      name: "trion-workspace",
      version: "0.0.1",
      private: true,
      workspaces: ["projects/*"],
      scripts: {
        dev: "npm run dev --workspace web",
        build: "nx run-many --target=build",
        test: "nx run-many --target=test",
        lint: "nx run-many --target=lint",
      },
      devDependencies: {
        nx: "^20.3.0",
        typescript: "^5.7.2",
        vite: "^6.0.7",
        "@vitejs/plugin-react": "^4.3.4",
      },
    }),
  },
  {
    path: "tsconfig.base.json",
    contents: json({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
      },
    }),
  },

  // -- projects/web: a runnable Vite + React app, the default preview target --
  {
    path: "projects/web/package.json",
    contents: json({
      name: "web",
      version: "0.0.1",
      private: true,
      type: "module",
      scripts: {
        // --host 0.0.0.0 is load-bearing: WebContainer only reports
        // `server-ready` for a server bound to all interfaces.
        dev: "vite --host 0.0.0.0 --port 5173",
        build: "vite build",
        preview: "vite preview --host 0.0.0.0",
        test: "tsc -p tsconfig.json --noEmit",
      },
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
      },
      devDependencies: {
        vite: "^6.0.7",
        "@vitejs/plugin-react": "^4.3.4",
        typescript: "^5.7.2",
      },
    }),
  },
  {
    path: "projects/web/project.json",
    contents: json({
      name: "web",
      root: "projects/web",
      projectType: "application",
      targets: {
        dev: { executor: "nx:run-commands", options: { command: "vite --host 0.0.0.0 --port 5173", cwd: "projects/web" } },
        build: { executor: "nx:run-commands", options: { command: "vite build", cwd: "projects/web" } },
        test: { executor: "nx:run-commands", options: { command: "tsc -p tsconfig.json --noEmit", cwd: "projects/web" } },
      },
    }),
  },
  {
    path: "projects/web/tsconfig.json",
    contents: json({
      extends: "../../tsconfig.base.json",
      include: ["src"],
    }),
  },
  {
    path: "projects/web/vite.config.ts",
    contents: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // The preview runs in a cross-origin-isolated iframe; allow it through.
    strictPort: false,
  },
});
`,
  },
  {
    path: "projects/web/index.html",
    contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Trion workspace</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  },
  {
    path: "projects/web/src/main.tsx",
    contents: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`,
  },
  {
    path: "projects/web/src/App.tsx",
    contents: `export default function App() {
  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">Trion sandbox</p>
        <h1>Your workspace is running.</h1>
        <p>
          This is <code>projects/web</code>, served by Vite inside the browser
          sandbox. Ask Trion to change it and the preview updates in place.
        </p>
      </section>
    </main>
  );
}
`,
  },
  {
    path: "projects/web/src/styles.css",
    contents: `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Plus Jakarta Sans", system-ui, sans-serif;
  background: #0b141c;
  color: #f7f9f8;
}
.shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.card {
  width: min(680px, 100%);
  padding: 32px;
  border-radius: 16px;
  border: 1px solid rgba(46, 230, 166, 0.24);
  background: rgba(255, 255, 255, 0.04);
}
.eyebrow { margin: 0; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #2ee6a6; }
h1 { margin: 8px 0 12px; font-size: 32px; line-height: 1.2; }
p { line-height: 1.6; margin: 0; }
code { font-family: "JetBrains Mono", ui-monospace, monospace; color: #2ee6a6; }
`,
  },

  {
    path: "README.md",
    contents: `# Trion workspace

An Nx + npm-workspaces monorepo running inside the browser sandbox.

- Applications live in \`projects/<name>/\`.
- \`projects/web\` is a Vite + React app and is the default preview target.
- All paths are POSIX and relative to this root.

## Commands

    npm install                 # install every workspace
    npm run dev                 # start the web dev server (preview)
    npx nx build web            # build one project
    npx nx run-many --target=build
`,
  },
  {
    path: ".gitignore",
    contents: "node_modules/\ndist/\n.nx/\n.turbo/\n",
  },
];

export function seedFileSystemTree(): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const { path, contents } of NX_WORKSPACE_SEED) {
    const parts = path.split("/");
    let cursor = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isFile = index === parts.length - 1;
      if (isFile) {
        cursor[part] = { file: { contents } };
      } else {
        if (!cursor[part]) cursor[part] = { directory: {} };
        cursor = (cursor[part] as { directory: Record<string, unknown> }).directory;
      }
    }
  }
  return root;
}
