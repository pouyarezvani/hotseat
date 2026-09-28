/**
 * With the lid closed a Mac still wakes for a second or two every few minutes
 * to check mail and the network, then sleeps again. A request sent in one of
 * those windows can reach the service and never get its answer back. For a
 * token renewal that is fatal: the service spends the old refresh token the
 * moment it accepts the request, and the new one is lost with the answer.
 * The system's own capabilities tell the two wakes apart: only a full wake
 * brings graphics up.
 */
export function awakeFrom(systemState: string): boolean {
	const capabilities = /Capabilities are:([^\n]*)/.exec(systemState)?.[1];
	if (capabilities === undefined) return true;
	return /\bGraphics\b/.test(capabilities);
}

/** Whether this machine is fully awake. Anywhere it cannot tell, it says yes. */
export async function fullyAwake(): Promise<boolean> {
	if (process.platform !== 'darwin') return true;
	try {
		const proc = Bun.spawn(['/usr/bin/pmset', '-g', 'systemstate'], {
			stdout: 'pipe',
			stderr: 'ignore',
		});
		const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return awakeFrom(text);
	} catch {
		return true;
	}
}
