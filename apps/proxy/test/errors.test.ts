import { describe, expect, it } from "vitest";
import { sanitizeClientMessage } from "../src/plugins/errors.js";

describe("client error sanitization", () => {
  it("redacts Unix and Windows paths while preserving the home shorthand", () => {
    expect(
      sanitizeClientMessage(
        String.raw`failed in C:\Users\other\private\file.ts and /srv/private/file.ts`,
        String.raw`C:\Users\current`,
      ),
    ).toBe("failed in <path> and <path>");

    expect(
      sanitizeClientMessage(
        String.raw`failed in C:\Users\current\project\file.ts`,
        String.raw`C:\Users\current`,
      ),
    ).toBe(String.raw`failed in ~\project\file.ts`);
  });
});
