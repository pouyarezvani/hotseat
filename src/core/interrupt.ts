/**
 * Runs work that leaves something behind while it runs, such as a scratch
 * folder holding a login, and makes sure it is cleaned up however the work
 * ends: finishing, failing, or the whole process being stopped. A `finally`
 * alone does not run when the process is killed, which is exactly when a
 * half-finished sign-in is abandoned.
 */
export async function cleanUpEvenIfInterrupted<T>(
	cleanup: () => Promise<void>,
	work: () => Promise<T>,
): Promise<T> {
	let cleaning: Promise<void> | undefined;
	const once = (): Promise<void> => {
		cleaning ??= cleanup().catch(() => undefined);
		return cleaning;
	};
	const stopWith = (code: number) => (): void => {
		void once().finally(() => process.exit(code));
	};
	const onInterrupt = stopWith(130);
	const onTerminate = stopWith(143);
	process.once('SIGINT', onInterrupt);
	process.once('SIGTERM', onTerminate);
	try {
		return await work();
	} finally {
		process.off('SIGINT', onInterrupt);
		process.off('SIGTERM', onTerminate);
		await once();
	}
}
