import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "xterm-addon-fit";
import { Terminal } from "xterm";
import { ConnectRequest, SessionInfo, SftpEntry } from "./types";

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
    <div className="app-shell">
      <aside className="sidebar">
        <h1>SSH Sessions</h1>
        <form onSubmit={handleConnect} className="panel">
          <input
            placeholder="连接名称（可选）"
            value={connectForm.label ?? ""}
            onChange={(event) =>
              setConnectForm((prev) => ({ ...prev, label: event.target.value }))
            }
          />
          <input
            placeholder="Host"
            value={connectForm.host}
            onChange={(event) =>
              setConnectForm((prev) => ({ ...prev, host: event.target.value }))
            }
            required
          />
          <input
            type="number"
            placeholder="Port"
            min={1}
            max={65535}
            value={connectForm.port}
            onChange={(event) =>
              setConnectForm((prev) => ({ ...prev, port: Number(event.target.value) }))
            }
            required
          />
          <input
            placeholder="Username"
            value={connectForm.username}
            onChange={(event) =>
              setConnectForm((prev) => ({ ...prev, username: event.target.value }))
            }
            required
          />

          <div className="auth-switcher">
            <button
              type="button"
              className={auth.kind === "password" ? "active" : ""}
              onClick={() =>
                setConnectForm((prev) => ({
                  ...prev,
                  auth: { kind: "password", password: "" }
                }))
              }
            >
              Password
            </button>
            <button
              type="button"
              className={auth.kind === "privateKey" ? "active" : ""}
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
            </button>
          </div>

          {auth.kind === "password" ? (
            <input
              type="password"
              placeholder="Password"
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
          ) : (
            <>
              <input
                placeholder="私钥路径（本机）"
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
              <input
                type="password"
                placeholder="私钥口令（可选）"
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
            </>
          )}

          <button type="submit" disabled={loading}>
            {loading ? "处理中..." : "新建连接"}
          </button>
        </form>

        <button className="refresh" disabled={loading} onClick={refreshSessions}>
          刷新会话
        </button>
      </aside>

      <main className="main">
        <div className="tabs">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`tab ${session.id === activeSessionId ? "active" : ""}`}
              onClick={() => setActiveSessionId(session.id)}
            >
              <span>{session.label}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void closeSession(session.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <section className="panel">
          <h2>交互式终端</h2>
          <div ref={terminalContainerRef} className="terminal-container" />
        </section>

        {activeSession ? (
          <>
            <section className="panel">
              <h2>会话信息</h2>
              <p>
                {activeSession.username}@{activeSession.host}:{activeSession.port}
              </p>
              <p>Connected: {new Date(activeSession.connectedAt).toLocaleString()}</p>
              <p>Last Active: {new Date(activeSession.lastActiveAt).toLocaleString()}</p>
              <button onClick={keepAlive} disabled={loading}>
                发送 Keepalive
              </button>
            </section>

            <section className="panel">
              <h2>命令执行（非交互）</h2>
              <div className="row">
                <input
                  value={commandInput}
                  onChange={(event) => setCommandInput(event.target.value)}
                  placeholder="输入远端命令"
                />
                <button onClick={runCommand} disabled={loading}>
                  运行
                </button>
              </div>
              <pre>
                {commandOutput
                  ? `exit=${commandOutput.exitCode}\n\nSTDOUT:\n${commandOutput.stdout}\n\nSTDERR:\n${commandOutput.stderr}`
                  : "暂无输出"}
              </pre>
            </section>

            <section className="panel">
              <h2>SFTP</h2>
              <div className="row">
                <input
                  value={remoteDir}
                  onChange={(event) => setRemoteDir(event.target.value)}
                  placeholder="远端目录"
                />
                <button onClick={listDir} disabled={loading}>
                  列目录
                </button>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>大小</th>
                    <th>路径</th>
                  </tr>
                </thead>
                <tbody>
                  {sftpEntries.map((entry) => (
                    <tr key={`${entry.path}-${entry.name}`}>
                      <td>{entry.name}</td>
                      <td>{entry.kind}</td>
                      <td>{entry.size ?? "-"}</td>
                      <td>{entry.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="row row-three">
                <input
                  placeholder="本地文件路径"
                  value={uploadLocal}
                  onChange={(event) => setUploadLocal(event.target.value)}
                />
                <input
                  placeholder="远端目标路径"
                  value={uploadRemote}
                  onChange={(event) => setUploadRemote(event.target.value)}
                />
                <button onClick={uploadFile} disabled={loading}>
                  上传
                </button>
              </div>

              <div className="row row-three">
                <input
                  placeholder="远端文件路径"
                  value={downloadRemote}
                  onChange={(event) => setDownloadRemote(event.target.value)}
                />
                <input
                  placeholder="本地目标路径"
                  value={downloadLocal}
                  onChange={(event) => setDownloadLocal(event.target.value)}
                />
                <button onClick={downloadFile} disabled={loading}>
                  下载
                </button>
              </div>
            </section>
          </>
        ) : (
          <section className="panel empty">先创建一个 SSH 连接。</section>
        )}

        {error ? <div className="error">{error}</div> : null}
      </main>
    </div>
  );
}
