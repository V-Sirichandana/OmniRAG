import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  Lock,
  Globe,
  Upload,
  Send,
  MessageSquare,
  FileText,
  Users,
  Settings,
  LogOut,
  ChevronRight,
  Trash2,
  Plus,
  CheckCircle2,
  Building,
  Activity,
  Layers,
  Search,
  Copy,
  Check,
  X,
  Briefcase,
  Code,
  DollarSign,
  TrendingUp,
  Folder,
  ArrowUpRight,
  Languages,
  RefreshCw,
  Key,
} from 'lucide-react';

interface User {
  id: string;
  username: string;
  role: 'admin' | 'member';
  tenant_id: string;
  tenant_name: string;
  department_id?: string;
  department_name?: string;
}

interface Department {
  id: string;
  tenant_id: string;
  name: string;
  code: string;
  description: string;
  icon: string;
  doc_count?: number;
  user_count?: number;
}

interface Citation {
  n: number;
  filename: string;
  page: number;
  department_name?: string;
  snippet: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  grounded?: boolean;
  confidence?: number;
}

interface ConversationItem {
  id: string;
  title: string;
  created: string;
}

interface DocumentItem {
  id: string;
  filename: string;
  department_id: string;
  department_name: string;
  department_code: string;
  visibility: 'org' | 'restricted';
  chunks: number;
  created: string;
  uploaded_by: string;
  allowed_user_ids?: string[];
}

interface AdminUser {
  id: string;
  username: string;
  role: 'admin' | 'member';
  department_id?: string;
  department_name?: string;
  department_code?: string;
  employee_id?: string;
  created: string;
}

interface AdminInvite {
  code: string;
  role: 'admin' | 'member';
  department_id?: string;
  department_name?: string;
  department_code?: string;
  created?: string;
  expires: string;
  used_by: string | null;
  used_by_name?: string | null;
}

interface AuditLog {
  id: number;
  created: string;
  action: string;
  detail: string;
  username: string;
}

interface AdminStats {
  users: number;
  departments: number;
  documents: number;
  chunks: number;
  queries: number;
}

const DEPT_ICONS: Record<string, React.ElementType> = {
  Users,
  Code,
  DollarSign,
  Shield,
  TrendingUp,
  Briefcase,
  Building,
  Folder,
};

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('omnirag_token'));
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);

  // Tabs / Navigation
  const [activeTab, setActiveTab] = useState<'ask' | 'departments' | 'library' | 'admin'>('ask');

  // Department Filter in Chat & Library
  const [departmentsList, setDepartmentsList] = useState<Department[]>([]);
  const [selectedDeptFilter, setSelectedDeptFilter] = useState<string>('all');

  // Chat State
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeCid, setActiveCid] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputQuery, setInputQuery] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Active Selected Citation (Slide-over drawer)
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null);

  // Multi-Language State (Default: English, + Spanish, Hindi, French)
  const [selectedLanguage, setSelectedLanguage] = useState<'English' | 'Spanish' | 'Hindi' | 'French'>('English');

  // Library State
  const [documentsList, setDocumentsList] = useState<DocumentItem[]>([]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadDepartment, setUploadDepartment] = useState<string>('dept_hr');
  const [uploadVisibility, setUploadVisibility] = useState<'org' | 'restricted'>('org');
  const [uploadAllowedUsers, setUploadAllowedUsers] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [librarySuccess, setLibrarySuccess] = useState<string | null>(null);

  // Admin State
  const [adminStats, setAdminStats] = useState<AdminStats | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminInvites, setAdminInvites] = useState<AdminInvite[]>([]);
  const [adminAudit, setAdminAudit] = useState<AuditLog[]>([]);
  const [newInviteRole, setNewInviteRole] = useState<'member' | 'admin'>('member');
  const [newInviteDept, setNewInviteDept] = useState<string>('dept_hr');
  const [newInviteDays, setNewInviteDays] = useState(7);
  const [createdInviteCode, setCreatedInviteCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Create Department Modal
  const [showNewDeptModal, setShowNewDeptModal] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptCode, setNewDeptCode] = useState('');
  const [newDeptDesc, setNewDeptDesc] = useState('');
  const [newDeptIcon, setNewDeptIcon] = useState('Folder');

  // Auth Forms State
  const [authMode, setAuthMode] = useState<'signin' | 'join' | 'signup_org'>('signin');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [authOrgName, setAuthOrgName] = useState('');
  const [authPrimaryDept, setAuthPrimaryDept] = useState('Engineering & Tech');
  const [authInviteCode, setAuthInviteCode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  // Change Password Modal
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');
  const [pwModalMsg, setPwModalMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  // API Call helper
  async function apiCall(method: string, path: string, body?: any, isFormData = false) {
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`/api${path}`, {
      method,
      headers: isFormData ? (token ? { Authorization: `Bearer ${token}` } : {}) : headers,
      body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
    });

    if (res.status === 401 && token) {
      handleSignOut();
      throw new Error('Session expired. Please sign in again.');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'Request failed');
    }
    return data;
  }

  // Load session
  useEffect(() => {
    if (!token) {
      setLoadingAuth(false);
      return;
    }
    apiCall('GET', '/auth/me')
      .then((user) => {
        setCurrentUser(user);
        setLoadingAuth(false);
      })
      .catch(() => {
        handleSignOut();
        setLoadingAuth(false);
      });
  }, [token]);

  // Load initial data on user login
  useEffect(() => {
    if (currentUser) {
      loadDepartments();
      loadConversations();
      loadDocuments();
      if (currentUser.role === 'admin') {
        loadAdminData();
      } else {
        // Enforce member restrictions: cannot view departments or admin tab
        if (activeTab === 'departments' || activeTab === 'admin') {
          setActiveTab('ask');
        }
        if (currentUser.department_id) {
          setSelectedDeptFilter(currentUser.department_id);
        }
      }
    }
  }, [currentUser, activeTab]);

  // Auto scroll in chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAsking]);

  const loadDepartments = async () => {
    try {
      const data = await apiCall('GET', '/departments');
      setDepartmentsList(data);
      if (data.length > 0 && !uploadDepartment) {
        setUploadDepartment(data[0].id);
      }
    } catch (e) {
      // ignore
    }
  };

  const loadConversations = async () => {
    try {
      const data = await apiCall('GET', '/conversations');
      setConversations(data);
    } catch (e) {
      // ignore
    }
  };

  const loadDocuments = async (deptFilter?: string) => {
    try {
      const queryParam = deptFilter && deptFilter !== 'all' ? `?department_id=${deptFilter}` : '';
      const data = await apiCall('GET', `/documents${queryParam}`);
      setDocumentsList(data);
    } catch (e) {
      // ignore
    }
  };

  const loadAdminData = async () => {
    try {
      const [stats, users, invites, audit] = await Promise.all([
        apiCall('GET', '/admin/stats'),
        apiCall('GET', '/admin/users'),
        apiCall('GET', '/admin/invites'),
        apiCall('GET', '/admin/audit'),
      ]);
      setAdminStats(stats);
      setAdminUsers(users);
      setAdminInvites(invites);
      setAdminAudit(audit);
    } catch (e) {
      // ignore
    }
  };

  const handleSignOut = () => {
    localStorage.removeItem('omnirag_token');
    setToken(null);
    setCurrentUser(null);
    setActiveCid(null);
    setMessages([]);
    setConversations([]);
    setDocumentsList([]);
    setDepartmentsList([]);
    setAdminStats(null);
    setAdminUsers([]);
    setAdminInvites([]);
    setAdminAudit([]);
    setSelectedDeptFilter('all');
    setActiveTab('ask');
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (authMode !== 'signin') {
      if (authPassword !== authConfirmPassword) {
        setAuthError('Passwords do not match. Please verify your password confirmation.');
        return;
      }
      if (authPassword.length < 6) {
        setAuthError('Password must be at least 6 characters long.');
        return;
      }
    }

    try {
      let res;
      if (authMode === 'signin') {
        res = await apiCall('POST', '/auth/login', { username: authUsername, password: authPassword });
      } else if (authMode === 'join') {
        res = await apiCall('POST', '/auth/register', {
          username: authUsername,
          password: authPassword,
          invite_code: authInviteCode,
        });
      } else {
        res = await apiCall('POST', '/auth/signup-org', {
          org_name: authOrgName,
          username: authUsername,
          password: authPassword,
          department_name: authPrimaryDept,
        });
      }

      // Pristine state initialization on login
      setActiveCid(null);
      setMessages([]);
      setConversations([]);
      setDocumentsList([]);
      setDepartmentsList([]);
      setAdminStats(null);
      setAdminUsers([]);
      setAdminInvites([]);
      setAdminAudit([]);

      localStorage.setItem('omnirag_token', res.token);
      setToken(res.token);
      setCurrentUser(res.user);
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwModalMsg(null);
    if (newPw !== confirmNewPw) {
      setPwModalMsg({ type: 'error', text: 'New passwords do not match' });
      return;
    }
    if (newPw.length < 6) {
      setPwModalMsg({ type: 'error', text: 'New password must be at least 6 characters' });
      return;
    }
    setPwLoading(true);
    try {
      await apiCall('POST', '/auth/change-password', {
        currentPassword: currentPw,
        newPassword: newPw,
      });
      setPwModalMsg({ type: 'success', text: 'Password successfully updated!' });
      setCurrentPw('');
      setNewPw('');
      setConfirmNewPw('');
      setTimeout(() => {
        setShowPasswordModal(false);
        setPwModalMsg(null);
      }, 1500);
    } catch (err: any) {
      setPwModalMsg({ type: 'error', text: err.message || 'Failed to update password' });
    } finally {
      setPwLoading(false);
    }
  };

  const selectConversation = async (cid: string) => {
    setActiveCid(cid);
    try {
      const history = await apiCall('GET', `/conversations/${cid}`);
      setMessages(history);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const deleteConversation = async (e: React.MouseEvent, cid: string) => {
    e.stopPropagation();
    try {
      await apiCall('DELETE', `/conversations/${cid}`);
      setConversations((prev) => prev.filter((c) => c.id !== cid));
      if (activeCid === cid) {
        setActiveCid(null);
        setMessages([]);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const startNewConversation = () => {
    setActiveCid(null);
    setMessages([]);
  };

  const handleAskQuestion = async (e?: React.FormEvent, customQuery?: string) => {
    if (e) e.preventDefault();
    const query = customQuery || inputQuery;
    if (!query.trim() || isAsking) return;

    const userMessage: Message = { role: 'user', content: query };
    setMessages((prev) => [...prev, userMessage]);
    setInputQuery('');
    setIsAsking(true);

    try {
      const res = await apiCall('POST', '/chat', {
        question: query,
        conversation_id: activeCid,
        department_id: currentUser?.role === 'admin' 
          ? (selectedDeptFilter === 'all' ? null : selectedDeptFilter)
          : (currentUser?.department_id || null),
        language: selectedLanguage,
      });

      if (!activeCid) {
        setActiveCid(res.conversation_id);
        loadConversations();
      }

      const assistantMessage: Message = {
        role: 'assistant',
        content: res.answer,
        citations: res.citations,
        grounded: res.grounded,
        confidence: res.confidence,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Could not retrieve an answer: ${err.message}`,
        },
      ]);
    } finally {
      setIsAsking(false);
    }
  };

  const handleSyncDrive = async () => {
    setIsSyncingDrive(true);
    setLibrarySuccess(null);
    setLibraryError(null);
    try {
      const res = await apiCall('POST', '/documents/sync');
      setLibrarySuccess(res.message || 'Successfully synchronized with Google Drive and OneDrive.');
      loadDocuments();
      loadAdminData();
    } catch (err: any) {
      setLibraryError(err.message || 'Failed to sync with cloud storage.');
    } finally {
      setIsSyncingDrive(false);
    }
  };

  const handleFileUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile) return;

    setLibraryError(null);
    setLibrarySuccess(null);
    setIsUploading(true);

    const formData = new FormData();
    formData.append('file', uploadFile);
    formData.append('department_id', uploadDepartment);
    formData.append('visibility', uploadVisibility);
    formData.append('allowed_user_ids', uploadAllowedUsers.join(','));

    try {
      const res = await apiCall('POST', '/documents', formData, true);
      setLibrarySuccess(`Indexed "${res.filename}" into ${res.chunks} passages.`);
      setUploadFile(null);
      setUploadAllowedUsers([]);
      loadDocuments();
      loadDepartments();
      if (currentUser?.role === 'admin') loadAdminData();
    } catch (err: any) {
      setLibraryError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    if (!confirm('Are you sure you want to delete this document?')) return;
    try {
      await apiCall('DELETE', `/documents/${docId}`);
      loadDocuments();
      loadDepartments();
      if (currentUser?.role === 'admin') loadAdminData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeptName || !newDeptCode) return;
    try {
      await apiCall('POST', '/departments', {
        name: newDeptName,
        code: newDeptCode,
        description: newDeptDesc,
        icon: newDeptIcon,
      });
      setShowNewDeptModal(false);
      setNewDeptName('');
      setNewDeptCode('');
      setNewDeptDesc('');
      loadDepartments();
      if (currentUser?.role === 'admin') loadAdminData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiCall('POST', '/admin/invites', {
        role: newInviteRole,
        department_id: newInviteDept,
        days: newInviteDays,
      });
      setCreatedInviteCode(res.code);
      setCopiedCode(false);
      loadAdminData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateUser = async (userId: string, role?: 'member' | 'admin', department_id?: string) => {
    try {
      await apiCall('PATCH', `/admin/users/${userId}`, { role, department_id });
      loadAdminData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRemoveUser = async (userId: string) => {
    if (!confirm('Are you sure you want to remove this user from the organization?')) return;
    try {
      await apiCall('DELETE', `/admin/users/${userId}`);
      loadAdminData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const copyText = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // Helper to render text with clickable citation markers [1], [2]
  const renderFormattedAnswer = (text: string, citations?: Citation[]) => {
    if (!citations || citations.length === 0) {
      return <span>{text}</span>;
    }

    // Replace [1], [2] or 【1】 with clickable chips
    const parts = text.split(/(\[\d+\]|【\d+】)/g);
    return (
      <span>
        {parts.map((part, i) => {
          const match = part.match(/\d+/);
          if (match) {
            const num = parseInt(match[0], 10);
            const foundCit = citations.find((c) => c.n === num);
            return (
              <button
                key={i}
                type="button"
                onClick={() => foundCit && setSelectedCitation(foundCit)}
                className="inline-flex items-center justify-center font-mono font-bold text-[11px] text-indigo-400 bg-indigo-500/15 hover:bg-indigo-500/30 px-1.5 py-0.5 mx-0.5 rounded cursor-pointer transition-colors align-baseline"
                title={foundCit ? `${foundCit.filename} (p. ${foundCit.page})` : `Source ${num}`}
              >
                [{num}]
              </button>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </span>
    );
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Authentication Screen
  // ───────────────────────────────────────────────────────────────────────────

  if (loadingAuth) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-white">
        <div className="flex flex-col items-center gap-3">
          <Shield className="h-8 w-8 text-indigo-400 animate-pulse" />
          <p className="text-xs text-slate-400">Loading OmniRAG Knowledge Platform...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <div className="inline-flex p-3 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 mb-3">
              <Shield className="h-7 w-7" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">OmniRAG</h1>
            <p className="text-xs text-slate-400 mt-1.5">
              Enterprise Knowledge Base with Cross-Department Retrieval & Strict Citations
            </p>
          </div>

          <div className="flex border-b border-slate-800 mb-6">
            <button
              onClick={() => { setAuthMode('signin'); setAuthError(null); }}
              className={`flex-1 pb-3 text-xs font-semibold border-b-2 transition-colors ${
                authMode === 'signin' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Sign in
            </button>
            <button
              onClick={() => { setAuthMode('join'); setAuthError(null); }}
              className={`flex-1 pb-3 text-xs font-semibold border-b-2 transition-colors ${
                authMode === 'join' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Join with Employee ID
            </button>
            <button
              onClick={() => { setAuthMode('signup_org'); setAuthError(null); }}
              className={`flex-1 pb-3 text-xs font-semibold border-b-2 transition-colors ${
                authMode === 'signup_org' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Create Organization
            </button>
          </div>

          {authError && (
            <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
              {authError}
            </div>
          )}

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            {authMode === 'signup_org' && (
              <>
                <div className="p-3 rounded-xl bg-indigo-950/40 border border-indigo-500/30 text-indigo-300 text-xs">
                  <div className="font-semibold text-white flex items-center gap-1.5 mb-0.5">
                    <Building className="h-4 w-4 text-indigo-400" />
                    New Company Workspace
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Sets up a tenant workspace with department data isolation and creates your Master Administrator account.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Company / Organization Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Acme Corporation or Apex Technologies"
                    value={authOrgName}
                    onChange={(e) => setAuthOrgName(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Primary Department</label>
                  <select
                    value={authPrimaryDept}
                    onChange={(e) => setAuthPrimaryDept(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="Engineering & Tech">Engineering & Tech</option>
                    <option value="Human Resources">Human Resources</option>
                    <option value="Finance & Operations">Finance & Operations</option>
                    <option value="Legal & Compliance">Legal & Compliance</option>
                    <option value="Product & Design">Product & Design</option>
                    <option value="Headquarters & Exec">Headquarters & Exec</option>
                  </select>
                </div>
              </>
            )}

            {authMode === 'join' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Company Employee ID</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. ENG-366399 or EMP-1001"
                  value={authInviteCode}
                  onChange={(e) => setAuthInviteCode(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono tracking-wider"
                />
                <span className="text-[10px] text-slate-400 mt-1 block">
                  Enter the Employee ID issued by your company Admin. (Demo IDs: <span className="text-indigo-400 font-mono">EMP-1001</span> to <span className="text-indigo-400 font-mono">EMP-1005</span>)
                </span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                {authMode === 'signup_org' ? 'Master Admin Username' : 'Username'}
              </label>
              <input
                type="text"
                required
                placeholder={authMode === 'signup_org' ? 'admin_username' : 'Choose your username'}
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-300">
                  {authMode === 'signin' ? 'Password' : 'Create Your Password (Choose your own)'}
                </label>
                {authMode !== 'signin' && (
                  <span className="text-[10px] text-indigo-400 font-medium">Confidential</span>
                )}
              </div>
              <input
                type="password"
                required
                placeholder={authMode === 'signin' ? 'Enter password' : 'Create a secure password (min 6 chars)'}
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            {authMode !== 'signin' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Confirm Password</label>
                <input
                  type="password"
                  required
                  placeholder="Re-enter your password to confirm"
                  value={authConfirmPassword}
                  onChange={(e) => setAuthConfirmPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                {authPassword && authConfirmPassword && authPassword !== authConfirmPassword && (
                  <p className="text-[10px] text-rose-400 mt-1">Passwords do not match</p>
                )}
                {authPassword && authConfirmPassword && authPassword === authConfirmPassword && (
                  <p className="text-[10px] text-emerald-400 mt-1 flex items-center gap-1">
                    <Check className="h-3 w-3" /> Passwords match
                  </p>
                )}
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs transition-colors flex items-center justify-center gap-2 mt-2 cursor-pointer shadow-lg shadow-indigo-600/20"
            >
              <Lock className="h-3.5 w-3.5" />
              {authMode === 'signin' ? 'Sign in to Workspace' : authMode === 'join' ? 'Register with Employee ID' : 'Launch Organization as Admin →'}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-800 space-y-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center justify-between">
                <span>Company 1: Acme Corporation</span>
                <span className="text-[9px] font-mono text-indigo-400">Tenant A</span>
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('signin');
                    setAuthUsername('admin');
                    setAuthPassword('password123');
                  }}
                  className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 text-left transition-colors"
                >
                  <div className="text-[11px] font-semibold text-indigo-300">Admin (All)</div>
                  <div className="text-[10px] text-slate-400">admin / password123</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('signin');
                    setAuthUsername('ravi');
                    setAuthPassword('password123');
                  }}
                  className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 text-left transition-colors"
                >
                  <div className="text-[11px] font-semibold text-sky-300">Ravi (Eng)</div>
                  <div className="text-[10px] text-slate-400">ravi / password123</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('signin');
                    setAuthUsername('sarah');
                    setAuthPassword('password123');
                  }}
                  className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 text-left transition-colors"
                >
                  <div className="text-[11px] font-semibold text-emerald-300">Sarah (HR)</div>
                  <div className="text-[10px] text-slate-400">sarah / password123</div>
                </button>
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center justify-between">
                <span>Company 2: Apex Global (Isolated Tenant)</span>
                <span className="text-[9px] font-mono text-purple-400">Tenant B</span>
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('signin');
                    setAuthUsername('apex_admin');
                    setAuthPassword('password123');
                  }}
                  className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 text-left transition-colors"
                >
                  <div className="text-[11px] font-semibold text-purple-300">Apex Admin</div>
                  <div className="text-[10px] text-slate-400">apex_admin / password123</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('signin');
                    setAuthUsername('apex_dev');
                    setAuthPassword('password123');
                  }}
                  className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 text-left transition-colors"
                >
                  <div className="text-[11px] font-semibold text-amber-300">Apex Dev (Eng)</div>
                  <div className="text-[10px] text-slate-400">apex_dev / password123</div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Main Authenticated Interface
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0">
        {/* Brand */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">OmniRAG</h2>
              <p className="text-xs text-slate-400 truncate max-w-[130px] flex items-center gap-1">
                <Building className="h-3 w-3 text-slate-500 shrink-0" />
                {currentUser.tenant_name}
              </p>
            </div>
          </div>
        </div>

        {/* Navigation Links */}
        <div className="px-3 py-3 border-b border-slate-800 space-y-1">
          <button
            onClick={() => setActiveTab('ask')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'ask'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            <MessageSquare className="h-4 w-4" />
            Ask Documents
          </button>

          {currentUser.role === 'admin' && (
            <button
              onClick={() => setActiveTab('departments')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'departments'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <Building className="h-4 w-4" />
              Departments ({departmentsList.length})
            </button>
          )}

          <button
            onClick={() => setActiveTab('library')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'library'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            <FileText className="h-4 w-4" />
            {currentUser.role === 'admin' ? 'Document Library' : `${currentUser.department_name || 'My Department'} Library`}
          </button>

          {currentUser.role === 'admin' && (
            <button
              onClick={() => setActiveTab('admin')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'admin'
                  ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <Settings className="h-4 w-4" />
              Administration
            </button>
          )}
        </div>

        {/* Conversation List */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-3 pb-2 flex items-center justify-between border-b border-slate-800/40">
            <div>
              <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider block">
                {currentUser.role === 'admin' ? 'Admin Queries' : 'Private Chats'}
              </span>
              <span className="text-[10px] text-emerald-400 block font-mono">
                Isolated to {currentUser.username}
              </span>
            </div>
            <button
              onClick={startNewConversation}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors text-xs flex items-center gap-1 cursor-pointer"
              title="New chat"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 space-y-1">
            {conversations.length === 0 ? (
              <p className="text-xs text-slate-500 px-3 py-4 text-center">No conversations yet.</p>
            ) : (
              conversations.map((c) => {
                const isActive = activeCid === c.id;
                return (
                  <div
                    key={c.id}
                    onClick={() => {
                      setActiveTab('ask');
                      selectConversation(c.id);
                    }}
                    className={`group w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-slate-800 text-white font-medium'
                        : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                      <span className="truncate">{c.title}</span>
                    </div>
                    <button
                      onClick={(e) => deleteConversation(e, c.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-rose-400 transition-opacity"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* User Card */}
        <div className="p-3 border-t border-slate-800 flex items-center justify-between bg-slate-900/60">
          <div className="flex items-center gap-2 truncate">
            <div className="w-7 h-7 rounded-full bg-indigo-600/30 text-indigo-300 font-bold text-xs flex items-center justify-center uppercase shrink-0">
              {currentUser.username[0]}
            </div>
            <div className="truncate">
              <p className="text-xs font-semibold text-white truncate">{currentUser.username}</p>
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="capitalize font-semibold text-slate-300">{currentUser.role}</span>
                <span className="text-slate-500">·</span>
                {currentUser.role === 'admin' ? (
                  <span className="text-indigo-400 font-medium">All Departments</span>
                ) : (
                  <span className="text-emerald-400 truncate max-w-[85px]">{currentUser.department_name || 'My Department'}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => {
                setShowPasswordModal(true);
                setPwModalMsg(null);
                setCurrentPw('');
                setNewPw('');
                setConfirmNewPw('');
              }}
              className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-300 hover:bg-slate-800 transition-colors cursor-pointer"
              title="Change Password"
            >
              <Key className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleSignOut}
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors cursor-pointer"
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col bg-slate-950 overflow-hidden relative">
        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 1: ASK (Knowledge Q&A) */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'ask' && (
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            {/* Department Filter & Multi-Language Bar */}
            <div className="h-14 border-b border-slate-800 px-6 flex items-center justify-between bg-slate-900/40">
              <div className="flex items-center gap-2 overflow-x-auto py-1 flex-1 mr-4">
                <span className="text-xs text-slate-400 font-medium whitespace-nowrap mr-1 flex items-center gap-1.5">
                  <Building className="h-3.5 w-3.5 text-slate-500" />
                  Department:
                </span>
                {currentUser.role === 'admin' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setSelectedDeptFilter('all')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                        selectedDeptFilter === 'all'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
                      }`}
                    >
                      All Departments
                    </button>
                    {departmentsList.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setSelectedDeptFilter(d.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                          selectedDeptFilter === d.id
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
                        }`}
                      >
                        <span>{d.name}</span>
                        <span className="text-[10px] opacity-75 font-mono">({d.doc_count || 0})</span>
                      </button>
                    ))}
                  </>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-medium whitespace-nowrap">
                    <Lock className="h-3.5 w-3.5 text-indigo-400" />
                    <span>{currentUser.department_name || 'Assigned Department'}</span>
                    <span className="text-[10px] bg-indigo-600/40 text-indigo-200 px-1.5 py-0.5 rounded font-mono">
                      Department Locked (1 of 1)
                    </span>
                  </div>
                )}
              </div>

              {/* 5th Feature: Multi-Language Corporate Support */}
              <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1.5 shrink-0 shadow-sm">
                <Languages className="h-3.5 w-3.5 text-indigo-400" />
                <span className="text-[11px] text-slate-400 font-medium hidden sm:inline">Language:</span>
                <select
                  value={selectedLanguage}
                  onChange={(e) => setSelectedLanguage(e.target.value as any)}
                  className="bg-transparent text-xs text-slate-200 outline-none cursor-pointer font-medium"
                >
                  <option value="English" className="bg-slate-900 text-slate-200">English (Default)</option>
                  <option value="Spanish" className="bg-slate-900 text-slate-200">Español (Spanish)</option>
                  <option value="Hindi" className="bg-slate-900 text-slate-200">हिन्दी (Hindi)</option>
                  <option value="French" className="bg-slate-900 text-slate-200">Français (French)</option>
                </select>
              </div>
            </div>

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {messages.length === 0 ? (
                <div className="max-w-2xl mx-auto py-12 text-center">
                  <div className="inline-flex p-3 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 mb-4">
                    <Shield className="h-8 w-8" />
                  </div>
                  <h2 className="text-lg font-bold text-white mb-1.5">Ask your documents</h2>
                  <p className="text-xs text-slate-400 mb-8 max-w-md mx-auto leading-relaxed">
                    Search across human resources, engineering guidelines, finance policies, and legal standards.
                  </p>

                  {/* Curated questions matching real policies */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-left max-w-xl mx-auto">
                    {[
                      { q: 'How many casual leaves do I get?', dept: 'Human Resources' },
                      { q: 'What is our 401(k) matching and vesting schedule?', dept: 'Human Resources' },
                      { q: 'What are the mandatory password and MFA rules?', dept: 'Engineering' },
                      { q: 'What is the daily meal per diem for travel?', dept: 'Finance' },
                    ].map((item, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => handleAskQuestion(undefined, item.q)}
                        className="p-3.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-left transition-colors group flex flex-col justify-between"
                      >
                        <div className="flex items-start justify-between">
                          <span className="text-xs font-medium text-slate-200 group-hover:text-white">
                            {item.q}
                          </span>
                          <ArrowUpRight className="h-3.5 w-3.5 text-slate-500 group-hover:text-indigo-400 shrink-0 ml-2" />
                        </div>
                        <span className="text-[10px] text-slate-500 mt-2">{item.dept}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m, idx) => (
                  <div
                    key={idx}
                    className={`flex gap-3.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    {/* Bot Icon */}
                    {m.role === 'assistant' && (
                      <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0 mt-0.5">
                        <Briefcase className="h-4 w-4" />
                      </div>
                    )}

                    <div
                      className={`max-w-2xl rounded-2xl p-4.5 text-sm ${
                        m.role === 'user'
                          ? 'bg-indigo-600 text-white rounded-tr-none'
                          : 'bg-slate-900 border border-slate-800 text-slate-100 rounded-tl-none shadow-sm'
                      }`}
                    >
                      {/* Message Content */}
                      <div className="whitespace-pre-wrap leading-relaxed text-[13px]">
                        {m.role === 'assistant' ? renderFormattedAnswer(m.content, m.citations) : m.content}
                      </div>

                      {/* Clean Verification Footer (Without raw tech names or bulky debug traces) */}
                      {m.role === 'assistant' && (
                        <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {m.grounded && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Verified {m.confidence ?? 100}%
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => copyText(m.content, idx)}
                              className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                              title="Copy answer"
                            >
                              {copiedIndex === idx ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* User Icon */}
                    {m.role === 'user' && (
                      <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold uppercase">
                        {currentUser.username[0]}
                      </div>
                    )}
                  </div>
                ))
              )}

              {isAsking && (
                <div className="flex gap-3.5 items-start">
                  <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
                    <Briefcase className="h-4 w-4" />
                  </div>
                  <div className="rounded-2xl p-4 bg-slate-900 border border-slate-800 text-xs text-slate-400 flex items-center gap-2.5">
                    <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping"></span>
                    <span>Retrieving verified department passages...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <div className="p-4 border-t border-slate-800 bg-slate-900/60">
              <form onSubmit={handleAskQuestion} className="max-w-4xl mx-auto flex items-center gap-2">
                <input
                  type="text"
                  placeholder={
                    selectedDeptFilter === 'all'
                      ? 'Ask a question across all departments...'
                      : `Ask about policies in ${departmentsList.find((d) => d.id === selectedDeptFilter)?.name || 'this department'}...`
                  }
                  value={inputQuery}
                  onChange={(e) => setInputQuery(e.target.value)}
                  disabled={isAsking}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={isAsking || !inputQuery.trim()}
                  className="p-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium transition-colors shadow-sm"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 2: DEPARTMENTS VIEW */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'departments' && (
          <div className="flex-1 overflow-y-auto p-8">
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-white">Organization Departments</h1>
                  <p className="text-xs text-slate-400 mt-1">
                    Knowledge bases and team documentation organized by organizational departments.
                  </p>
                </div>
                {currentUser.role === 'admin' && (
                  <button
                    onClick={() => setShowNewDeptModal(true)}
                    className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New Department
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {departmentsList.map((d) => {
                  const IconComp = DEPT_ICONS[d.icon] || Folder;
                  return (
                    <div
                      key={d.id}
                      className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition-colors flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                            <IconComp className="h-5 w-5" />
                          </div>
                          <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                            {d.code}
                          </span>
                        </div>

                        <h3 className="text-sm font-semibold text-white mb-1.5">{d.name}</h3>
                        <p className="text-xs text-slate-400 leading-relaxed min-h-[40px]">
                          {d.description || 'No description provided.'}
                        </p>
                      </div>

                      <div className="mt-5 pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
                        <span>{d.doc_count || 0} document{d.doc_count !== 1 ? 's' : ''}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDeptFilter(d.id);
                            setActiveTab('ask');
                          }}
                          className="text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1"
                        >
                          <span>Ask Dept</span>
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 3: DOCUMENT LIBRARY */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'library' && (
          <div className="flex-1 overflow-y-auto p-8">
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-white">
                    {currentUser.role === 'admin' ? 'Document Library' : `${currentUser.department_name || 'My Department'} Library`}
                  </h1>
                  <p className="text-xs text-slate-400 mt-1">
                    {currentUser.role === 'admin'
                      ? `Organization Knowledge Base · ${currentUser.tenant_name} (Admin Oversight)`
                      : `Scoped knowledge assets and department documents for ${currentUser.department_name || 'your department'}.`}
                  </p>
                </div>
                {currentUser.role === 'admin' && (
                  <button
                    type="button"
                    onClick={handleSyncDrive}
                    disabled={isSyncingDrive}
                    className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-2 transition-colors cursor-pointer shadow-sm disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 text-sky-400 ${isSyncingDrive ? 'animate-spin' : ''}`} />
                    <span>{isSyncingDrive ? 'Syncing Cloud Storage...' : 'Sync Google Drive / OneDrive'}</span>
                  </button>
                )}
              </div>

              {currentUser.role !== 'admin' ? (
                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      <Shield className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-xs font-semibold text-white flex items-center gap-2">
                        Department Access Isolation Active
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          {currentUser.department_name || 'My Department'}
                        </span>
                      </h3>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        You can only view documents assigned to your department and approved company-wide handbooks. Confidential records from other departments (HR, Finance, Legal) are isolated and restricted.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">Administrator Department Filter:</span>
                    <span className="text-[10px] text-slate-400">
                      Viewing: {selectedDeptFilter === 'all' ? 'All Departments' : departmentsList.find(d => d.id === selectedDeptFilter)?.name || selectedDeptFilter}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                    <button
                      type="button"
                      onClick={() => { setSelectedDeptFilter('all'); loadDocuments('all'); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                        selectedDeptFilter === 'all' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      All Departments
                    </button>
                    {departmentsList.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => { setSelectedDeptFilter(d.id); loadDocuments(d.id); }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                          selectedDeptFilter === d.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                        }`}
                      >
                        {d.name} ({d.code})
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Upload Card (Admin Only) */}
              {currentUser.role === 'admin' && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                  <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
                    <Upload className="h-4 w-4 text-indigo-400" />
                    Upload & Index New Document
                  </h2>
                  <p className="text-xs text-slate-400 mb-4">
                    PDF, DOCX, PPTX, TXT, MD, CSV, JSON (up to 25MB).
                  </p>

                  {libraryError && (
                    <div className="mb-3 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                      {libraryError}
                    </div>
                  )}

                  {librarySuccess && (
                    <div className="mb-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                      <span>{librarySuccess}</span>
                    </div>
                  )}

                  <form onSubmit={handleFileUpload} className="space-y-4">
                    <div className="border-2 border-dashed border-slate-700 hover:border-slate-600 rounded-xl p-6 text-center cursor-pointer transition-colors bg-slate-950/40">
                      <input
                        type="file"
                        id="doc-file-upload"
                        onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                        className="hidden"
                      />
                      <label htmlFor="doc-file-upload" className="cursor-pointer block">
                        <Upload className="h-7 w-7 text-slate-500 mx-auto mb-2" />
                        <span className="text-xs font-medium text-indigo-400">
                          {uploadFile ? uploadFile.name : 'Choose a file or drag here'}
                        </span>
                        {uploadFile && (
                          <p className="text-[11px] text-slate-400 mt-1">
                            {(uploadFile.size / 1024).toFixed(1)} KB
                          </p>
                        )}
                      </label>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Department Selector */}
                      <div>
                        <label className="block text-xs font-medium text-slate-300 mb-1.5">
                          Department
                        </label>
                        <select
                          value={uploadDepartment}
                          onChange={(e) => setUploadDepartment(e.target.value)}
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                        >
                          {departmentsList.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name} ({d.code})
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Visibility Selector */}
                      <div>
                        <label className="block text-xs font-medium text-slate-300 mb-1.5">
                          Access Control
                        </label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setUploadVisibility('org')}
                            className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium border flex items-center justify-center gap-1.5 transition-colors ${
                              uploadVisibility === 'org'
                                ? 'bg-indigo-600/30 border-indigo-500 text-indigo-300'
                                : 'bg-slate-800 border-slate-700 text-slate-400'
                            }`}
                          >
                            <Globe className="h-3.5 w-3.5" />
                            Whole Org
                          </button>
                          <button
                            type="button"
                            onClick={() => setUploadVisibility('restricted')}
                            className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium border flex items-center justify-center gap-1.5 transition-colors ${
                              uploadVisibility === 'restricted'
                                ? 'bg-indigo-600/30 border-indigo-500 text-indigo-300'
                                : 'bg-slate-800 border-slate-700 text-slate-400'
                            }`}
                          >
                            <Lock className="h-3.5 w-3.5" />
                            Restricted
                          </button>
                        </div>
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isUploading || !uploadFile}
                      className="py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs transition-colors flex items-center gap-2"
                    >
                      {isUploading ? 'Indexing...' : 'Upload & Index Document'}
                    </button>
                  </form>
                </div>
              )}

              {/* Documents List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Indexed Documents ({documentsList.length})
                  </h2>
                </div>

                {documentsList.length === 0 ? (
                  <div className="text-center py-10 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-400">
                    No documents indexed yet.
                  </div>
                ) : (
                  documentsList.map((doc) => {
                    const isRestricted = doc.visibility === 'restricted';
                    return (
                      <div
                        key={doc.id}
                        className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between hover:border-slate-700 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`p-2.5 rounded-xl ${
                              isRestricted
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                            }`}
                          >
                            {isRestricted ? <Lock className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
                          </div>

                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-xs font-semibold text-white">{doc.filename}</h3>
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-indigo-300">
                                {doc.department_name}
                              </span>
                              {isRestricted && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                                  Restricted
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400 mt-1">
                              {doc.chunks} passage{doc.chunks !== 1 ? 's' : ''} · uploaded by {doc.uploaded_by} ·{' '}
                              {new Date(doc.created).toLocaleDateString()}
                            </p>
                          </div>
                        </div>

                        {currentUser.role === 'admin' && (
                          <button
                            onClick={() => handleDeleteDocument(doc.id)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/30 text-slate-400 hover:text-rose-400 transition-colors"
                            title="Delete Document"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 4: ADMINISTRATION (Admin Only) */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'admin' && currentUser.role === 'admin' && (
          <div className="flex-1 overflow-y-auto p-8">
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h1 className="text-xl font-bold text-white flex items-center gap-2">
                    <span>Administration</span>
                    <span className="text-[11px] font-mono font-normal bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-full">
                      Admin Portal
                    </span>
                  </h1>
                  <p className="text-xs text-slate-400 mt-1">
                    Tenant metrics, document ingestion, employee assignments, invite codes, and activity audit trail.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.getElementById('admin-doc-upload-section');
                      if (el) el.scrollIntoView({ behavior: 'smooth' });
                      else setActiveTab('library');
                    }}
                    className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-2 shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
                  >
                    <Upload className="h-4 w-4" />
                    <span>Upload Document</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('library')}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>Document Library</span>
                  </button>
                </div>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  { label: 'People', value: adminStats?.users ?? 0, icon: Users },
                  { label: 'Departments', value: adminStats?.departments ?? 0, icon: Building },
                  { label: 'Documents', value: adminStats?.documents ?? 0, icon: FileText },
                  { label: 'Passages', value: adminStats?.chunks ?? 0, icon: Layers },
                  { label: 'Questions Asked', value: adminStats?.queries ?? 0, icon: Activity },
                ].map((s, i) => (
                  <div key={i} className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                    <div className="flex items-center justify-between text-slate-400 mb-1">
                      <span className="text-xs">{s.label}</span>
                      <s.icon className="h-3.5 w-3.5 text-indigo-400" />
                    </div>
                    <span className="text-xl font-bold text-white">{s.value}</span>
                  </div>
                ))}
              </div>

              {/* Document Upload & Cloud Sync Quick Access for Admin */}
              <div id="admin-doc-upload-section" className="bg-slate-900 border border-slate-800 rounded-2xl p-6 scroll-mt-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                  <div>
                    <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Upload className="h-4 w-4 text-indigo-400" />
                      Document Management & Ingestion Hub
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Upload policies, handbooks, engineering docs, or sync cloud storage for instant RAG indexing across the organization.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveTab('library')}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Open Full Document Library
                    </button>
                    <button
                      type="button"
                      onClick={handleSyncDrive}
                      disabled={isSyncingDrive}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 text-sky-400 ${isSyncingDrive ? 'animate-spin' : ''}`} />
                      <span>{isSyncingDrive ? 'Syncing...' : 'Sync Cloud'}</span>
                    </button>
                  </div>
                </div>

                <form onSubmit={handleFileUpload} className="space-y-4">
                  <div className="border-2 border-dashed border-slate-700 hover:border-slate-600 rounded-xl p-5 text-center cursor-pointer transition-colors bg-slate-950/40">
                    <input
                      type="file"
                      id="admin-doc-file-upload"
                      onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                      className="hidden"
                    />
                    <label htmlFor="admin-doc-file-upload" className="cursor-pointer block">
                      <Upload className="h-6 w-6 text-slate-500 mx-auto mb-1.5" />
                      <span className="text-xs font-medium text-indigo-400">
                        {uploadFile ? uploadFile.name : 'Click to select a file (PDF, DOCX, TXT, MD, CSV, PPTX)'}
                      </span>
                      {uploadFile && (
                        <p className="text-[11px] text-slate-400 mt-1">
                          {(uploadFile.size / 1024).toFixed(1)} KB selected
                        </p>
                      )}
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1.5">
                        Target Department
                      </label>
                      <select
                        value={uploadDepartment}
                        onChange={(e) => setUploadDepartment(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                      >
                        {departmentsList.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.code})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1.5">
                        Document Access Level
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setUploadVisibility('org')}
                          className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium border flex items-center justify-center gap-1.5 transition-colors ${
                            uploadVisibility === 'org'
                              ? 'bg-indigo-600/30 border-indigo-500 text-indigo-300'
                              : 'bg-slate-800 border-slate-700 text-slate-400'
                          }`}
                        >
                          <Globe className="h-3.5 w-3.5" />
                          Org-Wide
                        </button>
                        <button
                          type="button"
                          onClick={() => setUploadVisibility('restricted')}
                          className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium border flex items-center justify-center gap-1.5 transition-colors ${
                            uploadVisibility === 'restricted'
                              ? 'bg-indigo-600/30 border-indigo-500 text-indigo-300'
                              : 'bg-slate-800 border-slate-700 text-slate-400'
                          }`}
                        >
                          <Lock className="h-3.5 w-3.5" />
                          Restricted
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <p className="text-[11px] text-slate-500">
                      All uploaded files are vectorized with BM25 + dense neural chunking immediately.
                    </p>
                    <button
                      type="submit"
                      disabled={isUploading || !uploadFile}
                      className="py-2 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs transition-colors flex items-center gap-2 cursor-pointer shadow-md shadow-indigo-600/20"
                    >
                      {isUploading ? 'Indexing...' : 'Upload & Index Now'}
                    </button>
                  </div>
                </form>
              </div>

              {/* Users & Department Assignment: Who, When, Whom */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Users className="h-4 w-4 text-indigo-400" />
                      Employee Directory & Department Allocation
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Live directory of verified employees showing who joined, registration timestamp, assigned ID, and department.
                    </p>
                  </div>
                  <span className="text-xs bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2.5 py-1 rounded-lg font-mono">
                    {adminUsers.length} Employees
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="pb-3 font-semibold">Employee (Who)</th>
                        <th className="pb-3 font-semibold">Employee ID</th>
                        <th className="pb-3 font-semibold">Department (Whom)</th>
                        <th className="pb-3 font-semibold">Role</th>
                        <th className="pb-3 font-semibold">Joined (When)</th>
                        <th className="pb-3 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {adminUsers.map((u) => {
                        const isSelf = u.id === currentUser.id;
                        const joinDate = u.created ? new Date(u.created) : null;
                        return (
                          <tr key={u.id} className="text-slate-300">
                            <td className="py-3 font-medium text-white">
                              <div className="flex items-center gap-2">
                                <div className="w-6 h-6 rounded-full bg-indigo-600/30 text-indigo-300 font-bold text-[11px] flex items-center justify-center uppercase shrink-0">
                                  {u.username[0]}
                                </div>
                                <span className="font-semibold">{u.username}</span>
                                {isSelf && <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded font-medium">(You)</span>}
                              </div>
                            </td>
                            <td className="py-3">
                              <span className="font-mono text-[11px] font-bold text-indigo-300 bg-slate-800 border border-slate-700 px-2 py-0.5 rounded">
                                {u.employee_id || (u.role === 'admin' ? 'ORG-ADMIN' : 'DIRECT-JOIN')}
                              </span>
                            </td>
                            <td className="py-3">
                              <select
                                value={u.department_id || ''}
                                onChange={(e) => handleUpdateUser(u.id, undefined, e.target.value)}
                                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white"
                              >
                                <option value="">None / Floating</option>
                                {departmentsList.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name} ({d.code})
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="py-3">
                              {isSelf ? (
                                <span className="text-amber-400 font-semibold uppercase text-[11px]">{u.role}</span>
                              ) : (
                                <select
                                  value={u.role}
                                  onChange={(e) => handleUpdateUser(u.id, e.target.value as any)}
                                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white"
                                >
                                  <option value="member">member</option>
                                  <option value="admin">admin</option>
                                </select>
                              )}
                            </td>
                            <td className="py-3 text-slate-400 text-[11px] font-mono">
                              {joinDate ? (
                                <span title={joinDate.toISOString()}>
                                  {joinDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at{' '}
                                  {joinDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              ) : (
                                'Initial Seed'
                              )}
                            </td>
                            <td className="py-3 text-right">
                              {!isSelf && (
                                <button
                                  onClick={() => handleRemoveUser(u.id)}
                                  className="text-xs text-rose-400 hover:text-rose-300 cursor-pointer"
                                >
                                  Remove
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Single-Use Invites & Employee ID Issuance */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-indigo-400" />
                  Issue Company Employee ID with Department
                </h2>
                <p className="text-xs text-slate-400 mb-4">
                  New staff members register using their company-issued Employee ID (e.g., ENG-366399) assigned to their department.
                </p>

                <form onSubmit={handleCreateInvite} className="flex flex-wrap items-center gap-3 mb-4">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Target Department</label>
                    <select
                      value={newInviteDept}
                      onChange={(e) => setNewInviteDept(e.target.value)}
                      className="bg-slate-800 border border-slate-700 text-xs rounded-lg px-3 py-2 text-white"
                    >
                      {departmentsList.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.code})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Role</label>
                    <select
                      value={newInviteRole}
                      onChange={(e) => setNewInviteRole(e.target.value as any)}
                      className="bg-slate-800 border border-slate-700 text-xs rounded-lg px-3 py-2 text-white"
                    >
                      <option value="member">Employee (Member)</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Expires in</label>
                    <select
                      value={newInviteDays}
                      onChange={(e) => setNewInviteDays(parseInt(e.target.value, 10))}
                      className="bg-slate-800 border border-slate-700 text-xs rounded-lg px-3 py-2 text-white"
                    >
                      <option value={1}>1 day</option>
                      <option value={7}>7 days</option>
                      <option value={30}>30 days</option>
                    </select>
                  </div>

                  <div className="self-end">
                    <button
                      type="submit"
                      className="py-2 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs transition-colors cursor-pointer shadow-md shadow-indigo-600/20"
                    >
                      Issue Employee ID
                    </button>
                  </div>
                </form>

                {createdInviteCode && (
                  <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-500/40 flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      <div>
                        <span className="text-[11px] text-emerald-300 block">
                          Issued Employee ID: <strong className="font-mono text-white text-xs">{createdInviteCode}</strong>
                        </span>
                        <span className="text-[10px] text-emerald-400/80">
                          Assigned to {departmentsList.find(d => d.id === newInviteDept)?.name || 'Department'}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(createdInviteCode);
                        setCopiedCode(true);
                        setTimeout(() => setCopiedCode(false), 2000);
                      }}
                      className="px-3 py-1 rounded bg-emerald-600 text-xs font-medium text-white hover:bg-emerald-500 cursor-pointer"
                    >
                      {copiedCode ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                )}

                {/* Issued ID Register & Onboarding Status */}
                <div className="mt-4 pt-4 border-t border-slate-800">
                  <h3 className="text-xs font-semibold text-slate-300 mb-2.5">
                    Issued IDs & Onboarding Register ({adminInvites.length})
                  </h3>
                  {adminInvites.length === 0 ? (
                    <p className="text-xs text-slate-500 italic">No employee IDs issued yet.</p>
                  ) : (
                    <div className="overflow-x-auto max-h-56 overflow-y-auto">
                      <table className="w-full text-xs text-left">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                            <th className="pb-2">ID</th>
                            <th className="pb-2">Department (Whom)</th>
                            <th className="pb-2">Role</th>
                            <th className="pb-2">Registered By (Who Joined)</th>
                            <th className="pb-2">Expires</th>
                            <th className="pb-2 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {adminInvites.map((inv) => {
                            const isUsed = Boolean(inv.used_by || inv.used_by_name);
                            return (
                              <tr key={inv.code} className="text-slate-300">
                                <td className="py-2.5 font-mono font-bold text-indigo-300">{inv.code}</td>
                                <td className="py-2.5">{inv.department_name || 'All'}</td>
                                <td className="py-2.5 capitalize">{inv.role}</td>
                                <td className="py-2.5">
                                  {isUsed ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium">
                                      <CheckCircle2 className="h-3 w-3" />
                                      Joined: {inv.used_by_name || 'Registered'}
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-medium">
                                      ⏳ Pending Signup
                                    </span>
                                  )}
                                </td>
                                <td className="py-2.5 text-slate-400 text-[11px]">
                                  {new Date(inv.expires).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                </td>
                                <td className="py-2.5 text-right">
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(inv.code);
                                      alert(`Copied Employee ID: ${inv.code}`);
                                    }}
                                    className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
                                  >
                                    Copy ID
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* Activity Audit Trail */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                <h2 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-indigo-400" />
                  Audit Trail
                </h2>
                <div className="overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="sticky top-0 bg-slate-900">
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="pb-2">Time</th>
                        <th className="pb-2">Actor</th>
                        <th className="pb-2">Action</th>
                        <th className="pb-2">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {adminAudit.map((log) => (
                        <tr key={log.id} className="text-slate-300">
                          <td className="py-2 text-[11px] text-slate-500 font-mono">
                            {new Date(log.created).toLocaleTimeString()}
                          </td>
                          <td className="py-2 font-medium text-white">{log.username}</td>
                          <td className="py-2">
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-indigo-300 font-mono text-[10px]">
                              {log.action}
                            </span>
                          </td>
                          <td className="py-2 text-slate-400 truncate max-w-xs">{log.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* SLIDE-OVER: SOURCE INSPECTION DRAWER */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {selectedCitation && (
          <div className="absolute inset-y-0 right-0 w-96 bg-slate-900 border-l border-slate-800 shadow-2xl p-6 flex flex-col z-30 animate-in slide-in-from-right duration-200">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold text-indigo-400 bg-indigo-500/20 px-2 py-0.5 rounded">
                  Source [{selectedCitation.n}]
                </span>
                <span className="text-xs text-slate-400">Grounded Citation</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCitation(null)}
                className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4">
              <div>
                <label className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold block mb-1">
                  Document
                </label>
                <h4 className="text-sm font-semibold text-white">{selectedCitation.filename}</h4>
                <div className="flex items-center gap-2 text-xs text-slate-400 mt-1">
                  <span>Page {selectedCitation.page}</span>
                  {selectedCitation.department_name && (
                    <>
                      <span>·</span>
                      <span className="text-indigo-400">{selectedCitation.department_name}</span>
                    </>
                  )}
                </div>
              </div>

              <div>
                <label className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold block mb-1.5">
                  Verified Passage Content
                </label>
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 leading-relaxed italic border-l-4 border-l-indigo-500">
                  "{selectedCitation.snippet}"
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 text-xs text-slate-400">
                <p>
                  This excerpt was matched using hybrid BM25 + dense neural retrieval and verified for exact semantic grounding.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* MODAL: CREATE DEPARTMENT */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {showNewDeptModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-white">Create New Department</h3>
                <button
                  onClick={() => setShowNewDeptModal(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleCreateDepartment} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Department Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Customer Support"
                    value={newDeptName}
                    onChange={(e) => setNewDeptName(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Code</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. CS"
                      value={newDeptCode}
                      onChange={(e) => setNewDeptCode(e.target.value.toUpperCase())}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white uppercase font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Icon</label>
                    <select
                      value={newDeptIcon}
                      onChange={(e) => setNewDeptIcon(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                    >
                      <option value="Folder">Folder</option>
                      <option value="Users">Users</option>
                      <option value="Code">Code</option>
                      <option value="DollarSign">Finance</option>
                      <option value="Shield">Legal</option>
                      <option value="TrendingUp">Marketing</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Description</label>
                  <textarea
                    rows={2}
                    placeholder="Brief description of department scope..."
                    value={newDeptDesc}
                    onChange={(e) => setNewDeptDesc(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowNewDeptModal(false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition-colors"
                  >
                    Create
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal: Change Password */}
        {showPasswordModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-sm p-5 shadow-2xl">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-indigo-600/20 text-indigo-400">
                    <Key className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">Change Account Password</h3>
                    <p className="text-[11px] text-slate-400">Update your personal login password</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowPasswordModal(false)}
                  className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {pwModalMsg && (
                <div
                  className={`mb-4 p-2.5 rounded-lg text-xs flex items-center gap-2 ${
                    pwModalMsg.type === 'success'
                      ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                      : 'bg-rose-500/10 border border-rose-500/20 text-rose-400'
                  }`}
                >
                  {pwModalMsg.type === 'success' ? <Check className="h-3.5 w-3.5 shrink-0" /> : <X className="h-3.5 w-3.5 shrink-0" />}
                  <span>{pwModalMsg.text}</span>
                </div>
              )}

              <form onSubmit={handleChangePassword} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Current Password</label>
                  <input
                    type="password"
                    required
                    placeholder="Enter current password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">New Password (Min 6 chars)</label>
                  <input
                    type="password"
                    required
                    placeholder="Enter new password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Confirm New Password</label>
                  <input
                    type="password"
                    required
                    placeholder="Re-enter new password"
                    value={confirmNewPw}
                    onChange={(e) => setConfirmNewPw(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowPasswordModal(false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={pwLoading}
                    className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white transition-colors cursor-pointer"
                  >
                    {pwLoading ? 'Saving...' : 'Update Password'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
