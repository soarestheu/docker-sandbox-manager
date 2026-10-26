use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::process::Command;
use std::time::Duration;

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
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectState {
    pub status: String,
    pub services: Vec<ComposeService>,
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

pub fn compose_output(project_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("docker")
        .arg("compose")
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

            ComposeService {
                name,
                image: definition.image,
                state,
                health: health.into(),
                containers: instances.len(),
                running_containers: running,
                ports,
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

pub fn project_state(project_path: &str) -> Result<ProjectState, String> {
    let config = compose_output(project_path, &["config", "--format", "json"])?;
    let config = serde_json::from_str(&config)
        .map_err(|err| format!("Configuração Compose inválida: {err}"))?;
    let containers = compose_output(project_path, &["ps", "--all", "--format", "json"])?;
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
        "stop" => vec!["stop".into()],
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

pub fn execute_action(
    project_path: &str,
    action: &str,
    services: Option<&[String]>,
) -> Result<(), String> {
    let args = action_args(action, services)?;
    if let Some(services) = services {
        validate_services(project_path, services)?;
    }

    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    compose_output(project_path, &args)?;
    Ok(())
}

pub fn validate_services(project_path: &str, services: &[String]) -> Result<(), String> {
    if services.is_empty()
        || services
            .iter()
            .any(|name| name.is_empty() || name.starts_with('-'))
    {
        return Err("Seleção de serviços inválida.".into());
    }
    let config = compose_output(project_path, &["config", "--format", "json"])?;
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
                "api": {"image":"example/api","ports":[{"target":3000,"published":"8080","host_ip":"127.0.0.1"}]},
                "db": {"image":"postgres","ports":[{"target":5432,"published":"55432"}]},
                "worker": {"image":"example/worker"}
            }
        }"#).unwrap()
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
        assert!(state.services[2].ports.is_empty());
        assert_eq!(state.services[2].state, "running");
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
        assert!(action_args("up", Some(&[])).is_err());
        assert!(action_args("down", Some(&services)).is_err());
        assert!(action_args("stop", Some(&["--all".into()])).is_err());
        assert_eq!(action_args("up", None).unwrap(), ["up", "-d"]);
        assert_eq!(action_args("down", None).unwrap(), ["down"]);
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
        drop(listener);
        assert!(!probe_port(&port).unwrap());
    }
}
