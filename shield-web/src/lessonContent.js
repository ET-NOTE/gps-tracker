// Keep old tutorial bookmarks usable while the complete, downloadable editions are published.
const replacements = {
  dht11: "shield-uno-dht11",
  gnss: "shield-uno-gnss",
  upload: "shield-uno-first-upload",
  status: "shield-uno-connect",
};
export function lessonReplacement(id, posts) {
  // A later administrator edit takes precedence over this migration of untouched seed content.
  if (posts.some((p) => p.id === id && p.revision > 1)) return null;
  const target = replacements[id];
  return target && posts.some((p) => p.id === target && (p.kind || "example") === "example")
    ? target : null;
}
export function visibleLessons(posts) {
  return posts.filter((p) => !lessonReplacement(p.id, posts));
}
export function featuredLessons(posts, guide) {
  return visibleLessons(posts)
    .filter((p) => (p.kind || "example") === "example")
    .sort((a, b) => (b.id === guide) - (a.id === guide)
      || Number(Boolean(b.attachments?.length)) - Number(Boolean(a.attachments?.length)));
}
export function lessonLinks(text) {
  const parts = [];
  const pattern = /\[([^\]\n]{1,120})\]\(([^()\s]+)\)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) parts.push({ text: text.slice(start, match.index) });
    const href = match[2];
    let safe = /^\/(?!\/)/.test(href) && !/[\\\u0000-\u0020]/.test(href);
    if (/^https:\/\//i.test(href)) {
      try { const url = new URL(href); safe = !url.username && !url.password && !href.includes('\\'); }
      catch { safe = false; }
    }
    parts.push(safe ? { text: match[1], href } : { text: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) parts.push({ text: text.slice(start) });
  return parts;
}
