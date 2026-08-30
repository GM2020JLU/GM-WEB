export type RandomSource = () => number;

function getRandomIndex(length: number, random: RandomSource) {
  const value = random();
  const normalizedValue = Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 1 - Number.EPSILON)
    : 0;

  return Math.floor(normalizedValue * length);
}

function shuffle<T>(items: T[], random: RandomSource) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = getRandomIndex(index + 1, random);
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }

  return items;
}

function getNeighbors(index: number, columns: number, rows: number) {
  const column = Math.floor(index / rows);
  const row = index % rows;
  const neighbors: number[] = [];

  if (row > 0) neighbors.push(index - 1);
  if (row < rows - 1) neighbors.push(index + 1);
  if (column > 0) neighbors.push(index - rows);
  if (column < columns - 1) neighbors.push(index + rows);

  return neighbors;
}

/**
 * Builds a randomized depth-first walk through a column-major grid.
 *
 * The walk starts and ends on the top or bottom edge, visits every cell, and
 * only moves between orthogonally adjacent cells. Returning along the spanning
 * tree makes the snake's exit continuous without teleporting across the grid.
 */
export function createRandomHeatmapWalk(
  columns: number,
  rows: number,
  random: RandomSource = Math.random,
) {
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new RangeError('Heatmap dimensions must be positive integers.');
  }

  const startColumn = getRandomIndex(columns, random);
  const startRow = getRandomIndex(2, random) === 0 ? 0 : rows - 1;
  const startIndex = startColumn * rows + startRow;
  const visited = new Set<number>([startIndex]);
  const walk = [startIndex];
  const stack = [
    {
      index: startIndex,
      neighbors: shuffle(getNeighbors(startIndex, columns, rows), random),
    },
  ];

  while (stack.length > 0) {
    const current = stack.at(-1)!;
    const next = current.neighbors.pop();

    if (next === undefined) {
      stack.pop();
      if (stack.length > 0) walk.push(stack.at(-1)!.index);
      continue;
    }

    if (visited.has(next)) continue;

    visited.add(next);
    walk.push(next);
    stack.push({
      index: next,
      neighbors: shuffle(getNeighbors(next, columns, rows), random),
    });
  }

  return walk;
}
