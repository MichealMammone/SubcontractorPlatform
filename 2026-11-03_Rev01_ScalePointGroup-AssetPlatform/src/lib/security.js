// Password hashing (scrypt, built into Node - no native add-ons), tokens and password policy.
import crypto from 'node:crypto';

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// A fixed dummy hash, verified on unknown emails so response time does not reveal which accounts exist.
let dummyHash = null;
export async function burnPasswordCheck(password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function passwordProblems(password, email) {
  const p = String(password || '');
  const out = [];
  if (p.length < 12) out.push('at least 12 characters');
  if (p.length > 200) out.push('no more than 200 characters');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  if (classes < 3) out.push('at least three of: lower-case, upper-case, number, symbol');
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && p.toLowerCase().includes(local)) out.push('must not contain your email name');
  if (/^(password|qwerty|letmein|welcome|changeme)/i.test(p)) out.push('must not start with a common word');
  return out;
}

// Readable temporary password that satisfies the policy.
export function temporaryPassword() {
  const words = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
  return 'Spg-' + words.slice(0, 6) + '-' + crypto.randomInt(10, 99) + words.slice(6).toUpperCase();
}
