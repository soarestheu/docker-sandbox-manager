import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface Props {
    projectPath: string;
    dockerContext: string;
    profiles: string[];
    envFile: string | null;
    service: string;
    onClose: () => void;
}

export default function ServiceTerminal({
    projectPath, dockerContext, profiles, envFile, service, onClose,
}: Props) {
    const [output, setOutput] = useState('');
    const [command, setCommand] = useState('');
    const [error, setError] = useState('');
    const [status, setStatus] = useState('Conectando…');
    const [sending, setSending] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const streamIdRef = useRef('');

    useEffect(() => {
        const streamId = crypto.randomUUID();
        streamIdRef.current = streamId;
        let disposed = false;
        let started = false;
        const unlisteners: (() => void)[] = [];
        const stop = () => invoke('stop_service_terminal', { streamId }).catch(reason => {
            console.error('Erro ao encerrar terminal:', reason);
            if (!disposed) setError(String(reason));
        });
        const connect = async () => {
            try {
                const unlistenOutput = await listen<{ stream_id: string; text: string }>(
                    'docker-terminal-output',
                    event => {
                        if (!disposed && event.payload.stream_id === streamId) {
                            setOutput(previous => `${previous}${event.payload.text}`.slice(-50_000));
                        }
                    },
                );
                unlisteners.push(unlistenOutput);
                if (disposed) { unlistenOutput(); return; }
                const unlistenEnd = await listen<{ stream_id: string; error: string | null }>(
                    'docker-terminal-end',
                    event => {
                        if (!disposed && event.payload.stream_id === streamId) {
                            setStatus('Shell encerrado');
                            if (event.payload.error) setError(event.payload.error);
                        }
                    },
                );
                unlisteners.push(unlistenEnd);
                if (disposed) { unlistenEnd(); return; }
                await invoke('start_service_terminal', {
                    projectPath, dockerContext, profiles, envFile, service, streamId,
                });
                started = true;
                if (disposed) await stop();
                else {
                    setStatus('Conectado');
                    inputRef.current?.focus();
                }
            } catch (reason) {
                if (!disposed) {
                    setError(String(reason));
                    setStatus('Falha ao abrir');
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

    const sendCommand = async (event: FormEvent) => {
        event.preventDefault();
        const value = command.trim();
        if (!value || sending || status !== 'Conectado') return;
        setSending(true);
        setError('');
        try {
            await invoke('write_service_terminal', {
                streamId: streamIdRef.current,
                input: `${value}\n`,
            });
            setCommand('');
        } catch (reason) {
            setError(String(reason));
        } finally {
            setSending(false);
            inputRef.current?.focus();
        }
    };

    return (
        <section className="terminal-panel" aria-label={`Terminal de ${service}`}>
            <div className="utility-heading">
                <strong>Shell · {service} · {status}</strong>
                <button className="button button-quiet" onClick={onClose}>Fechar terminal</button>
            </div>
            <p className="dashboard-note">Shell /bin/sh sem pseudo-terminal. Os comandos são executados dentro do container.</p>
            {error && <p className="project-error" role="alert">{error}</p>}
            <pre className="terminal-output" aria-live="polite">{output || 'Digite um comando para começar.'}</pre>
            <form className="terminal-input-row" onSubmit={sendCommand}>
                <label htmlFor={`terminal-command-${service}`}>$</label>
                <input
                    ref={inputRef}
                    id={`terminal-command-${service}`}
                    className="utility-input"
                    aria-label={`Comando no terminal de ${service}`}
                    value={command}
                    onChange={event => setCommand(event.target.value)}
                    disabled={status !== 'Conectado' || sending}
                    autoComplete="off"
                />
                <button className="button button-primary" disabled={status !== 'Conectado' || sending || !command.trim()}>
                    {sending ? 'Enviando…' : 'Executar'}
                </button>
            </form>
        </section>
    );
}
