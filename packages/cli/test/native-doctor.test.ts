import { describe, expect, it } from "vitest";
import { evaluateDoctorReadiness } from "../src/native-doctor.js";

describe("doctor readiness semantics", () => {
  it("requires core and the selected harness", () => {
    expect(evaluateDoctorReadiness("codex", [{ ready: true }], true)).toBe(true);
    expect(evaluateDoctorReadiness("codex", [{ ready: false }], true)).toBe(false);
    expect(evaluateDoctorReadiness("codex", [{ ready: true }], false)).toBe(false);
  });
  it("allows partial all-harness success but not no success", () => {
    expect(evaluateDoctorReadiness("all", [{ ready: false }, { ready: true }], true)).toBe(true);
    expect(evaluateDoctorReadiness("all", [{ ready: false }, { ready: false }], true)).toBe(false);
  });
  it("strict mode requires every harness", () => {
    expect(evaluateDoctorReadiness("all", [{ ready: true }, { ready: false }], true, true)).toBe(
      false,
    );
    expect(evaluateDoctorReadiness("all", [{ ready: true }, { ready: true }], true, true)).toBe(
      true,
    );
  });
});
