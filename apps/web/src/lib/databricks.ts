export function normalizeDatabricksHost(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
