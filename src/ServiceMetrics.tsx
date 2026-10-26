import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Metrics {
    name: string;
    cpu: string;
    memory_usage: string;
    memory_percent: string;
}

export default function ServiceMetrics({ projectPath, service, onClose }: {
    projectPath: string; service: string; onClose: () => void;
}) {
    const [metrics, setMetrics] = useState<Metrics[]>([]);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [revision, setRevision] = useState(0);
    const [updatedAt, setUpdatedAt] = useState('');

    useEffect(() => {
        let disposed = false;
        setLoading(true);
        setError('');
        invoke<Metrics[]>('get_service_metrics', { projectPath, service })
            .then(result => {
                if (!disposed) {
                    setMetrics(result);
                    setUpdatedAt(new Date().toLocaleTimeString());
                }
            })
            .catch(err => { if (!disposed) setError(String(err)); })
            .finally(() => { if (!disposed) setLoading(false); });
        return () => { disposed = true; };
    }, [projectPath, service, revision]);

    return (
        <section className="metrics-panel" aria-label={`Métricas de ${service}`} aria-busy={loading}>
            <div className="utility-heading">
                <strong>CPU e memória · {service}</strong>
                <div className="utility-actions">
                    <button className="button button-quiet" disabled={loading} onClick={() => setRevision(value => value + 1)}>Atualizar métricas</button>
                    <button className="button button-quiet" onClick={onClose}>Fechar métricas</button>
                </div>
            </div>
            <p className="dashboard-note">Coleta pontual, sem atualização em segundo plano.{updatedAt && ` Última leitura: ${updatedAt}.`}</p>
            {error ? <p className="project-error" role="alert">{error}</p> : loading ? (
                <p className="services-hint">Consultando containers…</p>
            ) : metrics.length === 0 ? (
                <p className="services-hint">Nenhum container em execução para este serviço.</p>
            ) : (
                <div className="metrics-list">
                    {metrics.map(metric => (
                        <dl key={metric.name} className="metric-card">
                            <div><dt>Container</dt><dd>{metric.name}</dd></div>
                            <div><dt>CPU</dt><dd>{metric.cpu}</dd></div>
                            <div><dt>Memória</dt><dd>{metric.memory_usage} ({metric.memory_percent})</dd></div>
                        </dl>
                    ))}
                </div>
            )}
        </section>
    );
}
