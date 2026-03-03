import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { FitAddon } from "xterm-addon-fit";
import { Terminal } from "xterm";
import { ConnectRequest, SessionInfo, SftpEntry } from "./types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { Upload } from "lucide-react";

interface TerminalStartResult {
  terminalId: string;
}

interface CommandHistoryItem {
  id: string;
  command: string;
  sentAt: number;
  sessionLabel: string | null;
}

interface CommandTab {
  id: string;
  title: string;
  input: string;
  history: CommandHistoryItem[];
  historyIndex: number;
  draftInput: string;
}

interface SavedSessionProfile {
  id: string;
  name: string;
  request: ConnectRequest;
  createdAt: number;
  updatedAt: number;
}

const initialForm: ConnectRequest = {
  label: "",
  host: "",
  port: 22,
  username: "",
  auth: { kind: "password", password: "" }
};

const createCommandTab = (index: number): CommandTab => ({
  id: `cmd-${Date.now()}-${index}`,
  title: `Command ${index + 1}`,
  input: "",
  history: [],
  historyIndex: -1,
  draftInput: ""
});

const recentStorageKey = "tsh.recentConnections.v1";
const savedSessionsStorageKey = "tsh.savedSessions.v1";
const keepaliveStorageKey = "tsh.keepaliveSettings.v1";

const isSameAuthIdentity = (left: ConnectRequest["auth"], right: ConnectRequest["auth"]) => {
  switch (left.kind) {
    case "password":
      return right.kind === "password";
    case "privateKey":
      return right.kind === "privateKey" && left.privateKeyPath === right.privateKeyPath;
  }
};

const cloneConnectRequest = (request: ConnectRequest): ConnectRequest => ({
  label: request.label ?? "",
  host: request.host,
  port: request.port,
  username: request.username,
  auth:
    request.auth.kind === "password"
      ? { kind: "password", password: request.auth.password }
      : {
          kind: "privateKey",
          privateKeyPath: request.auth.privateKeyPath,
          passphrase: request.auth.passphrase
        }
});

const isSameConnectionIdentity = (left: ConnectRequest, right: ConnectRequest) =>
  left.host === right.host &&
  left.port === right.port &&
  left.username === right.username &&
  (left.label ?? "") === (right.label ?? "") &&
  isSameAuthIdentity(left.auth, right.auth);

const appendRecentConnection = (list: ConnectRequest[], request: ConnectRequest) => {
  const normalized = cloneConnectRequest(request);
  const filtered = list.filter((item) => !isSameConnectionIdentity(item, normalized));
  return [normalized, ...filtered].slice(0, 8);
};

const requestDisplayName = (request: ConnectRequest) =>
  request.label?.trim() || `${request.username}@${request.host}:${request.port}`;

export default function App() {
  const [connectForm, setConnectForm] = useState<ConnectRequest>(initialForm);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [sftpRoot, setSftpRoot] = useState(".");
  const [currentDir, setCurrentDir] = useState(".");
  const [sftpTree, setSftpTree] = useState<SftpEntry[]>([]);
  const [sftpChildren, setSftpChildren] = useState<Record<string, SftpEntry[]>>({});
  const [sftpExpanded, setSftpExpanded] = useState<Record<string, boolean>>({});
  const [sftpLoading, setSftpLoading] = useState<Record<string, boolean>>({});
  const [uploadLocal, setUploadLocal] = useState("");
  const [uploadRemote, setUploadRemote] = useState("");
  const [downloadRemote, setDownloadRemote] = useState("");
  const [downloadLocal, setDownloadLocal] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: SftpEntry;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandTabs, setCommandTabs] = useState<CommandTab[]>([createCommandTab(0)]);
  const [activeCommandTabId, setActiveCommandTabId] = useState<string>(
    commandTabs[0].id
  );
  const [commandTarget, setCommandTarget] = useState<"current" | "all">("current");
  const [leftSidebarTab, setLeftSidebarTab] = useState<"quick" | "recent" | "browser">(
    "quick"
  );
  const [recentConnections, setRecentConnections] = useState<ConnectRequest[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSessionProfile[]>([]);
  const [topMenu, setTopMenu] = useState<"file" | "options" | null>(null);
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [optionsDialogOpen, setOptionsDialogOpen] = useState(false);
  const [keepaliveEnabled, setKeepaliveEnabled] = useState(false);
  const [keepaliveIntervalSec, setKeepaliveIntervalSec] = useState(30);
  const [lastKeepaliveAt, setLastKeepaliveAt] = useState<number | null>(null);

  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const terminalBySessionRef = useRef<Map<string, string>>(new Map());
  const terminalGenerationRef = useRef(0);
  const sessionBufferRef = useRef<Map<string, string>>(new Map());
  const maxBufferSize = 200_000;

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  const activeCommandTab = useMemo(
    () => commandTabs.find((tab) => tab.id === activeCommandTabId) ?? null,
    [commandTabs, activeCommandTabId]
  );

  const activeSessionLabel = useMemo(() => {
    if (!activeSession) return null;
    return activeSession.label?.trim() || `${activeSession.username}@${activeSession.host}`;
  }, [activeSession]);

  const refreshSessions = async () => {
    const list = await invoke<SessionInfo[]>("list_sessions");
    setSessions(list);
    if (list.length === 0) {
      setActiveSessionId(null);
      return;
    }
    if (!activeSessionId || !list.some((item) => item.id === activeSessionId)) {
      setActiveSessionId(list[0].id);
    }
  };

  const closeTerminalInstance = async (terminalId?: string | null) => {
    const id = terminalId ?? terminalIdRef.current;
    if (!id) return;
    try {
      await invoke("close_terminal", { terminalId: id });
    } catch {
      // ignore close errors
    }
  };

  const closeAllTerminals = async () => {
    const terminals = Array.from(terminalBySessionRef.current.values());
    terminalBySessionRef.current.clear();
    terminalIdRef.current = null;
    setTerminalId(null);
    await Promise.allSettled(terminals.map((id) => closeTerminalInstance(id)));
  };

  const startTerminalForActiveSession = async (sessionId: string) => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;
    const generation = ++terminalGenerationRef.current;

    const existingTerminalId = terminalBySessionRef.current.get(sessionId);
    if (existingTerminalId) {
      terminalIdRef.current = existingTerminalId;
      setTerminalId(existingTerminalId);
      const buffer = sessionBufferRef.current.get(sessionId);
      term.reset();
      if (buffer) {
        term.write(buffer);
      }
      term.focus();
      return;
    }

    term.reset();
    const connectingMessage = `Connecting interactive shell to session ${sessionId}...`;
    term.writeln(connectingMessage);
    sessionBufferRef.current.set(sessionId, `${connectingMessage}\r\n`);

    const result = await invoke<TerminalStartResult>("start_terminal", {
      sessionId,
      cols: term.cols,
      rows: term.rows
    });

    if (terminalGenerationRef.current !== generation) {
      try {
        await invoke("close_terminal", { terminalId: result.terminalId });
      } catch {
        // ignore stale terminal cleanup errors
      }
      return;
    }

    terminalBySessionRef.current.set(sessionId, result.terminalId);
    terminalIdRef.current = result.terminalId;
    setTerminalId(result.terminalId);
    term.focus();
  };

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "Cascadia Mono, Consolas, Courier New, monospace",
      fontSize: 13,
      theme: {
        background: "#062b2b",
        foreground: "#d8f6e5",
        cursor: "#f4d03f",
        selectionBackground: "#1c5a5a"
      }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    term.writeln("No active SSH session. Create or select a tab.");

    const dataHandler = term.onData((data) => {
      const id = terminalIdRef.current;
      if (!id) return;
      void invoke("terminal_write", { terminalId: id, data }).catch(() => {
        // ignore transient write errors
      });
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      dataHandler.dispose();
      void closeAllTerminals();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const closeContext = () => {
      setContextMenu(null);
      setTopMenu(null);
    };
    window.addEventListener("click", closeContext);
    return () => {
      window.removeEventListener("click", closeContext);
    };
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(recentStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setRecentConnections(parsed as ConnectRequest[]);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(savedSessionsStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setSavedSessions(parsed as SavedSessionProfile[]);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(keepaliveStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        enabled?: boolean;
        intervalSec?: number;
      };
      if (typeof parsed.enabled === "boolean") {
        setKeepaliveEnabled(parsed.enabled);
      }
      if (typeof parsed.intervalSec === "number" && Number.isFinite(parsed.intervalSec)) {
        setKeepaliveIntervalSec(Math.min(3600, Math.max(5, Math.floor(parsed.intervalSec))));
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        recentStorageKey,
        JSON.stringify(recentConnections)
      );
    } catch {
      // ignore storage errors
    }
  }, [recentConnections]);

  useEffect(() => {
    try {
      window.localStorage.setItem(savedSessionsStorageKey, JSON.stringify(savedSessions));
    } catch {
      // ignore storage errors
    }
  }, [savedSessions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        keepaliveStorageKey,
        JSON.stringify({
          enabled: keepaliveEnabled,
          intervalSec: keepaliveIntervalSec
        })
      );
    } catch {
      // ignore storage errors
    }
  }, [keepaliveEnabled, keepaliveIntervalSec]);

  useEffect(() => {
    if (!activeSessionId) {
      if (sessions.length === 0) {
        void closeAllTerminals();
        sessionBufferRef.current.clear();
      }
      const term = xtermRef.current;
      if (term) {
        term.reset();
        term.writeln("No active SSH session. Create or select a tab.");
      }
      return;
    }

    void startTerminalForActiveSession(activeSessionId).catch((err) => {
      setError(String(err));
    });
  }, [activeSessionId, sessions]);

  useEffect(() => {
    setSftpTree([]);
    setSftpChildren({});
    setSftpExpanded({});
    if (activeSessionId) {
      void loadRoot();
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (!terminalId) return;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const output = await invoke<string>("terminal_read", { terminalId });
        if (!output) return;
        xtermRef.current?.write(output);
        if (activeSessionId) {
          const prev = sessionBufferRef.current.get(activeSessionId) ?? "";
          let next = prev + output;
          if (next.length > maxBufferSize) {
            next = next.slice(next.length - maxBufferSize);
          }
          sessionBufferRef.current.set(activeSessionId, next);
        }
      } catch {
        // ignore transient read errors
      }
    }, 80);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminalId, activeSessionId, maxBufferSize]);

  useEffect(() => {
    if (!keepaliveEnabled || sessions.length === 0) return;
    const intervalMs = Math.max(5, keepaliveIntervalSec) * 1000;
    let cancelled = false;

    const sendKeepaliveToAll = async () => {
      if (cancelled || sessions.length === 0) return;
      await Promise.allSettled(
        sessions.map((session) => invoke("send_keepalive", { sessionId: session.id }))
      );
      if (!cancelled) {
        setLastKeepaliveAt(Date.now());
      }
    };

    void sendKeepaliveToAll();
    const timer = window.setInterval(() => {
      void sendKeepaliveToAll();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [keepaliveEnabled, keepaliveIntervalSec, sessions]);

  useEffect(() => {
    const onResize = () => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      const id = terminalIdRef.current;
      if (!term || !fitAddon) return;
      fitAddon.fit();
      if (!id) return;
      void invoke("terminal_resize", {
        terminalId: id,
        cols: term.cols,
        rows: term.rows
      }).catch(() => {
        // ignore resize errors
      });
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const request = cloneConnectRequest(connectForm);
      const created = await invoke<SessionInfo>("create_session", {
        request
      });
      setSessions((prev) => [created, ...prev]);
      setActiveSessionId(created.id);
      setRecentConnections((prev) => appendRecentConnection(prev, request));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const openSessionRequests = async (requests: ConnectRequest[]) => {
    if (requests.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        requests.map((request) =>
          invoke<SessionInfo>("create_session", { request: cloneConnectRequest(request) })
        )
      );
      const created = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      const failedCount = results.length - created.length;

      if (created.length > 0) {
        setSessions((prev) => [...created, ...prev]);
        setActiveSessionId(created[0].id);
        setRecentConnections((prev) =>
          requests.reduce((next, request) => appendRecentConnection(next, request), prev)
        );
      }
      if (failedCount > 0) {
        setError(`有 ${failedCount} 个会话打开失败，请检查连接配置。`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const reconnectFromRecent = async (request: ConnectRequest) => {
    await openSessionRequests([request]);
  };

  const closeSession = async (sessionId: string) => {
    setLoading(true);
    setError(null);
    try {
      const terminalIdToClose = terminalBySessionRef.current.get(sessionId);
      if (terminalIdToClose) {
        terminalBySessionRef.current.delete(sessionId);
        await closeTerminalInstance(terminalIdToClose);
      }
      await invoke("close_session", { sessionId });
      if (sessionId === activeSessionId) {
        terminalIdRef.current = null;
        setTerminalId(null);
      }
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const closeAllSessions = async () => {
    if (sessions.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const ids = sessions.map((session) => session.id);
      await Promise.allSettled(ids.map((sessionId) => invoke("close_session", { sessionId })));
      await closeAllTerminals();
      sessionBufferRef.current.clear();
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const sortEntries = (entries: SftpEntry[]) =>
    [...entries].sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
      return a.name.localeCompare(b.name);
    });

  const loadDir = async (path: string) => {
    if (!activeSessionId) return [];
    setSftpLoading((prev) => ({ ...prev, [path]: true }));
    setError(null);
    try {
      const entries = await invoke<SftpEntry[]>("sftp_list_dir", {
        sessionId: activeSessionId,
        path
      });
      const sorted = sortEntries(entries);
      setSftpChildren((prev) => ({ ...prev, [path]: sorted }));
      return sorted;
    } catch (err) {
      setError(String(err));
      return [];
    } finally {
      setSftpLoading((prev) => ({ ...prev, [path]: false }));
    }
  };

  const loadRoot = async () => {
    if (!activeSessionId) return;
    setLoading(true);
    const rootPath = sftpRoot.trim() || ".";
    setSftpExpanded({});
    setSftpChildren({});
    const entries = await loadDir(rootPath);
    setSftpTree(entries);
    setCurrentDir(rootPath);
    setLoading(false);
  };

  const uploadFile = async (localPath: string, remotePath: string) => {
    if (!activeSessionId) return;
    setLoading(true);
    setError(null);
    try {
      await invoke("sftp_upload", {
        sessionId: activeSessionId,
        localPath,
        remotePath
      });
      if (sftpRoot.trim()) {
        await loadRoot();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const downloadFile = async (remotePath: string, localPath: string) => {
    if (!activeSessionId) return;
    setLoading(true);
    setError(null);
    try {
      await invoke("sftp_download", {
        sessionId: activeSessionId,
        remotePath,
        localPath
      });
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const keepAlive = async () => {
    if (!activeSessionId) return;
    setLoading(true);
    setError(null);
    try {
      await invoke("send_keepalive", { sessionId: activeSessionId });
      setLastKeepaliveAt(Date.now());
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const saveCurrentSessionProfile = () => {
    if (!connectForm.host.trim() || !connectForm.username.trim()) {
      setError("请先填写 Host 和 Username，再保存会话。");
      return;
    }
    setError(null);
    const now = Date.now();
    const request = cloneConnectRequest(connectForm);
    const existing = savedSessions.find((item) => isSameConnectionIdentity(item.request, request));
    const name = connectForm.label?.trim() || `${connectForm.username}@${connectForm.host}`;

    if (existing) {
      setSavedSessions((prev) =>
        prev.map((item) =>
          item.id === existing.id ? { ...item, name, request, updatedAt: now } : item
        )
      );
      return;
    }

    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${now}-${Math.random().toString(16).slice(2)}`;
    const profile: SavedSessionProfile = {
      id,
      name,
      request,
      createdAt: now,
      updatedAt: now
    };
    setSavedSessions((prev) => [profile, ...prev]);
  };

  const loadSavedSessionToForm = (profile: SavedSessionProfile) => {
    setConnectForm(cloneConnectRequest(profile.request));
    setLeftSidebarTab("quick");
    setTopMenu(null);
  };

  const openSavedSession = async (profile: SavedSessionProfile) => {
    await openSessionRequests([profile.request]);
    setTopMenu(null);
  };

  const openAllSavedSessions = async () => {
    await openSessionRequests(savedSessions.map((item) => item.request));
    setTopMenu(null);
  };

  const deleteSavedSession = (profileId: string) => {
    setSavedSessions((prev) => prev.filter((item) => item.id !== profileId));
  };

  const auth = connectForm.auth;
  const activeRoot = sftpRoot.trim() || ".";

  const toggleDir = async (entry: SftpEntry) => {
    if (entry.kind !== "dir") return;
    const isExpanded = sftpExpanded[entry.path];
    setSftpExpanded((prev) => ({ ...prev, [entry.path]: !isExpanded }));
    setCurrentDir(entry.path);
    if (!isExpanded && !sftpChildren[entry.path]) {
      await loadDir(entry.path);
    }
  };

  const openContextMenu = (event: React.MouseEvent, entry: SftpEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  };

  const handleDownload = async (entry: SftpEntry) => {
    setError(null);
    try {
      const localPath = await save({
        title: "下载到本地",
        defaultPath: downloadLocal || entry.name
      });
      if (!localPath || Array.isArray(localPath)) return;
      setDownloadLocal(localPath.toString());
      setDownloadRemote(entry.path);
      await downloadFile(entry.path, localPath.toString());
    } catch (err) {
      setError(`打开保存对话框失败: ${String(err)}`);
    }
  };

  const handleUploadClick = async () => {
    if (!activeSessionId) return;
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        title: "选择要上传的文件"
      });
      if (!selected || Array.isArray(selected)) return;
      const localPath = selected.toString();
      const normalizedLocalPath = localPath.replace(/\\/g, "/");
      const filename = normalizedLocalPath.split("/").pop() || "upload.bin";
      const remotePath = activeRoot === "." ? filename : `${currentDir}/${filename}`;
      setUploadLocal(localPath);
      setUploadRemote(remotePath);
      await uploadFile(localPath, remotePath);
    } catch (err) {
      setError(`打开文件选择器失败: ${String(err)}`);
    }
  };

  const renderEntries = (entries: SftpEntry[], depth = 0) => {
    if (!entries.length) {
      return (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
          此目录为空
        </div>
      );
    }

    return entries.map((entry) => {
      const isDir = entry.kind === "dir";
      const isExpanded = !!sftpExpanded[entry.path];
      const children = sftpChildren[entry.path];
      const isLoading = !!sftpLoading[entry.path];

      return (
        <div key={entry.path} className="space-y-1">
          <div
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1 text-xs transition",
              isDir ? "hover:bg-muted/60" : "hover:bg-muted/40"
            )}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() => (isDir ? toggleDir(entry) : undefined)}
            onContextMenu={(event) =>
              entry.kind === "file" ? openContextMenu(event, entry) : undefined
            }
          >
            <span className="w-4 text-center text-muted-foreground">
              {isDir ? (isExpanded ? "▾" : "▸") : "•"}
            </span>
            <span
              className={cn(
                "truncate",
                isDir ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {entry.name}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {entry.kind.toUpperCase()}
            </span>
          </div>
          {isDir ? (
            <div className="space-y-1">
              {isLoading ? (
                <div
                  className="text-[10px] text-muted-foreground"
                  style={{ paddingLeft: `${depth * 14 + 24}px` }}
                >
                  加载中...
                </div>
              ) : null}
              {isExpanded && children ? renderEntries(children, depth + 1) : null}
            </div>
          ) : null}
        </div>
      );
    });
  };

  const addCommandTab = () => {
    setCommandTabs((prev) => {
      const next = [...prev, createCommandTab(prev.length)];
      setActiveCommandTabId(next[next.length - 1].id);
      return next;
    });
  };

  const closeCommandTab = (tabId: string) => {
    setCommandTabs((prev) => {
      if (prev.length === 1) return prev;
      const next = prev.filter((tab) => tab.id !== tabId);
      if (activeCommandTabId === tabId) {
        setActiveCommandTabId(next[0].id);
      }
      return next;
    });
  };

  const updateCommandInput = (tabId: string, value: string) => {
    setCommandTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId) return tab;
        return {
          ...tab,
          input: value,
          draftInput: tab.historyIndex === -1 ? value : tab.draftInput
        };
      })
    );
  };

  const navigateCommandHistory = (tab: CommandTab, direction: "up" | "down") => {
    if (tab.history.length === 0) return;
    setCommandTabs((prev) =>
      prev.map((item) => {
        if (item.id !== tab.id) return item;
        if (direction === "up") {
          const nextIndex =
            item.historyIndex === -1
              ? 0
              : Math.min(item.historyIndex + 1, item.history.length - 1);
          return {
            ...item,
            historyIndex: nextIndex,
            draftInput: item.historyIndex === -1 ? item.input : item.draftInput,
            input: item.history[nextIndex].command
          };
        }

        if (item.historyIndex <= 0) {
          return {
            ...item,
            historyIndex: -1,
            input: item.draftInput
          };
        }

        const nextIndex = item.historyIndex - 1;
        return {
          ...item,
          historyIndex: nextIndex,
          input: item.history[nextIndex].command
        };
      })
    );
  };

  const runCommand = async (tab: CommandTab) => {
    const trimmed = tab.input.trim();
    if (!trimmed) return;
    if (commandTarget === "current" && !terminalIdRef.current) {
      setError("当前没有活动会话，无法执行命令。请先连接会话。");
      return;
    }

    const commandPayload = tab.input.endsWith("\n") ? tab.input : `${tab.input}\n`;
    try {
      if (commandTarget === "all") {
        const terminalIds = Array.from(terminalBySessionRef.current.values());
        if (terminalIds.length === 0) {
          setError("当前没有活动会话，无法执行命令。请先连接会话。");
          return;
        }
        await Promise.all(
          terminalIds.map((id) =>
            invoke("terminal_write", { terminalId: id, data: commandPayload })
          )
        );
      } else if (terminalIdRef.current) {
        await invoke("terminal_write", {
          terminalId: terminalIdRef.current,
          data: commandPayload
        });
      }
    } catch (err) {
      setError(String(err));
      return;
    }

    const historyItem: CommandHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: tab.input,
      sentAt: Date.now(),
      sessionLabel:
        commandTarget === "all"
          ? "所有会话"
          : activeSessionLabel
    };

    setCommandTabs((prev) =>
      prev.map((item) =>
        item.id === tab.id
          ? {
              ...item,
              input: "",
              draftInput: "",
              historyIndex: -1,
              history: [historyItem, ...item.history]
            }
          : item
      )
    );
  };

  const commandStatus =
    commandTarget === "all"
      ? "发送到: 所有会话"
      : activeSessionLabel
        ? `发送到: ${activeSessionLabel}`
        : "未连接会话";
  const keepaliveLastLabel = lastKeepaliveAt
    ? new Date(lastKeepaliveAt).toLocaleTimeString()
    : "尚未发送";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex h-screen flex-col">
        <header className="flex items-center gap-4 border-b border-border/70 bg-card/90 px-4 py-2 text-xs">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-[0.08em] text-primary">
            TSH
            <Badge variant="outline" className="border-border/70 text-[10px]">
              Terminal Suite
            </Badge>
          </div>
          <nav className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <div className="relative" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className={cn(
                  "rounded px-1 py-0.5 hover:text-foreground",
                  topMenu === "file" && "bg-muted text-foreground"
                )}
                onClick={() => setTopMenu((prev) => (prev === "file" ? null : "file"))}
              >
                File
              </button>
              {topMenu === "file" ? (
                <div className="absolute left-0 top-6 z-50 min-w-[180px] rounded-md border border-border/70 bg-card p-1 shadow-[0_10px_28px_rgba(0,0,0,0.3)]">
                  <button
                    type="button"
                    className="w-full rounded-sm px-2 py-1 text-left text-xs text-foreground hover:bg-muted"
                    onClick={() => {
                      setFileDialogOpen(true);
                      setTopMenu(null);
                    }}
                  >
                    Session Manager...
                  </button>
                </div>
              ) : null}
            </div>
            <span className="cursor-default hover:text-foreground">Edit</span>
            <span className="cursor-default hover:text-foreground">View</span>
            <div className="relative" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className={cn(
                  "rounded px-1 py-0.5 hover:text-foreground",
                  topMenu === "options" && "bg-muted text-foreground"
                )}
                onClick={() => setTopMenu((prev) => (prev === "options" ? null : "options"))}
              >
                Options
              </button>
              {topMenu === "options" ? (
                <div className="absolute left-0 top-6 z-50 min-w-[180px] rounded-md border border-border/70 bg-card p-1 shadow-[0_10px_28px_rgba(0,0,0,0.3)]">
                  <button
                    type="button"
                    className="w-full rounded-sm px-2 py-1 text-left text-xs text-foreground hover:bg-muted"
                    onClick={() => {
                      setOptionsDialogOpen(true);
                      setTopMenu(null);
                    }}
                  >
                    Keepalive Settings...
                  </button>
                </div>
              ) : null}
            </div>
            {["Transfer", "Script", "Tools", "Window", "Help"].map((item) => (
              <span key={item} className="cursor-default hover:text-foreground">
                {item}
              </span>
            ))}
          </nav>
        </header>

        <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-4 py-2">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={refreshSessions}>
              刷新会话
            </Button>
            <Button variant="secondary" size="sm">
              新建标签
            </Button>
            <Button variant="secondary" size="sm">
              发送组合键
            </Button>
            <Button variant="secondary" size="sm" onClick={keepAlive}>
              Keepalive
            </Button>
          </div>
          <div className="ml-auto text-xs text-muted-foreground">
            {activeSessionLabel ? `Active: ${activeSessionLabel}` : "No active session"}
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <aside className="flex w-[280px] border-r border-border/70 bg-card/70">
            <div className="flex w-10 flex-col items-center gap-2 border-r border-border/70 bg-muted/50 py-3 text-[10px] text-muted-foreground">
              {[
                { id: "quick", label: "Quick Connect" },
                { id: "recent", label: "Recent Sessions" },
                { id: "browser", label: "Browser" }
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    "rounded-full border px-2 py-1 transition",
                    leftSidebarTab === tab.id
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "border-border/60 bg-card/80 text-muted-foreground hover:text-foreground"
                  )}
                  style={{ writingMode: "vertical-rl" }}
                  onClick={() => setLeftSidebarTab(tab.id as typeof leftSidebarTab)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
              {leftSidebarTab === "quick" ? (
                <div className="rounded-lg border border-border/70 bg-card/80 p-3 shadow-[inset_0_0_18px_rgba(0,0,0,0.08)]">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold">Quick Connect</div>
                      <div className="text-[11px] text-muted-foreground">
                        SecureCRT style shortcuts
                      </div>
                    </div>
                    <Badge variant="outline" className="border-border/70 text-[10px]">
                      SSH
                    </Badge>
                  </div>
                  <form onSubmit={handleConnect} className="space-y-2 text-xs">
                    <div className="space-y-1">
                      <Label htmlFor="label" className="text-[11px]">
                        连接名称
                      </Label>
                      <Input
                        id="label"
                        placeholder="例如：生产环境"
                        value={connectForm.label ?? ""}
                        onChange={(event) =>
                          setConnectForm((prev) => ({
                            ...prev,
                            label: event.target.value
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="host" className="text-[11px]">
                        Host
                      </Label>
                      <Input
                        id="host"
                        placeholder="192.168.1.10"
                        value={connectForm.host}
                        onChange={(event) =>
                          setConnectForm((prev) => ({ ...prev, host: event.target.value }))
                        }
                        required
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="port" className="text-[11px]">
                          Port
                        </Label>
                        <Input
                          id="port"
                          type="number"
                          min={1}
                          max={65535}
                          value={connectForm.port}
                          onChange={(event) =>
                            setConnectForm((prev) => ({
                              ...prev,
                              port: Number(event.target.value)
                            }))
                          }
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="username" className="text-[11px]">
                          Username
                        </Label>
                        <Input
                          id="username"
                          placeholder="root"
                          value={connectForm.username}
                          onChange={(event) =>
                            setConnectForm((prev) => ({
                              ...prev,
                              username: event.target.value
                            }))
                          }
                          required
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant={auth.kind === "password" ? "default" : "secondary"}
                        className="shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
                        onClick={() =>
                          setConnectForm((prev) => ({
                            ...prev,
                            auth: { kind: "password", password: "" }
                          }))
                        }
                      >
                        Password
                      </Button>
                      <Button
                        type="button"
                        variant={auth.kind === "privateKey" ? "default" : "secondary"}
                        className="shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
                        onClick={() =>
                          setConnectForm((prev) => ({
                            ...prev,
                            auth: {
                              kind: "privateKey",
                              privateKeyPath: "",
                              passphrase: ""
                            }
                          }))
                        }
                      >
                        Private Key
                      </Button>
                    </div>

                    {auth.kind === "password" ? (
                      <div className="space-y-1">
                        <Label htmlFor="password" className="text-[11px]">
                          Password
                        </Label>
                        <Input
                          id="password"
                          type="password"
                          placeholder="请输入密码"
                          value={auth.password}
                          onChange={(event) =>
                            setConnectForm((prev) => ({
                              ...prev,
                              auth: {
                                kind: "password",
                                password: event.target.value
                              }
                            }))
                          }
                          required
                        />
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1">
                          <Label htmlFor="key-path" className="text-[11px]">
                            私钥路径（本机）
                          </Label>
                          <Input
                            id="key-path"
                            placeholder="/Users/name/.ssh/id_rsa"
                            value={auth.privateKeyPath}
                            onChange={(event) =>
                              setConnectForm((prev) => ({
                                ...prev,
                                auth: {
                                  kind: "privateKey",
                                  privateKeyPath: event.target.value,
                                  passphrase: auth.passphrase
                                }
                              }))
                            }
                            required
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="passphrase" className="text-[11px]">
                            私钥口令（可选）
                          </Label>
                          <Input
                            id="passphrase"
                            type="password"
                            placeholder="可留空"
                            value={auth.passphrase ?? ""}
                            onChange={(event) =>
                              setConnectForm((prev) => ({
                                ...prev,
                                auth: {
                                  kind: "privateKey",
                                  privateKeyPath: auth.privateKeyPath,
                                  passphrase: event.target.value
                                }
                              }))
                            }
                          />
                        </div>
                      </>
                    )}

                    <Button type="submit" disabled={loading} className="w-full">
                      {loading ? "处理中..." : "新建连接"}
                    </Button>
                  </form>
                </div>
              ) : null}

              {leftSidebarTab === "recent" ? (
                <div className="rounded-lg border border-border/70 bg-card/80 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold">Recent Sessions</div>
                      <div className="text-[11px] text-muted-foreground">
                        最近连接的服务器
                      </div>
                    </div>
                    <Badge variant="outline" className="border-border/70 text-[10px]">
                      {recentConnections.length}
                    </Badge>
                  </div>
                  <div className="space-y-2">
                    {recentConnections.length === 0 ? (
                      <div className="text-xs text-muted-foreground">暂无历史</div>
                    ) : (
                      recentConnections.map((item, index) => {
                        const label =
                          item.label?.trim() || `${item.username}@${item.host}`;
                        return (
                          <button
                            key={`${label}-${index}`}
                            type="button"
                            onClick={() => void reconnectFromRecent(item)}
                            className="flex w-full items-center justify-between rounded-md border border-border/60 bg-card/90 px-2 py-2 text-xs transition hover:bg-muted/40"
                          >
                            <div className="flex flex-col text-left">
                              <span className="font-medium text-foreground">{label}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {item.host}:{item.port} · {item.auth.kind}
                              </span>
                            </div>
                            <span className="text-[10px] text-muted-foreground">
                              连接
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}

              {leftSidebarTab === "browser" ? (
                <div className="rounded-lg border border-border/70 bg-card/80 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold">SFTP Browser</div>
                      <div className="text-[11px] text-muted-foreground">文件传输</div>
                    </div>
                    <Button variant="secondary" size="sm" onClick={loadRoot}>
                      刷新
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Input
                      value={sftpRoot}
                      onChange={(event) => setSftpRoot(event.target.value)}
                      placeholder="远端根目录，例如 /home 或 ."
                    />
                    <div className="rounded-md border border-border/60 bg-muted/40 p-2">
                      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>根目录：{activeRoot}</span>
                        <span>{loading ? "同步中..." : "就绪"}</span>
                      </div>
                      <div className="mb-2 text-[10px] text-muted-foreground">
                        当前目录：{currentDir}
                      </div>
                      <div className="space-y-1">
                        {sftpTree.length === 0 ? renderEntries([]) : renderEntries(sftpTree)}
                      </div>
                    </div>
                    <Button onClick={handleUploadClick} disabled={loading}>
                      <Upload className="h-4 w-4" />
                      选择文件上传
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </aside>

          <main className="flex-1 overflow-hidden">
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 border-b border-border/70 bg-card/70 px-3 py-2">
                {sessions.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/70 bg-card/60 px-4 py-1 text-xs text-muted-foreground">
                    还没有连接记录。
                  </div>
                ) : (
                  sessions.map((session) => {
                    const label =
                      session.label?.trim() ||
                      `${session.username}@${session.host}`;
                    const isActive = session.id === activeSessionId;
                    return (
                      <div
                        key={session.id}
                        className={cn(
                          "relative flex items-center gap-2 overflow-hidden rounded-md border px-3 py-1 text-xs shadow-[inset_0_0_12px_rgba(0,0,0,0.15)]",
                          isActive
                            ? "border-primary/60 bg-primary/15"
                            : "border-border/70 bg-card/90"
                        )}
                        onClick={() => setActiveSessionId(session.id)}
                      >
                        <div className="absolute left-0 top-0 h-full w-6 -skew-x-12 bg-muted/40" />
                        <div className="relative flex items-center gap-2">
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full",
                              isActive
                                ? "bg-emerald-500"
                                : "bg-amber-400"
                            )}
                          />
                          <span className="font-medium">{label}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="ml-2 h-6 w-6 text-muted-foreground hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            void closeSession(session.id);
                          }}
                        >
                          ×
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
                <div className="rounded-lg border border-border/70 bg-card/80 shadow-[0_18px_35px_rgba(0,0,0,0.18)]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">Terminal</span>
                      <Badge variant="outline" className="border-border/70 text-[10px]">
                        VT100
                      </Badge>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {activeSessionLabel
                        ? `Connected: ${activeSessionLabel}`
                        : "No active session"}
                    </div>
                  </div>
                  <div
                    ref={terminalContainerRef}
                    className="h-[520px] rounded-b-lg border-t border-border/70 bg-[#062b2b] shadow-[inset_0_0_18px_rgba(0,0,0,0.5)]"
                  />
                </div>

                <div className="rounded-lg border border-border/70 bg-card/80">
                  <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2 text-xs">
                    <span className="font-semibold">Command Window</span>
                    <span className="text-[11px] text-muted-foreground">
                      {commandStatus}
                    </span>
                    <div className="ml-2 flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px]">
                      <span className="text-muted-foreground">发送到</span>
                      <button
                        type="button"
                        className={cn(
                          "rounded px-2 py-0.5 text-[11px] transition",
                          commandTarget === "current"
                            ? "bg-primary/20 text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setCommandTarget("current")}
                      >
                        当前
                      </button>
                      <button
                        type="button"
                        className={cn(
                          "rounded px-2 py-0.5 text-[11px] transition",
                          commandTarget === "all"
                            ? "bg-primary/20 text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setCommandTarget("all")}
                      >
                        所有
                      </button>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={addCommandTab}>
                        新增标签
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 border-b border-border/70 bg-muted/30 px-3 py-2">
                    {commandTabs.map((tab) => (
                      <div
                        key={tab.id}
                        className={cn(
                          "flex items-center gap-2 rounded-md border px-3 py-1 text-xs",
                          tab.id === activeCommandTabId
                            ? "border-primary/60 bg-primary/10"
                            : "border-border/70 bg-card/80"
                        )}
                        onClick={() => setActiveCommandTabId(tab.id)}
                      >
                        <span>{tab.title}</span>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            closeCommandTab(tab.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-3 p-3">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>发送命令</span>
                        <span>Enter 执行 · Option/Ctrl + Enter 换行 · ↑/↓ 回溯历史</span>
                      </div>
                      <textarea
                        className="h-[160px] rounded-md border border-border/60 bg-background px-3 py-2 text-xs font-mono text-foreground shadow-[inset_0_0_12px_rgba(0,0,0,0.08)] focus:outline-none focus:ring-2 focus:ring-primary"
                        value={activeCommandTab?.input ?? ""}
                        onChange={(event) =>
                          activeCommandTab
                            ? updateCommandInput(activeCommandTab.id, event.target.value)
                            : undefined
                        }
                        onKeyDown={(event) => {
                          if (!activeCommandTab) return;
                          if (event.nativeEvent.isComposing) return;
                          if (event.key === "Enter" && (event.altKey || event.ctrlKey)) {
                            return;
                          }
                          if (
                            event.key === "Enter" &&
                            !event.metaKey &&
                            !event.shiftKey &&
                            !event.altKey &&
                            !event.ctrlKey
                          ) {
                            event.preventDefault();
                            void runCommand(activeCommandTab);
                            return;
                          }
                          if (event.key === "ArrowUp") {
                            event.preventDefault();
                            navigateCommandHistory(activeCommandTab, "up");
                          }
                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            navigateCommandHistory(activeCommandTab, "down");
                          }
                        }}
                        placeholder="输入命令，例如: show ip int brief"
                      />
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-border/70 bg-card/80 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold">Session Status</span>
                    <Button onClick={keepAlive} disabled={loading} size="sm">
                      Keepalive
                    </Button>
                  </div>
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    {activeSession
                      ? `Connected: ${activeSession.username}@${activeSession.host}:${activeSession.port}`
                      : "先创建一个 SSH 连接。"}
                  </div>
                </div>

                {contextMenu ? (
                  <div
                    className="fixed z-50 w-40 rounded-md border border-border/70 bg-card/95 p-1 text-xs shadow-[0_10px_30px_rgba(0,0,0,0.25)]"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                  >
                    <button
                      type="button"
                      className="w-full rounded-sm px-2 py-1 text-left hover:bg-muted"
                      onClick={() => {
                        void handleDownload(contextMenu.entry);
                        setContextMenu(null);
                      }}
                    >
                      下载到本地
                    </button>
                  </div>
                ) : null}

                {error ? (
                  <Alert variant="destructive">
                    <AlertTitle>发生错误</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            </div>
          </main>
        </div>

        <footer className="flex items-center gap-3 border-t border-border/70 bg-card/90 px-4 py-1 text-[11px] text-muted-foreground">
          <span>Ready</span>
          <span className="ml-auto">{activeSessionLabel ?? "No session"}</span>
        </footer>
      </div>

      {fileDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 p-6"
          onClick={() => setFileDialogOpen(false)}
        >
          <div
            className="w-full max-w-4xl rounded-lg border border-border/70 bg-card p-4 shadow-[0_18px_48px_rgba(0,0,0,0.35)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Session Manager</div>
                <div className="text-[11px] text-muted-foreground">管理保存和已打开的会话</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setFileDialogOpen(false)}>
                关闭
              </Button>
            </div>
            <div className="grid gap-3 lg:grid-cols-[280px_1fr] text-xs">
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-foreground">File Actions</div>
                <Button variant="secondary" size="sm" className="w-full" onClick={saveCurrentSessionProfile}>
                  保存当前连接配置
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={() => void openAllSavedSessions()}
                  disabled={savedSessions.length === 0 || loading}
                >
                  打开全部已保存会话
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={() => void closeAllSessions()}
                  disabled={sessions.length === 0 || loading}
                >
                  关闭全部已打开会话
                </Button>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-semibold text-foreground">Saved Sessions</div>
                  <Badge variant="outline" className="border-border/70 text-[10px]">
                    {savedSessions.length}
                  </Badge>
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {savedSessions.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-muted-foreground">
                      暂无保存的会话，请在 Quick Connect 填写后点击“保存当前连接配置”。
                    </div>
                  ) : (
                    savedSessions.map((profile) => (
                      <div
                        key={profile.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card/80 px-2 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-foreground">{profile.name}</div>
                          <div className="truncate text-[10px] text-muted-foreground">
                            {requestDisplayName(profile.request)}
                          </div>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => loadSavedSessionToForm(profile)}
                        >
                          加载
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={loading}
                          onClick={() => void openSavedSession(profile)}
                        >
                          打开
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => deleteSavedSession(profile.id)}>
                          删除
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {optionsDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 p-6"
          onClick={() => setOptionsDialogOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-border/70 bg-card p-4 shadow-[0_18px_48px_rgba(0,0,0,0.35)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Keepalive Settings</div>
                <div className="text-[11px] text-muted-foreground">设置自动 keepalive 频率</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setOptionsDialogOpen(false)}>
                关闭
              </Button>
            </div>
            <div className="grid gap-3 lg:grid-cols-[320px_1fr] text-xs">
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-foreground">Keepalive</div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={keepaliveEnabled}
                    onChange={(event) => setKeepaliveEnabled(event.target.checked)}
                  />
                  <span>启用自动 Keepalive（所有已连接会话）</span>
                </label>
                <div className="flex items-center gap-2">
                  <Label htmlFor="keepalive-interval" className="text-[11px]">
                    发送频率（秒）
                  </Label>
                  <Input
                    id="keepalive-interval"
                    type="number"
                    min={5}
                    max={3600}
                    className="h-8 w-24"
                    value={keepaliveIntervalSec}
                    onChange={(event) =>
                      setKeepaliveIntervalSec(
                        Math.min(3600, Math.max(5, Math.floor(Number(event.target.value) || 5)))
                      )
                    }
                  />
                </div>
                <div className="text-[11px] text-muted-foreground">
                  上次发送: {keepaliveLastLabel}
                </div>
                <Button variant="secondary" size="sm" onClick={keepAlive} disabled={loading || !activeSessionId}>
                  立即发送到当前会话
                </Button>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">
                启用后，客户端会按照设定频率自动向所有已连接 SSH 会话发送 keepalive。
                该设置会本地持久化，重启应用后仍保留。
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
