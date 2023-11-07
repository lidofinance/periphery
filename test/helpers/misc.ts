export async function promiseAllValues(obj: { [key: string]: Promise<unknown> }) {
  return await Promise.all(Object.entries(obj).map(async ([k, v]) => [k, await v])).then(Object.fromEntries);
}
