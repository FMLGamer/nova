/** Forgiving text search for settings: every word of the query has to show up, allowing a typo or two. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** True when `text` matches `query`: each query word is part of the text, or close to the start of one of its words. */
export function fuzzyMatch(text: string, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  const t = norm(text);
  const words = t.split(' ');
  return q.split(' ').every((w) => {
    if (t.includes(w)) return true;
    const slack = w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0;
    return slack > 0 && words.some((x) => distance(w, x.slice(0, w.length)) <= slack || distance(w, x) <= slack);
  });
}
