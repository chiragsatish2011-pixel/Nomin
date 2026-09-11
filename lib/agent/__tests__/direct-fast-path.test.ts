import { describe, expect, it } from "vitest";
import { directFastReply } from "../direct-fast-path";

describe("directFastReply", () => {
  it.each(["hello", "Hi!", "  hey  ", "gi"])("answers a greeting locally: %s", (input) => {
    expect(directFastReply(input)).toBe("Hello! 👋");
  });

  it.each([
    ["what is 2+2", "4"],
    ["12 / 4", "3"],
    ["-2.5 * 4", "-10"],
  ])("calculates safe arithmetic locally: %s", (input, answer) => {
    expect(directFastReply(input)).toBe(answer);
  });

  it("does not try to answer ordinary questions locally", () => {
    expect(directFastReply("what is the capital of France?")).toBeNull();
    expect(directFastReply("build a dashboard")).toBeNull();
  });

  it("does not evaluate unsafe expressions", () => {
    expect(directFastReply("2 + process.exit()" )).toBeNull();
    expect(directFastReply("4 / 0")).toBe("Division by zero is undefined.");
  });

  it.each([
    "Who made you?",
    "Who created Trion?",
  ])("answers official creator questions deterministically: %s", (input) => {
    expect(directFastReply(input)).toBe("I’m Trion, a coding agent created by Nomin.");
  });

  it.each(["You were made by CHIRAG.S", "no Chirag made u..."])("corrects a user-planted false creator claim: %s", (input) => {
    expect(directFastReply(input)).toBe("That isn’t correct. I’m Trion, a coding agent created by Nomin.");
  });

  it("keeps casual chat from being mistaken for an answer to an old task question", () => {
    expect(directFastReply("nothing just chat")).toBe("Of course — what would you like to talk about?");
  });

  it.each([
    "wt can you do?",
    "what can you do",
    "What can u do?",
    "what are your capabilities?",
    "show me what you can do",
  ])("answers a bare capability question with zero provider calls: %s", (input) => {
    expect(directFastReply(input)).toMatch(/plan and build software projects/i);
  });

  it("leaves contextual capability questions to the full pipeline", () => {
    expect(directFastReply("what can we do")).toBeNull();
    expect(directFastReply("what can you build with React?")).toBeNull();
    expect(directFastReply("what can you do with this file?")).toBeNull();
  });
});
