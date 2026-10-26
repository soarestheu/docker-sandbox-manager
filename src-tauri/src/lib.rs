mod docker;
mod logs;
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
    projects: &mut Vec<ProjectInfo>,
) -> Result<(), String> {
    if depth > 3 {
        return Ok(());
    }
    let entries =
        fs::read_dir(dir).map_err(|err| format!("Erro ao ler {}: {err}", dir.display()))?;
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
        let has_docker = [
            "docker-compose.yml",
            "docker-compose.yaml",
            "compose.yml",
            "compose.yaml",
        ]
        .iter()
        .any(|file| entry_path.join(file).exists());
        if has_docker {
            let path = entry_path.to_string_lossy().into_owned();
            let name = entry_path
                .strip_prefix(base_root)
                .map(|relative| relative.to_string_lossy().into_owned())
                .unwrap_or(folder_name);
            let (status, services, error) = match docker::project_state(&path) {
                Ok(state) => (state.status, state.services, None),
                Err(error) => ("unknown".into(), Vec::new(), Some(error)),
            };
            projects.push(ProjectInfo {
                name,
                path,
                has_docker,
                status,
                services,
                error,
            });
        } else {
            scan_recursive(&entry_path, depth + 1, base_root, projects)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn scan_directory(base_path: String) -> Result<Vec<ProjectInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&base_path);
        if !root.is_dir() {
            return Err("O caminho informado não é um diretório válido.".into());
        }
        let mut projects = Vec::new();
        scan_recursive(root, 1, root, &mut projects)?;
        projects.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(projects)
    })
    .await
    .map_err(|err| format!("Erro ao varrer diretório: {err}"))?
}

#[tauri::command]
async fn get_project_state(project_path: String) -> Result<docker::ProjectState, String> {
    tauri::async_runtime::spawn_blocking(move || docker::project_state(&project_path))
        .await
        .map_err(|err| format!("Erro ao consultar projeto: {err}"))?
}

#[tauri::command]
async fn run_compose_action(
    project_path: String,
    action: String,
    services: Option<Vec<String>>,
) -> Result<docker::ProjectState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        docker::execute_action(&project_path, &action, services.as_deref())?;
        docker::project_state(&project_path)
    })
    .await
    .map_err(|err| format!("Erro ao executar ação Docker: {err}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(logs::LogStreams::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Err(err) = window.state::<logs::LogStreams>().close_all()
            {
                eprintln!("Erro ao encerrar logs da janela: {err}");
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_default_projects_dir,
            open_in_webstorm,
            scan_directory,
            get_project_state,
            run_compose_action,
            logs::start_service_logs,
            logs::stop_service_logs,
            utilities::get_service_metrics,
            utilities::open_service_http,
            utilities::export_service_logs,
            utilities::copy_service_address
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
