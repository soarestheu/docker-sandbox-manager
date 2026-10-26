use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct LogStreams(Mutex<HashMap<String, Child>>, AtomicBool);

impl Drop for LogStreams {
    fn drop(&mut self) {
        match self.0.get_mut() {
            Ok(streams) => {
                for (_, mut child) in streams.drain() {
                    if let Err(err) = terminate(&mut child) {
                        eprintln!("Erro ao encerrar captura de logs: {err}");
                    }
                }
            }
            Err(err) => eprintln!("Erro no controle de logs: {err}"),
        }
    }
}

impl LogStreams {
    pub fn close_all(&self) -> Result<(), String> {
        self.1.store(true, Ordering::SeqCst);
        let mut streams = self
            .0
            .lock()
            .map_err(|err| format!("Erro no controle de logs: {err}"))?;
        let mut errors = Vec::new();
        for child in streams.values_mut() {
            if let Err(err) = terminate(child) {
                errors.push(err);
            }
        }
        streams.retain(|_, child| !matches!(child.try_wait(), Ok(Some(_))));
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
        // Docker CLI can spawn a Compose plugin; terminate its isolated group as well.
        let result = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        if result != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("Erro ao encerrar grupo de captura: {err}"));
            }
        }
    }
    #[cfg(not(unix))]
    if child.try_wait().map_err(|err| err.to_string())?.is_none() {
        child
            .kill()
            .map_err(|err| format!("Erro ao parar captura de logs: {err}"))?;
    }
    child
        .wait()
        .map_err(|err| format!("Erro ao aguardar captura de logs: {err}"))?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct LogPayload {
    stream_id: String,
    log_line: String,
}

#[derive(Clone, serde::Serialize)]
struct EndPayload {
    stream_id: String,
    error: Option<String>,
}

#[tauri::command]
pub async fn start_service_logs(
    app: AppHandle,
    project_path: String,
    service: String,
    stream_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::docker::validate_services(&project_path, std::slice::from_ref(&service))?;
        let state = app.state::<LogStreams>();
        let mut streams = state
            .0
            .lock()
            .map_err(|err| format!("Erro no controle de logs: {err}"))?;
        if state.1.load(Ordering::SeqCst) {
            return Err("A janela de logs foi encerrada.".into());
        }
        if streams.contains_key(&stream_id) {
            return Err("Esta captura já está aberta.".into());
        }
        let mut command = Command::new("docker");
        command
            .args([
                "compose",
                "logs",
                "--follow",
                "--tail",
                "100",
                "--no-color",
                &service,
            ])
            .current_dir(project_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|err| format!("Erro ao abrir logs de {service}: {err}"))?;
        let pipes = [
            child
                .stdout
                .take()
                .map(|pipe| Box::new(pipe) as Box<dyn std::io::Read + Send>),
            child
                .stderr
                .take()
                .map(|pipe| Box::new(pipe) as Box<dyn std::io::Read + Send>),
        ];
        streams.insert(stream_id.clone(), child);
        drop(streams);
        std::thread::spawn(move || {
            let readers: Vec<_> = pipes
                .into_iter()
                .flatten()
                .map(|pipe| {
                    let app = app.clone();
                    let id = stream_id.clone();
                    std::thread::spawn(move || {
                        for line in BufReader::new(pipe).lines() {
                            match line {
                                Ok(log_line) => {
                                    if let Err(err) = app.emit(
                                        "docker-log",
                                        LogPayload {
                                            stream_id: id.clone(),
                                            log_line,
                                        },
                                    ) {
                                        eprintln!("Erro ao emitir logs: {err}");
                                    }
                                }
                                Err(err) => {
                                    eprintln!("Erro ao ler logs: {err}");
                                    break;
                                }
                            }
                        }
                    })
                })
                .collect();
            let error = loop {
                let state = app.state::<LogStreams>();
                let mut streams = match state.0.lock() {
                    Ok(streams) => streams,
                    Err(err) => break Some(format!("Erro no controle de logs: {err}")),
                };
                let Some(child) = streams.get_mut(&stream_id) else {
                    break None;
                };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        streams.remove(&stream_id);
                        break if status.success() {
                            None
                        } else {
                            Some(format!("Captura de {service} encerrada com {status}."))
                        };
                    }
                    Ok(None) => {}
                    Err(err) => {
                        let cleanup = terminate(child);
                        streams.remove(&stream_id);
                        break Some(format!(
                            "Erro ao consultar captura: {err}; encerramento: {cleanup:?}"
                        ));
                    }
                }
                drop(streams);
                std::thread::sleep(Duration::from_millis(100));
            };
            for reader in readers {
                if let Err(err) = reader.join() {
                    eprintln!("Erro no leitor de logs: {err:?}");
                }
            }
            if let Err(err) = app.emit("docker-log-end", EndPayload { stream_id, error }) {
                eprintln!("Erro ao notificar fim dos logs: {err}");
            }
        });
        Ok(())
    })
    .await
    .map_err(|err| format!("Erro ao abrir captura: {err}"))?
}

#[tauri::command]
pub fn stop_service_logs(app: AppHandle, stream_id: String) -> Result<(), String> {
    let state = app.state::<LogStreams>();
    let mut streams = state
        .0
        .lock()
        .map_err(|err| format!("Erro no controle de logs: {err}"))?;
    if let Some(child) = streams.get_mut(&stream_id) {
        terminate(child)?;
        streams.remove(&stream_id);
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::sync::mpsc;

    #[test]
    fn closing_capture_terminates_wrapper_and_descendant_processes() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            sender.send(output.read_to_string(&mut text)).unwrap();
        });
        std::thread::sleep(Duration::from_millis(50));
        terminate(&mut child).unwrap();
        assert!(child.try_wait().unwrap().is_some());
        assert!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_ok()
        );
        reader.join().unwrap();
    }

    #[test]
    fn closing_window_clears_all_captures_and_disallows_new_ones() {
        let streams = LogStreams::default();
        let child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        streams
            .0
            .lock()
            .unwrap()
            .insert("test-stream".into(), child);
        streams.close_all().unwrap();
        assert!(streams.0.lock().unwrap().is_empty());
        assert!(streams.1.load(Ordering::SeqCst));
        streams.close_all().unwrap();
    }
}
