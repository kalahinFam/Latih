import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearMealCache,
  mealRequestKey,
  requestMeals,
  type MealsRequest,
  type MealsResponse,
} from './mealsClient.ts';

const REQUEST: MealsRequest = {
  slot: 'pagi',
  budgetKcal: 600,
  isTrainingDay: true,
  proteinTargetG: 100,
  excludeCodes: ['GR070'],
  preferCodes: ['CP077', 'CP061'],
};

const RESPONSE: MealsResponse = {
  options: [],
  rejected: [],
  regenerated: false,
};

beforeEach(() => {
  clearMealCache();
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mealRequestKey', () => {
  it('treats code order and duplicates as the same request', () => {
    expect(
      mealRequestKey({
        ...REQUEST,
        excludeCodes: ['GR070', 'GR070'],
        preferCodes: ['CP061', 'CP077', 'CP061'],
      }),
    ).toBe(mealRequestKey(REQUEST));
  });

  it('changes when an input that affects the menu changes', () => {
    expect(mealRequestKey({ ...REQUEST, budgetKcal: 700 })).not.toBe(mealRequestKey(REQUEST));
    expect(mealRequestKey({ ...REQUEST, excludeCodes: [] })).not.toBe(mealRequestKey(REQUEST));
  });
});

describe('requestMeals cache', () => {
  it('reuses one API call for repeated identical requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = requestMeals(REQUEST);
    const second = requestMeals({ ...REQUEST, preferCodes: ['CP061', 'CP077'] });

    expect(first).toBe(second);
    await expect(first).resolves.toEqual(RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed request', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response(JSON.stringify(RESPONSE), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestMeals(REQUEST)).rejects.toThrow('Perencana menu tidak bisa dihubungi.');
    await expect(requestMeals(REQUEST)).resolves.toEqual(RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
