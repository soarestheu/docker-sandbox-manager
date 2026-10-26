// src/App.tsx
import { Fragment, useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { displayPorts, isProjectActive, isServiceActive, portStateLabel, serviceStateLabel } from './docker';
import type { Project, ProjectState } from './docker';
import ServiceLogs from './ServiceLogs';
import ServiceMetrics from './ServiceMetrics';
import { parsePreferences, portAddress, projectMatches, servicesForFilter } from './workspace';
import type { Preferences, StatusFilter } from './workspace';

interface PendingAction {
    label: string;
    services: string[] | null;
}

export default function App() {
    const [searchPath, setSearchPath] = useState('');
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);

    const [activeLogPanel, setActiveLogPanel] = useState<{ path: string; service: string } | null>(null);
    const [selectedServices, setSelectedServices] = useState<Record<string, string[]>>({});
    const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
    const [busyPaths, setBusyPaths] = useState<Record<string, PendingAction>>({});
    const busyRef = useRef<Record<string, PendingAction>>({});
    const requestVersions = useRef<Record<string, number>>({});
    const [message, setMessage] = useState('');
    const [preferences, setPreferences] = useState<Preferences>({});
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [favoritesOnly, setFavoritesOnly] = useState(false);
    const [groupFilter, setGroupFilter] = useState('');
    const [activeMetrics, setActiveMetrics] = useState<{ path: string; service: string } | null>(null);

    useEffect(() => {
        try {
            setPreferences(parsePreferences(localStorage.getItem('sandbox-workspace')));
        } catch (err) {
            setMessage(`Erro ao carregar favoritos e grupos: ${err}`);
        }
    }, []);

    useEffect(() => {
        setSelectedPaths([]);
        setSelectedServices({});
        setActiveLogPanel(null);
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
        setProjects(prev => prev.map(project =>
            project.path === path ? { ...project, ...state, error: null } : project,
        ));
        setSelectedServices(prev => ({
            ...prev,
            [path]: (prev[path] || []).filter(name => state.services.some(service => service.name === name)),
        }));
    };

    const refreshProject = async (path: string) => {
        const version = (requestVersions.current[path] || 0) + 1;
        requestVersions.current[path] = version;
        try {
            const state = await invoke<ProjectState>('get_project_state', { projectPath: path });
            if (requestVersions.current[path] === version) applyProjectState(path, state);
        } catch (err) {
            if (requestVersions.current[path] === version) {
                setProjects(prev => prev.map(project =>
                    project.path === path ? { ...project, error: String(err) } : project,
                ));
            }
        }
    };

    const projectPathsKey = JSON.stringify(projects.map(project => project.path));
    useEffect(() => {
        const paths: string[] = JSON.parse(projectPathsKey);
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            await Promise.all(paths.filter(path => !busyRef.current[path]).map(refreshProject));
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
                const defaultPath: string = await invoke('get_default_projects_dir');
                if (!disposed) setSearchPath(defaultPath);
                const result: Project[] = await invoke('scan_directory', { basePath: defaultPath });
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
            const result: Project[] = await invoke('scan_directory', { basePath: searchPath });
            setProjects(result);
            setSelectedPaths([]);
            setSelectedServices({});
            setActiveLogPanel(null);
            setActiveMetrics(null);
        } catch (err) {
            setMessage(`Erro ao escanear: ${err}`);
        } finally {
            setLoading(false);
        }
    };

    const performAction = async (path: string, action: 'up' | 'stop' | 'down', services?: string[]) => {
        if (busyRef.current[path]) return 'Já existe uma ação em andamento neste projeto.';
        busyRef.current[path] = {
            label: action === 'up' ? 'Iniciando…' : 'Parando…',
            services: services ? [...services] : null,
        };
        setBusyPaths({ ...busyRef.current });
        const version = (requestVersions.current[path] || 0) + 1;
        requestVersions.current[path] = version;
        try {
            const state = await invoke<ProjectState>('run_compose_action', {
                projectPath: path, action, services: services ?? null,
            });
            if (requestVersions.current[path] === version) applyProjectState(path, state);
            if (action === 'up') {
                setCollapsedProjects(prev => ({ ...prev, [path]: false }));
            }
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

    const handleDockerAction = async (path: string, action: 'up' | 'stop' | 'down', services?: string[]) => {
        const error = await performAction(path, action, services);
        setMessage(error
            ? `Erro em ${path}: ${error}`
            : `${services ? 'Serviços selecionados' : 'Containers do projeto'} ${action === 'up' ? 'iniciados' : 'parados'} em ${path}.`);
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
                        <div>
                            <p className="brand-name">Docker <span>Sandbox</span></p>
                            <p className="brand-caption">Workspace local</p>
                        </div>
                    </div>
                    <div className="engine-status">
                        <span className="status-dot" />
                        <span>Monitoramento ativo</span>
                    </div>
                </header>

                <section className="intro">
                    <div>
                        <p className="eyebrow">VISÃO GERAL</p>
                        <h1>Seus ambientes</h1>
                        <p className="intro-copy">Acompanhe projetos, containers e portas em um só lugar.</p>
                    </div>
                    <div className="workspace-tag">
                        <span className="workspace-tag-icon">⌘</span>
                        Ambiente local
                    </div>
                </section>

                <div className="workspace-layout">
                <aside className="dashboard-column" aria-labelledby="dashboard-title">
                    <div className="dashboard-heading">
                        <p className="eyebrow">SEU WORKSPACE</p>
                        <h2 id="dashboard-title">Visão geral</h2>
                        <p>Um resumo dos ambientes locais.</p>
                    </div>
                <section className="stats-grid" aria-label="Resumo dos projetos">
                    <div className="stat-card">
                        <span className="stat-icon stat-icon-blue">▦</span>
                        <div><span className="stat-label">Projetos encontrados</span><strong>{projects.length}</strong></div>
                    </div>
                    <div className="stat-card">
                        <span className="stat-icon stat-icon-green">●</span>
                        <div><span className="stat-label">Projetos ativos</span><strong>{runningProjects}</strong></div>
                    </div>
                    <div className="stat-card">
                        <span className="stat-icon stat-icon-violet">◉</span>
                        <div><span className="stat-label">Containers ativos</span><strong>{runningContainers}<small> / {totalContainers}</small></strong></div>
                    </div>
                    <div className="stat-card">
                        <span className="stat-icon stat-icon-amber">⇄</span>
                        <div><span className="stat-label">Portas publicadas</span><strong>{publishedPorts}</strong></div>
                    </div>
                </section>

                <section className="dashboard-health" aria-labelledby="health-title">
                    <h3 id="health-title">Estado dos serviços</h3>
                    <dl>
                        <div><dt>Serviços encontrados</dt><dd>{services.length}</dd></div>
                        <div><dt>Serviços parados</dt><dd>{stoppedServices}</dd></div>
                        <div><dt>Não saudáveis</dt><dd className={unhealthyServices ? 'health-warning' : ''}>{unhealthyServices}</dd></div>
                        <div><dt>Portas TCP disponíveis</dt><dd>{availablePorts}</dd></div>
                        <div><dt>Falhas de consulta</dt><dd className={failedProjects ? 'health-warning' : ''}>{failedProjects}</dd></div>
                    </dl>
                    <p className="dashboard-note">Atualização automática a cada 3 segundos após a consulta anterior.</p>
                </section>

                <section className="scan-panel" aria-label="Localizar projetos">
                    <div className="scan-copy">
                        <span className="section-kicker">DIRETÓRIO DE PROJETOS</span>
                        <span className="scan-hint">Escolha onde procurar seus ambientes</span>
                    </div>
                    <div className="scan-controls">
                        <label className="path-field">
                            <span className="path-icon" aria-hidden="true">⌕</span>
                            <input
                                type="text"
                                value={searchPath}
                                onChange={(e) => setSearchPath(e.target.value)}
                                placeholder="/home/usuario/Projetos"
                                aria-label="Caminho do diretório de projetos"
                            />
                        </label>
                        <button className="button button-primary scan-button" onClick={handleScan} disabled={loading || hasBusyProjects || !searchPath.trim()}>
                            <span aria-hidden="true">{loading ? '◌' : '↻'}</span>
                            {loading ? 'Sincronizando' : 'Varrer diretório'}
                        </button>
                    </div>
                </section>
                </aside>

                <div className="projects-column">
                {message && (
                    <div className="notice" role="status">
                        <span className="notice-mark" aria-hidden="true">i</span>
                        <span>{message}</span>
                        <button className="notice-dismiss" onClick={() => setMessage('')} aria-label="Dispensar mensagem">×</button>
                    </div>
                )}

                <section className="projects-section">
                    <div className="projects-heading">
                        <div>
                            <h2>Projetos</h2>
                            <p>Gerencie os containers dos seus repositórios</p>
                        </div>
                        <span className="project-count">{visibleProjects.length} de {projects.length} projetos</span>
                    </div>

                    <div className="project-filters">
                        <input className="utility-input project-search" aria-label="Buscar projetos ou serviços" placeholder="Buscar projeto, serviço ou imagem…" value={query} onChange={event => setQuery(event.target.value)} />
                        <select className="utility-input" aria-label="Filtrar por status" value={statusFilter} onChange={event => setStatusFilter(event.target.value as StatusFilter)}>
                            <option value="all">Todos os estados</option>
                            <option value="active">Em execução</option>
                            <option value="stopped">Parados</option>
                            <option value="failed">Com falhas</option>
                        </select>
                        <select className="utility-input" aria-label="Filtrar por grupo" value={groupFilter} onChange={event => setGroupFilter(event.target.value)}>
                            <option value="">Todos os grupos</option>
                            {groups.map(group => <option key={group} value={group}>{group}</option>)}
                        </select>
                        <label className="select-all"><input type="checkbox" checked={favoritesOnly} onChange={event => setFavoritesOnly(event.target.checked)} />Só favoritos</label>
                    </div>
                    <datalist id="workspace-groups">{groups.map(group => <option key={group} value={group} />)}</datalist>

                    {visibleProjects.length > 0 && (
                        <div className="batch-toolbar">
                            <label className="select-all">
                                <input
                                    type="checkbox"
                                    checked={visibleSelectedPaths.length > 0 && visibleSelectedPaths.length === visibleProjects.length}
                                    onChange={toggleSelectAll}
                                />
                                <span>{visibleSelectedPaths.length ? `${visibleSelectedPaths.length} selecionado${visibleSelectedPaths.length === 1 ? '' : 's'}` : 'Selecionar visíveis'}</span>
                            </label>
                            {visibleSelectedPaths.length > 0 && (
                                <div className="batch-actions">
                                    <button className="button button-subtle" onClick={() => handleBatchAction('up')} disabled={loading || hasBusyProjects}>Iniciar selecionados</button>
                                    <button className="button button-danger-subtle" onClick={() => handleBatchAction('down')} disabled={loading || hasBusyProjects}>Parar selecionados</button>
                                </div>
                            )}
                        </div>
                    )}

                    {visibleProjects.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-illustration" aria-hidden="true">
                                <span>▱</span><span>▱</span><span>▱</span>
                            </div>
                            <h3>{loading ? 'Procurando projetos…' : projects.length ? 'Nenhum resultado para estes filtros' : 'Nenhum projeto por aqui'}</h3>
                            <p>{loading ? 'Estamos verificando o diretório selecionado.' : projects.length ? 'Altere a busca, o estado, os favoritos ou o grupo para visualizar outros projetos.' : 'Ajuste o caminho acima e faça uma nova varredura para encontrar seus projetos Docker.'}</p>
                        </div>
                    ) : (
                        <div className="project-list">
                            {visibleProjects.map((project) => {
                                const visibleServices = servicesForFilter(project, query, statusFilter);
                                const isExpanded = !collapsedProjects[project.path];
                                const detailsId = `project-details-${encodeURIComponent(project.path)}`;
                                const isRunning = isProjectActive(project);
                                const selection = (selectedServices[project.path] || []).filter(name => visibleServices.some(service => service.name === name));
                                const busy = busyPaths[project.path];
                                const projectBusyLabel = busy?.services === null ? busy.label : undefined;
                                const controlsDisabled = loading || !!busy;
                                const selectedItems = project.services.filter(service => selection.includes(service.name));

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
                                            <div className="project-symbol" aria-hidden="true">
                                                <svg viewBox="0 0 24 24" fill="none">
                                                    <path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5v-9Z" />
                                                    <path d="m4.5 7.8 7.5 3.4 7.5-3.4M12 11.2v8.3" />
                                                </svg>
                                            </div>
                                            <div className="project-info">
                                                <div className="project-title-row">
                                                    <h3 title={project.name}>{project.name}</h3>
                                                    <button
                                                        className="favorite-button"
                                                        aria-label={`Favoritar projeto ${project.name}`}
                                                        aria-pressed={!!preferences[project.path]?.favorite}
                                                        onClick={() => updatePreference(project.path, { favorite: !preferences[project.path]?.favorite })}
                                                    >{preferences[project.path]?.favorite ? '★' : '☆'}</button>
                                                    <span className={`status-pill ${project.error ? 'status-stopped' : isRunning ? 'status-online' : 'status-stopped'}`}>
                                                        <span className="status-dot" />
                                                        {projectBusyLabel || (project.error ? 'Falha na consulta' : project.status === 'partial' ? 'Execução parcial' : isRunning ? 'Em execução' : 'Parado')}
                                                    </span>
                                                </div>
                                                <p className="project-path" title={project.path}>{project.path}</p>
                                            </div>
                                            <div className="project-actions">
                                                <button
                                                    className="button button-quiet"
                                                    aria-label={`${isExpanded ? 'Recolher' : 'Expandir'} projeto ${project.name}`}
                                                    aria-expanded={isExpanded}
                                                    aria-controls={detailsId}
                                                    onClick={() => {
                                                        setCollapsedProjects(prev => ({ ...prev, [project.path]: isExpanded }));
                                                        if (isExpanded && activeLogPanel?.path === project.path) setActiveLogPanel(null);
                                                        if (isExpanded && activeMetrics?.path === project.path) setActiveMetrics(null);
                                                    }}
                                                >
                                                    <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                                                    {isExpanded ? 'Recolher' : 'Expandir'}
                                                </button>
                                                {isRunning ? (
                                                    <button className="button button-danger" disabled={controlsDisabled} onClick={() => handleDockerAction(project.path, 'down')} title="Parar e remover todos os containers do projeto">{projectBusyLabel || 'Parar projeto'}</button>
                                                ) : (
                                                    <button className="button button-start" disabled={controlsDisabled} onClick={() => handleDockerAction(project.path, 'up')}>{projectBusyLabel || 'Iniciar projeto'}</button>
                                                )}
                                                <button className="button button-ide" onClick={() => handleOpenWebStorm(project.path)} title="Abrir projeto no WebStorm">Abrir IDE</button>
                                            </div>
                                        </div>
                                        <div className="project-organization">
                                            <label>Grupo
                                                <input className="utility-input" aria-label={`Grupo de ${project.name}`} list="workspace-groups" placeholder="Ex.: Trabalho" maxLength={60} value={preferences[project.path]?.group || ''} onChange={event => updatePreference(project.path, { group: event.target.value })} />
                                            </label>
                                            <span className="services-hint">{visibleServices.length} de {project.services.length} serviços visíveis</span>
                                        </div>

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
                                                    <span className="detail-label">SERVIÇOS E PORTAS <span className="service-count">{project.services.length}</span></span>
                                                    <span className="services-hint">Ações por serviço, sem alterar os demais</span>
                                                </div>
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
                                                        <span>{selection.length ? `${selection.length} serviço(s) selecionado(s)` : 'Selecionar serviços'}</span>
                                                    </label>
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
                                                    </div>
                                                </div>
                                                <div className="service-list" aria-label={`Serviços de ${project.name}`} aria-busy={!!busy}>
                                                    {visibleServices.map(service => {
                                                        const active = isServiceActive(service);
                                                        const ports = displayPorts(service.ports);
                                                        const showLogs = activeLogPanel?.path === project.path && activeLogPanel.service === service.name;
                                                        const showMetrics = activeMetrics?.path === project.path && activeMetrics.service === service.name;
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
                                                                        <span className={`status-pill ${active && service.health !== 'unhealthy' ? 'status-online' : 'status-stopped'}`}>
                                                                            <span className="status-dot" />{serviceBusyLabel || serviceStateLabel(service)}
                                                                        </span>
                                                                        {service.containers > 1 && <span className="services-hint">{service.running_containers}/{service.containers} containers ativos</span>}
                                                                    </div>
                                                                    {service.image && <span className="service-image">{service.image}</span>}
                                                                    <div className="port-list">
                                                                        {ports.length === 0 ? (
                                                                            <span className="services-hint">Sem porta publicada</span>
                                                                        ) : ports.map(port => (
                                                                            <span
                                                                                key={`${port.host_ip}:${port.published}:${port.target}/${port.protocol}`}
                                                                                className={`port-chip ${port.is_open === true ? 'port-open' : 'port-pending'}`}
                                                                                title={`Host ${port.host_ips.join(', ')} · ${port.published} → container ${port.target}/${port.protocol}`}
                                                                            >
                                                                                <span className="port-dot" />
                                                                                <span>{port.published} → {port.target}/{port.protocol}</span>
                                                                                <span className="port-state">{portStateLabel(service, port)}</span>
                                                                                <button className="port-action" aria-label={`Copiar endereço ${portAddress(port)} de ${service.name}`} onClick={() => copyPort(portAddress(port))}>Copiar</button>
                                                                                {port.protocol === 'tcp' && (
                                                                                    <button className="port-action" aria-label={`Abrir HTTP ${portAddress(port)} de ${service.name}`} title="Abrir como HTTP (HTTPS nas portas 443 e 8443); o serviço precisa oferecer uma interface web." disabled={service.running_containers === 0} onClick={() => openPort(port.host_ip, port.published, [443, 8443].includes(port.target))}>Abrir HTTP{[443, 8443].includes(port.target) ? 'S' : ''}</button>
                                                                                )}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                                <button
                                                                    className="button button-quiet service-metrics-toggle"
                                                                    aria-label={`${showMetrics ? 'Fechar' : 'Exibir'} métricas de ${service.name} de ${project.name}`}
                                                                    aria-expanded={showMetrics}
                                                                    onClick={() => setActiveMetrics(showMetrics ? null : { path: project.path, service: service.name })}
                                                                >Métricas</button>
                                                                <button
                                                                    className="button button-quiet service-log-toggle"
                                                                    aria-label={`${showLogs ? 'Fechar' : 'Exibir'} logs de ${service.name} de ${project.name}`}
                                                                    aria-expanded={showLogs}
                                                                    onClick={() => setActiveLogPanel(showLogs ? null : { path: project.path, service: service.name })}
                                                                >{showLogs ? 'Fechar logs' : 'Exibir logs'}</button>
                                                                <button
                                                                    className={`button ${active ? 'button-danger' : 'button-start'}`}
                                                                    disabled={controlsDisabled || !!project.error}
                                                                    aria-label={`${active ? 'Parar' : 'Iniciar'} serviço ${service.name} de ${project.name}`}
                                                                    onClick={() => handleDockerAction(project.path, active ? 'stop' : 'up', [service.name])}
                                                                >{serviceBusyLabel || (active ? 'Parar' : 'Iniciar')}</button>
                                                            </div>
                                                            {showLogs && isExpanded && (
                                                                <ServiceLogs projectPath={project.path} service={service.name} onClose={() => setActiveLogPanel(null)} />
                                                            )}
                                                            {showMetrics && isExpanded && (
                                                                <ServiceMetrics projectPath={project.path} service={service.name} onClose={() => setActiveMetrics(null)} />
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
                </div>
                <footer className="app-footer"><span className="status-dot" /> Os dados são atualizados localmente no seu workspace</footer>
            </div>
        </main>
    );
}
