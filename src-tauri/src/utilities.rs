use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Deserialize, Serialize)]
pub struct ContainerMetrics {
    #[serde(rename(deserialize = "Name"))]
    name: String,
    #[serde(rename(deserialize = "ID"), default)]
    stats_id: String,
    #[serde(rename(deserialize = "CPUPerc"))]
    cpu: String,
    #[serde(rename(deserialize = "MemUsage"))]
    memory_usage: String,
    #[serde(rename(deserialize = "MemPerc"))]
    memory_percent: String,
    #[serde(rename(deserialize = "NetIO"), default)]
    network_io: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    volumes: Vec<VolumeInfo>,
    #[serde(default)]
    inspect: Value,
}

#[derive(Deserialize, Serialize)]
struct VolumeInfo {
    kind: String,
    source: String,
    destination: String,
    read_write: bool,
}

#[derive(Clone, Default)]
pub struct IdleMonitor {
    containers: Arc<Mutex<HashMap<String, NetworkActivity>>>,
}

struct NetworkActivity {
    received: u64,
    transmitted: u64,
    last_activity: Instant,
}

#[derive(Deserialize)]
struct StatsLine {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "NetIO", default)]
    network_io: String,
}

#[derive(Deserialize)]
struct InspectContainer {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Created", default)]
    created: String,
    #[serde(rename = "State", default)]
    state: Value,
    #[serde(rename = "Config", default)]
    config: Value,
    #[serde(rename = "NetworkSettings", default)]
    network_settings: Value,
    #[serde(rename = "Mounts", default)]
    mounts: Vec<InspectMount>,
}

#[derive(Deserialize)]
struct InspectMount {
    #[serde(rename = "Type", default)]
    kind: String,
    #[serde(rename = "Source", default)]
    source: String,
    #[serde(rename = "Destination", default)]
    destination: String,
    #[serde(rename = "RW", default)]
    read_write: bool,
}

fn docker_output(context: &str, args: &[&str]) -> Result<String, String> {
    crate::docker::validate_context(context)?;
    let output = Command::new("docker")
        .args(["--context", context])
        .args(args)
        .output()
        .map_err(|err| format!("Falha ao executar Docker: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "Docker {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout).map_err(|err| format!("Resposta inválida do Docker: {err}"))
}

#[derive(Clone, Serialize)]
pub struct ProjectResource {
    name: String,
    resource_type: String,
    driver: String,
    in_use: bool,
}

#[derive(Serialize)]
pub struct ProjectResources {
    volumes: Vec<ProjectResource>,
    networks: Vec<ProjectResource>,
}

fn compose_project_name(
    context: &str,
    project_path: &str,
    options: &crate::docker::ComposeOptions,
) -> Result<String, String> {
    let output = crate::docker::compose_output_with_options(
        Some(context),
        project_path,
        options,
        &["config", "--format", "json"],
    )?;
    let config: Value = serde_json::from_str(&output)
        .map_err(|error| format!("Configuração Compose inválida: {error}"))?;
    config
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "O Compose não informou o nome do projeto.".into())
}

fn project_resource_names(
    context: &str,
    resource_type: &str,
    project_name: &str,
) -> Result<Vec<String>, String> {
    let filter = format!("label=com.docker.compose.project={project_name}");
    let output = docker_output(
        context,
        &[
            resource_type,
            "ls",
            "--filter",
            &filter,
            "--format",
            "{{json .}}",
        ],
    )?;
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let item: Value = serde_json::from_str(line)
                .map_err(|error| format!("Lista de recursos Docker inválida: {error}"))?;
            item.get("Name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "O Docker não informou o nome de um recurso.".into())
        })
        .collect()
}

fn inspect_project_resource(
    context: &str,
    project_name: &str,
    resource_type: &str,
    name: &str,
) -> Result<ProjectResource, String> {
    let details = if resource_type == "volume" {
        docker_output(context, &[resource_type, "inspect", "--verbose", name])?
    } else {
        docker_output(context, &[resource_type, "inspect", name])?
    };
    let details: Value = serde_json::from_str(&details)
        .map_err(|error| format!("Inspeção do recurso Docker inválida: {error}"))?;
    let item = details
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| "O Docker não retornou detalhes do recurso.".to_string())?;
    let labels = item
        .get("Labels")
        .and_then(Value::as_object)
        .ok_or_else(|| "O recurso não possui etiquetas Compose verificáveis.".to_string())?;
    if labels
        .get("com.docker.compose.project")
        .and_then(Value::as_str)
        != Some(project_name)
    {
        return Err("O recurso não pertence ao projeto Compose selecionado.".into());
    }
    let in_use = match resource_type {
        "volume" => item
            .get("UsageData")
            .and_then(|usage| usage.get("RefCount"))
            .and_then(Value::as_u64)
            .map(|count| count > 0)
            .ok_or_else(|| "O Docker não informou o uso deste volume.".to_string())?,
        "network" => item
            .get("Containers")
            .and_then(Value::as_object)
            .map(|containers| !containers.is_empty())
            .ok_or_else(|| "O Docker não informou os containers desta rede.".to_string())?,
        _ => return Err("Tipo de recurso inválido.".into()),
    };
    Ok(ProjectResource {
        name: name.to_string(),
        resource_type: resource_type.to_string(),
        driver: item
            .get("Driver")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        in_use,
    })
}

#[tauri::command]
pub async fn get_project_resources(
    project_path: String,
    docker_context: String,
    profiles: Vec<String>,
    env_file: Option<String>,
) -> Result<ProjectResources, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let options = crate::docker::ComposeOptions { profiles, env_file };
        let project_name = compose_project_name(&docker_context, &project_path, &options)?;
        let volumes = project_resource_names(&docker_context, "volume", &project_name)?
            .into_iter()
            .map(|name| inspect_project_resource(&docker_context, &project_name, "volume", &name))
            .collect::<Result<Vec<_>, _>>()?;
        let networks = project_resource_names(&docker_context, "network", &project_name)?
            .into_iter()
            .map(|name| inspect_project_resource(&docker_context, &project_name, "network", &name))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ProjectResources { volumes, networks })
    })
    .await
    .map_err(|error| format!("Erro ao consultar recursos do projeto: {error}"))?
}

#[tauri::command]
pub async fn remove_project_resource(
    project_path: String,
    docker_context: String,
    profiles: Vec<String>,
    env_file: Option<String>,
    resource_type: String,
    name: String,
) -> Result<(), String> {
    if !matches!(resource_type.as_str(), "volume" | "network") {
        return Err("Tipo de recurso inválido.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let options = crate::docker::ComposeOptions { profiles, env_file };
        let project_name = compose_project_name(&docker_context, &project_path, &options)?;
        let names = project_resource_names(&docker_context, &resource_type, &project_name)?;
        if !names.iter().any(|candidate| candidate == &name) {
            return Err("O recurso não pertence ao projeto Compose selecionado.".into());
        }
        let resource =
            inspect_project_resource(&docker_context, &project_name, &resource_type, &name)?;
        if resource.in_use {
            return Err("Não é possível remover um recurso ainda em uso.".into());
        }
        docker_output(&docker_context, &[&resource_type, "rm", "--", &name])?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Erro ao remover recurso do projeto: {error}"))?
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
    docker_context: String,
    profiles: Vec<String>,
    env_file: Option<String>,
    service: String,
) -> Result<Vec<ContainerMetrics>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let options = crate::docker::ComposeOptions { profiles, env_file };
        crate::docker::validate_services_with_options(
            Some(&docker_context),
            &project_path,
            &options,
            std::slice::from_ref(&service),
        )?;
        let ids = crate::docker::compose_output_with_options(
            Some(&docker_context),
            &project_path,
            &options,
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
        let mut stats_args = vec!["stats", "--no-stream", "--format", "json"];
        stats_args.extend(ids.iter().copied());
        let stats_output = docker_output(&docker_context, &stats_args)?;
        let stats = parse_metrics(&stats_output)?;
        let mut inspect_args = vec!["inspect"];
        inspect_args.extend(ids.iter().copied());
        let inspected: Vec<InspectContainer> =
            serde_json::from_str(&docker_output(&docker_context, &inspect_args)?)
                .map_err(|err| format!("Resposta inválida do Docker inspect: {err}"))?;
        stats
            .into_iter()
            .map(|mut metric| {
                let container = inspected
                    .iter()
                    .find(|container| {
                        container.id.starts_with(&metric.stats_id)
                            || metric.stats_id.starts_with(&container.id)
                            || container.name.trim_start_matches('/')
                                == metric.name.trim_start_matches('/')
                    })
                    .ok_or_else(|| {
                        format!("Inspect não encontrado para o container {}.", metric.name)
                    })?;
                metric.id = container.id.clone();
                metric.state = container
                    .state
                    .get("Status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                metric.volumes = container
                    .mounts
                    .iter()
                    .map(|mount| VolumeInfo {
                        kind: mount.kind.clone(),
                        source: mount.source.clone(),
                        destination: mount.destination.clone(),
                        read_write: mount.read_write,
                    })
                    .collect();
                metric.inspect = json!({
                    "Id": container.id,
                    "Name": container.name,
                    "Created": container.created,
                    "Image": container.config.get("Image"),
                    "State": container.state,
                    "NetworkSettings": container.network_settings,
                    "Mounts": container.mounts.iter().map(|mount| json!({
                        "Type": mount.kind,
                        "Source": mount.source,
                        "Destination": mount.destination,
                        "RW": mount.read_write,
                    })).collect::<Vec<_>>(),
                });
                Ok(metric)
            })
            .collect()
    })
    .await
    .map_err(|err| format!("Erro na coleta de métricas: {err}"))?
}

fn parse_network_io(value: &str) -> Result<(u64, u64), String> {
    let (received, transmitted) = value
        .split_once('/')
        .ok_or_else(|| format!("Formato NetIO inválido: {value}"))?;
    Ok((
        parse_network_size(received)?,
        parse_network_size(transmitted)?,
    ))
}

fn parse_network_size(value: &str) -> Result<u64, String> {
    let value = value.trim();
    let split = value
        .find(|character: char| !character.is_ascii_digit() && character != '.')
        .unwrap_or(value.len());
    let amount: f64 = value[..split]
        .parse()
        .map_err(|err| format!("Volume de rede inválido ({value}): {err}"))?;
    let multiplier = match value[split..].trim() {
        "B" | "" => 1.0,
        "kB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        "KiB" => 1_024.0,
        "MiB" => 1_048_576.0,
        "GiB" => 1_073_741_824.0,
        "TiB" => 1_099_511_627_776.0,
        unit => return Err(format!("Unidade de rede desconhecida: {unit}")),
    };
    Ok((amount * multiplier).round() as u64)
}

#[tauri::command]
pub async fn pause_idle_containers(
    project_path: String,
    docker_context: String,
    profiles: Vec<String>,
    env_file: Option<String>,
    idle_seconds: u64,
    monitor: State<'_, IdleMonitor>,
) -> Result<Vec<String>, String> {
    if !(60..=86_400).contains(&idle_seconds) {
        return Err("O intervalo de ociosidade deve estar entre 60 segundos e 24 horas.".into());
    }
    let monitor = monitor.containers.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::docker::validate_context(&docker_context)?;
        let options = crate::docker::ComposeOptions { profiles, env_file };
        let ids = crate::docker::compose_output_with_options(
            Some(&docker_context),
            &project_path,
            &options,
            &["ps", "--status", "running", "--quiet"],
        )?;
        let ids: Vec<_> = ids.split_whitespace().collect();
        let project_prefix = format!("{docker_context}::{project_path}::");
        if ids.is_empty() {
            monitor
                .lock()
                .map_err(|_| "O monitor de ociosidade está indisponível.".to_string())?
                .retain(|tracked_id, _| !tracked_id.starts_with(&project_prefix));
            return Ok(Vec::new());
        }
        if ids
            .iter()
            .any(|id| !id.chars().all(|character| character.is_ascii_hexdigit()))
        {
            return Err("Identificador de container inválido.".into());
        }
        let mut stats_args = vec!["stats", "--no-stream", "--format", "json"];
        stats_args.extend(ids.iter().copied());
        let stats: Vec<StatsLine> = docker_output(&docker_context, &stats_args)?
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line)
                    .map_err(|err| format!("Métricas de rede inválidas: {err}"))
            })
            .collect::<Result<_, _>>()?;
        let now = Instant::now();
        let mut activity = monitor
            .lock()
            .map_err(|_| "O monitor de ociosidade está indisponível.".to_string())?;
        let mut paused = Vec::new();
        for stat in stats {
            if stat.id.is_empty() {
                return Err(
                    "O Docker não informou o ID de um container nas métricas de rede.".into(),
                );
            }
            let (received, transmitted) = parse_network_io(&stat.network_io)?;
            let key = ids
                .iter()
                .find(|id| id.starts_with(&stat.id) || stat.id.starts_with(**id))
                .copied()
                .ok_or_else(|| format!("Container não reconhecido nas métricas: {}.", stat.id))?;
            let tracked_id = format!("{project_prefix}{key}");
            let entry = activity
                .entry(tracked_id.clone())
                .or_insert(NetworkActivity {
                    received,
                    transmitted,
                    last_activity: now,
                });
            if entry.received != received || entry.transmitted != transmitted {
                entry.received = received;
                entry.transmitted = transmitted;
                entry.last_activity = now;
                continue;
            }
            if now.duration_since(entry.last_activity) >= Duration::from_secs(idle_seconds) {
                docker_output(&docker_context, &["pause", key])?;
                paused.push(if stat.name.is_empty() {
                    key.to_string()
                } else {
                    stat.name
                });
                activity.remove(&tracked_id);
            }
        }
        activity.retain(|tracked_id, _| {
            !tracked_id.starts_with(&project_prefix)
                || ids
                    .iter()
                    .any(|id| tracked_id == &format!("{project_prefix}{id}"))
        });
        Ok(paused)
    })
    .await
    .map_err(|err| format!("Erro ao monitorar ociosidade: {err}"))?
}

#[tauri::command]
pub fn reset_idle_monitor(monitor: State<'_, IdleMonitor>) -> Result<(), String> {
    monitor
        .containers
        .lock()
        .map_err(|_| "O monitor de ociosidade está indisponível.".to_string())?
        .clear();
    Ok(())
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
    fn network_activity_parses_docker_byte_units() {
        assert_eq!(
            parse_network_io("1.5kB / 2MiB").unwrap(),
            (1_500, 2_097_152)
        );
        assert_eq!(parse_network_io("0B / 10B").unwrap(), (0, 10));
        assert!(parse_network_io("unknown").is_err());
        assert!(parse_network_io("2XB / 3B").is_err());
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
