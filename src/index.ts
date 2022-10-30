export function createReleaseSummary() {
  return { scope: "release", status: "ready" };
}

// current lane: release
export function releaseTask() {
  return { scope: "release", status: "ready" };
}
