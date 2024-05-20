export function createWorkbenchSummary() {
  return { scope: "workbench", status: "ready" };
}

// current lane: workbench
export function workbenchTask() {
  return { scope: "workbench", status: "ready" };
}

// workbench: release

// current lane: inspection
export function inspectionTask() {
  return { scope: "inspection", status: "ready" };
}

