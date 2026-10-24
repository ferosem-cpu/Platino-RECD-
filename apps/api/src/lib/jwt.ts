import jwt from "jsonwebtoken";

// No fallback secret: a hardcoded default means anyone who has read the source can forge
// tokens (including super_admin) against any deployment that forgot to set JWT_SECRET. Fail
// loudly at startup instead so a misconfigured deploy never silently signs with a known key.
function requireSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Refusing to start with an insecure default - set a long random JWT_SECRET.",
    );
  }
  return secret;
}
const SECRET: string = requireSecret();
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

export interface AuthTokenPayload {
  userId: string;
  roleKey: string;
  customerId?: string | null;
  /** The user's tokenVersion when this token was issued (absent on tokens issued before revocation existed = 0). Not a credential. */
  tv?: number;
}

/** `tokenVersion` is the user's current User.tokenVersion; a later security-sensitive change bumps it and so revokes this token. */
export function signToken(payload: Omit<AuthTokenPayload, "tv"> & { tokenVersion?: number | null }): string {
  const { tokenVersion, ...rest } = payload;
  return jwt.sign({ ...rest, tv: tokenVersion ?? 0 }, SECRET, { expiresIn: EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, SECRET) as AuthTokenPayload;
}
