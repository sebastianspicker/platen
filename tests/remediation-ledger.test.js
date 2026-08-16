import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const proofManifestUrl = new URL(
  "../catalog/capability-proofs/proofs.json",
  import.meta.url,
);
const ledgerUrl = new URL("../docs/remediation-ledger.md", import.meta.url);

test("remediation ledger assigns every non-proven claim exactly once", async () => {
  const [manifestSource, ledger] = await Promise.all([
    readFile(proofManifestUrl, "utf8"),
    readFile(ledgerUrl, "utf8"),
  ]);
  const { records } = JSON.parse(manifestSource);
  const knownIds = new Set(records.map(({ capabilityId }) => capabilityId));
  const expectedIds = records
    .filter(({ status }) => status === "partial" || status === "false")
    .map(({ capabilityId }) => capabilityId)
    .sort();
  const partialCount = records.filter(({ status }) => status === "partial").length;
  const falseCount = records.filter(({ status }) => status === "false").length;
  const assignmentSection = ledger.slice(
    ledger.indexOf("## R01 "),
    ledger.indexOf("## Recommended agent order"),
  );
  const listedIds = [...assignmentSection.matchAll(/`([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)`/g)]
    .map((match) => match[1])
    .filter((capabilityId) => knownIds.has(capabilityId));

  assert.equal(new Set(listedIds).size, listedIds.length, "duplicate capability ID");
  assert.deepEqual(listedIds.toSorted(), expectedIds);
  assert.equal((ledger.match(/^## R\d{2} /gm) ?? []).length, 12);
  assert.match(
    ledger,
    new RegExp(`\\| \\*\\*Total\\*\\* \\|  \\| \\*\\*${partialCount}\\*\\* \\| \\*\\*${falseCount}\\*\\* \\| \\*\\*${expectedIds.length}\\*\\*`),
  );
  assert.match(ledger, /\| R10 AEC workflows \| P0 \| 0 \| 0 \| 0 \|/);
  const summarySection = ledger.slice(
    ledger.indexOf("## Program summary"),
    ledger.indexOf("## Agent assignment matrix"),
  );
  const programRows = summarySection
    .split("\n")
    .filter((line) => /^\| R\d{2} /.test(line));
  assert.equal(programRows.length, 12);
  for (const row of programRows) {
    assert.equal(row.split("|").length, 8, `malformed summary row: ${row}`);
  }
});
