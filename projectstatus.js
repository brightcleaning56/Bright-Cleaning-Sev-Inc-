// Project status follows the work. A person sets only "On Hold" (with a reason) and "Archived"; everything else is read from
// the project's record: the signed contract, readiness, dispatch approval, work started, tasks and customer sign-off.
// Pure functions: the database is read in pm.js, these only decide.

// facts: { status, executed, readiness, dispatchApproved, started, tasksTotal, tasksOpen, completeReasons }
// completeReasons is null when completion is allowed, otherwise the plain-words reasons it is not (from pm.js completeBlock).
function deriveStatus(f) {
  if (f.status === 'Archived') return 'Archived';
  if (f.status === 'On Hold') return 'On Hold';
  if (f.status === 'Completed') return 'Completed'; // finished work stays finished; a change order records new work
  if (!f.executed) return 'Planning';
  if (f.started && f.completeReasons === null) return 'Completed';
  if (f.started && f.tasksTotal > 0 && f.tasksOpen === 0) return 'Quality Review';
  if (f.started) return 'In Progress';
  if (f.readiness && f.dispatchApproved) return 'Ready to mobilize';
  return 'Contracted';
}

// The plain-words steps that move the project to its next status.
function nextSteps(f) {
  if (f.status === 'Archived' || f.status === 'Completed') return [];
  if (f.status === 'On Hold') return ['Resume the project once the hold reason is cleared'];
  const out = [];
  if (!f.executed) out.push('Get the contract signed by the customer');
  if (!f.readiness) out.push('Finish the readiness checklist (staffing, dates, access, equipment, supplies, safety)');
  if (!f.dispatchApproved && !f.started) out.push('An owner or manager approves dispatch');
  if (f.executed && !f.started) out.push('The first crew check-in or the project start date starts the work');
  if (f.tasksOpen > 0) out.push(`Finish ${f.tasksOpen} open task${f.tasksOpen === 1 ? '' : 's'}`);
  if (f.started && f.tasksOpen === 0 && f.completeReasons) out.push(...f.completeReasons.split('; '));
  return out;
}

module.exports = { deriveStatus, nextSteps };
