// src/App.tsx
import { Fragment, useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { displayPorts, isProjectActive, isServiceActive, portStateLabel, serviceStateLabel } from './docker';
import type { Project, ProjectState } from './docker';
import Icon from './Icon';
import { useUpdater } from './useUpdater';
import ServiceLogs from './ServiceLogs';
import ServiceMetrics from './ServiceMetrics';
import ServiceTerminal from './ServiceTerminal';
import {
    defaultFeatureFlags, parseFeatureFlags, parsePreferences, parseProjectComposeOptions, portAddress,
    parseServicePresets, projectMatches, servicesForFilter,
    sortServices,
} from './workspace';
import type {
    FeatureFlags, Preferences, ProjectComposeOptions, ProjectComposeOptionsMap, ServicePreset, ServicePresets,
    ServiceSort, StatusFilter,
} from './workspace';

interface PendingAction {
    label: string;
    services: string[] | null;
}

type ComposeAction = 'up' | 'up_with_deps' | 'stop' | 'down' | 'unpause' | 'pull' | 'build' | 'recreate';

interface DockerContext {
    name: string;
    current: boolean;
}

interface ProjectDiagnostic {
    severity: string;
    message: string;
}

interface ProjectResource {
    name: string;
    resource_type: 'volume' | 'network';
    driver: string;
    in_use: boolean;
}

interface ProjectResources {
    volumes: ProjectResource[];
    networks: ProjectResource[];
}

const EMPTY_COMPOSE_OPTIONS: ProjectComposeOptions = { profiles: [], envFile: null };

export default function App() {
    const updater = useUpdater();
    const [searchPath, setSearchPath] = useState('');
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [notificationsEnabled, setNotificationsEnabled] = useState(false);
    const [dockerContexts, setDockerContexts] = useState<DockerContext[]>([]);
    const [dockerContext, setDockerContext] = useState('');

    const [activeLogPanel, setActiveLogPanel] = useState<{ path: string; service: string } | null>(null);
    const [activeTerminalPanel, setActiveTerminalPanel] = useState<{ path: string; service: string } | null>(null);
    const [selectedServices, setSelectedServices] = useState<Record<string, string[]>>({});
    const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
    const scanPopoverRef = useRef<HTMLDetailsElement>(null);
    const [busyPaths, setBusyPaths] = useState<Record<string, PendingAction>>({});
    const busyRef = useRef<Record<string, PendingAction>>({});
    const requestVersions = useRef<Record<string, number>>({});
    const [message, setMessage] = useState('');
    const [preferences, setPreferences] = useState<Preferences>({});
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [serviceSort, setServiceSort] = useState<ServiceSort>('active');
    const [favoritesOnly, setFavoritesOnly] = useState(false);
    const [groupFilter, setGroupFilter] = useState('');
    const [activeMetrics, setActiveMetrics] = useState<{ path: string; service: string } | null>(null);
    const [features, setFeatures] = useState<FeatureFlags>(defaultFeatureFlags);
    const [projectOptions, setProjectOptions] = useState<ProjectComposeOptionsMap>({});
    const [servicePresets, setServicePresets] = useState<ServicePresets>({});
    const [presetNames, setPresetNames] = useState<Record<string, string>>({});
    const [selectedPresets, setSelectedPresets] = useState<Record<string, string>>({});
    const [diagnostics, setDiagnostics] = useState<Record<string, ProjectDiagnostic[]>>({});
    const [diagnosticErrors, setDiagnosticErrors] = useState<Record<string, string>>({});
    const [diagnosing, setDiagnosing] = useState<Record<string, boolean>>({});
    const [resources, setResources] = useState<Record<string, ProjectResources>>({});
    const [resourceErrors, setResourceErrors] = useState<Record<string, string>>({});
    const [resourceLoading, setResourceLoading] = useState<Record<string, boolean>>({});
    const featureRef = useRef(features);
    featureRef.current = features;
    const [featureModalOpen, setFeatureModalOpen] = useState(false);
    const [theme, setTheme] = useState<'dark' | 'light'>('dark');
    const projectsRef = useRef(projects);
    projectsRef.current = projects;

    useEffect(() => {
        try {
            setPreferences(parsePreferences(localStorage.getItem('sandbox-workspace')));
            setProjectOptions(parseProjectComposeOptions(localStorage.getItem('sandbox-compose-options')));
            setServicePresets(parseServicePresets(localStorage.getItem('sandbox-service-presets')));
            setFeatures(parseFeatureFlags(localStorage.getItem('sandbox-features')));
            const savedTheme = localStorage.getItem('sandbox-theme');
            if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);
            if (localStorage.getItem('sandbox-notifications') === 'true') {
                void isPermissionGranted().then(setNotificationsEnabled).catch(err => {
                    setMessage(`Erro ao verificar permissão de notificações: ${err}`);
                });
            }
        } catch (err) {
            setMessage(`Erro ao carregar configurações locais: ${err}`);
        }
    }, []);

    useEffect(() => {
        const closeAll = (except?: Node | null) => {
            document.querySelectorAll<HTMLDetailsElement>('details.popover[open]').forEach(details => {
                if (!except || !details.contains(except)) details.open = false;
            });
        };
        const onMouseDown = (event: MouseEvent) => closeAll(event.target as Node);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeAll();
        };
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        try {
            localStorage.setItem('sandbox-theme', theme);
        } catch (err) {
            setMessage(`Erro ao salvar o tema: ${err}`);
        }
    }, [theme]);

    useEffect(() => {
        invoke('reset_idle_monitor').catch(err => {
            setMessage(`Erro ao reiniciar o monitor de ociosidade: ${err}`);
        });
    }, [features.autoPause]);

    const updateFeature = (key: keyof FeatureFlags, enabled: boolean) => {
        const next = { ...features, [key]: enabled };
        try {
            localStorage.setItem('sandbox-features', JSON.stringify(next));
            setFeatures(next);
            if (key === 'metrics' && !enabled) setActiveMetrics(null);
            if (key === 'theme' && !enabled) setTheme('dark');
            if (key === 'diagnostics' && !enabled) {
                setDiagnostics({});
                setDiagnosticErrors({});
            }
            if (key === 'volumes' && !enabled) {
                setResources({});
                setResourceErrors({});
            }
        } catch (err) {
            setMessage(`Erro ao salvar controles de funcionalidades: ${err}`);
        }
    };

    useEffect(() => {
        setSelectedPaths([]);
        setSelectedServices({});
        setActiveLogPanel(null);
        setActiveTerminalPanel(null);
        setActiveMetrics(null);
    }, [query, statusFilter, favoritesOnly, groupFilter]);

    const updatePreference = (path: string, update: Partial<Preferences[string]>) => {
        const next = { ...preferences, [path]: { ...(preferences[path] ?? { favorite: false, group: '' }), ...update } };
        try {
            localStorage.setItem('sandbox-workspace', JSON.stringify(next));
            setPreferences(next);
        } catch (err) {
            setMessage(`Erro ao salvar favoritos e grupos: ${err}`);
        }
    };

    const groups = [...new Set(Object.values(preferences).map(preference => preference.group).filter(Boolean))].sort();
    const visibleProjects = projects.filter(project =>
        projectMatches(project, query, statusFilter)
        && (!favoritesOnly || preferences[project.path]?.favorite)
        && (!groupFilter || preferences[project.path]?.group === groupFilter),
    ).sort((a, b) => Number(!!preferences[b.path]?.favorite) - Number(!!preferences[a.path]?.favorite));
    const visibleSelectedPaths = selectedPaths.filter(path => visibleProjects.some(project => project.path === path));

    const copyPort = async (address: string) => {
        try {
            await invoke('copy_service_address', { address });
            setMessage(`Endereço copiado: ${address}`);
        } catch (err) {
            setMessage(`Erro ao copiar endereço: ${err}`);
        }
    };

    const openPort = async (host: string, port: number, https: boolean) => {
        try {
            await invoke('open_service_http', { host, port, https });
        } catch (err) {
            setMessage(`Erro ao abrir serviço HTTP: ${err}`);
        }
    };

    const applyProjectState = (path: string, state: ProjectState) => {
        const previousProject = projectsRef.current.find(project => project.path === path);
        for (const service of state.services) {
            const previous = previousProject?.services.find(item => item.name === service.name);
            if (!previous || !notificationsEnabled) continue;
            const wasFailed = previous.health === 'unhealthy' || previous.state === 'dead';
            const isFailed = service.health === 'unhealthy' || service.state === 'dead';
            if (isFailed && !wasFailed) {
                try {
                    sendNotification({
                        title: `Falha no serviço ${service.name}`,
                        body: `${path} · ${service.health === 'unhealthy' ? 'container não saudável' : 'container encerrado com falha'}`,
                    });
                } catch (err) {
                    setMessage(`Erro ao enviar notificação: ${err}`);
                }
            } else if (wasFailed && !isFailed && isServiceActive(service)) {
                try {
                    sendNotification({ title: `Serviço recuperado: ${service.name}`, body: path });
                } catch (err) {
                    setMessage(`Erro ao enviar notificação: ${err}`);
                }
            }
        }
        setProjects(prev => prev.map(project =>
            project.path === path ? { ...project, ...state, error: null } : project,
        ));
        setSelectedServices(prev => ({
            ...prev,
            [path]: (prev[path] || []).filter(name => state.services.some(service => service.name === name)),
        }));
    };

    const toggleNotifications = async () => {
        if (notificationsEnabled) {
            try {
                localStorage.setItem('sandbox-notifications', 'false');
                setNotificationsEnabled(false);
            } catch (err) {
                setMessage(`Erro ao desativar notificações: ${err}`);
            }
            return;
        }
        try {
            const granted = await isPermissionGranted() || await requestPermission() === 'granted';
            if (!granted) {
                setMessage('Permissão de notificações negada pelo sistema.');
                return;
            }
            localStorage.setItem('sandbox-notifications', 'true');
            setNotificationsEnabled(true);
            sendNotification({ title: 'Docker Sandbox Manager', body: 'Notificações de estado ativadas.' });
        } catch (err) {
            setMessage(`Erro ao ativar notificações: ${err}`);
        }
    };
    const optionsFor = (path: string): ProjectComposeOptions =>
        projectOptions[path] ?? EMPTY_COMPOSE_OPTIONS;

    const refreshProject = async (path: string, options = optionsFor(path)) => {
        const version = (requestVersions.current[path] || 0) + 1;
        requestVersions.current[path] = version;
        try {
            const state = await invoke<ProjectState>('get_project_state', {
                projectPath: path,
                dockerContext,
                profiles: options.profiles,
                envFile: options.envFile,
            });
            if (requestVersions.current[path] === version) {
                applyProjectState(path, state);
                if (featureRef.current.autoPause && !busyRef.current[path]) {
                    try {
                        const paused = await invoke<string[]>('pause_idle_containers', {
                            projectPath: path,
                            dockerContext,
                            profiles: options.profiles,
                            envFile: options.envFile,
                            idleSeconds: 900,
                        });
                        if (paused.length) {
                            setMessage(`Pausa automática após 15 minutos sem tráfego: ${paused.join(', ')} (${path}).`);
                            const updated = await invoke<ProjectState>('get_project_state', {
                                projectPath: path,
                                dockerContext,
                                profiles: options.profiles,
                                envFile: options.envFile,
                            });
                            if (requestVersions.current[path] === version) applyProjectState(path, updated);
                        }
                    } catch (err) {
                        setMessage(current => current === `Falha na pausa automática em ${path}: ${err}`
                            ? current : `Falha na pausa automática em ${path}: ${err}`);
                    }
                }
            }
        } catch (err) {
            if (requestVersions.current[path] === version) {
                setProjects(prev => prev.map(project =>
                    project.path === path ? { ...project, error: String(err) } : project,
                ));
            }
        }
    };

    const updateProjectOptions = (path: string, nextOptions: ProjectComposeOptions) => {
        const next = { ...projectOptions, [path]: nextOptions };
        try {
            localStorage.setItem('sandbox-compose-options', JSON.stringify(next));
            setProjectOptions(next);
            void refreshProject(path, nextOptions);
        } catch (err) {
            setMessage(`Erro ao salvar opções Compose: ${err}`);
        }
    };

    const projectPathsKey = JSON.stringify({
        context: dockerContext,
        paths: projects.map(project => project.path),
        options: projectOptions,
    });
    useEffect(() => {
        const { paths }: { context: string; paths: string[] } = JSON.parse(projectPathsKey);
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            await Promise.all(paths.filter(path => !busyRef.current[path]).map(path => refreshProject(path)));
            if (!disposed) timer = setTimeout(poll, 3000);
        };
        timer = setTimeout(poll, 3000);
        return () => {
            disposed = true;
            clearTimeout(timer);
            paths.forEach(path => { requestVersions.current[path] = (requestVersions.current[path] || 0) + 1; });
        };
    }, [projectPathsKey]);

    useEffect(() => {
        let disposed = false;
        async function init() {
            setLoading(true);
            try {
                const contexts = await invoke<DockerContext[]>('get_docker_contexts');
                if (!contexts.length) throw new Error('Nenhum contexto Docker disponível.');
                const savedContext = localStorage.getItem('sandbox-docker-context');
                const context = contexts.find(item => item.name === savedContext)?.name
                    ?? contexts.find(item => item.current)?.name
                    ?? contexts[0].name;
                if (!disposed) {
                    setDockerContexts(contexts);
                    setDockerContext(context);
                }
                const defaultPath: string = await invoke('get_default_projects_dir');
                if (!disposed) setSearchPath(defaultPath);
                const result: Project[] = await invoke('scan_directory', {
                    basePath: defaultPath, dockerContext: context,
                });
                if (!disposed) setProjects(result);
            } catch (err) {
                if (!disposed) setMessage(`Erro ao carregar diretório padrão: ${err}`);
            } finally {
                if (!disposed) setLoading(false);
            }
        }
        init();
        return () => { disposed = true; };
    }, []);

    const handleScan = async () => {
        if (!searchPath) return;
        setLoading(true);
        setMessage('');
        try {
            const result: Project[] = await invoke('scan_directory', {
                basePath: searchPath, dockerContext,
            });
            setProjects(result);
            setSelectedPaths([]);
            setSelectedServices({});
            setActiveLogPanel(null);
            setActiveTerminalPanel(null);
            setActiveMetrics(null);
        } catch (err) {
            setMessage(`Erro ao escanear: ${err}`);
        } finally {
            setLoading(false);
        }
    };

    const handleContextChange = async (context: string) => {
        setDockerContext(context);
        try {
            localStorage.setItem('sandbox-docker-context', context);
        } catch (err) {
            setMessage(`Erro ao salvar o contexto Docker: ${err}`);
        }
        if (!searchPath) return;
        setLoading(true);
        setMessage('');
        try {
            const result: Project[] = await invoke('scan_directory', {
                basePath: searchPath, dockerContext: context,
            });
            setProjects(result);
            setSelectedPaths([]);
            setSelectedServices({});
            setActiveLogPanel(null);
            setActiveTerminalPanel(null);
            setActiveMetrics(null);
        } catch (err) {
            setMessage(`Erro ao escanear contexto ${context}: ${err}`);
        } finally {
            setLoading(false);
        }
    };

    const performAction = async (path: string, action: ComposeAction, services?: string[]) => {
        if (busyRef.current[path]) return 'Já existe uma ação em andamento neste projeto.';
        const actionLabels: Record<ComposeAction, string> = {
            up: 'Iniciando…',
            up_with_deps: 'Iniciando dependências…',
            stop: 'Parando…',
            down: 'Parando…',
            unpause: 'Retomando…',
            pull: 'Baixando imagens…',
            build: 'Construindo…',
            recreate: 'Recriando…',
        };
        busyRef.current[path] = {
            label: actionLabels[action],
            services: services ? [...services] : null,
        };
        setBusyPaths({ ...busyRef.current });
        const version = (requestVersions.current[path] || 0) + 1;
        requestVersions.current[path] = version;
        try {
            const state = await invoke<ProjectState>('run_compose_action', {
                projectPath: path,
                dockerContext,
                profiles: optionsFor(path).profiles,
                envFile: optionsFor(path).envFile,
                action,
                services: services ?? null,
            });
            if (requestVersions.current[path] === version) applyProjectState(path, state);
            return null;
        } catch (err) {
            // Compose can apply only part of an action before returning an error.
            await refreshProject(path);
            return String(err);
        } finally {
            delete busyRef.current[path];
            setBusyPaths({ ...busyRef.current });
        }
    };

    const handleDockerAction = async (path: string, action: ComposeAction, services?: string[]) => {
        const error = await performAction(path, action, services);
        const successMessages: Record<ComposeAction, string> = {
            up: `${services ? 'Serviços selecionados' : 'Projeto'} iniciado`,
            up_with_deps: 'Serviços e dependências iniciados',
            stop: 'Serviços selecionados parados',
            down: 'Projeto parado',
            unpause: 'Serviços retomados',
            pull: 'Imagens atualizadas',
            build: 'Build concluído',
            recreate: 'Containers recriados',
        };
        setMessage(error ? `Erro em ${path}: ${error}` : `${successMessages[action]} em ${path}.`);
    };

    const saveServicePreset = (path: string) => {
        const name = (presetNames[path] ?? '').trim();
        const services = selectedServices[path] ?? [];
        if (!name || !services.length) {
            setMessage('Informe um nome e selecione ao menos um serviço para salvar a predefinição.');
            return;
        }
        const entry: ServicePreset = { name, services: [...new Set(services)] };
        const current = servicePresets[path] ?? [];
        const next = {
            ...servicePresets,
            [path]: [...current.filter(preset => preset.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name)),
        };
        try {
            localStorage.setItem('sandbox-service-presets', JSON.stringify(next));
            setServicePresets(next);
            setSelectedPresets(prev => ({ ...prev, [path]: name }));
            setPresetNames(prev => ({ ...prev, [path]: '' }));
            setMessage(`Predefinição "${name}" salva para ${path}.`);
        } catch (err) {
            setMessage(`Erro ao salvar predefinições: ${err}`);
        }
    };

    const removeServicePreset = (path: string, name: string) => {
        const next = { ...servicePresets, [path]: (servicePresets[path] ?? []).filter(preset => preset.name !== name) };
        try {
            localStorage.setItem('sandbox-service-presets', JSON.stringify(next));
            setServicePresets(next);
            setSelectedPresets(prev => ({ ...prev, [path]: next[path][0]?.name ?? '' }));
        } catch (err) {
            setMessage(`Erro ao remover predefinição: ${err}`);
        }
    };

    const runServicePreset = (path: string, action: 'up' | 'stop') => {
        const preset = (servicePresets[path] ?? []).find(item => item.name === selectedPresets[path]);
        if (!preset) {
            setMessage('Selecione uma predefinição de serviços.');
            return;
        }
        void handleDockerAction(path, action, preset.services);
    };

    const diagnoseProject = async (path: string) => {
        setDiagnosing(prev => ({ ...prev, [path]: true }));
        setDiagnosticErrors(prev => ({ ...prev, [path]: '' }));
        try {
            const options = optionsFor(path);
            const result = await invoke<ProjectDiagnostic[]>('diagnose_project', {
                projectPath: path,
                dockerContext,
                profiles: options.profiles,
                envFile: options.envFile,
            });
            setDiagnostics(prev => ({ ...prev, [path]: result }));
        } catch (err) {
            setDiagnosticErrors(prev => ({ ...prev, [path]: String(err) }));
        } finally {
            setDiagnosing(prev => ({ ...prev, [path]: false }));
        }
    };

    const clearDiagnostics = (path: string) => {
        setDiagnostics(prev => {
            const next = { ...prev };
            delete next[path];
            return next;
        });
        setDiagnosticErrors(prev => {
            const next = { ...prev };
            delete next[path];
            return next;
        });
    };

    const loadProjectResources = async (path: string) => {
        setResourceLoading(prev => ({ ...prev, [path]: true }));
        setResourceErrors(prev => ({ ...prev, [path]: '' }));
        try {
            const options = optionsFor(path);
            const result = await invoke<ProjectResources>('get_project_resources', {
                projectPath: path,
                dockerContext,
                profiles: options.profiles,
                envFile: options.envFile,
            });
            setResources(prev => ({ ...prev, [path]: result }));
        } catch (err) {
            setResourceErrors(prev => ({ ...prev, [path]: String(err) }));
        } finally {
            setResourceLoading(prev => ({ ...prev, [path]: false }));
        }
    };

    const removeProjectResource = async (path: string, resource: ProjectResource) => {
        const warning = resource.resource_type === 'volume'
            ? `Excluir o volume "${resource.name}" apagará permanentemente os dados armazenados nele. Continuar?`
            : `Excluir a rede "${resource.name}"? Ela será recriada pelo Compose se necessária.`;
        if (!window.confirm(warning)) return;
        try {
            const options = optionsFor(path);
            await invoke('remove_project_resource', {
                projectPath: path,
                dockerContext,
                profiles: options.profiles,
                envFile: options.envFile,
                resourceType: resource.resource_type,
                name: resource.name,
            });
            await loadProjectResources(path);
        } catch (err) {
            setResourceErrors(prev => ({ ...prev, [path]: String(err) }));
        }
    };

    const handleBatchAction = async (action: 'up' | 'down') => {
        if (visibleSelectedPaths.length === 0) return;
        setLoading(true);
        setMessage(`Executando ação em ${visibleSelectedPaths.length} projetos…`);
        const errors: string[] = [];
        try {
            for (const path of visibleSelectedPaths) {
                const error = await performAction(path, action);
                if (error) errors.push(`${path}: ${error}`);
            }
            setMessage(errors.length
                ? `Falha em ${errors.length} projeto(s): ${errors.join(' | ')}`
                : 'Ação em lote finalizada com sucesso.');
        } finally {
            setLoading(false);
        }
    };

    const handleOpenWebStorm = async (path: string) => {
        try {
            await invoke('open_in_webstorm', { projectPath: path });
        } catch (err) {
            setMessage(`Erro ao abrir IDE: ${err}`);
        }
    };

    const toggleSelectProject = (path: string) => {
        setSelectedPaths(prev =>
            prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
        );
    };

    const toggleSelectAll = () => {
        if (visibleSelectedPaths.length === visibleProjects.length) {
            setSelectedPaths([]);
        } else {
            setSelectedPaths(visibleProjects.map(p => p.path));
        }
    };

    const hasBusyProjects = Object.keys(busyPaths).length > 0;
    const runningProjects = projects.filter(isProjectActive).length;
    const services = projects.flatMap(project => project.services);
    const runningContainers = services.reduce((total, service) => total + service.running_containers, 0);
    const totalContainers = services.reduce((total, service) => total + service.containers, 0);
    const stoppedServices = services.filter(service => !isServiceActive(service)).length;
    const unhealthyServices = services.filter(service => service.health === 'unhealthy').length;
    const failedProjects = projects.filter(project => project.error).length;
    const availablePorts = services.reduce((total, service) =>
        total + displayPorts(service.ports).filter(port => service.running_containers > 0 && port.is_open === true).length, 0);
    const publishedPorts = projects.reduce(
        (total, project) => total + project.services.reduce(
            (count, service) => count + (service.running_containers > 0 ? displayPorts(service.ports).length : 0), 0,
        ),
        0,
    );

    return (
        <main className="app-shell">
            <div className="app-frame">
                <header className="topbar">
                    <div className="brand">
                        <div className="brand-mark" aria-hidden="true">
                            <svg viewBox="0 0 32 32" fill="none">
                                <path d="M7 10.5 16 6l9 4.5v11L16 26l-9-4.5v-11Z" />
                                <path d="m7.5 10.8 8.5 4.4 8.5-4.4M16 15.5V25" />
                            </svg>
                        </div>
                        <p className="brand-name">Docker <span>Sandbox</span></p>
                    </div>
                    <div className="topbar-tools">
                        {features.directory && (
                            <>
                                <label className="context-select">
                                    <span className="context-label">Contexto</span>
                                    <select
                                        aria-label="Contexto Docker"
                                        value={dockerContext}
                                        onChange={event => void handleContextChange(event.target.value)}
                                        disabled={loading || !dockerContexts.length}
                                    >
                                        {dockerContexts.map(context => (
                                            <option key={context.name} value={context.name}>
                                                {context.name}{context.current ? ' · atual' : ''}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <details className="popover scan-popover" ref={scanPopoverRef}>
                                    <summary className="button button-quiet" title={searchPath || 'Escolher a pasta dos projetos'}>
                                        <Icon name="folder" />
                                        <span className="scan-path-label">{searchPath.split('/').filter(Boolean).pop() || 'Escolher pasta'}</span>
                                        <Icon name="chevron" size={14} />
                                    </summary>
                                    <div className="popover-panel scan-form" aria-label="Localizar projetos">
                                        <label className="menu-field">
                                            Pasta dos projetos
                                            <input
                                                className="utility-input"
                                                type="text"
                                                value={searchPath}
                                                onChange={(e) => setSearchPath(e.target.value)}
                                                placeholder="/home/usuario/Projetos"
                                                aria-label="Caminho do diretório de projetos"
                                            />
                                        </label>
                                        <button className="button button-primary scan-button" onClick={handleScan} disabled={loading || hasBusyProjects || !searchPath.trim()}>
                                            {loading ? 'Sincronizando…' : 'Varrer diretório'}
                                        </button>
                                    </div>
                                </details>
                            </>
                        )}
                        <span className="topbar-divider" aria-hidden="true" />
                        <button
                            className="icon-button"
                            onClick={() => void toggleNotifications()}
                            aria-label={notificationsEnabled ? 'Desativar notificações' : 'Ativar notificações'}
                            title={notificationsEnabled ? 'Desativar notificações' : 'Ativar notificações'}
                        ><Icon name={notificationsEnabled ? 'bell' : 'bellOff'} /></button>
                        {features.theme && (
                            <button
                                className="icon-button"
                                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                                aria-label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
                                title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
                            ><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
                        )}
                        <button className="icon-button" onClick={() => setFeatureModalOpen(true)} aria-label="Preferências" title="Preferências">
                            <Icon name="gear" />
                        </button>
                    </div>
                </header>

                {updater.state.status !== 'idle' && !(updater.dismissed && updater.state.status === 'available') && (
                    <div className="update-banner" role="status">
                        {updater.state.status === 'available' && (
                            <>
                                <span>Nova versão <strong>{updater.state.version}</strong> disponível.</span>
                                <button className="button button-primary" onClick={() => void updater.install()}>Atualizar agora</button>
                                <button className="icon-button" onClick={updater.dismiss} aria-label="Dispensar aviso de atualização" title="Depois"><Icon name="close" /></button>
                            </>
                        )}
                        {updater.state.status === 'downloading' && (
                            <span>Baixando {updater.state.version}{updater.state.progress !== null ? ` — ${updater.state.progress}%` : '…'}</span>
                        )}
                        {updater.state.status === 'error' && <span>Falha ao atualizar: {updater.state.message}</span>}
                    </div>
                )}

                <section className="summary-bar" aria-label="Resumo dos projetos">
                    <span className="summary-item" role="status">
                        <span className="status-dot" />
                        <strong>{runningProjects}</strong> de {projects.length} projetos ativos
                    </span>
                    <span className="summary-item"><strong>{runningContainers}</strong>/{totalContainers} containers</span>
                    <span className="summary-item"><strong>{publishedPorts}</strong> portas publicadas</span>
                    {(unhealthyServices > 0 || failedProjects > 0) && (
                        <span className="summary-item summary-warning">
                            <Icon name="alert" size={14} />
                            {unhealthyServices + failedProjects} com problemas
                        </span>
                    )}
                    <details className="popover dashboard-health">
                        <summary title="Os dados são atualizados automaticamente a cada 3 segundos">Detalhes</summary>
                        <div className="popover-panel">
                            <dl>
                                <div><dt>Serviços encontrados</dt><dd>{services.length}</dd></div>
                                <div><dt>Serviços parados</dt><dd>{stoppedServices}</dd></div>
                                <div><dt>Não saudáveis</dt><dd className={unhealthyServices ? 'health-warning' : ''}>{unhealthyServices}</dd></div>
                                <div><dt>Portas TCP disponíveis</dt><dd>{availablePorts}</dd></div>
                                <div><dt>Falhas de consulta</dt><dd className={failedProjects ? 'health-warning' : ''}>{failedProjects}</dd></div>
                            </dl>
                        </div>
                    </details>
                </section>

                {message && (
                    <div className="notice" role="status">
                        <span className="notice-mark" aria-hidden="true">i</span>
                        <span>{message}</span>
                        <button className="notice-dismiss" onClick={() => setMessage('')} aria-label="Dispensar mensagem">×</button>
                    </div>
                )}

                <section className="projects-section">
                    <div className="project-filters">
                        <label className="search-field">
                            <Icon name="search" />
                            <input className="utility-input project-search" aria-label="Buscar projetos ou serviços" placeholder="Buscar projeto, serviço ou imagem…" value={query} onChange={event => setQuery(event.target.value)} />
                        </label>
                        <div className="chip-group" role="group" aria-label="Filtrar por status">
                            {([['all', 'Todos'], ['active', 'Ativos'], ['stopped', 'Parados'], ['failed', 'Falhas']] as const).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    className={`chip${statusFilter === value ? ' is-active' : ''}`}
                                    data-status={value}
                                    aria-pressed={statusFilter === value}
                                    onClick={() => setStatusFilter(value)}
                                >{label}<span className="chip-count">{projects.filter(project => projectMatches(project, '', value)).length}</span></button>
                            ))}
                        </div>
                        <button
                            type="button"
                            className={`chip${favoritesOnly ? ' is-active' : ''}`}
                            aria-pressed={favoritesOnly}
                            onClick={() => setFavoritesOnly(!favoritesOnly)}
                        ><Icon name="star" size={13} />Favoritos</button>
                        {groups.length > 0 && (
                            <select className="utility-input" aria-label="Filtrar por grupo" value={groupFilter} onChange={event => setGroupFilter(event.target.value)}>
                                <option value="">Todos os grupos</option>
                                {groups.map(group => <option key={group} value={group}>{group}</option>)}
                            </select>
                        )}
                    </div>
                    <datalist id="workspace-groups">{groups.map(group => <option key={group} value={group} />)}</datalist>

                    {visibleProjects.length > 0 && (
                        <div className="list-header">
                            <label className="select-all">
                                <input
                                    type="checkbox"
                                    checked={visibleSelectedPaths.length > 0 && visibleSelectedPaths.length === visibleProjects.length}
                                    onChange={toggleSelectAll}
                                    aria-label="Selecionar projetos visíveis"
                                />
                                <span>{visibleProjects.length} de {projects.length} projetos</span>
                            </label>
                        </div>
                    )}
                    {visibleSelectedPaths.length > 0 && (
                        <div className="selection-bar" role="toolbar" aria-label="Ações em lote">
                            <span>{visibleSelectedPaths.length} selecionado{visibleSelectedPaths.length === 1 ? '' : 's'}</span>
                            <button className="button button-start" onClick={() => handleBatchAction('up')} disabled={loading || hasBusyProjects}><Icon name="play" size={14} />Iniciar</button>
                            <button className="button button-danger" onClick={() => handleBatchAction('down')} disabled={loading || hasBusyProjects}><Icon name="stop" size={14} />Parar</button>
                            <button className="icon-button" onClick={() => setSelectedPaths([])} aria-label="Limpar seleção" title="Limpar seleção"><Icon name="close" /></button>
                        </div>
                    )}

                    {visibleProjects.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-illustration" aria-hidden="true">
                                <span>▱</span><span>▱</span><span>▱</span>
                            </div>
                            <h3>{loading ? 'Procurando projetos…' : projects.length ? 'Nenhum resultado para estes filtros' : 'Nenhum projeto por aqui'}</h3>
                            <p>{loading ? 'Estamos verificando o diretório selecionado.' : projects.length ? 'Altere a busca, o estado, os favoritos ou o grupo para visualizar outros projetos.' : 'Escolha a pasta dos projetos e faça uma varredura para encontrar seus projetos Docker.'}</p>
                            {!loading && !projects.length && features.directory && (
                                <button className="button button-primary" onClick={() => { if (scanPopoverRef.current) scanPopoverRef.current.open = true; }}>
                                    <Icon name="folder" />Escolher pasta
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="project-list">
                            {visibleProjects.map((project) => {
                                const visibleServices = sortServices(servicesForFilter(project, query, statusFilter), serviceSort);
                                const composeOptions = optionsFor(project.path);
                                const isExpanded = !!expandedProjects[project.path];
                                const detailsId = `project-details-${encodeURIComponent(project.path)}`;
                                const isRunning = isProjectActive(project);
                                const selection = (selectedServices[project.path] || []).filter(name => visibleServices.some(service => service.name === name));
                                const busy = busyPaths[project.path];
                                const projectBusyLabel = busy?.services === null ? busy.label : undefined;
                                const controlsDisabled = loading || !!busy;
                                const selectedItems = project.services.filter(service => selection.includes(service.name));
                                const activeServiceCount = project.services.filter(isServiceActive).length;
                                const openPortNumbers = [...new Set(project.services.flatMap(service =>
                                    service.running_containers > 0 ? displayPorts(service.ports).map(port => port.published) : []))];

                                return (
                                    <article key={project.path} className={`project-card${isRunning ? ' is-running' : ''}`}>
                                        <div className="project-main">
                                            <label className="project-select">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedPaths.includes(project.path)}
                                                    onChange={() => toggleSelectProject(project.path)}
                                                    aria-label={`Selecionar ${project.name}`}
                                                />
                                            </label>
                                            <button
                                                className="icon-button expand-toggle"
                                                aria-label={`${isExpanded ? 'Recolher' : 'Expandir'} projeto ${project.name}`}
                                                aria-expanded={isExpanded}
                                                aria-controls={detailsId}
                                                onClick={() => {
                                                    setExpandedProjects(prev => ({ ...prev, [project.path]: !isExpanded }));
                                                    if (isExpanded && activeLogPanel?.path === project.path) setActiveLogPanel(null);
                                                    if (isExpanded && activeTerminalPanel?.path === project.path) setActiveTerminalPanel(null);
                                                    if (isExpanded && activeMetrics?.path === project.path) setActiveMetrics(null);
                                                }}
                                            ><Icon name="chevron" /></button>
                                            <div className="project-info">
                                                <div className="project-title-row">
                                                    <h3 title={project.path}>{project.name}</h3>
                                                    <button
                                                        className="favorite-button"
                                                        aria-label={`Favoritar projeto ${project.name}`}
                                                        aria-pressed={!!preferences[project.path]?.favorite}
                                                        onClick={() => updatePreference(project.path, { favorite: !preferences[project.path]?.favorite })}
                                                    ><Icon name="star" size={15} /></button>
                                                    <span className={`status-pill ${project.error ? 'status-stopped' : isRunning ? 'status-online' : 'status-stopped'}`}>
                                                        <span className="status-dot" />
                                                        {projectBusyLabel || (project.error ? 'Falha na consulta' : project.status === 'partial' ? 'Execução parcial' : isRunning ? 'Em execução' : 'Parado')}
                                                    </span>
                                                </div>
                                                <p className="project-summary">
                                                    {project.services.length > 0 && <span>{activeServiceCount}/{project.services.length} serviços</span>}
                                                    {openPortNumbers.slice(0, 4).map(port => <span key={port} className="mini-port">:{port}</span>)}
                                                    {openPortNumbers.length > 4 && <span className="mini-port">+{openPortNumbers.length - 4}</span>}
                                                    {preferences[project.path]?.group && <span className="mini-tag">{preferences[project.path]?.group}</span>}
                                                </p>
                                            </div>
                                            <div className="project-actions">
                                                {isRunning ? (
                                                    <button className="button button-danger" disabled={controlsDisabled} onClick={() => handleDockerAction(project.path, 'down')} title="Parar e remover todos os containers do projeto"><Icon name="stop" size={14} />{projectBusyLabel || 'Parar'}</button>
                                                ) : (
                                                    <button className="button button-start" disabled={controlsDisabled} onClick={() => handleDockerAction(project.path, 'up')}><Icon name="play" size={14} />{projectBusyLabel || 'Iniciar'}</button>
                                                )}
                                                <details className="popover menu">
                                                    <summary className="icon-button" aria-label={`Mais ações de ${project.name}`} title="Mais ações"><Icon name="more" /></summary>
                                                    <div
                                                        className="popover-panel"
                                                        onClick={event => {
                                                            if ((event.target as HTMLElement).closest('button')) {
                                                                event.currentTarget.closest('details')?.removeAttribute('open');
                                                            }
                                                        }}
                                                    >
                                                        <button className="menu-item" onClick={() => handleOpenWebStorm(project.path)} title="Abrir projeto no WebStorm"><Icon name="code" />Abrir na IDE</button>
                                                        {(features.imagePull || features.projectBuild || features.containerRecreate || features.diagnostics || features.volumes) && (
                                                            <div className="lifecycle-actions" aria-label={`Ações do projeto ${project.name}`}>
                                                                {(features.imagePull || features.projectBuild || features.containerRecreate) && (
                                                                    <>
                                                                        <span className="menu-label">Imagem e projeto</span>
                                                                        {features.imagePull && <button className="menu-item" disabled={controlsDisabled || !!project.error} onClick={() => handleDockerAction(project.path, 'pull')}>Baixar imagens</button>}
                                                                        {features.projectBuild && <button className="menu-item" disabled={controlsDisabled || !!project.error} onClick={() => handleDockerAction(project.path, 'build')}>Build do projeto</button>}
                                                                        {features.containerRecreate && <button className="menu-item" disabled={controlsDisabled || !!project.error} onClick={() => handleDockerAction(project.path, 'recreate')}>Recriar containers</button>}
                                                                    </>
                                                                )}
                                                                {(features.diagnostics || features.volumes) && (
                                                                    <>
                                                                        <span className="menu-label">Ferramentas</span>
                                                                        {features.diagnostics && (
                                                                            <button className="menu-item" disabled={diagnosing[project.path]} onClick={() => void diagnoseProject(project.path)}>
                                                                                {diagnosing[project.path] ? 'Diagnosticando…' : 'Diagnosticar'}
                                                                            </button>
                                                                        )}
                                                                        {features.volumes && (
                                                                            <button className="menu-item" disabled={resourceLoading[project.path]} onClick={() => void loadProjectResources(project.path)}>
                                                                                {resourceLoading[project.path] ? 'Carregando recursos…' : 'Volumes e redes'}
                                                                            </button>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>
                                                        )}
                                                        <span className="menu-label">Organização</span>
                                                        <label className="menu-field">Grupo
                                                            <input className="utility-input" aria-label={`Grupo de ${project.name}`} list="workspace-groups" placeholder="Ex.: Trabalho" maxLength={60} value={preferences[project.path]?.group || ''} onChange={event => updatePreference(project.path, { group: event.target.value })} />
                                                        </label>
                                                    </div>
                                                </details>
                                            </div>
                                        </div>
                                        {features.diagnostics && (diagnosticErrors[project.path] || diagnostics[project.path]) && (
                                            <div className="diagnostic-results" role={diagnosticErrors[project.path] ? 'alert' : 'status'}>
                                                <div className="diagnostic-messages">
                                                    {diagnosticErrors[project.path]
                                                        ? <p>{diagnosticErrors[project.path]}</p>
                                                        : diagnostics[project.path]?.map((item, index) => (
                                                            <p key={`${item.severity}-${index}`} className={`diagnostic-${item.severity}`}>
                                                                <strong>{item.severity === 'ok' ? 'OK' : 'Aviso'}</strong> · {item.message}
                                                            </p>
                                                        ))}
                                                </div>
                                                <button
                                                    className="diagnostic-dismiss"
                                                    type="button"
                                                    aria-label={`Fechar diagnóstico de ${project.name}`}
                                                    title="Fechar diagnóstico"
                                                    onClick={() => clearDiagnostics(project.path)}
                                                >×</button>
                                            </div>
                                        )}
                                        {(project.services.length > 0 || (project.profiles?.length ?? 0) > 0 || (project.env_files?.length ?? 0) > 0) && (
                                        <details className="project-config" hidden={!isExpanded}>
                                        <summary>Configuração do projeto</summary>
                                        {((project.profiles?.length ?? 0) > 0 || (project.env_files?.length ?? 0) > 0) && (
                                            <div className="compose-options">
                                                {(project.profiles?.length ?? 0) > 0 && (
                                                    <label>Perfis Compose
                                                        <select
                                                            className="utility-input"
                                                            aria-label={`Perfis Compose de ${project.name}`}
                                                            multiple
                                                            value={optionsFor(project.path).profiles}
                                                            disabled={controlsDisabled}
                                                            onChange={event => updateProjectOptions(project.path, {
                                                                ...optionsFor(project.path),
                                                                profiles: Array.from(event.currentTarget.selectedOptions, option => option.value),
                                                            })}
                                                        >
                                                            {project.profiles.map(profile => <option key={profile} value={profile}>{profile}</option>)}
                                                        </select>
                                                    </label>
                                                )}
                                                {(project.env_files?.length ?? 0) > 0 && (
                                                    <label>Arquivo de ambiente
                                                        <select
                                                            className="utility-input"
                                                            aria-label={`Arquivo de ambiente de ${project.name}`}
                                                            value={optionsFor(project.path).envFile ?? ''}
                                                            disabled={controlsDisabled}
                                                            onChange={event => updateProjectOptions(project.path, {
                                                                ...optionsFor(project.path),
                                                                envFile: event.target.value || null,
                                                            })}
                                                        >
                                                            <option value="">Compose padrão</option>
                                                            {project.env_files.map(file => <option key={file} value={file}>{file}</option>)}
                                                        </select>
                                                    </label>
                                                )}
                                                <span className="services-hint">Valores dos arquivos .env não são exibidos.</span>
                                            </div>
                                        )}
                                        {project.services.length > 0 && (
                                            <div className="preset-controls" aria-label={`Predefinições de serviços de ${project.name}`}>
                                                <label>Salvar seleção
                                                    <input
                                                        className="utility-input"
                                                        aria-label={`Nome da predefinição de ${project.name}`}
                                                        maxLength={60}
                                                        placeholder="Ex.: backend"
                                                        value={presetNames[project.path] ?? ''}
                                                        onChange={event => setPresetNames(prev => ({
                                                            ...prev, [project.path]: event.target.value,
                                                        }))}
                                                    />
                                                </label>
                                                <button
                                                    className="button button-quiet"
                                                    disabled={controlsDisabled || !(selectedServices[project.path]?.length)}
                                                    onClick={() => saveServicePreset(project.path)}
                                                >Salvar preset</button>
                                                <label>Predefinição
                                                    <select
                                                        className="utility-input"
                                                        aria-label={`Predefinição de ${project.name}`}
                                                        value={selectedPresets[project.path] ?? ''}
                                                        onChange={event => setSelectedPresets(prev => ({
                                                            ...prev, [project.path]: event.target.value,
                                                        }))}
                                                    >
                                                        <option value="">Selecione…</option>
                                                        {(servicePresets[project.path] ?? []).map(preset => (
                                                            <option key={preset.name} value={preset.name}>
                                                                {preset.name} · {preset.services.length} serviço(s)
                                                            </option>
                                                        ))}
                                                    </select>
                                                </label>
                                                <button
                                                    className="button button-subtle"
                                                    disabled={controlsDisabled || !!project.error || !selectedPresets[project.path]}
                                                    onClick={() => runServicePreset(project.path, 'up')}
                                                >Iniciar preset</button>
                                                <button
                                                    className="button button-danger-subtle"
                                                    disabled={controlsDisabled || !!project.error || !selectedPresets[project.path]}
                                                    onClick={() => runServicePreset(project.path, 'stop')}
                                                >Parar preset</button>
                                                <button
                                                    className="button button-quiet"
                                                    disabled={!selectedPresets[project.path]}
                                                    onClick={() => removeServicePreset(project.path, selectedPresets[project.path])}
                                                >Remover</button>
                                            </div>
                                        )}
                                        </details>
                                        )}
                                        {features.volumes && resources[project.path] && (
                                            <div className="resource-explorer" aria-label={`Volumes e redes de ${project.name}`}>
                                                {(['volumes', 'networks'] as const).map((kind) => (
                                                    <section key={kind}>
                                                        <h4>{kind === 'volumes' ? 'Volumes' : 'Redes'}</h4>
                                                        {resources[project.path][kind].length === 0
                                                            ? <p className="services-hint">Nenhum recurso do projeto encontrado.</p>
                                                            : resources[project.path][kind].map(resource => (
                                                                <div className="resource-row" key={`${resource.resource_type}:${resource.name}`}>
                                                                    <span><strong>{resource.name}</strong><small>{resource.driver} · {resource.in_use ? 'em uso' : 'sem containers conectados'}</small></span>
                                                                    <button
                                                                        className="button button-danger-subtle"
                                                                        disabled={resource.in_use}
                                                                        onClick={() => void removeProjectResource(project.path, resource)}
                                                                    >Excluir</button>
                                                                </div>
                                                            ))}
                                                    </section>
                                                ))}
                                                <p className="dashboard-note">A exclusão só é permitida para recursos etiquetados neste projeto e sem containers associados. Volumes são apagados permanentemente.</p>
                                            </div>
                                        )}
                                        {features.volumes && resourceErrors[project.path] && (
                                            <div className="project-error" role="alert">{resourceErrors[project.path]}</div>
                                        )}

                                        {project.error && (
                                            <div className="project-error" role="alert">
                                                <span>Não foi possível atualizar os serviços: {project.error}</span>
                                                <button className="button button-quiet" disabled={controlsDisabled} onClick={() => refreshProject(project.path)}>Tentar novamente</button>
                                            </div>
                                        )}

                                        <div id={detailsId} hidden={!isExpanded}>
                                        {project.services.length > 0 && (
                                            <div className="project-details">
                                                <div className="services-heading">
                                                    <span className="detail-label">Serviços <span className="service-count">{project.services.length}</span></span>
                                                    <div className="service-sort">
                                                        <label htmlFor={`service-sort-${encodeURIComponent(project.path)}`}>Ordenar</label>
                                                        <select
                                                            id={`service-sort-${encodeURIComponent(project.path)}`}
                                                            className="utility-input"
                                                            aria-label={`Ordenar serviços de ${project.name}`}
                                                            value={serviceSort}
                                                            onChange={event => setServiceSort(event.target.value as ServiceSort)}
                                                        >
                                                            <option value="active">Ativos primeiro</option>
                                                            <option value="name">Nome A–Z</option>
                                                            <option value="state">Estado</option>
                                                        </select>
                                                    </div>
                                                </div>
                                                <details className="dependency-graph">
                                                    <summary>Mapa de dependências</summary>
                                                    <div className="dependency-map">
                                                        {project.services.map(service => (
                                                            <div className="dependency-node" key={service.name}>
                                                                <strong>{service.name}</strong>
                                                                <span aria-hidden="true">→</span>
                                                                <span>{service.dependencies?.length
                                                                    ? service.dependencies.join(' · ')
                                                                    : 'sem dependências declaradas'}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                    <p className="dashboard-note">Use “Iniciar com dependências” para incluir os serviços necessários ao serviço selecionado.</p>
                                                </details>
                                                <div className="services-toolbar">
                                                    <label className="select-all">
                                                        <input
                                                            type="checkbox"
                                                            aria-label={`Selecionar todos os serviços de ${project.name}`}
                                                            checked={visibleServices.length > 0 && visibleServices.every(service => selection.includes(service.name))}
                                                            disabled={controlsDisabled || !!project.error}
                                                            onChange={() => setSelectedServices(prev => ({
                                                                ...prev,
                                                                [project.path]: visibleServices.every(service => selection.includes(service.name))
                                                                    ? [] : visibleServices.map(service => service.name),
                                                            }))}
                                                        />
                                                        <span>{selection.length ? `${selection.length} selecionado(s)` : 'Selecionar todos'}</span>
                                                    </label>
                                                    {selection.length > 0 && (
                                                    <div className="batch-actions">
                                                        <button
                                                            className="button button-subtle"
                                                            disabled={controlsDisabled || !!project.error || !selectedItems.some(service => !isServiceActive(service))}
                                                            onClick={() => handleDockerAction(project.path, 'up', selection)}
                                                        >Iniciar selecionados</button>
                                                        <button
                                                            className="button button-danger-subtle"
                                                            disabled={controlsDisabled || !!project.error || !selectedItems.some(isServiceActive)}
                                                            onClick={() => handleDockerAction(project.path, 'stop', selection)}
                                                        >Parar selecionados</button>
                                                        <details className="popover menu">
                                                            <summary className="button button-quiet">Mais <Icon name="chevron" size={13} /></summary>
                                                            <div
                                                                className="popover-panel"
                                                                onClick={event => event.currentTarget.closest('details')?.removeAttribute('open')}
                                                            >
                                                                <button
                                                                    className="menu-item"
                                                                    disabled={controlsDisabled || !!project.error || !selection.length}
                                                                    onClick={() => handleDockerAction(project.path, 'up_with_deps', selection)}
                                                                >Iniciar com dependências</button>
                                                                <button
                                                                    className="menu-item"
                                                                    disabled={controlsDisabled || !!project.error || !selection.length}
                                                                    onClick={() => handleDockerAction(project.path, 'pull', selection)}
                                                                >Pull selecionados</button>
                                                                <button
                                                                    className="menu-item"
                                                                    disabled={controlsDisabled || !!project.error || !selection.length}
                                                                    onClick={() => handleDockerAction(project.path, 'build', selection)}
                                                                >Build selecionados</button>
                                                                <button
                                                                    className="menu-item"
                                                                    disabled={controlsDisabled || !!project.error || !selection.length}
                                                                    onClick={() => handleDockerAction(project.path, 'recreate', selection)}
                                                                >Recriar selecionados</button>
                                                            </div>
                                                        </details>
                                                    </div>
                                                    )}
                                                </div>
                                                <div className="service-list" aria-label={`Serviços de ${project.name}`} aria-busy={!!busy}>
                                                    {visibleServices.map(service => {
                                                        const active = isServiceActive(service);
                                                        const paused = service.state === 'paused';
                                                        const ports = displayPorts(service.ports);
                                                        const showLogs = activeLogPanel?.path === project.path && activeLogPanel.service === service.name;
                                                        const showTerminal = activeTerminalPanel?.path === project.path && activeTerminalPanel.service === service.name;
                                                        const showMetrics = activeMetrics?.path === project.path && activeMetrics.service === service.name;
                                                        const hasContainerDetails = features.metrics || features.containerId || features.inspect || features.volumes || features.state;
                                                        const serviceBusyLabel = busy && (busy.services === null || busy.services.includes(service.name))
                                                            ? busy.label : undefined;
                                                        return (
                                                            <Fragment key={service.name}>
                                                            <div className={`service-row${selection.includes(service.name) ? ' is-selected' : ''}`} aria-busy={!!serviceBusyLabel}>
                                                                <input
                                                                    type="checkbox"
                                                                    aria-label={`Selecionar serviço ${service.name} de ${project.name}`}
                                                                    checked={selection.includes(service.name)}
                                                                    disabled={controlsDisabled || !!project.error}
                                                                    onChange={() => setSelectedServices(prev => ({
                                                                        ...prev,
                                                                        [project.path]: selection.includes(service.name)
                                                                            ? selection.filter(name => name !== service.name)
                                                                            : [...selection, service.name],
                                                                    }))}
                                                                />
                                                                <div className="service-info">
                                                                    <div className="service-title">
                                                                        <strong>{service.name}</strong>
                                                                        {features.state && <span className={`status-pill ${active && service.health !== 'unhealthy' ? 'status-online' : 'status-stopped'}`}>
                                                                            <span className="status-dot" />{serviceBusyLabel || serviceStateLabel(service)}
                                                                        </span>}
                                                                        {service.containers > 1 && <span className="services-hint">{service.running_containers}/{service.containers} containers ativos</span>}
                                                                        {service.image && <span className="service-image">{service.image}</span>}
                                                                    </div>
                                                                    {features.ports && <div className="port-list">
                                                                        {ports.length === 0 ? (
                                                                            <span className="services-hint">Sem porta publicada</span>
                                                                        ) : ports.map(port => (
                                                                            <span
                                                                                key={`${port.host_ip}:${port.published}:${port.target}/${port.protocol}`}
                                                                                className={`port-chip ${port.is_open === true ? 'port-open' : 'port-pending'}`}
                                                                                title={`Host ${port.host_ips.join(', ')} · ${port.published} → container ${port.target}/${port.protocol} · ${portStateLabel(service, port)}`}
                                                                            >
                                                                                <span className="port-dot" />
                                                                                <span>{port.published} → {port.target}{port.protocol === 'tcp' ? '' : `/${port.protocol}`}</span>
                                                                                <span className="sr-only">{portStateLabel(service, port)}</span>
                                                                                <button className="port-action" aria-label={`Copiar endereço ${portAddress(port)} de ${service.name}`} title="Copiar endereço" onClick={() => copyPort(portAddress(port))}><Icon name="copy" size={13} /></button>
                                                                                {port.protocol === 'tcp' && (
                                                                                    <button className="port-action" aria-label={`Abrir HTTP ${portAddress(port)} de ${service.name}`} title={`Abrir como HTTP${[443, 8443].includes(port.target) ? 'S' : ''}; o serviço precisa oferecer uma interface web.`} disabled={service.running_containers === 0} onClick={() => openPort(port.host_ip, port.published, [443, 8443].includes(port.target))}><Icon name="external" size={13} /></button>
                                                                                )}
                                                                            </span>
                                                                        ))}
                                                                    </div>}
                                                                </div>
                                                                <div className="service-actions">
                                                                {hasContainerDetails && <button
                                                                    className={`icon-button service-metrics-toggle${showMetrics ? ' is-active' : ''}`}
                                                                    aria-label={`${showMetrics ? 'Fechar' : 'Exibir'} métricas de ${service.name} de ${project.name}`}
                                                                    title={features.metrics ? 'Consumo' : 'Detalhes'}
                                                                    aria-expanded={showMetrics}
                                                                    onClick={() => setActiveMetrics(showMetrics ? null : { path: project.path, service: service.name })}
                                                                ><Icon name="chart" /></button>}
                                                                <button
                                                                    className={`icon-button service-log-toggle${showLogs ? ' is-active' : ''}`}
                                                                    aria-label={`${showLogs ? 'Fechar' : 'Exibir'} logs de ${service.name} de ${project.name}`}
                                                                    title="Logs"
                                                                    aria-expanded={showLogs}
                                                                    onClick={() => setActiveLogPanel(showLogs ? null : { path: project.path, service: service.name })}
                                                                ><Icon name="logs" /></button>
                                                                <button
                                                                    className={`icon-button service-terminal-toggle${showTerminal ? ' is-active' : ''}`}
                                                                    aria-label={`${showTerminal ? 'Fechar' : 'Abrir'} terminal de ${service.name} de ${project.name}`}
                                                                    title="Terminal"
                                                                    aria-expanded={showTerminal}
                                                                    disabled={!service.running_containers || !!project.error || controlsDisabled}
                                                                    onClick={() => {
                                                                        const next = showTerminal ? null : { path: project.path, service: service.name };
                                                                        setActiveTerminalPanel(next);
                                                                        setActiveLogPanel(null);
                                                                        setActiveMetrics(null);
                                                                    }}
                                                                ><Icon name="terminal" /></button>
                                                                <button
                                                                    className={`button ${active && !paused ? 'button-danger' : 'button-start'}`}
                                                                    disabled={controlsDisabled || !!project.error}
                                                                    aria-label={`${paused ? 'Retomar' : active ? 'Parar' : 'Iniciar'} serviço ${service.name} de ${project.name}`}
                                                                    onClick={() => handleDockerAction(project.path, paused ? 'unpause' : active ? 'stop' : 'up', [service.name])}
                                                                ><Icon name={active && !paused ? 'stop' : 'play'} size={13} />{serviceBusyLabel || (paused ? 'Retomar' : active ? 'Parar' : 'Iniciar')}</button>
                                                                </div>
                                                            </div>
                                                            {showLogs && isExpanded && (
                                                                <ServiceLogs
                                                                    projectPath={project.path}
                                                                    dockerContext={dockerContext}
                                                                    profiles={composeOptions.profiles}
                                                                    envFile={composeOptions.envFile}
                                                                    service={service.name}
                                                                    onClose={() => setActiveLogPanel(null)}
                                                                    semanticErrors={features.semanticErrors}
                                                                />
                                                            )}
                                                            {showTerminal && isExpanded && (
                                                                <ServiceTerminal
                                                                    projectPath={project.path}
                                                                    dockerContext={dockerContext}
                                                                    profiles={composeOptions.profiles}
                                                                    envFile={composeOptions.envFile}
                                                                    service={service.name}
                                                                    onClose={() => setActiveTerminalPanel(null)}
                                                                />
                                                            )}
                                                            {showMetrics && isExpanded && hasContainerDetails && (
                                                                <ServiceMetrics
                                                                    projectPath={project.path}
                                                                    dockerContext={dockerContext}
                                                                    profiles={composeOptions.profiles}
                                                                    envFile={composeOptions.envFile}
                                                                    service={service.name}
                                                                    onClose={() => setActiveMetrics(null)}
                                                                    features={features}
                                                                    notificationsEnabled={notificationsEnabled}
                                                                />
                                                            )}
                                                            </Fragment>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}

                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    )}
                </section>
            </div>
            {featureModalOpen && (
                <div className="modal-backdrop" onMouseDown={event => {
                    if (event.target === event.currentTarget) setFeatureModalOpen(false);
                }}>
                    <section className="feature-modal" role="dialog" aria-modal="true" aria-labelledby="feature-modal-title">
                        <header>
                            <div>
                                <p className="eyebrow">CONTROLE REMOTO</p>
                                <h2 id="feature-modal-title">Funcionalidades</h2>
                                <p>Ative ou desative recursos do workspace. As escolhas ficam salvas neste dispositivo.</p>
                            </div>
                            <button className="button button-quiet" onClick={() => setFeatureModalOpen(false)} aria-label="Fechar controles">×</button>
                        </header>
                        <div className="feature-list">
                            <div className="feature-option">
                                <span><strong>Notificações</strong><small>Receba alertas quando um serviço falhar ou se recuperar.</small></span>
                                <div className="feature-control">
                                    <span className={`feature-status${notificationsEnabled ? ' is-enabled' : ''}`}>
                                        {notificationsEnabled ? 'Ativado' : 'Desativado'}
                                    </span>
                                    <button
                                        className="feature-switch"
                                        type="button"
                                        role="switch"
                                        aria-checked={notificationsEnabled}
                                        aria-label={`Notificações: ${notificationsEnabled ? 'ativadas' : 'desativadas'}`}
                                        onClick={() => void toggleNotifications()}
                                    >
                                        <span className="feature-switch-thumb" />
                                    </button>
                                </div>
                            </div>
                            {([
                                ['directory', 'Localizar diretórios', 'Escolha o contexto Docker e a pasta dos projetos.'],
                                ['theme', 'Tema claro e escuro', 'Mostra o controle de alternância de tema.'],
                                ['containerId', 'ID do container', 'Exibe o identificador completo do container.'],
                                ['ports', 'Portas publicadas', 'Mostra portas do host e do container.'],
                                ['metrics', 'Consumo em tempo real', 'Atualiza CPU, memória e rede a cada 3 segundos.'],
                                ['inspect', 'Docker Inspect', 'Exibe detalhes selecionados do container, sem variáveis de ambiente.'],
                                ['volumes', 'Volumes e redes', 'Exibe recursos do projeto e diretórios montados nos containers.'],
                                ['state', 'Estado do serviço', 'Mostra estado e saúde de cada serviço.'],
                                ['autoPause', 'Pausa por ociosidade', 'Pausa containers após 15 minutos sem tráfego de rede.'],
                                ['semanticErrors', 'Filtro semântico de erros', 'Identifica erros, falhas, exceções, timeouts e conexões recusadas nos logs.'],
                                ['diagnostics', 'Diagnóstico de projetos', 'Analisa containers órfãos e conflitos de portas; os avisos podem ser fechados.'],
                                ['imagePull', 'Baixar imagens', 'Permite atualizar as imagens usadas pelo projeto.'],
                                ['projectBuild', 'Build do projeto', 'Permite construir as imagens definidas no Compose.'],
                                ['containerRecreate', 'Recriar containers', 'Permite recriar os containers do projeto.'],
                            ] as const).map(([key, title, description]) => (
                                <div className="feature-option" key={key}>
                                    <span><strong>{title}</strong><small>{description}</small></span>
                                    <div className="feature-control">
                                        <span className={`feature-status${features[key] ? ' is-enabled' : ''}`}>
                                            {features[key] ? 'Ativado' : 'Desativado'}
                                        </span>
                                        <button
                                            className="feature-switch"
                                            type="button"
                                            role="switch"
                                            aria-checked={features[key]}
                                            aria-label={`${title}: ${features[key] ? 'ativado' : 'desativado'}`}
                                            onClick={() => updateFeature(key, !features[key])}
                                        >
                                            <span className="feature-switch-thumb" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {features.autoPause && (
                            <p className="feature-warning">A pausa automática pode interromper serviços ociosos que aguardam tráfego. O recurso não retoma containers automaticamente.</p>
                        )}
                        <footer><button className="button button-primary" onClick={() => setFeatureModalOpen(false)}>Concluir</button></footer>
                    </section>
                </div>
            )}
        </main>
    );
}
