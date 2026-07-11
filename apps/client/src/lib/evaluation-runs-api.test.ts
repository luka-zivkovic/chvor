import { describe, expect, it, vi } from "vitest";
import { createEvaluationRunsApi } from "./evaluation-runs-api";

describe("evaluation runs API", () => {
  it("encodes run, pagination, and comparison requests", async () => {
    const request = vi.fn().mockResolvedValue({ runs: [], nextCursor: null });
    const api = createEvaluationRunsApi(request);
    await api.list({ limit: 10, cursor: "cursor" });
    expect(request).toHaveBeenCalledWith("/evaluation-runs?limit=10&cursor=cursor");
    request.mockResolvedValueOnce({ rows: [], nextCursor: null });
    await api.compare("base/id", "candidate", { limit: 5 });
    expect(request.mock.calls[1][0]).toBe(
      "/evaluation-runs/compare?baseline=base%2Fid&candidate=candidate&limit=5"
    );
  });
});
