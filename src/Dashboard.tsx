import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ComposeService, Project } from './docker';
import { displayPorts, isServiceActive, serviceStateLabel } from './docker';
import Icon from './Icon';
import type { ProjectComposeOptionsMap, ServiceNames } from './workspace';
import { serviceDisplayName } from './workspace';
import ServiceLogs from './ServiceLogs';

interface ContainerMetrics {
    name: string;
    state: string;
    cpu: string;
    memory_usage: string;
    memory_percent: string;
    network_io: string;
}

interface MetricsSnapshot {
    containers: ContainerMetrics[];
    updatedAt: number;
    error: string;
}

interface DashboardService {
    project: Project;
    service: ComposeService;
    key: string;
}

type DashboardAction = 'up' | 'stop' | 'unpause' | 'restart';

const REFRESH_INTERVAL_MS = 10_000;
const EMPTY_COMPOSE_OPTIONS = { profiles: [], envFile: null };

function metricMemoryBytes(value: string): number | null {
    const usage = value.split('/')[0]?.trim() ?? '';
    const match = usage.match(/^([\d.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/);
    if (!match) return null;
    const amount = Number(match[1]);
    const multipliers: Record<string, number> = {
        B: 1,
        kB: 1_000,
        MB: 1_000_000,
        GB: 1_000_000_000,
        TB: 1_000_000_000_000,
        KiB: 1_024,
        MiB: 1_048_576,
        GiB: 1_073_741_824,
        TiB: 1_099_511_627_776,
    };
    return Number.isFinite(amount) ? amount * multipliers[match[2]] : null;
}

function formatMemory(bytes: number | null): string {
    if (bytes === null) return '—';
    const value = bytes / 1_048_576;
    return value >= 1_024 ? `${(value / 1_024).toFixed(1)} GiB` : `${value.toFixed(1)} MiB`;
}

function metricPercent(value: string): number | null {
    const parsed = Number.parseFloat(value.replace(/%$/, '').trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export default function Dashboard({
    projects, dockerContext, selection, projectOptions, serviceNames, metricsEnabled, semanticErrors,
    busyPaths, controlsDisabled, activeTerminal, autoTerminalKeys, onAction, onToggleTerminal,
    onCloseTerminal, onRemoveContainers,
}: {
    projects: Project[];
    dockerContext: string;
    selection: Record<string, string[]>;
    projectOptions: ProjectComposeOptionsMap;
    serviceNames: ServiceNames;
    metricsEnabled: boolean;
    semanticErrors: boolean;
    busyPaths: string[];
    controlsDisabled: boolean;
    activeTerminal: { context: string; path: string; service: string } | null;
    autoTerminalKeys: Record<string, string>;
    onAction: (path: string, service: string, action: DashboardAction) => void;
    onToggleTerminal: (path: string, service: string) => void;
    onCloseTerminal: (path: string, service: string) => void;
    onRemoveContainers: (path: string, service: string, displayName: string) => void;
}) {
    const [metrics, setMetrics] = useState<Record<string, MetricsSnapshot>>({});
    const [logsKey, setLogsKey] = useState('');
    const [revision, setRevision] = useState(0);
    const [windowVisible, setWindowVisible] = useState(() => !document.hidden);

    useEffect(() => {
        const updateVisibility = () => setWindowVisible(!document.hidden);
        document.addEventListener('visibilitychange', updateVisibility);
        return () => document.removeEventListener('visibilitychange', updateVisibility);
    }, []);

    const selectedServices = useMemo<DashboardService[]>(() => projects.flatMap(project =>
        project.services
            .filter(service => selection[project.path]?.includes(service.name))
            .map(service => ({
                project,
                service,
                key: JSON.stringify([dockerContext, project.path, service.name]),
            })),
    ), [projects, selection, dockerContext]);
    const selectionKey = JSON.stringify(selectedServices.map(item => item.key));
    const monitoredServices = selectedServices.filter(({ project, service }) =>
        !project.error && service.running_containers > 0 && service.state !== 'paused',
    );
    const monitorKey = JSON.stringify([dockerContext, monitoredServices.map(({ project, service }) => {
        const options = projectOptions[project.path] ?? { profiles: [], envFile: null };
        return [project.path, service.name, options.profiles, options.envFile];
    })]);

    useEffect(() => {
        const selectedKeys = new Set(selectedServices.map(item => item.key));
        setMetrics(previous => {
            const retained = Object.fromEntries(
                Object.entries(previous).filter(([key]) => selectedKeys.has(key)),
            );
            return Object.keys(retained).length === Object.keys(previous).length ? previous : retained;
        });
    }, [selectionKey]);

    useEffect(() => {
        if (!metricsEnabled || !windowVisible || monitoredServices.length === 0) return;
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            for (const { project, service, key } of monitoredServices) {
                if (!active) return;
                const options = projectOptions[project.path] ?? { profiles: [], envFile: null };
                try {
                    const containers = await invoke<ContainerMetrics[]>('get_service_metrics', {
                        projectPath: project.path,
                        dockerContext,
                        profiles: options.profiles,
                        envFile: options.envFile,
                        service: service.name,
                    });
                    if (!active) return;
                    setMetrics(previous => ({
                        ...previous,
                        [key]: { containers, updatedAt: Date.now(), error: '' },
                    }));
                } catch (reason) {
                    if (!active) return;
                    setMetrics(previous => ({
                        ...previous,
                        [key]: {
                            containers: previous[key]?.containers ?? [],
                            updatedAt: previous[key]?.updatedAt ?? 0,
                            error: String(reason),
                        },
                    }));
                }
            }
            if (active) timer = setTimeout(refresh, REFRESH_INTERVAL_MS);
        };
        void refresh();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [monitorKey, metricsEnabled, windowVisible, revision]);

    const servicesWithLiveMetrics = selectedServices.filter(({ service }) =>
        service.running_containers > 0 && service.state !== 'paused',
    );
    const cpuValues = servicesWithLiveMetrics.flatMap(item =>
        (metrics[item.key]?.containers ?? [])
            .map(container => metricPercent(container.cpu))
            .filter((value): value is number => value !== null),
    );
    const cpuPercent = cpuValues.reduce((total, value) => total + value, 0);
    const hasCpuReading = metricsEnabled && cpuValues.length > 0;
    const memoryBytes = servicesWithLiveMetrics.reduce((total, item) =>
        total + (metrics[item.key]?.containers ?? []).reduce(
            (sum, container) => sum + (metricMemoryBytes(container.memory_usage) ?? 0), 0,
        ),
    0);
    const hasMemoryReading = metricsEnabled && servicesWithLiveMetrics.some(item =>
        (metrics[item.key]?.containers ?? []).some(container => metricMemoryBytes(container.memory_usage) !== null),
    );
    const activePorts = selectedServices.reduce((total, { service }) => {
        if (service.running_containers === 0 || service.state === 'paused') return total;
        return total + displayPorts(service.ports).filter(port =>
            port.protocol === 'tcp' && port.is_open === true,
        ).length;
    }, 0);

    return (
        <section className="dashboard-screen" aria-label="Dashboard de serviços">
            <header className="dashboard-screen-heading">
                <div>
                    <p className="eyebrow">VISÃO SELECIONADA</p>
                    <h1>Dashboard</h1>
                    <p>Os serviços são selecionados na tela de Projetos. O ciclo de métricas tem intervalo mínimo de 10 segundos e consulta serviços em sequência enquanto esta tela está visível.</p>
                </div>
                <button
                    className="button button-quiet"
                    disabled={!metricsEnabled || !windowVisible || monitoredServices.length === 0}
                    onClick={() => setRevision(value => value + 1)}
                >Atualizar métricas</button>
            </header>

            <div className="dashboard-overview" aria-label="Resumo dos serviços selecionados">
                <article className="dashboard-overview-card dashboard-kpi dashboard-kpi-cpu">
                    <div className="dashboard-kpi-heading">
                        <span className="dashboard-kpi-icon"><Icon name="cpu" size={18} /></span>
                        <span>CPU</span>
                    </div>
                    <strong>{hasCpuReading ? `${cpuPercent.toFixed(1)}%` : '—'}</strong>
                    <small title="A soma do uso dos containers pode ultrapassar 100%.">
                        {hasCpuReading ? `Soma de ${cpuValues.length} leituras de containers ativos` : 'Aguardando leitura de métricas'}
                    </small>
                </article>
                <article className="dashboard-overview-card dashboard-kpi dashboard-kpi-memory">
                    <div className="dashboard-kpi-heading">
                        <span className="dashboard-kpi-icon"><Icon name="memory" size={18} /></span>
                        <span>Memória</span>
                    </div>
                    <strong>{hasMemoryReading ? formatMemory(memoryBytes) : '—'}</strong>
                    <small>Soma aproximada dos containers selecionados</small>
                </article>
                <article className="dashboard-overview-card dashboard-kpi dashboard-kpi-ports">
                    <div className="dashboard-kpi-heading">
                        <span className="dashboard-kpi-icon"><Icon name="network" size={18} /></span>
                        <span>Portas ativas</span>
                    </div>
                    <strong>{activePorts}</strong>
                    <small>Portas TCP confirmadas como abertas</small>
                </article>
            </div>

            {!metricsEnabled && (
                <p className="dashboard-information" role="status">
                    Métricas desativadas nas Preferências. O dashboard continua exibindo estado e permite controlar os serviços.
                </p>
            )}
            {metricsEnabled && !windowVisible && (
                <p className="dashboard-information" role="status">Coleta pausada enquanto a janela está oculta.</p>
            )}

            {selectedServices.length === 0 ? (
                <div className="empty-state dashboard-empty">
                    <h3>Nenhum serviço selecionado</h3>
                    <p>Na tela de Projetos, clique em <strong>Acompanhar</strong> na linha de cada serviço que deseja ver aqui.</p>
                </div>
            ) : (
                <div className="dashboard-service-list">
                    {selectedServices.map(({ project, service, key }) => {
                        const displayName = serviceDisplayName(serviceNames, project.path, service.name);
                        const snapshot = metrics[key];
                        const options = projectOptions[project.path] ?? EMPTY_COMPOSE_OPTIONS;
                        const active = isServiceActive(service);
                        const paused = service.state === 'paused';
                        const unhealthy = service.health === 'unhealthy' || service.state === 'dead';
                        const warning = !unhealthy && (
                            service.health === 'starting'
                            || ['paused', 'partial', 'restarting'].includes(service.state)
                        );
                        const statusTone = unhealthy ? 'status-down' : warning ? 'status-warn' : active ? 'status-up' : 'status-down';
                        const showLogs = logsKey === key;
                        const serviceTerminalKey = JSON.stringify([dockerContext, project.path, service.name]);
                        const showTerminal = activeTerminal?.context === dockerContext
                            && activeTerminal.path === project.path && activeTerminal.service === service.name;
                        const terminalOpen = showTerminal || !!autoTerminalKeys[serviceTerminalKey];
                        const busy = busyPaths.includes(project.path);
                        return (
                            <article className="dashboard-service-card" key={key}>
                                <div className="dashboard-service-heading">
                                    <div className="dashboard-service-title">
                                        <p>{project.name}</p>
                                        <h2>{displayName}</h2>
                                        <span className={`status-pill ${statusTone}`}>
                                            <span className="status-dot" />{serviceStateLabel(service)}
                                        </span>
                                        <small>{service.running_containers}/{service.containers} containers ativos</small>
                                    </div>
                                    <div className="dashboard-service-actions">
                                        {paused ? (
                                            <>
                                                <button
                                                    className="button button-start"
                                                    disabled={controlsDisabled || busy || !!project.error}
                                                    onClick={() => onAction(project.path, service.name, 'unpause')}
                                                >Retomar</button>
                                                <button
                                                    className="button button-danger"
                                                    disabled={controlsDisabled || busy || !!project.error}
                                                    title="Parar o serviço encerra os containers e libera a memória reservada"
                                                    onClick={() => onAction(project.path, service.name, 'stop')}
                                                >Parar e liberar RAM</button>
                                            </>
                                        ) : (
                                            <>
                                                <button
                                                    className={`button ${active ? 'button-danger' : 'button-start'}`}
                                                    disabled={controlsDisabled || busy || !!project.error}
                                                    title={active ? 'Parar encerra os containers e libera a memória reservada' : 'Iniciar os containers deste serviço'}
                                                    onClick={() => onAction(project.path, service.name, active ? 'stop' : 'up')}
                                                >{active ? 'Parar e liberar RAM' : 'Iniciar'}</button>
                                            </>
                                        )}
                                        <button
                                            className={`button ${showLogs ? 'button-subtle' : 'button-quiet'}`}
                                            aria-expanded={showLogs}
                                            onClick={() => {
                                                setLogsKey(showLogs ? '' : key);
                                            }}
                                        >{showLogs ? 'Fechar logs' : 'Exibir logs'}</button>
                                        <details className="popover menu dashboard-service-menu">
                                            <summary className="icon-button" aria-label={`Mais ações do serviço ${service.name}`} title="Mais ações"><Icon name="more" /></summary>
                                            <div className="popover-panel">
                                                <button
                                                    className="menu-item"
                                                    aria-label={`Reiniciar serviço ${service.name} de ${project.name}`}
                                                    disabled={!active || paused || controlsDisabled || busy || !!project.error}
                                                    onClick={event => {
                                                        event.currentTarget.closest('details')?.removeAttribute('open');
                                                        onAction(project.path, service.name, 'restart');
                                                    }}
                                                ><Icon name="restart" />Reiniciar</button>
                                                <button
                                                    className="menu-item"
                                                    aria-label={`${terminalOpen ? 'Fechar' : 'Abrir'} terminal de ${service.name} de ${project.name}`}
                                                    disabled={!service.running_containers || controlsDisabled || busy || !!project.error}
                                                    onClick={event => {
                                                        event.currentTarget.closest('details')?.removeAttribute('open');
                                                        if (autoTerminalKeys[serviceTerminalKey]) onCloseTerminal(project.path, service.name);
                                                        else onToggleTerminal(project.path, service.name);
                                                    }}
                                                ><Icon name="terminal" />{terminalOpen ? 'Fechar terminal' : 'Abrir terminal'}</button>
                                                <button
                                                    className="menu-item danger"
                                                    aria-label={`Remover containers de ${service.name} de ${project.name}`}
                                                    disabled={!service.containers || controlsDisabled || busy || !!project.error}
                                                    onClick={event => {
                                                        event.currentTarget.closest('details')?.removeAttribute('open');
                                                        onRemoveContainers(project.path, service.name, displayName);
                                                    }}
                                                ><Icon name="trash" />Remover containers</button>
                                            </div>
                                        </details>
                                    </div>
                                </div>

                                {project.error && <p className="project-error" role="alert">{project.error}</p>}
                                {metricsEnabled && (
                                    <div className="dashboard-metrics">
                                        {snapshot?.error && <p className="project-error" role="alert">Falha ao consultar métricas: {snapshot.error}</p>}
                                        {service.running_containers === 0 || paused ? (
                                            <p className="services-hint">{paused
                                                ? 'Serviço pausado. A pausa não libera a memória já alocada.'
                                                : 'Serviço parado. Inicie-o para consultar consumo de recursos.'}</p>
                                        ) : (
                                            <>
                                                <div className="dashboard-metric-caption">
                                                    <span>{snapshot?.updatedAt ? `Atualizado às ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : 'Aguardando primeira leitura…'}</span>
                                                    <span>Leitura sob demanda para este serviço</span>
                                                </div>
                                                {(snapshot?.containers ?? []).length > 0 ? (
                                                    <div className="dashboard-container-list">
                                                        {snapshot?.containers.map(container => (
                                                            <div className="dashboard-container-row" key={container.name}>
                                                                <strong title={container.name}>{container.name}</strong>
                                                                <span>CPU <b>{container.cpu}</b></span>
                                                                <span>Memória <b>{container.memory_usage}</b> <small>({container.memory_percent})</small></span>
                                                                <span>Rede <b>{container.network_io || 'Sem dados'}</b></span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : !snapshot?.error && snapshot?.updatedAt ? (
                                                    <p className="services-hint">Nenhum container em execução para este serviço.</p>
                                                ) : null}
                                            </>
                                        )}
                                    </div>
                                )}

                                {showLogs && (
                                    <div className="service-inspector-panels">
                                        {showLogs && (
                                            <ServiceLogs
                                                projectPath={project.path}
                                                dockerContext={dockerContext}
                                                profiles={options.profiles}
                                                envFile={options.envFile}
                                                service={service.name}
                                                displayName={displayName}
                                                onClose={() => setLogsKey('')}
                                                semanticErrors={semanticErrors}
                                            />
                                        )}
                                    </div>
                                )}
                            </article>
                        );
                    })}
                </div>
            )}
            <p className="dashboard-note">A memória exibida é a informada pelo Docker para cada container; a soma é aproximada e pode não representar o uso total da máquina. Parar containers libera memória; pausar não.</p>
        </section>
    );
}
