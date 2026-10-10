/** One value per process, kept across Next.js dev reloads. */
export function once<T>(name: string, make: () => T): T {
  const store = globalThis as unknown as Record<string, T | undefined>;
  return (store[`__pap_${name}`] ??= make());
}
