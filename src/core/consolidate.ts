import { cosine } from './retrieval'

/**
 * Groups of notes that say nearly the same thing, largest first. Each note joins the first group
 * whose seed it closely matches, so a group never chains loosely related notes together.
 */
export function nearDuplicates(items: { path: string; vec: number[] }[], min = 0.86): string[][] {
  const groups: { seed: number[]; paths: string[] }[] = []
  for (const it of items) {
    const g = groups.find((x) => cosine(x.seed, it.vec) >= min)
    if (g) g.paths.push(it.path)
    else groups.push({ seed: it.vec, paths: [it.path] })
  }
  return groups
    .map((g) => g.paths)
    .filter((p) => p.length > 1)
    .sort((a, b) => b.length - a.length)
}
