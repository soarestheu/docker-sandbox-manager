export interface ServicePort {
    host_ip: string;
    published: number;
    target: number;
    protocol: string;
    is_open: boolean | null;
}

export interface ComposeService {
    name: string;
    image: string;
    state: string;
    health: string;
    containers: number;
    running_containers: number;
    ports: ServicePort[];
    dependencies: string[];
}

export interface ProjectState {
    status: string;
    services: ComposeService[];
}

export interface Project extends ProjectState {
    name: string;
    path: string;
    has_docker: boolean;
    error: string | null;
    profiles: string[];
    env_files: string[];
}

export function displayPorts(ports: ServicePort[]): (ServicePort & { host_ips: string[] })[] {
    const groups = new Map<string, ServicePort & { host_ips: string[] }>();
    for (const port of ports) {
        const host = ['', '0.0.0.0', '::'].includes(port.host_ip) ? '*' : port.host_ip;
        const key = JSON.stringify([host, port.published, port.target, port.protocol]);
        const existing = groups.get(key);
        if (existing) {
            if (!existing.host_ips.includes(port.host_ip)) existing.host_ips.push(port.host_ip);
            if (port.is_open === true) existing.is_open = true;
            else if (port.is_open === false && existing.is_open === null) existing.is_open = false;
        } else {
            groups.set(key, { ...port, host_ips: [port.host_ip] });
        }
    }
    return [...groups.values()];
}

export const isServiceActive = (service: ComposeService) =>
    ['running', 'partial', 'paused', 'restarting'].includes(service.state);

export const isProjectActive = (project: ProjectState) =>
    project.status === 'running' || project.status === 'partial';

export function serviceStateLabel(service: ComposeService): string {
    if (service.health === 'unhealthy') return 'Não saudável';
    if (service.health === 'starting') return 'Inicializando';
    switch (service.state) {
        case 'running': return 'Em execução';
        case 'partial': return 'Execução parcial';
        case 'paused': return 'Pausado';
        case 'restarting': return 'Reiniciando';
        case 'created': return 'Criado';
        case 'not_created': return 'Não iniciado';
        case 'exited': return 'Parado';
        case 'dead': return 'Falhou';
        default: return service.state;
    }
}

export function portStateLabel(service: ComposeService, port: ServicePort): string {
    if (service.running_containers === 0) return 'Serviço parado';
    if (port.protocol !== 'tcp') return 'UDP · sem teste TCP';
    if (port.is_open === true) return 'Disponível';
    if (port.is_open === false) return 'Indisponível';
    return 'Sem verificação';
}
