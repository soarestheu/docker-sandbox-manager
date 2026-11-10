import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import Icon from './Icon';
import type { TerminalCommandPreset } from './workspace';

interface Props {
    projectPath: string;
    dockerContext: string;
    profiles: string[];
    envFile: string | null;
    service: string;
    displayName: string;
    commandPresets: TerminalCommandPreset[];
    onSaveCommandPreset: (name: string, command: string) => void;
    onRemoveCommandPreset: (name: string) => void;
    onClose: () => void;
}

export default function ServiceTerminal({
    projectPath, dockerContext, profiles, envFile, service, displayName, commandPresets,
    onSaveCommandPreset, onRemoveCommandPreset, onClose,
}: Props) {
    const [output, setOutput] = useState('');
    const [command, setCommand] = useState('');
    const [error, setError] = useState('');
    const [status, setStatus] = useState('Conectando…');
    const [sending, setSending] = useState(false);
    const [autoScroll, setAutoScroll] = useState(true);
    const [presetName, setPresetName] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const streamIdRef = useRef('');
    const outputRef = useRef<HTMLPreElement>(null);

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

    useEffect(() => {
        if (autoScroll && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }, [autoScroll, output]);

    const runCommand = async (input: string, clearInput = false) => {
        const value = input.trim();
        if (!value || sending || status !== 'Conectado') return;
        setSending(true);
        setError('');
        try {
            await invoke('write_service_terminal', {
                streamId: streamIdRef.current,
                input: `${value}\n`,
            });
            if (clearInput) setCommand('');
        } catch (reason) {
            setError(String(reason));
        } finally {
            setSending(false);
            inputRef.current?.focus();
        }
    };

    const sendCommand = (event: FormEvent) => {
        event.preventDefault();
        void runCommand(command, true);
    };

    const saveCommandPreset = (event: FormEvent) => {
        event.preventDefault();
        const name = presetName.trim();
        const value = command.trim();
        if (!name || !value) return;
        onSaveCommandPreset(name, value);
        setPresetName('');
    };

    return (
        <section className="terminal-panel" aria-label={`Terminal de ${displayName}`}>
            <div className="utility-heading">
                <strong>Shell · {displayName} · {status}</strong>
                <button className="button button-quiet" onClick={onClose}>Fechar terminal</button>
            </div>
            <p className="dashboard-note">Shell /bin/sh sem pseudo-terminal. Os comandos são executados dentro do container.</p>
            {error && <p className="project-error" role="alert">{error}</p>}
            <label className="select-all terminal-auto-scroll">
                <input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />
                Rolagem automática
            </label>
            <pre ref={outputRef} className="terminal-output" aria-live="polite">{output || 'Digite um comando para começar.'}</pre>
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
            <details className="terminal-presets">
                <summary>Comandos rápidos ({commandPresets.length})</summary>
                <div className="terminal-presets-content">
                    {commandPresets.length > 0 && (
                        <div className="terminal-preset-list">
                            {commandPresets.map(preset => (
                                <div className="terminal-preset-row" key={preset.name}>
                                    <button
                                        type="button"
                                        className="terminal-preset-run"
                                        aria-label={`Executar comando rápido ${preset.name} no terminal de ${service}`}
                                        title={preset.command}
                                        disabled={status !== 'Conectado' || sending}
                                        onClick={() => void runCommand(preset.command)}
                                    >
                                        <strong>{preset.name}</strong>
                                        <code>{preset.command}</code>
                                    </button>
                                    <button
                                        type="button"
                                        className="icon-button"
                                        aria-label={`Remover comando salvo ${preset.name} do terminal de ${service}`}
                                        title="Remover comando salvo"
                                        onClick={() => onRemoveCommandPreset(preset.name)}
                                    ><Icon name="close" size={14} /></button>
                                </div>
                            ))}
                        </div>
                    )}
                    <form className="terminal-preset-form" onSubmit={saveCommandPreset}>
                        <input
                            className="utility-input"
                            aria-label={`Nome do comando salvo para ${service}`}
                            placeholder="Nome do comando"
                            value={presetName}
                            onChange={event => setPresetName(event.target.value)}
                        />
                        <button
                            className="button button-quiet"
                            type="submit"
                            disabled={!presetName.trim() || !command.trim()}
                        >{commandPresets.some(preset => preset.name === presetName.trim()) ? 'Atualizar comando salvo' : 'Salvar comando atual'}</button>
                    </form>
                    <p className="dashboard-note">Salva o comando digitado e o associa a este serviço.</p>
                </div>
            </details>
        </section>
    );
}
