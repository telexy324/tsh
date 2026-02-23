export type AuthMethod =
  | { kind: "password"; password: string }
  | { kind: "privateKey"; privateKeyPath: string; passphrase?: string };

export interface ConnectRequest {
  label?: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
}

export interface SessionInfo {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  connectedAt: string;
  lastActiveAt: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "unknown";
  size?: number;
  permissions?: number;
  modifiedAt?: number;
}
