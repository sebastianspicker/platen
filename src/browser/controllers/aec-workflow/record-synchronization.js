export function syncAecRecordIds(state, workspace) {
  const records = workspace?.namespaces?.measurements;
  if (!Array.isArray(records)) return;
  state.aecLastCalibrationId = [...records].reverse().find(
    (record) => record?.schemaVersion === 2 && record.type === 'scale-calibration',
  )?.id ?? null;
  state.aecLastMeasurementId = [...records].reverse().find(
    (record) => record?.schemaVersion === 2 && record.type === 'measurement',
  )?.id ?? null;
  state.aecMeasurementIds = records.filter((record) => record?.schemaVersion === 2 && record.type === 'measurement').map((record) => record.id);
}
