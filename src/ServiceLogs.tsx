import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { filterLogLines, isLogError } from './workspace';

interface Props {
    projectPath: string;
    dockerContext: string;
    profiles: string[];
    envFile: string | null;
    service: string;
    onClose: () => void;
    semanticErrors: boolean;
}

export default function ServiceLogs({
    projectPath, dockerContext, profiles, envFile, service, onClose, semanticErrors,
}: Props) {
    const [lines, setLines] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('Conectando…');
    const [query, setQuery] = useState('');
    const [errorsOnly, setErrorsOnly] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportMessage, setExportMessage] = useState('');
    const visibleLines = filterLogLines(lines, query, semanticErrors && errorsOnly);

    const exportLogs = async () => {
        setExporting(true);
        setExportMessage('');
        try {
            const path = await invoke<string>('export_service_logs', {
                service, content: visibleLines.join('\n') + '\n',
            });
            setExportMessage(`Logs exportados para ${path}`);
        } catch (err) {
            setExportMessage(`Erro ao exportar logs: ${err}`);
        } finally {
            setExporting(false);
        }
    };

    useEffect(() => {
        const streamId = crypto.randomUUID();
        let disposed = false;
        let started = false;
        const unlisteners: (() => void)[] = [];
        const stop = () => invoke('stop_service_logs', { streamId }).catch(err => {
            console.error('Erro ao encerrar captura de logs:', err);
            if (!disposed) setError(String(err));
        });
        const connect = async () => {
            try {
                const unlisten = await listen<{ stream_id: string; log_line: string }>('docker-log', event => {
                    if (!disposed && event.payload.stream_id === streamId) {
                        setLines(prev => [...prev, event.payload.log_line.slice(-8000)].slice(-100));
                    }
                });
                unlisteners.push(unlisten);
                if (disposed) { unlisten(); return; }
                const unlistenEnd = await listen<{ stream_id: string; error: string | null }>('docker-log-end', event => {
                    if (!disposed && event.payload.stream_id === streamId) {
                        setStatus('Captura encerrada');
                        if (event.payload.error) setError(event.payload.error);
                    }
                });
                unlisteners.push(unlistenEnd);
                if (disposed) { unlistenEnd(); return; }
                setStatus('Capturando');
                await invoke('start_service_logs', {
                    projectPath, dockerContext, profiles, envFile, service, streamId,
                });
                started = true;
                if (disposed) await stop();
            } catch (err) {
                if (!disposed) {
                    setError(String(err));
                    setStatus('Falha na captura');
                }
            }
        };
        void connect();
        return () => {
            disposed = true;
            unlisteners.forEach(unlisten => unlisten());
            if (started) void stop();
        };
    }, [projectPath, dockerContext, profiles, envFile, service]);

    return (
        <section className="log-panel" aria-label={`Logs de ${service}`}>
            <div className="log-header">
                <div><span>{service}</span><span>· {status}</span></div>
                <div>
                    <button className="button button-log-clear" onClick={() => setLines([])}>Limpar logs</button>
                    <button className="button button-log-clear" onClick={onClose}>Fechar logs</button>
                </div>
            </div>
            <div className="log-toolbar">
                <input className="utility-input" aria-label={`Buscar nos logs de ${service}`} placeholder="Buscar nos logs…" value={query} onChange={event => setQuery(event.target.value)} />
                {semanticErrors && <label className="select-all">
                    <input type="checkbox" checked={errorsOnly} onChange={event => setErrorsOnly(event.target.checked)} />
                    Somente erros (semântico)
                </label>}
                <button className="button button-quiet" disabled={exporting || visibleLines.length === 0} onClick={exportLogs}>
                    {exporting ? 'Exportando…' : 'Exportar exibidos'}
                </button>
                <span className="services-hint">{visibleLines.length} / {lines.length} linhas</span>
            </div>
            {exportMessage && <p className="utility-feedback" role="status">{exportMessage}</p>}
            {error && <div className="project-error" role="alert">{error}</div>}
            <div className="log-output">
                {visibleLines.length === 0 ? (
                    <p className="log-empty">{lines.length ? 'Nenhuma linha corresponde aos filtros.' : 'Nenhum log recebido deste serviço.'}</p>
                ) : visibleLines.map((line, index) => (
                    <div key={index} className={`log-line${isLogError(line) ? ' log-error' : ''}`}>
                        <span className="log-index">{String(index + 1).padStart(2, '0')}</span>
                        <span>{line}</span>
                    </div>
                ))}
            </div>
        </section>
    );
}
