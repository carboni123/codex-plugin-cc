// What the codex:dispatch relay agent sees and returns when a dispatch is over. The relay is a
// model, and a model asked to repeat a report rewrites it, so in relay mode the companion prints
// these two lines instead of the report. The report-delivery hooks read the job id from them and
// attach the stored report to the relay's result. This file has no imports: one of those hooks
// runs on every prompt.

const HANDOFF_LINE = /^Codex dispatch ([A-Za-z0-9._-]+) (completed|failed|was cancelled)\b/m;

export function renderDispatchHandoff(job) {
  const outcome = job.status === "completed" ? "completed" : job.status === "cancelled" ? "was cancelled" : "failed";
  const elapsed = job.duration ?? job.elapsed;
  return [
    `Codex dispatch ${job.id} ${outcome}${elapsed ? ` after ${elapsed}` : ""}.`,
    `The Codex plugin attaches Codex's report and the runtime evidence to this result. If they are missing, run /codex:result ${job.id}`
  ].join("\n") + "\n";
}

export function parseDispatchHandoff(output) {
  const match = String(output ?? "").match(HANDOFF_LINE);
  return match ? { jobId: match[1], status: match[2] === "was cancelled" ? "cancelled" : match[2] } : null;
}
