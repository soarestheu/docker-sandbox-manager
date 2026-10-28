mod docker;
mod logs;
mod terminals;
mod utilities;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

#[derive(serde::Serialize)]
struct ProjectInfo {
    name: String,
    path: String,
    has_docker: bool,
    status: String,
    services: Vec<docker::ComposeService>,
    profiles: Vec<String>,
    env_files: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
fn get_default_projects_dir() -> String {
    if let Ok(home) = env::var("HOME") {
        let projetos_path = PathBuf::from(&home).join("Projetos");
        if projetos_path.exists() {
            return projetos_path.to_string_lossy().into_owned();
        }
        return home;
    }
    "/home".into()
}

#[tauri::command]
fn open_in_webstorm(project_path: String) -> Result<String, String> {
    Command::new("webstorm")
        .arg(&project_path)
        .spawn()
        .map_err(|err| format!("Erro ao abrir o WebStorm: {err}"))?;
    Ok("Projeto aberto no WebStorm!".into())
}

fn scan_recursive(
    dir: &Path,
    depth: u8,
    base_root: &Path,
    docker_context: &str,
    projects: &mut Vec<ProjectInfo>,
) -> Result<(), String> {
    if depth > 5 {
        return Ok(());
    }
    let has_docker = [
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
    ]
    .iter()
    .any(|file| dir.join(file).is_file());
    if has_docker {
        let path = dir.to_string_lossy().into_owned();
        let name = dir
            .strip_prefix(base_root)
            .ok()
            .filter(|relative| !relative.as_os_str().is_empty())
            .map(|relative| relative.to_string_lossy().into_owned())
            .or_else(|| {
                dir.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| path.clone());
        let (status, services, mut error) =
            match docker::project_state_in_context(Some(docker_context), &path) {
                Ok(state) => (state.status, state.services, None),
                Err(error) => ("unknown".into(), Vec::new(), Some(error)),
            };
        let (profiles, env_files) =
            match docker::project_metadata_in_context(Some(docker_context), &path) {
                Ok(metadata) => metadata,
                Err(metadata_error) => {
                    error = Some(match error {
                        Some(existing) => format!("{existing}; {metadata_error}"),
                        None => metadata_error,
                    });
                    (Vec::new(), Vec::new())
                }
            };
        projects.push(ProjectInfo {
            name,
            path,
            has_docker,
            status,
            services,
            profiles,
            env_files,
            error,
        });
        return Ok(());
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if depth == 0 => {
            return Err(format!("Erro ao ler {}: {err}", dir.display()));
        }
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let entry = entry.map_err(|err| format!("Erro ao ler {}: {err}", dir.display()))?;
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().into_owned();
        if folder_name.starts_with('.')
            || matches!(
                folder_name.as_str(),
                "node_modules" | "target" | "dist" | "build"
            )
        {
            continue;
        }
        scan_recursive(&entry_path, depth + 1, base_root, docker_context, projects)?;
    }
    Ok(())
}

#[tauri::command]
fn get_docker_contexts() -> Result<Vec<docker::DockerContext>, String> {
    docker::docker_contexts()
}

#[tauri::command]
async fn scan_directory(
    base_path: String,
    docker_context: String,
) -> Result<Vec<ProjectInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&base_path);
        if !root.is_dir() {
            return Err("O caminho informado não é um diretório válido.".into());
        }
        let mut projects = Vec::new();
        scan_recursive(root, 0, root, &docker_context, &mut projects)?;
        projects.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(projects)
    })
    .await
    .map_err(|err| format!("Erro ao varrer diretório: {err}"))?
}

#[tauri::command]
async fn get_project_state(
    project_path: String,
    docker_context: String,
    profiles: Vec<String>,
    env_file: Option<String>,
) -> Result<docker::ProjectState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        docker::project_state_with_options(
            Some(&docker_context),
            &project_path,
            &docker::ComposeOptions { profiles, env_file },
        )
    })
    .await
    .map_err(|err| format!("Erro ao consultar projeto: {err}"))?
}

#[tauri::command]
async fn run_compose_action(
    project_path: String,
    docker_context: String,
    profiles: Vec<String>,
    env_file: Option<String>,
    action: String,
    services: Option<Vec<String>>,
) -> Result<docker::ProjectState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let options = docker::ComposeOptions { profiles, env_file };
        docker::execute_action_with_options(
            Some(&docker_context),
            &project_path,
            &options,
            &action,
            services.as_deref(),
        )?;
        docker::project_state_with_options(Some(&docker_context), &project_path, &options)
    })
    .await
    .map_err(|err| format!("Erro ao executar ação Docker: {err}"))?
}

#[tauri::command]
async fn diagnose_project(
    project_path: String,
    docker_context: String,
    profiles: Vec<String>,
    env_file: Option<String>,
) -> Result<Vec<docker::ProjectDiagnostic>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        docker::diagnose_project(
            Some(&docker_context),
            &project_path,
            &docker::ComposeOptions { profiles, env_file },
        )
    })
    .await
    .map_err(|err| format!("Erro ao diagnosticar projeto: {err}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(logs::LogStreams::default())
        .manage(terminals::TerminalStreams::default())
        .manage(utilities::IdleMonitor::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Err(err) = window.state::<logs::LogStreams>().close_all() {
                    eprintln!("Erro ao encerrar logs da janela: {err}");
                }
                if let Err(err) = window.state::<terminals::TerminalStreams>().close_all() {
                    eprintln!("Erro ao encerrar terminais da janela: {err}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_default_projects_dir,
            get_docker_contexts,
            open_in_webstorm,
            scan_directory,
            get_project_state,
            run_compose_action,
            diagnose_project,
            logs::start_service_logs,
            logs::stop_service_logs,
            terminals::start_service_terminal,
            terminals::write_service_terminal,
            terminals::stop_service_terminal,
            utilities::get_service_metrics,
            utilities::get_project_resources,
            utilities::remove_project_resource,
            utilities::pause_idle_containers,
            utilities::reset_idle_monitor,
            utilities::open_service_http,
            utilities::export_service_logs,
            utilities::copy_service_address
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
