'use strict';

import { CACHE_DIR, detect_modem, write_json, monotonic_ms } from './telemetry-cache.uc';
import { JOB_DIR, active_job, finish_job, recover_interrupted_job, recover_orphaned_claim, maintain_jobs, run_sms_job } from './sms-jobs.uc';
import { worker_command, specs, new_cache, collect_round } from './collector-core.uc';

// The shell launcher owns the inherited singleton flock. Child commands keep
// that descriptor too: a replacement daemon cannot overlap an orphaned worker.
recover_interrupted_job();
let cache = null, attempted = {}, queries = [], next = 0, completion = null, next_gc = 0;
function publish(value) { return write_json(CACHE_DIR + '/status.json', value); }
while (true) {
	let now = monotonic_ms();
	write_json(CACHE_DIR + '/heartbeat.json', { monotonic_ms: now });
	let modem = detect_modem();
	if (cache == null || cache.generation != (modem?.generation ?? '')) {
		cache = new_cache(modem, now, time());
		queries = modem ? specs(modem) : []; attempted = {}; next = 0;
		publish(cache);
	}
	// Publication failure must not discard a known terminal result or rerun
	// its write. Keep retrying that result before accepting any more work.
	if (completion) {
		if (finish_job(completion.job, completion.result)) {
			completion = null; cache.busy = null; publish(cache); next = 0;
		}
		else { sleep(500); continue; }
	}
	recover_orphaned_claim();
	if (now >= next_gc) { maintain_jobs(); next_gc = now + 60000; }
	let job = active_job();
	if (job?.state == 'queued') {
		cache.busy = 'sms'; publish(cache);
		job.state = 'running';
		if (write_json(JOB_DIR + '/' + job.id + '.json', job)) {
			job.state = 'queued';
			let result;
			try { result = run_sms_job(job, modem, worker_command, monotonic_ms); }
			catch (e) { result = { ok: false, outcome_unknown: job.kind != 'list', error: 'SMS worker failed' }; }
			if (!finish_job(job, result)) completion = { job, result };
		}
		cache.busy = completion ? 'sms' : null; publish(cache); next = 0;
	}
	else if (now >= next) {
		if (modem) collect_round(cache, modem, queries, attempted, worker_command,
			monotonic_ms, time, () => active_job() != null, publish);
		else { cache.monotonic_ms = now; cache.updated_at = time(); publish(cache); }
		next = now + 5000;
	}
	sleep(500);
}
