import {
	installLoginItem,
	isRunning,
	loginItemStatus,
	removeLoginItem,
	stopMenuBar,
} from '../../src/core/menubar.ts';

// Runs one login-item step against the app named on the command line and
// prints what it returned, so a test can run it under a scratch HOME and PATH.
const [step, app, within] = process.argv.slice(2);
const options = within ? { answerWithinMs: Number(within) } : {};
if (!app) throw new Error('give a step and an app');
const steps: Record<string, () => Promise<unknown>> = {
	install: () => installLoginItem(app, options),
	remove: () => removeLoginItem(app, options),
	status: () => loginItemStatus(app, options),
	running: () => isRunning(),
	stop: () => stopMenuBar(),
};
const result = await (steps[step ?? ''] ?? steps.status)?.();
console.log(JSON.stringify(result ?? null));
