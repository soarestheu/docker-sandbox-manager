import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { sendNotification } from '@tauri-apps/plugin-notification';

interface Metrics {
    name: string;
    id: string;
    state: string;
    cpu: string;
    memory_usage: string;
    memory_percent: string;
    network_io: string;
    volumes: { kind: string; source: string; destination: string; read_write: boolean }[];
    inspect: Record<string, unknown>;
}

interface MetricSample {
    at: number;
    cpu: number;
    memory: number;
}

type MetricHistory = Record<string, MetricSample[]>;
interface AlertThresholds {
    cpu: number;
    memory: number;
}

function readHistory(raw: string | null): MetricHistory {
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Histórico de métricas inválido.');
    }
    const history: MetricHistory = {};
    for (const [key, samples] of Object.entries(value)) {
        if (!Array.isArray(samples) || !samples.every(sample =>
            !!sample && typeof sample === 'object'
            && Number.isFinite(sample.at) && Number.isFinite(sample.cpu) && Number.isFinite(sample.memory),
        )) {
            throw new Error('Histórico de métricas inválido.');
        }
        history[key] = samples.slice(-120) as MetricSample[];
    }
    return history;
}

function metricValue(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0;
}

function historyKey(projectPath: string, context: string, service: string, container: string): string {
    return JSON.stringify([projectPath, context, service, container]);
}

function chartPoints(samples: MetricSample[], field: 'cpu' | 'memory'): string {
    const recent = samples.slice(-30);
    return recent.map((sample, index) => {
        const x = recent.length < 2 ? 50 : index * 100 / (recent.length - 1);
        const y = 36 - sample[field] * 0.32;
        return `${x},${y}`;
    }).join(' ');
}

export default function ServiceMetrics({
    projectPath, dockerContext, profiles, envFile, service, onClose, features, notificationsEnabled,
}: {
    projectPath: string;
    dockerContext: string;
    profiles: string[];
    envFile: string | null;
    service: string;
    onClose: () => void;
    features: { containerId: boolean; inspect: boolean; volumes: boolean; state: boolean; metrics: boolean };
    notificationsEnabled: boolean;
}) {
    const [metrics, setMetrics] = useState<Metrics[]>([]);
    const [error, setError] = useState('');
    const [storageError, setStorageError] = useState('');
    const [loading, setLoading] = useState(true);
    const [revision, setRevision] = useState(0);
    const [updatedAt, setUpdatedAt] = useState('');
    const [history, setHistory] = useState<MetricHistory>({});
    const historyRef = useRef<MetricHistory>({});
    const notifiedAlerts = useRef(new Set<string>());
    const [thresholds, setThresholds] = useState<AlertThresholds>({ cpu: 80, memory: 80 });
    const settingsKey = JSON.stringify([projectPath, dockerContext, service]);

    useEffect(() => {
        try {
            const parsedHistory = readHistory(localStorage.getItem('sandbox-metric-history'));
            historyRef.current = parsedHistory;
            setHistory(parsedHistory);
            const saved = localStorage.getItem(`sandbox-metric-thresholds:${settingsKey}`);
            if (saved) {
                const parsed: unknown = JSON.parse(saved);
                if (!parsed || typeof parsed !== 'object' || !('cpu' in parsed) || !('memory' in parsed)
                    || typeof parsed.cpu !== 'number' || typeof parsed.memory !== 'number'
                    || parsed.cpu < 0 || parsed.cpu > 100 || parsed.memory < 0 || parsed.memory > 100) {
                    throw new Error('Limites de alerta de métricas inválidos.');
                }
                setThresholds({ cpu: parsed.cpu, memory: parsed.memory });
            } else {
                setThresholds({ cpu: 80, memory: 80 });
            }
        } catch (reason) {
            setStorageError(`Erro ao carregar histórico ou alertas: ${reason}`);
        }
    }, [settingsKey]);

    const saveThresholds = (next: AlertThresholds) => {
        const safe = {
            cpu: Math.min(100, Math.max(0, next.cpu)),
            memory: Math.min(100, Math.max(0, next.memory)),
        };
        setThresholds(safe);
        try {
            localStorage.setItem(`sandbox-metric-thresholds:${settingsKey}`, JSON.stringify(safe));
        } catch (reason) {
            setStorageError(`Erro ao salvar limites de alerta: ${reason}`);
        }
    };

    const recordHistory = (result: Metrics[]) => {
        const next = { ...historyRef.current };
        const now = Date.now();
        for (const metric of result) {
            const key = historyKey(projectPath, dockerContext, service, metric.name);
            next[key] = [...(next[key] ?? []), {
                at: now,
                cpu: metricValue(metric.cpu),
                memory: metricValue(metric.memory_percent),
            }].slice(-120);
        }
        const bounded = Object.fromEntries(Object.entries(next).slice(-100));
        localStorage.setItem('sandbox-metric-history', JSON.stringify(bounded));
        historyRef.current = bounded;
        setHistory(bounded);
    };

    useEffect(() => {
        let disposed = false;
        setLoading(true);
        setError('');
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const result = await invoke<Metrics[]>('get_service_metrics', {
                    projectPath, dockerContext, profiles, envFile, service,
                });
                if (!disposed) {
                    setMetrics(result);
                    setUpdatedAt(new Date().toLocaleTimeString());
                    setError('');
                    try {
                        recordHistory(result);
                    } catch (reason) {
                        setStorageError(`Erro ao salvar histórico de métricas: ${reason}`);
                    }
                    for (const metric of result) {
                        const containerKey = historyKey(projectPath, dockerContext, service, metric.name);
                        const alerts = [
                            ['cpu', metricValue(metric.cpu) >= thresholds.cpu, metric.cpu],
                            ['memory', metricValue(metric.memory_percent) >= thresholds.memory, metric.memory_percent],
                        ] as const;
                        for (const [kind, active, value] of alerts) {
                            const alertKey = `${containerKey}:${kind}`;
                            if (active && notificationsEnabled && !notifiedAlerts.current.has(alertKey)) {
                                try {
                                    sendNotification({
                                        title: `${kind === 'cpu' ? 'CPU' : 'Memória'} alta: ${metric.name}`,
                                        body: `${value} · ${service} · ${projectPath}`,
                                    });
                                    notifiedAlerts.current.add(alertKey);
                                } catch (reason) {
                                    setStorageError(`Erro ao enviar alerta de recursos: ${reason}`);
                                }
                            } else if (!active) {
                                notifiedAlerts.current.delete(alertKey);
                            }
                        }
                    }
                }
            } catch (err) {
                if (!disposed) setError(String(err));
            } finally {
                if (!disposed) {
                    setLoading(false);
                    if (features.metrics) timer = setTimeout(refresh, 3000);
                }
            }
        };
        void refresh();
        return () => { disposed = true; clearTimeout(timer); };
    }, [
        projectPath, dockerContext, profiles, envFile, service, revision, features.metrics,
        thresholds.cpu, thresholds.memory, notificationsEnabled,
    ]);

    return (
        <section className="metrics-panel" aria-label={`Métricas de ${service}`} aria-busy={loading}>
            <div className="utility-heading">
                <strong>{features.metrics ? 'Consumo em tempo real' : 'Detalhes dos containers'} · {service}</strong>
                <div className="utility-actions">
                    <button className="button button-quiet" disabled={loading} onClick={() => setRevision(value => value + 1)}>Atualizar agora</button>
                    <button className="button button-quiet" onClick={onClose}>Fechar métricas</button>
                </div>
            </div>
            <p className="dashboard-note">{features.metrics ? 'Atualização automática a cada 3 segundos.' : 'Dados consultados sob demanda.'}{updatedAt && ` Última leitura: ${updatedAt}.`}</p>
            {features.metrics && (
                <>
                    <div className="metric-alert-settings">
                        <label>Alerta de CPU ≥
                            <input
                                type="number" min="0" max="100" step="1"
                                aria-label={`Limite de alerta de CPU de ${service}`}
                                value={thresholds.cpu}
                                onChange={event => {
                                    const value = Number(event.target.value);
                                    if (Number.isFinite(value)) saveThresholds({ ...thresholds, cpu: value });
                                }}
                            />%
                        </label>
                        <label>Alerta de memória ≥
                            <input
                                type="number" min="0" max="100" step="1"
                                aria-label={`Limite de alerta de memória de ${service}`}
                                value={thresholds.memory}
                                onChange={event => {
                                    const value = Number(event.target.value);
                                    if (Number.isFinite(value)) saveThresholds({ ...thresholds, memory: value });
                                }}
                            />%
                        </label>
                        <span className="services-hint">Histórico local limitado a 120 leituras por container.</span>
                    </div>
                    {metrics.some(metric =>
                        metricValue(metric.cpu) >= thresholds.cpu
                        || metricValue(metric.memory_percent) >= thresholds.memory,
                    ) && <p className="metric-warning" role="alert">Um container ultrapassou o limite de CPU ou memória.</p>}
                </>
            )}
            {(error || storageError) && <p className="project-error" role="alert">{error || storageError}</p>}
            {error ? null : loading ? (
                <p className="services-hint">Consultando containers…</p>
            ) : metrics.length === 0 ? (
                <p className="services-hint">Nenhum container em execução para este serviço.</p>
            ) : (
                <div className="metrics-list">
                    {metrics.map(metric => {
                        const samples = history[historyKey(projectPath, dockerContext, service, metric.name)] ?? [];
                        const cpu = metricValue(metric.cpu);
                        const memory = metricValue(metric.memory_percent);
                        return <dl key={metric.name} className="metric-card">
                            <div><dt>Container</dt><dd>{metric.name}</dd></div>
                            {features.containerId && <div><dt>ID</dt><dd className="container-id">{metric.id}</dd></div>}
                            {features.state && <div><dt>Estado</dt><dd>{metric.state}</dd></div>}
                            {features.metrics && <div><dt>CPU</dt><dd>{metric.cpu}</dd></div>}
                            {features.metrics && <div><dt>Memória</dt><dd>{metric.memory_usage} ({metric.memory_percent})</dd></div>}
                            {features.metrics && <div><dt>Rede</dt><dd>{metric.network_io || 'Sem dados'}</dd></div>}
                            {features.metrics && (
                                <div className="metric-history metric-full-row">
                                    <dt>Histórico recente</dt>
                                    <dd>
                                        <span>CPU {cpu}%</span>
                                        <svg viewBox="0 0 100 40" role="img" aria-label={`Histórico de CPU de ${metric.name}`}>
                                            <polyline points={chartPoints(samples, 'cpu')} />
                                        </svg>
                                        <span>Memória {memory}%</span>
                                        <svg viewBox="0 0 100 40" role="img" aria-label={`Histórico de memória de ${metric.name}`}>
                                            <polyline points={chartPoints(samples, 'memory')} />
                                        </svg>
                                        <small>{samples.length} leituras</small>
                                    </dd>
                                </div>
                            )}
                            {features.volumes && (
                                <div className="metric-full-row">
                                    <dt>Volumes</dt>
                                    <dd>{metric.volumes.length ? metric.volumes.map(volume =>
                                        `${volume.source} → ${volume.destination} (${volume.kind}${volume.read_write ? ', leitura e escrita' : ', somente leitura'})`,
                                    ).join('\n') : 'Nenhum volume montado'}</dd>
                                </div>
                            )}
                            {features.inspect && (
                                <details className="metric-full-row inspect-details">
                                    <summary>Exibir Inspect</summary>
                                    <pre>{JSON.stringify(metric.inspect, null, 2)}</pre>
                                </details>
                            )}
                        </dl>;
                    })}
                </div>
            )}
        </section>
    );
}
