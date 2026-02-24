import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "xterm-addon-fit";
import { Terminal } from "xterm";
import { ConnectRequest, SessionInfo, SftpEntry } from "./types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TerminalStartResult {
  terminalId: string;
}

const initialForm: ConnectRequest = {
  label: "",
  host: "",
  port: 22,
  username: "",
  auth: { kind: "password", password: "" }
};

export default function App() {
  const [connectForm, setConnectForm] = useState<ConnectRequest>(initialForm);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState("uname -a");
  const [commandOutput, setCommandOutput] = useState<CommandResult | null>(null);
  const [remoteDir, setRemoteDir] = useState(".");
  const [sftpEntries, setSftpEntries] = useState<SftpEntry[]>([]);
  const [uploadLocal, setUploadLocal] = useState("");
  const [uploadRemote, setUploadRemote] = useState("");
  const [downloadRemote, setDownloadRemote] = useState("");
  const [downloadLocal, setDownloadLocal] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

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

  const closeTerminalInstance = async () => {
    const id = terminalIdRef.current;
    if (!id) return;
    try {
      await invoke("close_terminal", { terminalId: id });
    } catch {
      // ignore close errors
    }
    terminalIdRef.current = null;
    setTerminalId(null);
  };

  const startTerminalForActiveSession = async (sessionId: string) => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    await closeTerminalInstance();
    term.clear();
    term.writeln(`Connecting interactive shell to session ${sessionId}...`);

    const result = await invoke<TerminalStartResult>("start_terminal", {
      sessionId,
      cols: term.cols,
      rows: term.rows
    });

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
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#0b1320",
        foreground: "#dbeafe",
        cursor: "#93c5fd"
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
      void closeTerminalInstance();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      void closeTerminalInstance();
      const term = xtermRef.current;
      if (term) {
        term.clear();
        term.writeln("No active SSH session. Create or select a tab.");
      }
      return;
    }

    void startTerminalForActiveSession(activeSessionId).catch((err) => {
      setError(String(err));
    });
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
      } catch {
        // ignore transient read errors
      }
    }, 80);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminalId]);

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
      const created = await invoke<SessionInfo>("create_session", {
        request: connectForm
      });
      setSessions((prev) => [created, ...prev]);
      setActiveSessionId(created.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const closeSession = async (sessionId: string) => {
    setLoading(true);
    setError(null);
    try {
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

  const runCommand = async () => {
    if (!activeSessionId) return;
    setLoading(true);
    setError(null);
    try {
      const output = await invoke<CommandResult>("run_command", {
        sessionId: activeSessionId,
        command: commandInput
      });
      setCommandOutput(output);
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const listDir = async () => {
    if (!activeSessionId) return;
    setLoading(true);
    setError(null);
    try {
      const entries = await invoke<SftpEntry[]>("sftp_list_dir", {
        sessionId: activeSessionId,
        path: remoteDir
      });
      setSftpEntries(entries);
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const uploadFile = async () => {
    if (!activeSessionId) return;
    setLoading(true);
    setError(null);
    try {
      await invoke("sftp_upload", {
        sessionId: activeSessionId,
        localPath: uploadLocal,
        remotePath: uploadRemote
      });
      await listDir();
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  };

  const downloadFile = async () => {
    if (!activeSessionId) return;
    setLoading(true);
    setError(null);
    try {
      await invoke("sftp_download", {
        sessionId: activeSessionId,
        remotePath: downloadRemote,
        localPath: downloadLocal
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
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const auth = connectForm.auth;

  return (
    <div className="min-h-screen text-foreground">
      <div className="min-h-screen p-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/60 bg-card/70 px-4 py-3 shadow-[0_12px_30px_rgba(0,0,0,0.3)] backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 shadow-[0_0_18px_rgba(245,158,11,0.6)]" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold tracking-tight">
                  MobaXterm Control
                </span>
                <Badge variant="secondary" className="border border-border/60">
                  SSH Center
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                多会话管理 · 终端 · SFTP
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm">
              新建会话
            </Button>
            <Button variant="secondary" size="sm">
              导入书签
            </Button>
            <Button variant="secondary" size="sm">
              终端设置
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={refreshSessions}
            >
              刷新
            </Button>
          </div>
        </header>

        <div className="grid min-h-[calc(100vh-160px)] gap-6 md:grid-cols-[320px_1fr]">
          <aside className="space-y-4">
            <Card className="border-border/70 bg-card/80 shadow-[0_12px_30px_rgba(0,0,0,0.25)]">
            <CardHeader>
              <CardTitle>新建连接</CardTitle>
              <CardDescription>快速建立一个新的 SSH 会话。</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleConnect} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="label">连接名称（可选）</Label>
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
                    <Label htmlFor="host">Host</Label>
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
                  <div className="space-y-1">
                    <Label htmlFor="port">Port</Label>
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
                    <Label htmlFor="username">Username</Label>
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

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant={auth.kind === "password" ? "default" : "secondary"}
                      className="shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]"
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
                      className="shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]"
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
                      <Label htmlFor="password">Password</Label>
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
                        <Label htmlFor="key-path">私钥路径（本机）</Label>
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
                        <Label htmlFor="passphrase">私钥口令（可选）</Label>
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
            </CardContent>
          </Card>

            <Card className="border-border/70 bg-card/80">
              <CardHeader>
                <CardTitle>会话树</CardTitle>
                <CardDescription>按分组浏览和快速切换。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="rounded-lg border border-border/70 bg-muted/50 p-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>已连接</span>
                    <span>{sessions.length}</span>
                  </div>
                  <div className="mt-2 space-y-2">
                    {sessions.length === 0 ? (
                      <div className="text-xs text-muted-foreground">
                        暂无会话
                      </div>
                    ) : (
                      sessions.map((session) => {
                        const label =
                          session.label?.trim() ||
                          `${session.username}@${session.host}`;
                        const isActive = session.id === activeSessionId;
                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => setActiveSessionId(session.id)}
                            className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 transition ${
                              isActive
                                ? "bg-primary/20 text-foreground"
                                : "hover:bg-muted"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`h-2.5 w-2.5 rounded-full ${
                                  isActive
                                    ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]"
                                    : "bg-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.7)]"
                                }`}
                              />
                              <span className="truncate text-left text-xs">
                                {label}
                              </span>
                            </div>
                            <span className="text-[10px] text-muted-foreground">
                              SSH
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
        </aside>

        <main className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {sessions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 bg-card/60 px-4 py-2 text-sm text-muted-foreground">
                还没有连接记录。
              </div>
            ) : (
              sessions.map((session) => {
                const label =
                  session.label?.trim() || `${session.username}@${session.host}`;
                const isActive = session.id === activeSessionId;
                return (
                  <div
                    key={session.id}
                    className={`relative flex items-center gap-2 overflow-hidden rounded-md border px-4 py-2 text-sm shadow-[inset_0_0_12px_rgba(0,0,0,0.25)] ${
                      isActive
                        ? "border-primary/60 bg-primary/15"
                        : "border-border/70 bg-card/80"
                    }`}
                    onClick={() => setActiveSessionId(session.id)}
                  >
                    <div className="absolute left-0 top-0 h-full w-8 -skew-x-12 bg-muted/40" />
                    <div className="relative flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          isActive
                            ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]"
                            : "bg-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.7)]"
                        }`}
                      />
                      <span className="font-medium">{label}</span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-2 h-7 w-7 text-muted-foreground hover:text-foreground"
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

          <Card className="border-border/70 bg-card/80 shadow-[0_18px_35px_rgba(0,0,0,0.3)]">
            <CardHeader>
              <CardTitle>交互式终端</CardTitle>
              <CardDescription>直接在当前会话中操作 Shell。</CardDescription>
            </CardHeader>
            <CardContent>
              <div
                ref={terminalContainerRef}
                className="h-[320px] rounded-lg border border-border/70 bg-[#0b111a] shadow-[inset_0_0_20px_rgba(0,0,0,0.6)]"
              />
            </CardContent>
          </Card>

            {activeSession ? (
              <>
                <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
                  <Card className="border-border/70 bg-card/80">
                    <CardHeader>
                      <CardTitle>会话信息</CardTitle>
                      <CardDescription>当前连接的实时状态。</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">地址</span>
                        <span>
                          {activeSession.username}@{activeSession.host}:
                          {activeSession.port}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Connected</span>
                        <span>
                          {new Date(activeSession.connectedAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Last Active</span>
                        <span>
                          {new Date(activeSession.lastActiveAt).toLocaleString()}
                        </span>
                      </div>
                      <Separator className="my-3 bg-border/70" />
                      <Button onClick={keepAlive} disabled={loading} className="w-full">
                        发送 Keepalive
                      </Button>
                    </CardContent>
                  </Card>

                  <Card className="border-border/70 bg-card/80">
                    <CardHeader>
                      <CardTitle>命令执行（非交互）</CardTitle>
                      <CardDescription>快速执行一次性命令。</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={commandInput}
                          onChange={(event) => setCommandInput(event.target.value)}
                          placeholder="输入远端命令"
                        />
                        <Button onClick={runCommand} disabled={loading}>
                          运行
                        </Button>
                      </div>
                      <pre className="min-h-[160px] whitespace-pre-wrap rounded-lg border border-border/70 bg-[#0b111a] p-3 text-xs text-slate-200">
                        {commandOutput
                          ? `exit=${commandOutput.exitCode}\n\nSTDOUT:\n${commandOutput.stdout}\n\nSTDERR:\n${commandOutput.stderr}`
                          : "暂无输出"}
                      </pre>
                    </CardContent>
                  </Card>
                </div>

                <Card className="border-border/70 bg-card/80">
                  <CardHeader>
                    <CardTitle>SFTP</CardTitle>
                    <CardDescription>浏览与传输远端文件。</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        value={remoteDir}
                        onChange={(event) => setRemoteDir(event.target.value)}
                        placeholder="远端目录"
                      />
                      <Button onClick={listDir} disabled={loading}>
                        列目录
                      </Button>
                    </div>

                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>名称</TableHead>
                          <TableHead>类型</TableHead>
                          <TableHead>大小</TableHead>
                          <TableHead>路径</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sftpEntries.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center">
                              暂无文件记录
                            </TableCell>
                          </TableRow>
                        ) : (
                          sftpEntries.map((entry) => (
                            <TableRow key={`${entry.path}-${entry.name}`}>
                              <TableCell>{entry.name}</TableCell>
                              <TableCell>{entry.kind}</TableCell>
                              <TableCell>{entry.size ?? "-"}</TableCell>
                              <TableCell>{entry.path}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>

                    <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                      <Input
                        placeholder="本地文件路径"
                        value={uploadLocal}
                        onChange={(event) => setUploadLocal(event.target.value)}
                      />
                      <Input
                        placeholder="远端目标路径"
                        value={uploadRemote}
                        onChange={(event) => setUploadRemote(event.target.value)}
                      />
                      <Button onClick={uploadFile} disabled={loading}>
                        上传
                      </Button>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                      <Input
                        placeholder="远端文件路径"
                        value={downloadRemote}
                        onChange={(event) => setDownloadRemote(event.target.value)}
                      />
                      <Input
                        placeholder="本地目标路径"
                        value={downloadLocal}
                        onChange={(event) => setDownloadLocal(event.target.value)}
                      />
                      <Button onClick={downloadFile} disabled={loading}>
                        下载
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card className="border-border/70 bg-card/80">
                <CardContent className="py-10 text-center text-muted-foreground">
                  先创建一个 SSH 连接。
                </CardContent>
              </Card>
            )}

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>发生错误</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}
