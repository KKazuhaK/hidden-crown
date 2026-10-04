// Automated tests need explicit admin credentials; none are embedded in production files.
export async function adminHeaders(base) {
  if (!process.env.HIDDEN_CROWN_ADMIN_PASSWORD) throw new Error('Set HIDDEN_CROWN_ADMIN_PASSWORD to run admin-backed integration tests against the self-hosted server');
  const response = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.HIDDEN_CROWN_ADMIN_USERNAME ?? 'admin', password: process.env.HIDDEN_CROWN_ADMIN_PASSWORD }) });
  if (!response.ok) throw new Error(`Test admin login failed: ${response.status}`);
  return { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: base };
}
