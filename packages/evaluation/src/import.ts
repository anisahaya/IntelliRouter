import { createHmac } from "node:crypto";
import {
  type DatasetManifest,
  type DatasetSeedRecord,
  datasetManifestSchema,
  datasetSeedRecordSchema,
} from "@model-router/contracts";

export interface SeedDatasetAdapter {
  records: AsyncIterable<DatasetSeedRecord>;
  manifest: DatasetManifest;
}
export async function importSeedDataset(
  adapter: SeedDatasetAdapter,
  salt: string,
  onRecord: (
    record: DatasetSeedRecord & { externalIdHmac: string; labelNamespace: string },
  ) => Promise<void> | void,
): Promise<number> {
  const manifest = datasetManifestSchema.parse(adapter.manifest);
  let count = 0;
  for await (const raw of adapter.records) {
    const record = datasetSeedRecordSchema.parse(raw);
    const source = record.source ?? manifest.provenance;
    const pair = record.modelPair ?? `${manifest.modelPair.source}->${manifest.modelPair.target}`;
    const externalIdHmac = createHmac("sha256", salt)
      .update(`dataset-external:${record.externalId}`)
      .digest("hex");
    const strength =
      record.strength === "verified" || record.strength === "comparative"
        ? record.strength
        : record.strength === "attested"
          ? "attested"
          : "none";
    await onRecord({
      ...record,
      source,
      modelPair: pair,
      externalIdHmac,
      labelNamespace: `${source}:${pair}`,
      strength,
    });
    count++;
  }
  return count;
}
