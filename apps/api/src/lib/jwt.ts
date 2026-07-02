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
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, SECRET) as AuthTokenPayload;
}
