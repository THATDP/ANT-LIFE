import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export class SessionManager {
  constructor(private readonly secret: string, private readonly inviteCode: string) {}

  verifyInvite(candidate: string): boolean {
    if (typeof candidate !== 'string' || candidate.length > 256) return false;
    const expected = sign(this.inviteCode, this.secret);
    const actual = sign(candidate, this.secret);
    return timingSafeEqual(expected, actual) && candidate === this.inviteCode;
  }

  issue(playerId: string = randomUUID(), now = Date.now()): { playerId: string; token: string } {
    const payload = Buffer.from(`${playerId}.${now + SESSION_TTL_MS}`).toString('base64url');
    const signature = sign(payload, this.secret).toString('base64url');
    return { playerId, token: `${payload}.${signature}` };
  }

  verify(token: string | undefined, now = Date.now()): string | null {
    if (!token || token.length > 512) return null;
    const separator = token.lastIndexOf('.');
    if (separator < 1) return null;
    const payload = token.slice(0, separator);
    const supplied = Buffer.from(token.slice(separator + 1), 'base64url');
    const expected = sign(payload, this.secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

    try {
      const decoded = Buffer.from(payload, 'base64url').toString('utf8');
      const splitAt = decoded.lastIndexOf('.');
      const playerId = decoded.slice(0, splitAt);
      const expiresAt = Number(decoded.slice(splitAt + 1));
      if (!playerId || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
      return playerId;
    } catch {
      return null;
    }
  }
}

export function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const nickname = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (nickname.length < 2 || nickname.length > 18) return null;
  if (!/^[\p{L}\p{N}_ -]+$/u.test(nickname)) return null;
  return nickname;
}
