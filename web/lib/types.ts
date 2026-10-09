/** Shared API types — mirror the FastAPI response shapes. */

export type Role = "admin" | "member";
export type Visibility = "org" | "department" | "restricted";

export interface User {
  id: string;
  username: string;
  role: Role;
  tenant_id: string;
  department: string;
  employee_id?: string | null;
  tenant_name?: string;
}

export interface Session {
  token: string;
  user: User;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  created: string;
  documents: number;
  members: number;
}

export interface Doc {
  id: string;
  filename: string;
  visibility: Visibility;
  department: string;
  chunks: number;
  created: string;
  uploaded_by: string;
  allowed_user_ids?: string[];
}

export interface Citation {
  doc_id?: string;
  filename: string;
  page: number;
  snippet?: string;
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  grounded: boolean;
  confidence?: number;
  provider?: string | null;
  latency_ms?: number;
  conversation_id: string;
  trace?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  created: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  grounded?: boolean;
  confidence?: number;
  provider?: string | null;
  latency_ms?: number;
}

export interface AdminUser {
  id: string;
  username: string;
  role: Role;
  department: string;
  employee_id?: string | null;
  created: string;
}

export interface Invite {
  code: string;
  role: Role;
  department: string;
  expires: string;
  used_by?: string | null;
  joined_by?: string | null;
}

export interface AuditEntry {
  created: string;
  action: string;
  detail: string;
  username: string;
}

export interface Stats {
  users: number;
  documents: number;
  queries: number;
  chunks: number;
}

export interface Providers {
  llm: string[];
  embeddings: boolean;
}
