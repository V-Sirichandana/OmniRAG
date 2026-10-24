/** Shared API types — mirror the FastAPI response shapes. */

export type Role = "admin" | "member";
export type Visibility =
  | "org" // legacy alias — behaves like "department"
  | "department"
  | "organization"
  | "selected_departments"
  | "restricted";

export interface User {
  id: string;
  username: string;
  /** Work email (optional) — null/absent for username-only accounts. */
  email?: string | null;
  role: Role;
  tenant_id: string;
  department: string;
  employee_id?: string | null;
  tenant_name?: string;
  /** Manager designation (backend-enforced workspace gate, default 0/false).
   *  Grants no extra data — only access to the Team workspace UI/API. */
  is_manager?: number | boolean;
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

export interface DocTarget {
  id: string;
  name: string;
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
  download_allowed?: boolean;
  departments?: DocTarget[];
}

export interface ChatResponse {
  answer: string;
  latency_ms?: number;
  conversation_id: string;
}

export interface Conversation {
  id: string;
  title: string;
  created: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface AdminUser {
  id: string;
  username: string;
  /** Work email (optional) — null/absent for username-only accounts. */
  email?: string | null;
  role: Role;
  department: string;
  employee_id?: string | null;
  is_manager?: number | boolean;
  created: string;
  full_name?: string | null;
  employment_type?: string;
  agreement_start?: string | null;
  agreement_end?: string | null;
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
  /** stored bytes across this tenant's documents (SUM of file content) */
  storage?: number;
}

/** GET /api/team/overview — department data for designated managers only. */
export interface TeamOverview {
  department: string;
  member_count: number;
  document_count: number;
  documents: Doc[];
}

export interface Providers {
  llm: string[];
  embeddings: boolean;
}
