export type AuthMethod = "password" | "pin";

export interface AuthStatus {
  enabled: boolean;
  setupComplete: boolean;
  method: AuthMethod | null;
  authenticated: boolean;
}

export interface AuthSetupRequest {
  method: AuthMethod;
  username?: string;
  password?: string;
  pin?: string;
}

export interface AuthSetupResponse {
  recoveryKey: string;
}

export interface AuthLoginRequest {
  username?: string;
  password?: string;
  pin?: string;
}

export interface AuthLoginResponse {
  expiresAt: string;
}

export interface AuthRecoverRequest {
  recoveryKey: string;
  method: AuthMethod;
  username?: string;
  password?: string;
  pin?: string;
}

export interface AuthRecoverResponse {
  recoveryKey: string;
}

export interface AuthSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  lastActiveAt: string;
  current?: boolean;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateApiKeyRequest {
  name: string;
  expiresInDays?: number;
}

export interface CreateApiKeyResponse {
  id: string;
  key: string;
  prefix: string;
  name: string;
}
