import { useState, useCallback } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  useListInviteJobs,
  useCreateInviteJobs,
  useRunAllInviteJobs,
  useRunInviteJob,
  useDeleteInviteJob,
  useGetPicsartSlots,
  useGetDbSettings,
  useUpdateDbSettings,
  useGetProxySettings,
  useUpdateProxySettings,
  getListInviteJobsQueryKey,
  getGetPicsartSlotsQueryKey,
  getGetDbSettingsQueryKey,
  getGetProxySettingsQueryKey,
} from "@workspace/api-client-react";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 3000, retry: false } },
});

type JobStatus =
  | "pending"
  | "inviting"
  | "invited"
  | "accepting"
  | "accepted"
  | "extracting"
  | "in_pool"
  | "failed";

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: "Pending",
  inviting: "Inviting...",
  invited: "Invited",
  accepting: "Accepting...",
  accepted: "Accepted",
  extracting: "Extracting Token...",
  in_pool: "In Pool ✓",
  failed: "Failed",
};

const STATUS_COLORS: Record<JobStatus, string> = {
  pending: "bg-slate-700 text-slate-300",
  inviting: "bg-blue-900 text-blue-300 animate-pulse",
  invited: "bg-indigo-900 text-indigo-300",
  accepting: "bg-violet-900 text-violet-300 animate-pulse",
  accepted: "bg-purple-900 text-purple-300",
  extracting: "bg-fuchsia-900 text-fuchsia-300 animate-pulse",
  in_pool: "bg-emerald-900 text-emerald-300",
  failed: "bg-red-900 text-red-400",
};

function StepDot({ done, active }: { done: boolean; active: boolean }) {
  if (done) return <span className="inline-block w-3 h-3 rounded-full bg-emerald-400" />;
  if (active) return <span className="inline-block w-3 h-3 rounded-full bg-violet-400 animate-pulse" />;
  return <span className="inline-block w-3 h-3 rounded-full bg-slate-700" />;
}

function stepsDone(status: JobStatus) {
  const order: JobStatus[] = [
    "pending", "inviting", "invited", "accepting",
    "accepted", "extracting", "in_pool",
  ];
  const idx = order.indexOf(status);
  return {
    invited: idx >= order.indexOf("invited"),
    accepted: idx >= order.indexOf("accepted"),
    in_pool: idx >= order.indexOf("in_pool"),
    inviting: status === "inviting",
    accepting: status === "accepting",
    extracting: status === "extracting",
  };
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/invite-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ secret }),
      });
      if (res.ok) {
        onLogin();
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? `Error ${res.status}`);
      }
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0d0d14] flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 justify-center mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-600 to-pink-600 flex items-center justify-center text-lg font-bold">P</div>
          <div>
            <h1 className="font-bold text-xl text-white leading-none">Invite Automation</h1>
            <p className="text-xs text-slate-500 mt-0.5">Picsart HEAD Team Manager</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="bg-[#13131f] border border-white/10 rounded-2xl p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Admin Secret</label>
            <input
              type="password"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              placeholder="Enter INVITE_PANEL_SECRET"
              autoFocus
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-violet-500"
            />
          </div>
          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg px-3 py-2">{error}</div>
          )}
          <button
            type="submit"
            disabled={loading || !secret}
            className="w-full py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 transition text-sm font-medium"
          >
            {loading ? "Masuk..." : "Masuk"}
          </button>
        </form>
      </div>
    </div>
  );
}

function isAuthError(status: number) {
  return status === 401 || status === 503;
}

function DbSettingsCard({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useGetDbSettings();
  const updateMutation = useUpdateDbSettings();
  const [url, setUrl] = useState("");

  const sourceLabel =
    settings?.source === "panel" ? "Diset dari panel"
    : settings?.source === "env" ? "Dari environment (default)"
    : "Belum diset";

  async function handleSave() {
    try {
      const res = await updateMutation.mutateAsync({ data: { url } });
      if (res.ok) {
        toast({ title: "DB Railway tersimpan", description: "Koneksi berhasil dites & disimpan." });
        setUrl("");
        qc.invalidateQueries({ queryKey: getGetDbSettingsQueryKey() });
      } else {
        toast({ title: "Koneksi gagal", description: res.error ?? "Tidak bisa connect", variant: "destructive" });
      }
    } catch (e: unknown) {
      toast({ title: "Gagal simpan", description: String(e), variant: "destructive" });
    }
  }

  async function handleClear() {
    try {
      await updateMutation.mutateAsync({ data: { url: "" } });
      toast({ title: "Override dihapus", description: "Kembali ke default environment." });
      setUrl("");
      qc.invalidateQueries({ queryKey: getGetDbSettingsQueryKey() });
    } catch (e: unknown) {
      toast({ title: "Gagal", description: String(e), variant: "destructive" });
    }
  }

  return (
    <div className="bg-[#13131f] border border-violet-500/30 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-sm text-white">Database Railway (Pool Token)</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Token akun Picsart yang berhasil otomatis masuk ke tabel <code className="text-violet-300">picsart_credentials</code> di DB ini.
          </p>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-sm px-2">✕</button>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className={`w-2 h-2 rounded-full ${settings?.configured ? "bg-emerald-400" : "bg-amber-400"}`} />
        <span className="text-slate-400">{sourceLabel}</span>
        {settings?.urlMasked && (
          <code className="ml-1 text-slate-300 bg-black/30 border border-white/10 rounded px-2 py-0.5 truncate max-w-md">
            {settings.urlMasked}
          </code>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-xs font-medium text-slate-400">
          Connection string Railway
        </label>
        <input
          type="password"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="postgresql://postgres:password@host.proxy.rlwy.net:5432/railway"
          className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500"
        />
        <p className="text-xs text-slate-600">
          Disimpan terenkripsi di server & nggak pernah ditampilkan ulang. Akan dites dulu sebelum disimpan.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={updateMutation.isPending || !url.trim()}
          className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 transition text-sm font-medium"
        >
          {updateMutation.isPending ? "Mengetes koneksi..." : "Tes & Simpan"}
        </button>
        {settings?.source === "panel" && (
          <button
            onClick={handleClear}
            disabled={updateMutation.isPending}
            className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition text-sm text-slate-400"
          >
            Hapus override
          </button>
        )}
      </div>
    </div>
  );
}

const PROXY_COUNTRIES: { code: string; label: string }[] = [
  { code: "id", label: "🇮🇩 Indonesia" },
  { code: "sg", label: "🇸🇬 Singapura" },
  { code: "us", label: "🇺🇸 Amerika Serikat" },
  { code: "gb", label: "🇬🇧 Inggris (UK)" },
  { code: "au", label: "🇦🇺 Australia" },
  { code: "de", label: "🇩🇪 Jerman" },
  { code: "fr", label: "🇫🇷 Prancis" },
  { code: "jp", label: "🇯🇵 Jepang" },
  { code: "ca", label: "🇨🇦 Kanada" },
  { code: "in", label: "🇮🇳 India" },
];

function ProxySettingsCard({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useGetProxySettings();
  const updateMutation = useUpdateProxySettings();
  const current = settings?.country ?? "id";

  async function handleSelect(country: string) {
    if (country === current) return;
    try {
      await updateMutation.mutateAsync({ data: { country } });
      const label = PROXY_COUNTRIES.find(c => c.code === country)?.label ?? country.toUpperCase();
      toast({ title: "Negara proxy diganti", description: `Sekarang pakai ${label}. Jalankan ulang job-nya.` });
      qc.invalidateQueries({ queryKey: getGetProxySettingsQueryKey() });
    } catch (e: unknown) {
      toast({ title: "Gagal ganti proxy", description: String(e), variant: "destructive" });
    }
  }

  return (
    <div className="bg-[#13131f] border border-violet-500/30 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-sm text-white">Negara Proxy (IP)</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Pilih negara IP buat login — seperti milih negara di VPN. Kalau kena blokir "unusual activity", coba ganti negara lalu jalankan ulang.
          </p>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-sm px-2">✕</button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {PROXY_COUNTRIES.map(c => {
          const active = c.code === current;
          return (
            <button
              key={c.code}
              onClick={() => handleSelect(c.code)}
              disabled={updateMutation.isPending}
              className={`px-3 py-2.5 rounded-lg text-sm font-medium transition text-left border disabled:opacity-40 ${
                active
                  ? "bg-violet-600 border-violet-400 text-white"
                  : "bg-black/30 border-white/10 text-slate-300 hover:border-violet-500/50"
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-slate-600">
        Proxy residential ganti IP tiap dijalankan. Kalau satu negara masih keblokir, ganti negara lain & coba lagi.
      </p>
    </div>
  );
}

function Panel({ onLogout }: { onLogout: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const {
    data: jobs = [],
    isLoading: jobsLoading,
    error: jobsError,
  } = useListInviteJobs();

  const { data: slots } = useGetPicsartSlots();
  const createMutation = useCreateInviteJobs();
  const runAllMutation = useRunAllInviteJobs();
  const runOneMutation = useRunInviteJob();
  const deleteMutation = useDeleteInviteJob();

  const [bulkText, setBulkText] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [showDbSettings, setShowDbSettings] = useState(false);
  const [showProxySettings, setShowProxySettings] = useState(false);

  const authFailed =
    jobsError instanceof Error &&
    "status" in jobsError &&
    isAuthError((jobsError as { status: number }).status);

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListInviteJobsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetPicsartSlotsQueryKey() });
  }

  async function handleLogout() {
    await fetch("/api/invite-auth/logout", { method: "POST", credentials: "include" });
    onLogout();
  }

  async function handleAdd() {
    const lines = bulkText.trim().split("\n").filter(Boolean);
    const entries: { email: string; gmailPassword: string }[] = [];
    for (const line of lines) {
      const parts = line.split(/[,|;:\t]/).map(s => s.trim());
      if (parts.length >= 2 && parts[0].includes("@")) {
        entries.push({ email: parts[0], gmailPassword: parts[1] });
      }
    }
    if (!entries.length) {
      toast({ title: "Format salah", description: "Tiap baris: email,password", variant: "destructive" });
      return;
    }
    try {
      await createMutation.mutateAsync({ data: { entries } });
      toast({ title: `${entries.length} email ditambahkan` });
      setBulkText("");
      setShowAddForm(false);
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Gagal tambah", description: String(e), variant: "destructive" });
    }
  }

  async function handleRunAll() {
    try {
      const res = await runAllMutation.mutateAsync();
      toast({ title: `${res.queued} job dimulai` });
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Gagal run all", description: String(e), variant: "destructive" });
    }
  }

  async function handleRunOne(id: number) {
    try {
      await runOneMutation.mutateAsync({ id });
      toast({ title: `Job #${id} dimulai` });
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Gagal run", description: String(e), variant: "destructive" });
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteMutation.mutateAsync({ id });
      toast({ title: `Job #${id} dihapus` });
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Gagal hapus", description: String(e), variant: "destructive" });
    }
  }

  if (authFailed) {
    return (
      <div className="min-h-screen bg-[#0d0d14] flex items-center justify-center text-slate-500 text-sm">
        Sesi habis. <button onClick={onLogout} className="ml-1 underline text-violet-400">Login ulang</button>
      </div>
    );
  }

  const pending = jobs.filter(j => j.status === "pending" || j.status === "failed").length;
  const inPool = jobs.filter(j => j.status === "in_pool").length;
  const running = jobs.filter(j => ["inviting", "accepting", "extracting"].includes(j.status)).length;

  return (
    <div className="min-h-screen bg-[#0d0d14] text-white font-sans">
      <div className="border-b border-white/5 bg-[#13131f]">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-pink-600 flex items-center justify-center text-sm font-bold">P</div>
            <div>
              <h1 className="font-bold text-lg leading-none">Invite Automation</h1>
              <p className="text-xs text-slate-500 mt-0.5">Picsart HEAD Team Manager</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {slots && (
              <div className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="text-slate-300">
                  <span className="text-white font-semibold">{slots.available}</span> slot tersisa
                </span>
              </div>
            )}
            <button
              onClick={() => setShowAddForm(s => !s)}
              className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 transition text-sm font-medium"
            >
              + Tambah Email
            </button>
            <button
              onClick={handleRunAll}
              disabled={pending === 0 || runAllMutation.isPending}
              className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 transition text-sm font-medium"
            >
              {runAllMutation.isPending ? "Starting..." : `▶ Run All (${pending})`}
            </button>
            <button
              onClick={() => setShowProxySettings(s => !s)}
              className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-400 transition"
              title="Negara proxy (IP)"
            >
              🌐 Proxy
            </button>
            <button
              onClick={() => setShowDbSettings(s => !s)}
              className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-400 transition"
              title="Pengaturan DB Railway"
            >
              ⚙ DB
            </button>
            <button
              onClick={handleLogout}
              className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-500 transition"
            >
              Keluar
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: "Total", value: jobs.length, color: "text-white" },
            { label: "Running", value: running, color: "text-violet-400" },
            { label: "In Pool", value: inPool, color: "text-emerald-400" },
            { label: "Pending/Failed", value: pending, color: "text-amber-400" },
          ].map(stat => (
            <div key={stat.label} className="bg-white/5 border border-white/10 rounded-xl p-4">
              <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
              <div className="text-xs text-slate-500 mt-1">{stat.label}</div>
            </div>
          ))}
        </div>

        {showProxySettings && <ProxySettingsCard onClose={() => setShowProxySettings(false)} />}

        {showDbSettings && <DbSettingsCard onClose={() => setShowDbSettings(false)} />}

        {showAddForm && (
          <div className="bg-[#13131f] border border-white/10 rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-sm text-slate-300">
              Tambah Email (satu per baris: email,password)
            </h2>
            <textarea
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
              placeholder={"user1@gmail.com,password123\nuser2@gmail.com,mypass456"}
              className="w-full h-36 bg-black/30 border border-white/10 rounded-lg p-3 text-sm font-mono text-slate-200 placeholder:text-slate-600 resize-none focus:outline-none focus:border-violet-500"
            />
            <div className="flex gap-2">
              <button
                onClick={handleAdd}
                disabled={createMutation.isPending}
                className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 transition text-sm font-medium"
              >
                {createMutation.isPending ? "Menambahkan..." : "Tambahkan"}
              </button>
              <button
                onClick={() => { setShowAddForm(false); setBulkText(""); }}
                className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition text-sm"
              >
                Batal
              </button>
            </div>
          </div>
        )}

        <div className="bg-[#13131f] border border-white/10 rounded-xl overflow-hidden">
          <div className="grid grid-cols-[1fr_140px_auto_auto] gap-0 text-xs font-medium text-slate-500 uppercase tracking-wider px-5 py-3 border-b border-white/5">
            <div>Email</div>
            <div>Status</div>
            <div className="text-center">Progress</div>
            <div className="text-right">Aksi</div>
          </div>

          {jobsLoading && (
            <div className="px-5 py-8 text-center text-slate-600 text-sm">Loading...</div>
          )}

          {!jobsLoading && jobs.length === 0 && (
            <div className="px-5 py-12 text-center text-slate-600 text-sm">
              Belum ada email. Klik "+ Tambah Email" untuk mulai.
            </div>
          )}

          {jobs.map((job, i) => {
            const steps = stepsDone(job.status as JobStatus);
            const isRunning = ["inviting", "accepting", "extracting"].includes(job.status);
            return (
              <div
                key={job.id}
                className={`grid grid-cols-[1fr_140px_auto_auto] gap-4 items-center px-5 py-3.5 ${
                  i < jobs.length - 1 ? "border-b border-white/5" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white truncate">{job.email}</div>
                  {job.errorMessage && (
                    <div className="text-xs text-red-400 mt-0.5 truncate">{job.errorMessage}</div>
                  )}
                  {job.pooledAt && (
                    <div className="text-xs text-emerald-500 mt-0.5">
                      ✓ Masuk pool — cred #{job.credentialId}
                    </div>
                  )}
                </div>

                <div>
                  <span
                    className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${
                      STATUS_COLORS[job.status as JobStatus] ?? "bg-slate-700 text-slate-300"
                    }`}
                  >
                    {STATUS_LABELS[job.status as JobStatus] ?? job.status}
                  </span>
                </div>

                <div className="flex items-center gap-2 justify-center">
                  <StepDot done={steps.invited} active={steps.inviting} />
                  <div className="w-5 h-px bg-white/10" />
                  <StepDot done={steps.accepted} active={steps.accepting} />
                  <div className="w-5 h-px bg-white/10" />
                  <StepDot done={steps.in_pool} active={steps.extracting} />
                </div>

                <div className="flex items-center gap-2 justify-end">
                  {(job.status === "pending" || job.status === "failed") && (
                    <button
                      onClick={() => handleRunOne(job.id)}
                      disabled={runOneMutation.isPending}
                      className="px-3 py-1.5 rounded-lg bg-violet-700 hover:bg-violet-600 text-xs transition"
                    >
                      ▶ Run
                    </button>
                  )}
                  {isRunning && (
                    <span className="px-3 py-1.5 rounded-lg bg-white/5 text-xs text-slate-500">
                      Running...
                    </span>
                  )}
                  <button
                    onClick={() => handleDelete(job.id)}
                    disabled={deleteMutation.isPending}
                    className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-red-900/50 hover:text-red-400 text-xs transition text-slate-500"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-slate-700 text-center">
          Auto-refresh setiap 3 detik. Progress dot: invite → accept → in pool.
        </p>
      </div>
    </div>
  );
}

function AppInner() {
  const [authenticated, setAuthenticated] = useState(false);

  const handleLogin = useCallback(() => {
    setAuthenticated(true);
    queryClient.invalidateQueries();
  }, []);

  const handleLogout = useCallback(() => {
    setAuthenticated(false);
    queryClient.clear();
  }, []);

  if (!authenticated) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <Switch>
      <Route path="/" component={() => <Panel onLogout={handleLogout} />} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppInner />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
