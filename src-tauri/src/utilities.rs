use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Deserialize, Serialize)]
pub struct ContainerMetrics {
    #[serde(rename(deserialize = "Name"))]
    name: String,
    #[serde(rename(deserialize = "CPUPerc"))]
    cpu: String,
    #[serde(rename(deserialize = "MemUsage"))]
    memory_usage: String,
    #[serde(rename(deserialize = "MemPerc"))]
    memory_percent: String,
}

fn parse_metrics(output: &str) -> Result<Vec<ContainerMetrics>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).map_err(|err| format!("Métricas Docker inválidas: {err}"))
        })
        .collect()
}

#[tauri::command]
pub async fn get_service_metrics(
    project_path: String,
    service: String,
) -> Result<Vec<ContainerMetrics>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::docker::validate_services(&project_path, std::slice::from_ref(&service))?;
        let ids = crate::docker::compose_output(
            &project_path,
            &["ps", "--status", "running", "--quiet", &service],
        )?;
        let ids: Vec<_> = ids.split_whitespace().collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        if ids
            .iter()
            .any(|id| !id.chars().all(|character| character.is_ascii_hexdigit()))
        {
            return Err("Identificador de container inválido.".into());
        }
        let output = Command::new("docker")
            .args(["stats", "--no-stream", "--format", "json"])
            .args(ids)
            .output()
            .map_err(|err| format!("Erro ao consultar métricas: {err}"))?;
        if !output.status.success() {
            return Err(format!(
                "Erro no Docker stats: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        parse_metrics(&String::from_utf8_lossy(&output.stdout))
    })
    .await
    .map_err(|err| format!("Erro na coleta de métricas: {err}"))?
}

fn http_address(host: &str, port: u16, https: bool) -> Result<String, String> {
    if port == 0 {
        return Err("Porta HTTP inválida.".into());
    }
    let host = match host {
        "" | "0.0.0.0" | "::" | "localhost" => "localhost".into(),
        host => match host
            .parse::<IpAddr>()
            .map_err(|err| format!("Endereço inválido: {err}"))?
        {
            IpAddr::V4(address) => address.to_string(),
            IpAddr::V6(address) => format!("[{address}]"),
        },
    };
    Ok(format!(
        "{}://{host}:{port}",
        if https { "https" } else { "http" }
    ))
}

#[tauri::command]
pub fn copy_service_address(app: AppHandle, address: String) -> Result<(), String> {
    if address.trim().is_empty() || address.len() > 512 {
        return Err("Endereço inválido para copiar.".into());
    }
    app.clipboard()
        .write_text(address)
        .map_err(|err| format!("Erro ao copiar endereço: {err}"))
}

#[tauri::command]
pub fn open_service_http(
    app: AppHandle,
    host: String,
    port: u16,
    https: bool,
) -> Result<(), String> {
    let url = http_address(&host, port, https)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("Erro ao abrir navegador: {err}"))
}

#[tauri::command]
pub async fn export_service_logs(
    app: AppHandle,
    service: String,
    content: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app
            .path()
            .download_dir()
            .map_err(|err| format!("Pasta de downloads indisponível: {err}"))?;
        let path = write_log_export(&directory, &service, &content)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| format!("Erro ao exportar logs: {err}"))?
}

fn write_log_export(directory: &Path, service: &str, content: &str) -> Result<PathBuf, String> {
    if content.trim().is_empty() || content.len() > 4_000_000 {
        return Err("O conteúdo dos logs está vazio ou excede o limite de exportação.".into());
    }
    let service: String = service
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(80)
        .collect();
    if service.is_empty() {
        return Err("Nome do serviço inválido.".into());
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Erro ao gerar nome da exportação: {err}"))?
        .as_nanos();
    std::fs::create_dir_all(directory)
        .map_err(|err| format!("Erro ao preparar downloads: {err}"))?;
    let path = directory.join(format!("{service}-{timestamp}.log"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|err| format!("Erro ao criar arquivo de logs: {err}"))?;
    file.write_all(content.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|err| format!("Erro ao salvar logs: {err}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_urls_use_only_ip_addresses_and_safe_schemes() {
        assert_eq!(
            http_address("0.0.0.0", 8080, false).unwrap(),
            "http://localhost:8080"
        );
        assert_eq!(
            http_address("::", 443, true).unwrap(),
            "https://localhost:443"
        );
        assert_eq!(
            http_address("::1", 8080, false).unwrap(),
            "http://[::1]:8080"
        );
        assert!(http_address("example.com/path", 8080, false).is_err());
        assert!(http_address("javascript:alert(1)", 8080, false).is_err());
        assert!(http_address("127.0.0.1", 0, false).is_err());
    }

    #[test]
    fn metrics_include_each_replica_and_reject_invalid_output() {
        let metrics = parse_metrics("{\"Name\":\"api-1\",\"CPUPerc\":\"1.20%\",\"MemUsage\":\"20MiB / 1GiB\",\"MemPerc\":\"2%\"}\n{\"Name\":\"api-2\",\"CPUPerc\":\"0.40%\",\"MemUsage\":\"10MiB / 1GiB\",\"MemPerc\":\"1%\"}\n").unwrap();
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].cpu, "1.20%");
        assert_eq!(metrics[1].name, "api-2");
        assert!(parse_metrics("invalid json").is_err());
        assert!(parse_metrics("").unwrap().is_empty());
    }

    #[test]
    fn exports_exact_visible_content_to_new_files_without_overwriting() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("export-test-{}-{timestamp}", std::process::id()));
        let content = "ERROR banco indisponível\n";
        let first = write_log_export(&directory, "../db", content).unwrap();
        let second = write_log_export(&directory, "../db", content).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.parent().unwrap(), directory);
        assert!(
            first
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("db-")
        );
        assert_eq!(std::fs::read_to_string(&first).unwrap(), content);
        assert!(write_log_export(&directory, "db", " \n").is_err());
        assert!(write_log_export(&directory, "db", &"x".repeat(4_000_001)).is_err());
        std::fs::remove_file(first).unwrap();
        std::fs::remove_file(second).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
