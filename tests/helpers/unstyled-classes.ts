/** Class names a page's markup uses that no selector in the page's own styles mentions. */
export function unstyledClasses(html: string): string[] {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(([, css]) => css).join('\n');
  const markup = html.replace(/<style[^>]*>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>/g, '');
  const used = new Set(
    [...markup.matchAll(/\sclass="([^"]*)"/g)].flatMap(([, names]) => names!.split(/\s+/).filter(Boolean)),
  );
  const styled = new Set([...styles.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(([, name]) => name));
  return [...used].filter((name) => !styled.has(name)).sort();
}
