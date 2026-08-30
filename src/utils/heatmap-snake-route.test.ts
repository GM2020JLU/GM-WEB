import { describe, expect, test } from 'bun:test';

import { createRandomHeatmapWalk } from './heatmap-snake-route';

function createSeededRandom(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function expectValidWalk(walk: number[], columns: number, rows: number) {
  const cellCount = columns * rows;

  expect(walk).toHaveLength(cellCount * 2 - 1);
  expect(new Set(walk).size).toBe(cellCount);
  expect([...new Set(walk)].sort((left, right) => left - right)).toEqual(
    Array.from({ length: cellCount }, (_, index) => index),
  );
  expect(walk.at(-1)).toBe(walk[0]);

  for (let index = 1; index < walk.length; index += 1) {
    const previousColumn = Math.floor(walk[index - 1] / rows);
    const previousRow = walk[index - 1] % rows;
    const column = Math.floor(walk[index] / rows);
    const row = walk[index] % rows;

    expect(Math.abs(column - previousColumn) + Math.abs(row - previousRow)).toBe(1);
  }
}

describe('createRandomHeatmapWalk', () => {
  test('covers all 168 heatmap cells with adjacent moves for varied routes', () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      expectValidWalk(createRandomHeatmapWalk(24, 7, createSeededRandom(seed)), 24, 7);
    }
  });

  test('always starts on the top or bottom edge so the snake can enter continuously', () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const [start] = createRandomHeatmapWalk(24, 7, createSeededRandom(seed));
      const startRow = start % 7;

      expect([0, 6]).toContain(startRow);
    }
  });

  test('produces a different route when the random sequence changes', () => {
    const firstRoute = createRandomHeatmapWalk(24, 7, createSeededRandom(7));
    const secondRoute = createRandomHeatmapWalk(24, 7, createSeededRandom(19));

    expect(secondRoute).not.toEqual(firstRoute);
  });

  test('supports the single-cell edge case', () => {
    expect(createRandomHeatmapWalk(1, 1, createSeededRandom(1))).toEqual([0]);
  });

  test('rejects invalid grid dimensions', () => {
    expect(() => createRandomHeatmapWalk(0, 7)).toThrow(RangeError);
    expect(() => createRandomHeatmapWalk(24, 2.5)).toThrow(RangeError);
  });
});
