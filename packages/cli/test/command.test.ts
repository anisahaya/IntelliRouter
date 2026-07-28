import { describe, expect, it } from "vitest";
import { commandCandidates, taskkillArgs } from "../src/command.js";

describe("portable command helpers", () => {
  it("uses Windows command shims without shell interpolation", () => {
    expect(commandCandidates("codex", "win32")).toEqual(["codex", "codex.cmd", "codex.exe"]);
    expect(taskkillArgs(42)).toEqual(["/pid", "42", "/t", "/f"]);
  });
});
