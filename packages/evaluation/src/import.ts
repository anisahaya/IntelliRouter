import type { DatasetManifest, DatasetSeedRecord } from "@model-router/contracts";
import type { SeedImportResult, TaskRunStore } from "@model-router/telemetry";

/**
 * A deliberately local-only boundary. The caller supplies an already-open stream;
 * this package never downloads a dataset or invokes a model.
 */
export interface SeedDatasetAdapter {
  manifest: DatasetManifest;
  records: AsyncIterable<DatasetSeedRecord>;
}

export async function importSeedDataset(
  adapter: SeedDatasetAdapter,
  store: TaskRunStore,
): Promise<SeedImportResult> {
  return store.importSeedDataset(adapter.manifest, adapter.records);
}
