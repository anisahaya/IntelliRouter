import type {
  HarnessId,
  HarnessRouteRecord,
  NativeRouteHistoryFilters,
  NativeRouteStats,
  RouteOutcome,
} from "@model-router/contracts";
import {
  getNativeRouteHistory,
  getNativeRouteStats,
} from "../../../apps/mcp-server/src/route-state.js";

export interface NativeStateCliFilters {
  since?: string;
  harness?: HarnessId;
  outcome?: RouteOutcome;
}

export async function nativeHistory(
  filters: NativeStateCliFilters & { limit?: number } = {},
): Promise<HarnessRouteRecord[]> {
  return getNativeRouteHistory(filters satisfies NativeRouteHistoryFilters);
}

export async function nativeStats(filters: NativeStateCliFilters = {}): Promise<NativeRouteStats> {
  return getNativeRouteStats(filters);
}
