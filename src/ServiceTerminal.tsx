import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import Icon from './Icon';
import type { TerminalCommandPreset } from './workspace';

export interface AutoCommandResult {
    command: string;
    status: 'running' | 'success' | 'error';
    output: string;
}

interface Props {
    projectPath: string;
    dockerContext: string;
    profiles: string[];
    envFile: string | null;
    service: string;
    displayName: string;
    commandPresets: TerminalCommandPreset[];
    autoCommandBatch?: { id: string; commands: TerminalCommandPreset[] };
    commandResults: Record<string, AutoCommandResult>;
    onSaveCommandPreset: (name: string, command: string, autoExecute: boolean) => void;
    onAutoCommandResult: (
        name: string, command: string, status: AutoCommandResult['status'], output: string,
    ) => void;
    onConsumeAutoCommandBatch: (id: string) => void;
    onRemoveCommandPreset: (name: string) => void;
    onClose: () => void;
}

export default function ServiceTerminal({
    projectPath, dockerContext, profiles, envFile, service, displayName, commandPresets,
    autoCommandBatch, commandResults, onSaveCommandPreset, onAutoCommandResult,
    onConsumeAutoCommandBatch, onRemoveCommandPreset, onClose,
}: Props) {
    const [output, setOutput] = useState('');
    const [command, setCommand] = useState('');
    const [error, setError] = useState('');
    const [status, setStatus] = useState('Conectando…');
    const [sending, setSending] = useState(false);
    const [autoScroll, setAutoScroll] = useState(true);
    const [presetName, setPresetName] = useState('');
    const [presetCommand, setPresetCommand] = useState('');
    const [presetAutoExecute, setPresetAutoExecute] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const streamIdRef = useRef('');
    const outputRef = useRef<HTMLPreElement>(null);
    const handledAutoBatchRef = useRef('');
    const pendingAutoMarkersRef = useRef(new Map<string, {
        resolve: (exitCode: number) => void;
        reject: (reason: Error) => void;
    }>());
    const outputTailRef = useRef('');

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
                            let text = `${outputTailRef.current}${event.payload.text}`;
                            outputTailRef.current = '';
                            for (const [marker, pending] of pendingAutoMarkersRef.current) {
                                const match = text.match(new RegExp(`${marker}(\\d+)__`));
                                if (match) {
                                    text = text.replace(match[0], '');
                                    pendingAutoMarkersRef.current.delete(marker);
                                    pending.resolve(Number(match[1]));
                                }
                            }
                            if (pendingAutoMarkersRef.current.size) {
                                const keep = Math.max(...[...pendingAutoMarkersRef.current.keys()].map(marker => marker.length + 8));
                                const splitAt = Math.max(0, text.length - keep);
                                outputTailRef.current = text.slice(splitAt);
                                text = text.slice(0, splitAt);
                            }
                            if (text) setOutput(previous => `${previous}${text}`.slice(-50_000));
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
                            for (const pending of pendingAutoMarkersRef.current.values()) {
                                pending.reject(new Error(event.payload.error || 'Shell encerrado antes do comando terminar.'));
                            }
                            pendingAutoMarkersRef.current.clear();
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
            for (const pending of pendingAutoMarkersRef.current.values()) {
                pending.reject(new Error('Terminal fechado antes do comando terminar.'));
            }
            pendingAutoMarkersRef.current.clear();
            unlisteners.forEach(unlisten => unlisten());
            if (started) void stop();
        };
    }, [projectPath, dockerContext, profiles, envFile, service]);

    useEffect(() => {
        if (autoScroll && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }, [autoScroll, output]);

    const runCommand = async (input: string, clearInput = false): Promise<{ success: boolean; error?: string }> => {
        const value = input.trim();
        if (!value) return { success: false, error: 'Informe um comando.' };
        if (sending) {
            const reason = 'Aguarde o envio do comando atual.';
            setError(reason);
            return { success: false, error: reason };
        }
        if (status !== 'Conectado') {
            const reason = `Terminal indisponível: ${status}`;
            setError(reason);
            return { success: false, error: reason };
        }
        setSending(true);
        setError('');
        try {
            await invoke('write_service_terminal', {
                streamId: streamIdRef.current,
                input: `${value}\n`,
            });
            if (clearInput) setCommand('');
            return { success: true };
        } catch (reason) {
            const message = String(reason);
            setError(message);
            return { success: false, error: message };
        } finally {
            setSending(false);
            inputRef.current?.focus();
        }
    };

    const runAutomaticCommand = async (preset: TerminalCommandPreset) => {
        const value = preset.command.trim();
        if (status !== 'Conectado') {
            return { success: false, error: `Terminal indisponível: ${status}` };
        }
        setSending(true);
        const marker = `__DSM_EXIT_${crypto.randomUUID().replaceAll('-', '')}_`;
        let resolveExitCode!: (exitCode: number) => void;
        let rejectExitCode!: (reason: Error) => void;
        const exitCodeResult = new Promise<number>((resolve, reject) => {
            resolveExitCode = resolve;
            rejectExitCode = reject;
        });
        pendingAutoMarkersRef.current.set(marker, { resolve: resolveExitCode, reject: rejectExitCode });
        try {
            await invoke('write_service_terminal', {
                streamId: streamIdRef.current,
                input: `${value}\n`,
            });
            await invoke('write_service_terminal', {
                streamId: streamIdRef.current,
                input: `printf '\\n${marker}%s__\\n' "$?"\n`,
            });
            const exitCode = await exitCodeResult;
            return exitCode === 0
                ? { success: true, error: '' }
                : { success: false, error: `Comando encerrado com código ${exitCode}.` };
        } catch (reason) {
            pendingAutoMarkersRef.current.delete(marker);
            return { success: false, error: String(reason) };
        } finally {
            setSending(false);
        }
    };

    useEffect(() => {
        const batch = autoCommandBatch;
        if (!batch || handledAutoBatchRef.current === batch.id) return;
        if (status === 'Conectado') {
            handledAutoBatchRef.current = batch.id;
            onConsumeAutoCommandBatch(batch.id);
            void (async () => {
                for (const preset of batch.commands) {
                    const result = await runAutomaticCommand(preset);
                    onAutoCommandResult(
                        preset.name,
                        preset.command,
                        result.success ? 'success' : 'error',
                        result.error ?? '',
                    );
                }
            })();
        } else if (status === 'Falha ao abrir' || status === 'Shell encerrado') {
            handledAutoBatchRef.current = batch.id;
            onConsumeAutoCommandBatch(batch.id);
            for (const preset of batch.commands) {
                onAutoCommandResult(
                    preset.name,
                    preset.command,
                    'error',
                    error || `Não foi possível executar: ${status}.`,
                );
            }
        }
    }, [autoCommandBatch, status, error, onAutoCommandResult, onConsumeAutoCommandBatch]);

    const sendCommand = (event: FormEvent) => {
        event.preventDefault();
        void runCommand(command, true);
    };

    const saveCommandPreset = (event: FormEvent) => {
        event.preventDefault();
        const name = presetName.trim();
        const value = presetCommand.trim();
        if (!name || !value) return;
        onSaveCommandPreset(name, value, presetAutoExecute);
        setPresetName('');
        setPresetCommand('');
        setPresetAutoExecute(false);
    };

    return (
        <section className="terminal-panel" aria-label={`Terminal de ${displayName}`}>
            <div className="utility-heading">
                <strong>Shell · {displayName} · {status}</strong>
                <div className="utility-actions">
                    <button
                        type="button"
                        className="button button-quiet"
                        aria-label={`Limpar terminal de ${service}`}
                        disabled={!output && !error}
                        onClick={() => {
                            setOutput('');
                            setError('');
                        }}
                    >Limpar terminal</button>
                    <button type="button" className="button button-quiet" onClick={onClose}>Fechar terminal</button>
                </div>
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
                    onChange={event => {
                        setCommand(event.target.value);
                        setPresetCommand(event.target.value);
                    }}
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
                                    <div className="terminal-preset-details">
                                        <button
                                            type="button"
                                            className="terminal-preset-run"
                                            aria-label={`Executar comando rápido ${preset.name} no terminal de ${service}`}
                                            title={preset.command}
                                            disabled={preset.autoExecute}
                                            onClick={() => void runCommand(preset.command)}
                                        >
                                            <strong>{preset.name}</strong>
                                            <code>{preset.command}</code>
                                        </button>
                                        {preset.autoExecute && (() => {
                                            const result = commandResults[preset.name];
                                            const currentResult = result?.command === preset.command ? result : undefined;
                                            const label = currentResult?.status === 'running' ? 'Executando…'
                                                : currentResult?.status === 'success' ? 'Executado'
                                                    : currentResult?.status === 'error' ? 'Erro ao executar' : 'Execução automática';
                                            return (
                                                <span
                                                    className={`terminal-auto-result${currentResult?.status === 'error' ? ' is-error' : ''}`}
                                                    title={currentResult?.output || undefined}
                                                    role={currentResult?.status === 'error' ? 'alert' : 'status'}
                                                >{label}{currentResult?.status === 'error' && currentResult.output ? `: ${currentResult.output}` : ''}</span>
                                            );
                                        })()}
                                    </div>
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
                        <input
                            className="utility-input"
                            aria-label={`Comando a salvar para ${service}`}
                            placeholder="Comando a salvar"
                            value={presetCommand}
                            onChange={event => setPresetCommand(event.target.value)}
                        />
                        <label className="terminal-auto-execute">
                            <input
                                type="checkbox"
                                aria-label={`Executar automaticamente ${presetName.trim() || 'comando'} ao iniciar ${service}`}
                                checked={presetAutoExecute}
                                onChange={event => setPresetAutoExecute(event.target.checked)}
                            />
                            Auto executar
                        </label>
                        <button
                            className="button button-quiet"
                            type="submit"
                            disabled={!presetName.trim() || !presetCommand.trim()}
                        >{commandPresets.some(preset => preset.name === presetName.trim()) ? 'Atualizar comando' : 'Adicionar comando'}</button>
                    </form>
                    <p className="dashboard-note">Informe o nome, o comando e se ele deve ser executado automaticamente ao iniciar este serviço.</p>
                </div>
            </details>
        </section>
    );
}
