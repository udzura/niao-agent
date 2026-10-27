export async function authenticated(request: Request, secret?: string): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const value = request.headers.get("Authorization");
  if (!value?.startsWith("Bearer ") || value.length > 1024) return false;
  const bytes = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", bytes.encode(value.slice(7))),
    crypto.subtle.digest("SHA-256", bytes.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
