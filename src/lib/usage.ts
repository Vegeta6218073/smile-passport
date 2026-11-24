// Usage analytics (roadmap #27) record route patterns only: ids, queries and anything else that
// could point at a patient are removed before an event leaves the browser.
export function routePattern(pathname: string): string | null {
  const clean = pathname.split(/[?#]/)[0].toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '[id]')
    .replace(/\/\d+(?=\/|$)/g, '/[n]');
  return /^\/[a-z0-9/_\[\]-]{0,80}$/.test(clean) ? clean : null;
}
