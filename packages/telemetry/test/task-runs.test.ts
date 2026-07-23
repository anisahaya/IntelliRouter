import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrations.js";
import { TaskRunStore } from "../src/task-runs.js";

describe("task runs", () => {
  it("records process separately and returns safe receipt", () => {
    const db = new Database(":memory:");
    migrate(db);
    const s = new TaskRunStore(db, "salt");
    s.createRun({ routeId: "r", origin: "native", taskFingerprint: "t" });
    s.completeProcess("r", "completed");
    const receipt = s.receipt("r");
    expect(receipt?.verification).toBe("not-run");
    expect(receipt).not.toHaveProperty("content");
    db.close();
  });
  it("rejects invalid embeddings", () => {
    const db = new Database(":memory:");
    migrate(db);
    const s = new TaskRunStore(db, "salt");
    s.createRun({ routeId: "r", origin: "evaluation", taskFingerprint: "t" });
    expect(
      s.embedding(
        "r",
        { locallyGenerated: true, model: "m", dimensions: 2, values: [NaN, 1] },
        true,
      ),
    ).toBe(false);
    db.close();
  });
});
