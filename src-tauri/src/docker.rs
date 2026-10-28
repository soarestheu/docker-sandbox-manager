use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ComposeOptions {
    #[serde(default)]
    pub profiles: Vec<String>,
    #[serde(default)]
    pub env_file: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DockerContext {
    #[serde(rename(deserialize = "Name", serialize = "name"))]
    pub name: String,
    #[serde(rename(deserialize = "Current", serialize = "current"), default)]
    pub current: bool,
}

pub fn docker_contexts() -> Result<Vec<DockerContext>, String> {
    let output = Command::new("docker")
        .args(["context", "ls", "--format", "{{json .}}"])
        .output()
        .map_err(|err| format!("Falha ao listar contextos Docker: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "Docker context ls: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8(output.stdout)
        .map_err(|err| format!("Resposta inválida do Docker: {err}"))?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).map_err(|err| format!("Contexto Docker inválido: {err}"))
        })
        .collect()
}

pub fn validate_context(context: &str) -> Result<(), String> {
    if context.is_empty()
        || context.starts_with('-')
        || !context.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("Nome de contexto Docker inválido.".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServicePort {
    pub host_ip: String,
    pub published: u16,
    pub target: u16,
    pub protocol: String,
    pub is_open: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ComposeService {
    pub name: String,
    pub image: String,
    pub state: String,
    pub health: String,
    pub containers: usize,
    pub running_containers: usize,
    pub ports: Vec<ServicePort>,
    pub dependencies: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectState {
    pub status: String,
    pub services: Vec<ComposeService>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectDiagnostic {
    pub severity: String,
    pub message: String,
}

#[derive(Default, Deserialize)]
struct ComposeConfig {
    services: BTreeMap<String, ServiceConfig>,
}

#[derive(Default, Deserialize)]
struct ServiceConfig {
    #[serde(default)]
    image: String,
    #[serde(default)]
    ports: Vec<ConfigPort>,
    #[serde(default)]
    depends_on: Option<Dependencies>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Dependencies {
    Names(Vec<String>),
    Conditions(BTreeMap<String, Value>),
}

impl Dependencies {
    fn names(self) -> Vec<String> {
        match self {
            Self::Names(names) => names,
            Self::Conditions(conditions) => conditions.into_keys().collect(),
        }
    }
}

#[derive(Deserialize)]
struct ConfigPort {
    target: u16,
    #[serde(default)]
    published: Option<String>,
    #[serde(default = "default_host")]
    host_ip: String,
    #[serde(default = "default_protocol")]
    protocol: String,
}

#[derive(Debug, Deserialize)]
struct Container {
    #[serde(rename = "Service")]
    service: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Health", default)]
    health: String,
    #[serde(rename = "Publishers", default)]
    publishers: Option<Vec<Publisher>>,
}

#[derive(Debug, Deserialize)]
struct Publisher {
    #[serde(rename = "URL", default = "default_host")]
    host_ip: String,
    #[serde(rename = "PublishedPort")]
    published: u16,
    #[serde(rename = "TargetPort")]
    target: u16,
    #[serde(rename = "Protocol", default = "default_protocol")]
    protocol: String,
}

fn default_host() -> String {
    "0.0.0.0".into()
}

fn default_protocol() -> String {
    "tcp".into()
}

pub fn compose_output_in_context(
    context: Option<&str>,
    project_path: &str,
    args: &[&str],
) -> Result<String, String> {
    compose_output_with_options(context, project_path, &ComposeOptions::default(), args)
}

pub fn compose_output_with_options(
    context: Option<&str>,
    project_path: &str,
    options: &ComposeOptions,
    args: &[&str],
) -> Result<String, String> {
    let mut command = Command::new("docker");
    if let Some(context) = context {
        validate_context(context)?;
        command.args(["--context", context]);
    }
    command.arg("compose");
    for profile in &options.profiles {
        validate_profile(profile)?;
        command.args(["--profile", profile]);
    }
    if let Some(env_file) = options.env_file.as_deref() {
        validate_env_file(project_path, env_file)?;
        command.args(["--env-file", env_file]);
    }
    let output = command
        .args(args)
        .current_dir(project_path)
        .output()
        .map_err(|err| format!("Falha ao executar Docker Compose: {err}"))?;

    if !output.status.success() {
        return Err(format!(
            "Docker Compose {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|err| format!("Resposta inválida do Docker Compose: {err}"))
}

pub fn validate_profile(profile: &str) -> Result<(), String> {
    if profile.is_empty()
        || profile.starts_with('-')
        || !profile.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err(format!("Perfil Compose inválido: {profile}"));
    }
    Ok(())
}

pub fn validate_env_file(project_path: &str, env_file: &str) -> Result<(), String> {
    let name = Path::new(env_file);
    let path = Path::new(project_path).join(name);
    if !env_file.starts_with(".env")
        || name.file_name().and_then(|value| value.to_str()) != Some(env_file)
    {
        return Err("Arquivo de ambiente inválido para este projeto.".into());
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|err| format!("Erro ao verificar arquivo de ambiente: {err}"))?;
    if !metadata.file_type().is_file() {
        return Err("Arquivo de ambiente inválido para este projeto.".into());
    }
    Ok(())
}

pub fn project_metadata_in_context(
    context: Option<&str>,
    project_path: &str,
) -> Result<(Vec<String>, Vec<String>), String> {
    let profiles = compose_output_in_context(context, project_path, &["config", "--profiles"])?
        .lines()
        .map(str::trim)
        .filter(|profile| !profile.is_empty())
        .map(str::to_string)
        .collect();
    let entries = std::fs::read_dir(project_path)
        .map_err(|err| format!("Erro ao listar arquivos de ambiente: {err}"))?;
    let mut env_files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("Erro ao ler arquivo de ambiente: {err}"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name != ".env" && !name.starts_with(".env.") {
            continue;
        }
        let metadata = entry
            .path()
            .symlink_metadata()
            .map_err(|err| format!("Erro ao verificar arquivo de ambiente {name}: {err}"))?;
        if metadata.file_type().is_file() {
            env_files.push(name);
        }
    }
    env_files.sort();
    Ok((profiles, env_files))
}

pub fn diagnose_project(
    context: Option<&str>,
    project_path: &str,
    options: &ComposeOptions,
) -> Result<Vec<ProjectDiagnostic>, String> {
    let config_output = compose_output_with_options(
        context,
        project_path,
        options,
        &["config", "--format", "json"],
    )?;
    let config: ComposeConfig = serde_json::from_str(&config_output)
        .map_err(|error| format!("Configuração Compose inválida: {error}"))?;
    let container_output = compose_output_with_options(
        context,
        project_path,
        options,
        &["ps", "--all", "--orphans", "--format", "json"],
    )?;
    let containers = parse_containers(&container_output)?;
    let mut diagnostics = Vec::new();
    let mut orphans = containers
        .iter()
        .filter(|container| !config.services.contains_key(&container.service))
        .map(|container| container.service.clone())
        .collect::<Vec<_>>();
    orphans.sort();
    orphans.dedup();
    for service in orphans {
        diagnostics.push(ProjectDiagnostic {
            severity: "warning".into(),
            message: format!(
                "Container órfão do serviço {service}; ele não existe mais na configuração atual."
            ),
        });
    }

    let mut published = BTreeMap::<(String, u16, String), Vec<String>>::new();
    for (service, definition) in &config.services {
        for port in &definition.ports {
            let Some(number) = port
                .published
                .as_deref()
                .and_then(|value| value.parse().ok())
            else {
                continue;
            };
            published
                .entry((port.host_ip.clone(), number, port.protocol.clone()))
                .or_default()
                .push(service.clone());
        }
    }
    for ((host, port, protocol), mut services) in published {
        services.sort();
        services.dedup();
        if services.len() > 1 {
            diagnostics.push(ProjectDiagnostic {
                severity: "warning".into(),
                message: format!(
                    "Porta publicada {host}:{port}/{protocol} está declarada em múltiplos serviços: {}.",
                    services.join(", ")
                ),
            });
        }
    }

    if diagnostics.is_empty() {
        diagnostics.push(ProjectDiagnostic {
            severity: "ok".into(),
            message: "Nenhum problema comum foi encontrado na configuração e nos containers."
                .into(),
        });
    }
    Ok(diagnostics)
}

fn parse_containers(output: &str) -> Result<Vec<Container>, String> {
    let output = output.trim();
    if output.is_empty() {
        return Ok(Vec::new());
    }
    if output.starts_with('[') {
        serde_json::from_str(output).map_err(|err| format!("Lista de containers inválida: {err}"))
    } else {
        output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line)
                    .map_err(|err| format!("Estado de container inválido: {err}"))
            })
            .collect()
    }
}

fn is_active(state: &str) -> bool {
    matches!(state, "running" | "restarting" | "paused" | "partial")
}

fn build_state(config: ComposeConfig, containers: Vec<Container>) -> ProjectState {
    let services: Vec<ComposeService> = config
        .services
        .into_iter()
        .map(|(name, definition)| {
            let instances: Vec<_> = containers
                .iter()
                .filter(|item| item.service == name)
                .collect();
            let running = instances
                .iter()
                .filter(|item| item.state == "running")
                .count();
            let state = if instances.is_empty() {
                "not_created".into()
            } else if instances
                .iter()
                .all(|item| item.state == instances[0].state)
            {
                instances[0].state.clone()
            } else if instances.iter().any(|item| is_active(&item.state)) {
                "partial".into()
            } else {
                "exited".into()
            };
            let health = if instances.iter().any(|item| item.health == "unhealthy") {
                "unhealthy"
            } else if instances.iter().any(|item| item.health == "starting") {
                "starting"
            } else if running > 0
                && instances
                    .iter()
                    .filter(|item| item.state == "running")
                    .all(|item| item.health == "healthy")
            {
                "healthy"
            } else {
                ""
            };

            let mut ports = Vec::new();
            for container in &instances {
                if container.state != "running" {
                    continue;
                }
                for port in container.publishers.iter().flatten() {
                    if port.published == 0 {
                        continue;
                    }
                    if !ports.iter().any(|existing: &ServicePort| {
                        existing.host_ip == port.host_ip
                            && existing.published == port.published
                            && existing.protocol == port.protocol
                    }) {
                        ports.push(ServicePort {
                            host_ip: port.host_ip.clone(),
                            published: port.published,
                            target: port.target,
                            protocol: port.protocol.clone(),
                            is_open: None,
                        });
                    }
                }
            }
            if running == 0 {
                for port in definition.ports {
                    // A range or an automatic port is resolved only by the running container.
                    if let Some(published) = port.published.and_then(|value| value.parse().ok()) {
                        ports.push(ServicePort {
                            host_ip: port.host_ip,
                            published,
                            target: port.target,
                            protocol: port.protocol,
                            is_open: None,
                        });
                    }
                }
            }

            let mut dependencies = definition
                .depends_on
                .map(Dependencies::names)
                .unwrap_or_default();
            dependencies.sort();
            dependencies.dedup();
            ComposeService {
                name,
                image: definition.image,
                state,
                health: health.into(),
                containers: instances.len(),
                running_containers: running,
                ports,
                dependencies,
            }
        })
        .collect();
    let active = services
        .iter()
        .filter(|item| is_active(&item.state))
        .count();
    let status = if active == 0 {
        "stopped"
    } else if active == services.len() && services.iter().all(|item| item.state == "running") {
        "running"
    } else {
        "partial"
    };
    ProjectState {
        status: status.into(),
        services,
    }
}

fn probe_port(port: &ServicePort) -> Result<bool, String> {
    let address = match port.host_ip.as_str() {
        "" | "0.0.0.0" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        "::" => IpAddr::V6(Ipv6Addr::LOCALHOST),
        host => host
            .parse()
            .map_err(|err| format!("Endereço de porta inválido ({host}): {err}"))?,
    };
    Ok(TcpStream::connect_timeout(
        &SocketAddr::new(address, port.published),
        Duration::from_millis(150),
    )
    .is_ok())
}

pub fn project_state_in_context(
    context: Option<&str>,
    project_path: &str,
) -> Result<ProjectState, String> {
    project_state_with_options(context, project_path, &ComposeOptions::default())
}

pub fn project_state_with_options(
    context: Option<&str>,
    project_path: &str,
    options: &ComposeOptions,
) -> Result<ProjectState, String> {
    let config = compose_output_with_options(
        context,
        project_path,
        options,
        &["config", "--format", "json"],
    )?;
    let config = serde_json::from_str(&config)
        .map_err(|err| format!("Configuração Compose inválida: {err}"))?;
    let containers = compose_output_with_options(
        context,
        project_path,
        options,
        &["ps", "--all", "--format", "json"],
    )?;
    let mut state = build_state(config, parse_containers(&containers)?);
    for service in &mut state.services {
        if service.running_containers == 0 {
            continue;
        }
        for port in &mut service.ports {
            if port.protocol == "tcp" {
                port.is_open = Some(probe_port(port)?);
            }
        }
    }
    Ok(state)
}

fn action_args(action: &str, services: Option<&[String]>) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = match action {
        "up" if services.is_some() => vec!["up".into(), "-d".into(), "--no-deps".into()],
        "up" => vec!["up".into(), "-d".into()],
        "up_with_deps" if services.is_some() => {
            vec!["up".into(), "-d".into(), "--with-dependencies".into()]
        }
        "up_with_deps" => vec!["up".into(), "-d".into()],
        "pull" => vec!["pull".into()],
        "build" => vec!["build".into()],
        "recreate" if services.is_some() => {
            vec![
                "up".into(),
                "-d".into(),
                "--no-deps".into(),
                "--force-recreate".into(),
            ]
        }
        "recreate" => vec!["up".into(), "-d".into(), "--force-recreate".into()],
        "stop" => vec!["stop".into()],
        "unpause" if services.is_some() => vec!["unpause".into()],
        "down" if services.is_none() => vec!["down".into()],
        _ => return Err("Ação Docker inválida para esta seleção.".into()),
    };
    if let Some(services) = services {
        if services.is_empty() {
            return Err("Selecione pelo menos um serviço.".into());
        }
        if services.iter().any(|name| name.starts_with('-')) {
            return Err("Nome de serviço inválido.".into());
        }
        args.extend_from_slice(services);
    }
    Ok(args)
}

pub fn execute_action_with_options(
    context: Option<&str>,
    project_path: &str,
    options: &ComposeOptions,
    action: &str,
    services: Option<&[String]>,
) -> Result<(), String> {
    let args = action_args(action, services)?;
    if let Some(services) = services {
        validate_services_with_options(context, project_path, options, services)?;
    }

    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    compose_output_with_options(context, project_path, options, &args)?;
    Ok(())
}

pub fn validate_services_with_options(
    context: Option<&str>,
    project_path: &str,
    options: &ComposeOptions,
    services: &[String],
) -> Result<(), String> {
    if services.is_empty()
        || services
            .iter()
            .any(|name| name.is_empty() || name.starts_with('-'))
    {
        return Err("Seleção de serviços inválida.".into());
    }
    let config = compose_output_with_options(
        context,
        project_path,
        options,
        &["config", "--format", "json"],
    )?;
    let config: ComposeConfig = serde_json::from_str(&config)
        .map_err(|err| format!("Configuração Compose inválida: {err}"))?;
    for name in services {
        if !config.services.contains_key(name) {
            return Err(format!("O serviço {name} não pertence a este projeto."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ComposeConfig {
        serde_json::from_str(r#"{
            "services": {
                "api": {"image":"example/api","depends_on":{"db":{"condition":"service_started"}},"ports":[{"target":3000,"published":"8080","host_ip":"127.0.0.1"}]},
                "db": {"image":"postgres","ports":[{"target":5432,"published":"55432"}]},
                "worker": {"image":"example/worker","depends_on":["api"]}
            }
        }"#).unwrap()
    }

    #[test]
    fn docker_context_names_are_safe_cli_arguments() {
        assert!(validate_context("default").is_ok());
        assert!(validate_context("remote-prod_2").is_ok());
        for invalid in ["", "--help", "my context", "remote;docker"] {
            assert!(validate_context(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn docker_contexts_use_cli_names_internally_and_camel_case_for_the_frontend() {
        let context: DockerContext =
            serde_json::from_str(r#"{"Name":"default","Current":true}"#).unwrap();
        assert_eq!(context.name, "default");
        assert!(context.current);
        assert_eq!(
            serde_json::to_string(&context).unwrap(),
            r#"{"name":"default","current":true}"#
        );
    }

    #[test]
    fn compose_profiles_and_env_files_are_validated_without_exposing_contents() {
        assert!(validate_profile("dev.local-2").is_ok());
        assert!(validate_profile("--help").is_err());
        let directory = std::env::temp_dir().join(format!(
            "docker-sandbox-env-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let env_path = directory.join(".env.dev");
        std::fs::write(&env_path, "SECRET=value").unwrap();
        assert!(validate_env_file(directory.to_str().unwrap(), ".env.dev").is_ok());
        assert!(validate_env_file(directory.to_str().unwrap(), "../.env.dev").is_err());
        assert!(validate_env_file(directory.to_str().unwrap(), "Cargo.toml").is_err());
        std::fs::remove_file(env_path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn empty_json_array_means_stopped_not_running() {
        let state = build_state(config(), parse_containers("[]\n").unwrap());
        assert_eq!(state.status, "stopped");
        assert!(
            state
                .services
                .iter()
                .all(|service| service.state == "not_created")
        );
        assert_eq!(state.services[0].ports[0].published, 8080);
        assert_eq!(state.services[0].ports[0].protocol, "tcp");
        assert_eq!(state.services[0].ports[0].is_open, None);
    }

    #[test]
    fn stopped_containers_do_not_keep_project_running() {
        let containers = parse_containers(
            r#"[
            {"Service":"api","State":"exited","Publishers":null},
            {"Service":"db","State":"exited","Health":""}
        ]"#,
        )
        .unwrap();
        let state = build_state(config(), containers);
        assert_eq!(state.status, "stopped");
        assert_eq!(state.services[0].state, "exited");
        assert_eq!(state.services[1].running_containers, 0);
    }

    #[test]
    fn actual_service_and_published_port_replace_guessed_labels() {
        let containers = parse_containers(
            "{\"Service\":\"api\",\"State\":\"running\",\"Health\":\"healthy\",\"Publishers\":[{\"URL\":\"127.0.0.1\",\"PublishedPort\":49153,\"TargetPort\":3000,\"Protocol\":\"tcp\"}]}\n\
             {\"Service\":\"worker\",\"State\":\"running\"}\n"
        ).unwrap();
        let state = build_state(config(), containers);
        assert_eq!(state.status, "partial");
        assert_eq!(state.services[0].ports[0].published, 49153);
        assert_eq!(state.services[0].ports[0].target, 3000);
        assert_eq!(state.services[0].health, "healthy");
        assert_eq!(state.services[0].dependencies, ["db"]);
        assert!(state.services[2].ports.is_empty());
        assert_eq!(state.services[2].state, "running");
        assert_eq!(state.services[2].dependencies, ["api"]);
    }

    #[test]
    fn mixed_replicas_and_unhealthy_containers_are_reported() {
        let containers = parse_containers(
            r#"[
            {"Service":"api","State":"running","Health":"unhealthy"},
            {"Service":"api","State":"exited"},
            {"Service":"db","State":"paused"},
            {"Service":"worker","State":"restarting"}
        ]"#,
        )
        .unwrap();
        let state = build_state(config(), containers);
        assert_eq!(state.status, "partial");
        assert_eq!(state.services[0].containers, 2);
        assert_eq!(state.services[0].running_containers, 1);
        assert_eq!(state.services[0].state, "partial");
        assert_eq!(state.services[0].health, "unhealthy");
        assert_eq!(state.services[1].state, "paused");
        assert_eq!(state.services[2].state, "restarting");
    }

    #[test]
    fn all_running_services_make_project_running() {
        let containers = parse_containers(
            r#"[
            {"Service":"api","State":"running"},
            {"Service":"db","State":"running"},
            {"Service":"worker","State":"running"}
        ]"#,
        )
        .unwrap();
        assert_eq!(build_state(config(), containers).status, "running");
    }

    #[test]
    fn invalid_json_is_an_error_not_a_stopped_project() {
        assert!(parse_containers("not json").is_err());
        assert!(parse_containers(r#"{"Service":"db"}"#).is_err());
    }

    #[test]
    fn scoped_actions_cannot_affect_the_whole_project_or_dependencies() {
        let services = vec!["api".into(), "worker".into()];
        assert_eq!(
            action_args("up", Some(&services)).unwrap(),
            ["up", "-d", "--no-deps", "api", "worker"]
        );
        assert_eq!(
            action_args("stop", Some(&services)).unwrap(),
            ["stop", "api", "worker"]
        );
        assert_eq!(
            action_args("unpause", Some(&services)).unwrap(),
            ["unpause", "api", "worker"]
        );
        assert!(action_args("up", Some(&[])).is_err());
        assert!(action_args("down", Some(&services)).is_err());
        assert!(action_args("unpause", None).is_err());
        assert!(action_args("stop", Some(&["--all".into()])).is_err());
        assert_eq!(action_args("up", None).unwrap(), ["up", "-d"]);
        assert_eq!(action_args("down", None).unwrap(), ["down"]);
        assert_eq!(
            action_args("up_with_deps", Some(&services)).unwrap(),
            ["up", "-d", "--with-dependencies", "api", "worker"]
        );
        assert_eq!(
            action_args("pull", Some(&services)).unwrap(),
            ["pull", "api", "worker"]
        );
        assert_eq!(action_args("build", None).unwrap(), ["build"]);
        assert_eq!(
            action_args("recreate", Some(&services)).unwrap(),
            ["up", "-d", "--no-deps", "--force-recreate", "api", "worker"]
        );
        assert_eq!(
            action_args("recreate", None).unwrap(),
            ["up", "-d", "--force-recreate"]
        );
    }

    #[test]
    fn tcp_probe_uses_the_published_port_and_distinguishes_closed_ports() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = ServicePort {
            host_ip: "0.0.0.0".into(),
            published: listener.local_addr().unwrap().port(),
            target: 5432,
            protocol: "tcp".into(),
            is_open: None,
        };
        assert!(probe_port(&port).unwrap());
        drop(listener.accept().unwrap().0);
        drop(listener);
        assert!(
            !probe_port(&ServicePort {
                host_ip: "127.0.0.1".into(),
                published: 0,
                target: 5432,
                protocol: "tcp".into(),
                is_open: None,
            })
            .unwrap()
        );
    }
}
