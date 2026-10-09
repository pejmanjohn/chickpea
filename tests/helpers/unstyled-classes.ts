/** Class names a page's markup uses that no selector in the page's own styles mentions. */
export function unstyledClasses(html: string): string[] {
  const styled = new Set(styledClasses(html));
  return markupClasses(html).filter((name) => !styled.has(name)).sort();
}

/** Class names the pages' styles mention that no page's markup uses. */
export function unusedStyledClasses(pages: readonly string[]): string[] {
  const used = new Set(pages.flatMap(markupClasses));
  const styled = new Set(pages.flatMap(styledClasses));
  return [...styled].filter((name) => !used.has(name)).sort();
}

function styledClasses(html: string): string[] {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(([, css]) => css).join('\n');
  return [...styles.replace(/url\([^)]*\)/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(([, name]) => name!);
}

function markupClasses(html: string): string[] {
  const markup = html.replace(/<style[^>]*>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>/g, '');
  return [...new Set(
    [...markup.matchAll(/\sclass="([^"]*)"/g)].flatMap(([, names]) => names!.split(/\s+/).filter(Boolean)),
  )];
}
