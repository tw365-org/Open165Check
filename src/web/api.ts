export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message ?? '服務暫時無法使用');
  return data;
}
