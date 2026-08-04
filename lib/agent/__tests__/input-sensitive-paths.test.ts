import { describe, expect, it } from "vitest";
import { parseChatRequest } from "../input";
import { isSensitiveWorkspacePath } from "../path-policy";

describe("model-facing sensitive path boundary", () => {
  it("recognizes credential-bearing names while allowing checked-in templates", () => {
    for (const path of [".env", ".env.local", "secrets/token.txt", ".aws/credentials", "certs/site.pem", "id_ed25519"]) {
      expect(isSensitiveWorkspacePath(path), path).toBe(true);
    }
    expect(isSensitiveWorkspacePath(".env.example")).toBe(false);
  });

  it("removes sensitive snapshot paths before they enter agent input", () => {
    const request = parseChatRequest({
      sessionId: "safe-snapshot",
      userText: "inspect the project",
      mode: "plan",
      model: "trion-1.4",
      snapshot: ["src/App.tsx", ".env", "secrets/production.key", ".env.example"],
    });

    expect(request.snapshot).toEqual(["src/App.tsx", ".env.example"]);
  });

  it("drops accidental sensitive attachments but retains ordinary user files", () => {
    const request = parseChatRequest({
      sessionId: "safe-attachment",
      userText: "review these files",
      mode: "plan",
      model: "trion-1.4",
      attachments: [
        { path: ".env.production", content: "secret" },
        { path: "notes.md", content: "Please improve the onboarding copy." },
      ],
    });

    expect(request.attachments).toEqual([{ type: "file", path: "notes.md", content: "Please improve the onboarding copy." }]);
  });
});
