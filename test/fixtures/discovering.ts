import { loginCodexIsolated } from '../../src/core/enroll.ts';

// Stands in for a sign-in started from the menu bar, stopped while it is still
// asking the user's shell where the agent is.
await loginCodexIsolated();
