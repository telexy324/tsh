#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ssh2::{Channel, Session};
use tauri::State;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("SSH error: {0}")]
    Ssh(#[from] ssh2::Error),
    #[error("Session not found")]
    SessionNotFound,
    #[error("Terminal not found")]
    TerminalNotFound,
    #[error("Authentication failed")]
    AuthFailed,
    #[error("Invalid input: {0}")]
    InvalidInput(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum AuthMethod {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "privateKey")]
    PrivateKey {
        #[serde(rename = "privateKeyPath")]
        private_key_path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
struct ConnectRequest {
    label: Option<String>,
    host: String,
    port: u16,
    username: String,
    auth: AuthMethod,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    label: String,
    host: String,
    port: u16,
    username: String,
    connected_at: DateTime<Utc>,
    last_active_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Debug, Serialize)]
struct KeepaliveStatus {
    seconds_to_next: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpEntry {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
    permissions: Option<u32>,
    modified_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStartResult {
    terminal_id: String,
}

struct SshSession {
    info: SessionInfo,
    session: Session,
    _tcp: TcpStream,
}

struct TerminalSession {
    session_id: String,
    channel: Channel,
}

#[derive(Clone, Default)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    terminals: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

fn now_utc() -> DateTime<Utc> {
    Utc::now()
}

fn set_last_active(session: &mut SshSession) {
    session.info.last_active_at = now_utc();
}

fn connect_ssh(request: ConnectRequest) -> AppResult<SshSession> {
    if request.host.trim().is_empty() || request.username.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "host and username are required".to_string(),
        ));
    }

    let address = format!("{}:{}", request.host.trim(), request.port);
    let tcp = TcpStream::connect(address)?;
    tcp.set_nodelay(true)?;

    let mut session = Session::new()?;
    session.set_tcp_stream(tcp.try_clone()?);
    session.handshake()?;

    match request.auth {
        AuthMethod::Password { password } => {
            session.userauth_password(request.username.trim(), password.as_str())?;
        }
        AuthMethod::PrivateKey {
            private_key_path,
            passphrase,
        } => {
            session.userauth_pubkey_file(
                request.username.trim(),
                None,
                Path::new(private_key_path.trim()),
                passphrase.as_deref(),
            )?;
        }
    }

    if !session.authenticated() {
        return Err(AppError::AuthFailed);
    }

    session.set_keepalive(true, 30);

    let id = Uuid::new_v4().to_string();
    let connected_at = now_utc();
    let label = request
        .label
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("{}@{}", request.username, request.host));

    Ok(SshSession {
        info: SessionInfo {
            id,
            label,
            host: request.host,
            port: request.port,
            username: request.username,
            connected_at,
            last_active_at: connected_at,
        },
        session,
        _tcp: tcp,
    })
}

#[tauri::command]
fn create_session(state: State<'_, AppState>, request: ConnectRequest) -> AppResult<SessionInfo> {
    let created = connect_ssh(request)?;
    let session_info = created.info.clone();

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    sessions.insert(session_info.id.clone(), created);

    Ok(session_info)
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> AppResult<Vec<SessionInfo>> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;

    let mut list: Vec<SessionInfo> = sessions.values().map(|item| item.info.clone()).collect();
    list.sort_by(|a, b| b.connected_at.cmp(&a.connected_at));
    Ok(list)
}

#[tauri::command]
fn close_session(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;

        sessions
            .remove(&session_id)
            .ok_or(AppError::SessionNotFound)
            .map(|_| ())?;
    }

    let mut terminals = state
        .terminals
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;

    let keys: Vec<String> = terminals
        .iter()
        .filter(|(_, terminal)| terminal.session_id == session_id)
        .map(|(id, _)| id.clone())
        .collect();

    for terminal_id in keys {
        if let Some(mut terminal) = terminals.remove(&terminal_id) {
            let _ = terminal.channel.close();
            let _ = terminal.channel.wait_close();
        }
    }

    Ok(())
}

#[tauri::command]
fn run_command(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> AppResult<CommandOutput> {
    if command.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "command cannot be empty".to_string(),
        ));
    }

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    let item = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound)?;

    let mut channel = item.session.channel_session()?;
    channel.exec(command.as_str())?;

    let mut stdout = String::new();
    channel.read_to_string(&mut stdout)?;

    let mut stderr = String::new();
    channel.stderr().read_to_string(&mut stderr)?;

    channel.wait_close()?;
    let exit_code = channel.exit_status()?;

    set_last_active(item);

    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code,
    })
}

#[tauri::command]
fn send_keepalive(state: State<'_, AppState>, session_id: String) -> AppResult<KeepaliveStatus> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;

    let item = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound)?;

    let seconds_to_next = item.session.keepalive_send()?;
    set_last_active(item);

    Ok(KeepaliveStatus { seconds_to_next })
}

#[tauri::command]
fn sftp_list_dir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<Vec<SftpEntry>> {
    let normalized = if path.trim().is_empty() {
        "."
    } else {
        path.trim()
    };

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    let item = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound)?;

    let sftp = item.session.sftp()?;
    let entries = sftp.readdir(Path::new(normalized))?;

    let mapped = entries
        .into_iter()
        .map(|(path_buf, stat)| {
            let name = path_buf
                .file_name()
                .and_then(|x| x.to_str())
                .unwrap_or_default()
                .to_string();
            let path = path_buf.to_string_lossy().to_string();
            let permissions = stat.perm;
            let kind = permissions
                .map(|perm| match perm & 0o170000 {
                    0o040000 => "dir",
                    0o100000 => "file",
                    0o120000 => "symlink",
                    _ => "unknown",
                })
                .unwrap_or("unknown")
                .to_string();

            SftpEntry {
                name,
                path,
                kind,
                size: stat.size,
                permissions,
                modified_at: stat.mtime,
            }
        })
        .collect();

    set_last_active(item);

    Ok(mapped)
}

#[tauri::command]
fn sftp_upload(
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> AppResult<()> {
    if local_path.trim().is_empty() || remote_path.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "local_path and remote_path are required".to_string(),
        ));
    }

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    let item = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound)?;

    let mut local_file = File::open(local_path.trim())?;
    let sftp = item.session.sftp()?;
    let mut remote_file = sftp.create(Path::new(remote_path.trim()))?;
    std::io::copy(&mut local_file, &mut remote_file)?;
    remote_file.flush()?;

    set_last_active(item);

    Ok(())
}

#[tauri::command]
fn sftp_download(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> AppResult<()> {
    if local_path.trim().is_empty() || remote_path.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "local_path and remote_path are required".to_string(),
        ));
    }

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    let item = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound)?;

    let sftp = item.session.sftp()?;
    let mut remote_file = sftp.open(Path::new(remote_path.trim()))?;
    let mut local_file = File::create(local_path.trim())?;
    std::io::copy(&mut remote_file, &mut local_file)?;
    local_file.flush()?;

    set_last_active(item);

    Ok(())
}

#[tauri::command]
fn start_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<TerminalStartResult> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    let item = sessions
        .get_mut(&session_id)
        .ok_or(AppError::SessionNotFound)?;

    let mut channel = item.session.channel_session()?;
    let dimensions = Some((cols.max(20), rows.max(5), 0, 0));
    channel.request_pty("xterm-256color", None, dimensions)?;
    channel.shell()?;
    item.session.set_blocking(false);
    set_last_active(item);

    let terminal_id = Uuid::new_v4().to_string();
    drop(sessions);

    let terminal = TerminalSession {
        session_id,
        channel,
    };

    let mut terminals = state
        .terminals
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    terminals.insert(terminal_id.clone(), terminal);

    Ok(TerminalStartResult { terminal_id })
}

#[tauri::command]
fn terminal_write(state: State<'_, AppState>, terminal_id: String, data: String) -> AppResult<()> {
    let session_id = {
        let mut terminals = state
            .terminals
            .lock()
            .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
        let terminal = terminals
            .get_mut(&terminal_id)
            .ok_or(AppError::TerminalNotFound)?;
        terminal.channel.write_all(data.as_bytes())?;
        terminal.channel.flush()?;
        terminal.session_id.clone()
    };

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    if let Some(item) = sessions.get_mut(&session_id) {
        set_last_active(item);
    }

    Ok(())
}

#[tauri::command]
fn terminal_read(state: State<'_, AppState>, terminal_id: String) -> AppResult<String> {
    let session_id;
    let mut output = Vec::<u8>::new();
    {
        let mut terminals = state
            .terminals
            .lock()
            .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
        let terminal = terminals
            .get_mut(&terminal_id)
            .ok_or(AppError::TerminalNotFound)?;
        session_id = terminal.session_id.clone();

        let mut buf = [0_u8; 4096];
        loop {
            match terminal.channel.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => output.extend_from_slice(&buf[..n]),
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(err) => return Err(AppError::Io(err)),
            }
        }

        loop {
            match terminal.channel.stderr().read(&mut buf) {
                Ok(0) => break,
                Ok(n) => output.extend_from_slice(&buf[..n]),
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(err) => return Err(AppError::Io(err)),
            }
        }
    }

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    if let Some(item) = sessions.get_mut(&session_id) {
        set_last_active(item);
    }

    Ok(String::from_utf8_lossy(&output).to_string())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    let mut terminals = state
        .terminals
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    let terminal = terminals
        .get_mut(&terminal_id)
        .ok_or(AppError::TerminalNotFound)?;
    terminal
        .channel
        .request_pty_size(cols.max(20), rows.max(5), None, None)?;
    Ok(())
}

#[tauri::command]
fn close_terminal(state: State<'_, AppState>, terminal_id: String) -> AppResult<()> {
    let mut terminals = state
        .terminals
        .lock()
        .map_err(|_| AppError::InvalidInput("state lock poisoned".to_string()))?;
    let mut terminal = terminals
        .remove(&terminal_id)
        .ok_or(AppError::TerminalNotFound)?;
    let _ = terminal.channel.close();
    let _ = terminal.channel.wait_close();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            create_session,
            list_sessions,
            close_session,
            run_command,
            send_keepalive,
            sftp_list_dir,
            sftp_upload,
            sftp_download,
            start_terminal,
            terminal_write,
            terminal_read,
            terminal_resize,
            close_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}
