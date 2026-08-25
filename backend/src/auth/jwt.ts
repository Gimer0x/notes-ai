import { sign, verify, type JwtPayload } from 'jsonwebtoken';

const JWT_EXPIRES = '7d';

export function signUserToken(userId: string, secret: string): string {
  return sign({ sub: userId }, secret, { expiresIn: JWT_EXPIRES });
}

export function verifyUserToken(token: string, secret: string): string | null {
  try {
    const payload = verify(token, secret) as JwtPayload;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
