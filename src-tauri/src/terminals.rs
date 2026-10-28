use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct TerminalProcess {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct TerminalStreams(Mutex<HashMap<String, TerminalProcess>>, AtomicBool);

impl Drop for TerminalStreams {
    fn drop(&mut self) {
        if let Ok(streams) = self.0.get_mut() {
            for (_, mut terminal) in streams.drain() {
                if let Err(error) = terminate(&mut terminal.child) {
                    eprintln!("Erro ao encerrar terminal: {error}");
                }
            }
        }
    }
}

impl TerminalStreams {
    pub fn close_all(&self) -> Result<(), String> {
        self.1.store(true, Ordering::SeqCst);
        let mut streams = self
            .0
            .lock()
            .map_err(|error| format!("Erro no controle dos terminais: {error}"))?;
        let mut errors = Vec::new();
        for terminal in streams.values_mut() {
            if let Err(error) = terminate(&mut terminal.child) {
                errors.push(error);
            }
        }
        streams.clear();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn terminate(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("Erro ao encerrar processo do terminal: {error}"));
            }
        }
    }
    #[cfg(not(unix))]
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        child
            .kill()
            .map_err(|error| format!("Erro ao parar terminal: {error}"))?;
    }
    child
        .wait()
        .map_err(|error| format!("Erro ao aguardar terminal: {error}"))?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct TerminalOutput {
    stream_id: String,
    text: String,
}

#[derive(Clone, serde::Serialize)]
struct TerminalEnd {
    stream_id: String,
    error: Option<String>,
}

fn emit_text(app: &AppHandle, stream_id: &str, text: String) {
    if let Err(error) = app.emit(
        "docker-terminal-output",
        TerminalOutput {
            stream_id: stream_id.to_string(),
            text,
        },
    ) {
        eprintln!("Erro ao emitir saída do terminal: {error}");
    }
}

#[tauri::command]
pub async fn start_service_terminal(
    app: AppHandle,
    project_path: String,
    docker_context: String,
    profiles: Vec<String>,
    env_file: Option<String>,
    service: String,
    stream_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::docker::validate_context(&docker_context)?;
        let options = crate::docker::ComposeOptions { profiles, env_file };
        crate::docker::validate_services_with_options(
            Some(&docker_context),
            &project_path,
            &options,
            std::slice::from_ref(&service),
        )?;
        let state = app.state::<TerminalStreams>();
        let mut terminals = state
            .0
            .lock()
            .map_err(|error| format!("Erro no controle dos terminais: {error}"))?;
        if state.1.load(Ordering::SeqCst) {
            return Err("A janela do terminal foi encerrada.".into());
        }
        if terminals.contains_key(&stream_id) {
            return Err("Este terminal já está aberto.".into());
        }
        let mut command = Command::new("docker");
        command.args(["--context", &docker_context, "compose"]);
        for profile in &options.profiles {
            crate::docker::validate_profile(profile)?;
            command.args(["--profile", profile]);
        }
        if let Some(env_file) = options.env_file.as_deref() {
            crate::docker::validate_env_file(&project_path, env_file)?;
            command.args(["--env-file", env_file]);
        }
        command
            .args(["exec", "--interactive", "--no-TTY", &service, "sh"])
            .current_dir(project_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Erro ao abrir terminal para {service}: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Não foi possível abrir a entrada do terminal.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Não foi possível abrir a saída do terminal.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Não foi possível abrir erros do terminal.".to_string())?;
        terminals.insert(stream_id.clone(), TerminalProcess { child, stdin });
        drop(terminals);

        let pipes: [Box<dyn Read + Send>; 2] = [Box::new(stdout), Box::new(stderr)];
        for pipe in pipes {
            let app = app.clone();
            let stream_id = stream_id.clone();
            std::thread::spawn(move || {
                let mut pipe = pipe;
                let mut buffer = [0; 4096];
                loop {
                    match pipe.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => emit_text(
                            &app,
                            &stream_id,
                            String::from_utf8_lossy(&buffer[..count]).into_owned(),
                        ),
                        Err(error) => {
                            emit_text(
                                &app,
                                &stream_id,
                                format!("\r\nErro ao ler saída do terminal: {error}\r\n"),
                            );
                            break;
                        }
                    }
                }
            });
        }

        std::thread::spawn(move || {
            let error = loop {
                let state = app.state::<TerminalStreams>();
                let mut terminals = match state.0.lock() {
                    Ok(terminals) => terminals,
                    Err(error) => break Some(format!("Erro no controle dos terminais: {error}")),
                };
                let Some(terminal) = terminals.get_mut(&stream_id) else {
                    break None;
                };
                match terminal.child.try_wait() {
                    Ok(Some(status)) => {
                        terminals.remove(&stream_id);
                        break (!status.success())
                            .then(|| format!("Shell do container encerrado com {status}."));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let cleanup = terminate(&mut terminal.child);
                        terminals.remove(&stream_id);
                        break Some(format!(
                            "Erro ao consultar terminal: {error}; encerramento: {cleanup:?}"
                        ));
                    }
                }
                drop(terminals);
                std::thread::sleep(Duration::from_millis(100));
            };
            if let Err(error) = app.emit("docker-terminal-end", TerminalEnd { stream_id, error }) {
                eprintln!("Erro ao notificar fim do terminal: {error}");
            }
        });
        Ok(())
    })
    .await
    .map_err(|error| format!("Erro ao iniciar terminal: {error}"))?
}

#[tauri::command]
pub fn write_service_terminal(
    app: AppHandle,
    stream_id: String,
    input: String,
) -> Result<(), String> {
    if input.len() > 8_000 || input.contains('\0') {
        return Err("Entrada de terminal inválida ou muito longa.".into());
    }
    let state = app.state::<TerminalStreams>();
    let mut terminals = state
        .0
        .lock()
        .map_err(|error| format!("Erro no controle dos terminais: {error}"))?;
    let terminal = terminals
        .get_mut(&stream_id)
        .ok_or_else(|| "Terminal não encontrado ou já encerrado.".to_string())?;
    terminal
        .stdin
        .write_all(input.as_bytes())
        .and_then(|()| terminal.stdin.flush())
        .map_err(|error| format!("Erro ao enviar comando ao terminal: {error}"))
}

#[tauri::command]
pub fn stop_service_terminal(app: AppHandle, stream_id: String) -> Result<(), String> {
    let state = app.state::<TerminalStreams>();
    let mut terminals = state
        .0
        .lock()
        .map_err(|error| format!("Erro no controle dos terminais: {error}"))?;
    if let Some(mut terminal) = terminals.remove(&stream_id) {
        terminate(&mut terminal.child)?;
    }
    Ok(())
}
