import { describe, expect, test } from 'bun:test';
import {
	ACTIVE_CALM_MS,
	ACTIVE_URGENT_MS,
	CANDIDATE_MS,
	cadenceFor,
	REREAD_FLOOR_MS,
} from '../src/core/collect.ts';

const threshold = 90;

describe('how often each account is read', () => {
	test('the account in use is read every minute when near the threshold and climbing', () => {
		expect(
			cadenceFor({
				isActive: true,
				usedPercent: 80,
				previousPercent: 78,
				thresholdPercent: threshold,
			}),
		).toBe(ACTIVE_URGENT_MS);
		expect(
			cadenceFor({
				isActive: true,
				usedPercent: 75,
				previousPercent: undefined,
				thresholdPercent: threshold,
			}),
		).toBe(ACTIVE_URGENT_MS);
	});

	test('near the threshold but not moving, it drops back to three minutes', () => {
		// A minute-by-minute read of a number that is not changing is the one
		// way to burn the hourly budget for nothing.
		expect(
			cadenceFor({
				isActive: true,
				usedPercent: 80,
				previousPercent: 80,
				thresholdPercent: threshold,
			}),
		).toBe(ACTIVE_CALM_MS);
		expect(
			cadenceFor({
				isActive: true,
				usedPercent: 80.4,
				previousPercent: 80,
				thresholdPercent: threshold,
			}),
		).toBe(ACTIVE_CALM_MS);
	});

	test('well under the threshold it is read every three minutes even while climbing', () => {
		expect(
			cadenceFor({
				isActive: true,
				usedPercent: 40,
				previousPercent: 30,
				thresholdPercent: threshold,
			}),
		).toBe(ACTIVE_CALM_MS);
		expect(
			cadenceFor({
				isActive: true,
				usedPercent: 74,
				previousPercent: 70,
				thresholdPercent: threshold,
			}),
		).toBe(ACTIVE_CALM_MS);
	});

	test('the other accounts are read every five minutes whatever their level', () => {
		expect(
			cadenceFor({
				isActive: false,
				usedPercent: 99,
				previousPercent: 90,
				thresholdPercent: threshold,
			}),
		).toBe(CANDIDATE_MS);
		expect(
			cadenceFor({
				isActive: false,
				usedPercent: 0,
				previousPercent: 0,
				thresholdPercent: threshold,
			}),
		).toBe(CANDIDATE_MS);
	});

	test('an account with no reading yet is read at the calm rate, not the urgent one', () => {
		expect(
			cadenceFor({
				isActive: true,
				usedPercent: undefined,
				previousPercent: undefined,
				thresholdPercent: threshold,
			}),
		).toBe(ACTIVE_CALM_MS);
	});

	test('the steady rates sit inside the endpoint budget of about thirty reads an hour', () => {
		const perHour = (ms: number): number => 3_600_000 / ms;
		expect(perHour(ACTIVE_CALM_MS)).toBeLessThanOrEqual(20);
		expect(perHour(CANDIDATE_MS)).toBeLessThanOrEqual(12);
		expect(REREAD_FLOOR_MS).toBeGreaterThanOrEqual(60_000);
	});
});
