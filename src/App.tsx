import React, { useState } from 'react';
import { Shield, MessageSquare, Building, FileText, Settings, LogOut, CheckCircle2, Globe, Send, RefreshCw } from 'lucide-react';

export default function App() {
  const [user, setUser] = useState<{ username: string; role: string; dept: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'ask' | 'depts' | 'lib' | 'admin'>('ask');
  const [selectedLang, setSelectedLang] = useState('English');
  const [inputQuery, setInputQuery] = useState('');
  const [messages, setMessages] = useState<Array<{ role: string; text: string }>>([
    { role: 'assistant', text: 'According to the HR Leave and Attendance Policy 2025, employees receive 12 casual leaves per year [1].' }
  ]);
  const [loginUser, setLoginUser] = useState('siri');
  const [issuedCode, setIssuedCode] = useState('');

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0b0f19] flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex p-3 rounded-2xl bg-indigo-500/10 text-indigo-400"><Shield className="h-8 w-8" /></div>
            <h1 className="text-xl font-bold text-white">OmniRAG Enterprise</h1>
            <p className="text-xs text-slate-400">Department-Isolated Knowledge Platform</p>
          </div>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-slate-400">Username</label>
              <input value={loginUser} onChange={(e) => setLoginUser(e.target.value)} className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none" />
              <p className="text-[10px] text-slate-500 mt-1">Try: <b>siri</b> (Admin) or <b>ravi</b> (Engineering)</p>
            </div>
            <button onClick={() => setUser(loginUser === 'ravi' ? { username: 'Ravi', role: 'member', dept: 'Engineering & Tech' } : { username: 'Siri', role: 'admin', dept: 'Human Resources' })} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl py-2.5 text-xs">Sign In</button>
          </div>
        </div>
      </div>
    );
  }

  const isMember = user.role === 'member';

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-200 flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-slate-900 border-r border-slate-800 p-5 flex flex-col justify-between">
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-600 text-white"><Shield className="h-5 w-5" /></div>
            <div>
              <h2 className="font-bold text-white text-sm">OmniRAG</h2>
              <p className="text-[11px] text-slate-400">Acme Corporation</p>
            </div>
          </div>
          <nav className="space-y-1.5 text-xs font-semibold">
            <button onClick={() => setActiveTab('ask')} className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2.5 ${activeTab === 'ask' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}><MessageSquare className="h-4 w-4" /> Ask Documents</button>
            {!isMember && <button onClick={() => setActiveTab('depts')} className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2.5 ${activeTab === 'depts' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}><Building className="h-4 w-4" /> Departments (5)</button>}
            <button onClick={() => setActiveTab('lib')} className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2.5 ${activeTab === 'lib' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}><FileText className="h-4 w-4" /> Document Library</button>
            {!isMember && <button onClick={() => setActiveTab('admin')} className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2.5 ${activeTab === 'admin' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}><Settings className="h-4 w-4" /> Administration</button>}
          </nav>
        </div>
        <div className="pt-4 border-t border-slate-800 space-y-2">
          <p className="text-xs font-bold text-white">👤 {user.username} ({user.role})</p>
          <p className="text-[11px] text-indigo-400">{user.dept}</p>
          <button onClick={() => setUser(null)} className="text-xs text-rose-400 hover:underline flex items-center gap-1.5"><LogOut className="h-3.5 w-3.5" /> Sign out</button>
        </div>
      </aside>

      <main className="flex-1 p-6 md:p-8 overflow-y-auto">
        {activeTab === 'ask' && (
          <div className="space-y-6 max-w-4xl mx-auto">
            <div className="flex justify-between items-center border-b border-slate-800 pb-4">
              <span className="text-xs text-indigo-400 bg-indigo-950/60 px-3 py-1.5 rounded-xl border border-indigo-800">🔒 Department Locked: <b>{user.dept}</b></span>
              <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl text-xs">
                <Globe className="h-3.5 w-3.5 text-indigo-400" />
                <select value={selectedLang} onChange={(e) => setSelectedLang(e.target.value)} className="bg-transparent text-white outline-none">
                  <option value="English" className="bg-slate-900">English (Default)</option>
                  <option value="Spanish" className="bg-slate-900">Español (Spanish)</option>
                  <option value="Hindi" className="bg-slate-900">हिन्दी (Hindi)</option>
                  <option value="French" className="bg-slate-900">Français (French)</option>
                </select>
              </div>
            </div>
            <div className="space-y-4 py-4">
              {messages.map((m, idx) => (
                <div key={idx} className={`p-4 rounded-xl border ${m.role === 'user' ? 'bg-slate-900 border-indigo-500/30' : 'bg-slate-900/60 border-slate-800 space-y-1'}`}>
                  {m.role === 'assistant' && <div className="flex justify-between text-xs font-bold text-white"><span>🛡️ OmniRAG Assistant</span><span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Verified 100%</span></div>}
                  <p className="text-xs text-slate-300 leading-relaxed">{m.text}</p>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={inputQuery} onChange={(e) => setInputQuery(e.target.value)} placeholder={`Ask a question in ${selectedLang}…`} className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-xs text-white outline-none focus:border-indigo-500" />
              <button onClick={() => { if (!inputQuery) return; setMessages(p => [...p, { role: 'user', text: inputQuery }, { role: 'assistant', text: selectedLang === 'Spanish' ? 'Tiene derecho a 12 días de permiso ocasional al año [1].' : (selectedLang === 'Hindi' ? 'आप प्रति वर्ष 12 दिनों के आकस्मिक अवकाश के हकदार हैं [1]।' : 'You are entitled to 12 days of casual leave per year [1].') }]); setInputQuery(''); }} className="bg-indigo-600 hover:bg-indigo-500 text-white px-5 rounded-xl text-xs font-semibold"><Send className="h-4 w-4" /></button>
            </div>
          </div>
        )}

        {activeTab === 'depts' && (
          <div className="space-y-6">
            <h1 className="text-xl font-bold text-white">Organization Departments</h1>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[{ name: 'Engineering & Tech', code: 'ENG' }, { name: 'Finance & Operations', code: 'FIN' }, { name: 'Human Resources', code: 'HR' }].map(d => (
                <div key={d.code} className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-2">
                  <span className="text-xs font-mono bg-indigo-950 text-indigo-400 px-2 py-0.5 rounded">{d.code}</span>
                  <h3 className="font-bold text-white text-sm">{d.name}</h3>
                  <button onClick={() => setActiveTab('ask')} className="text-xs text-indigo-400 hover:underline">Ask Dept →</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'lib' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h1 className="text-xl font-bold text-white">Document Library</h1>
              <button onClick={() => alert('Synced Google Drive & OneDrive successfully!')} className="bg-slate-800 border border-slate-700 text-xs text-slate-200 px-3.5 py-2 rounded-xl flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5 text-sky-400" /> Sync Cloud Storage</button>
            </div>
            <div className="space-y-3">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4"><p className="text-xs font-bold text-white">📄 HR_Leave_Policy_2025.pdf</p><p className="text-[11px] text-slate-400">Human Resources · 4 passages</p></div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4"><p className="text-xs font-bold text-white">📄 Cloud_Infrastructure_Security.pdf</p><p className="text-[11px] text-slate-400">Engineering & Tech · 6 passages</p></div>
            </div>
          </div>
        )}

        {activeTab === 'admin' && (
          <div className="space-y-6">
            <h1 className="text-xl font-bold text-white">Administration</h1>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-bold text-white">Issue Company Employee ID</h3>
              <div className="flex gap-3">
                <select id="sel-dept" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white">
                  <option>Engineering & Tech</option>
                  <option>Human Resources</option>
                  <option>Finance & Operations</option>
                </select>
                <button onClick={() => setIssuedCode('ENG-' + Math.floor(100000 + Math.random() * 900000))} className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded-xl">Issue Employee ID</button>
              </div>
              {issuedCode && <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs rounded-xl font-semibold">✅ Issued Employee ID: {issuedCode}</div>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}