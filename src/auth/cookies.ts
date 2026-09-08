export function setCookieValues(headers: Headers): string[] {
  return (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
}
