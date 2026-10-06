export const emptyLibraryOrder = { categories: [], lessons: {} };
export const categoryName = (post) => post.category?.trim() || "기타";

// Keep newly published items in their existing fallback order after saved items.
export function sortByOrder(items, ids = [], key = item => item.id) {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(key(a)) ?? Infinity) - (rank.get(key(b)) ?? Infinity));
}
export function sortLessons(items, order = emptyLibraryOrder) {
  const categories = sortByOrder([...new Set(items.map(categoryName))], order.categories, name => name);
  return categories.flatMap(name => sortByOrder(items.filter(p => categoryName(p) === name), order.lessons[name]));
}
export function moveItem(items, from, to) {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]); return next;
}
