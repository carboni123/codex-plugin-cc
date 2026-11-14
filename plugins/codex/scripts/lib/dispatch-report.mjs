import { renderDispatchUnfinished } from "./dispatch.mjs";
import { buildSingleJobSnapshot, readStoredJob } from "./job-control.mjs";

export const DISPATCH_PROGRESS_LINES = 6;

function isActive(job) {
  return job.status === "queued" || job.status === "running";
}

// The report of a dispatch that is over: the one stored when Codex's turn ended, or, for a job
// that was cancelled or lost its worker before that, what is known about how it stopped.
export function renderFinishedDispatch(job, storedJob) {
  return storedJob?.rendered ?? renderDispatchUnfinished(job, storedJob);
}

/**
 * Looks a dispatch up by job id, in any workspace, and returns its report. Null when the id is
 * unknown, belongs to another kind of job, or the dispatch is still running.
 */
export function readDispatchReport(cwd, jobId) {
  let snapshot;
  try {
    snapshot = buildSingleJobSnapshot(cwd, jobId, { maxProgressLines: DISPATCH_PROGRESS_LINES });
  } catch {
    return null;
  }
  const { workspaceRoot, job } = snapshot;
  if (job.id !== jobId || job.jobClass !== "dispatch" || isActive(job)) {
    return null;
  }
  return { job, report: renderFinishedDispatch(job, readStoredJob(workspaceRoot, job.id)) };
}
