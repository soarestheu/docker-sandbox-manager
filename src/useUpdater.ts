import { useCallback, useEffect, useRef, useState } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterState =
    | { status: 'idle' }
    | { status: 'available'; version: string; notes: string }
    | { status: 'downloading'; version: string; progress: number | null }
    | { status: 'error'; message: string };

export function useUpdater() {
    const [state, setState] = useState<UpdaterState>({ status: 'idle' });
    const [dismissed, setDismissed] = useState(false);
    const updateRef = useRef<Update | null>(null);

    const check = useCallback(async () => {
        try {
            const { check } = await import('@tauri-apps/plugin-updater');
            const update = await check();
            if (!update) return;
            updateRef.current = update;
            setState(current => current.status === 'downloading' ? current : { status: 'available', version: update.version, notes: update.body ?? '' });
        } catch {
            // Sem rede, endpoint indisponível ou fora do Tauri: ignora silenciosamente.
        }
    }, []);

    useEffect(() => {
        void check();
        const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [check]);

    const install = useCallback(async () => {
        const update = updateRef.current;
        if (!update) return;
        let total = 0;
        let downloaded = 0;
        setState({ status: 'downloading', version: update.version, progress: null });
        try {
            await update.downloadAndInstall(event => {
                if (event.event === 'Started') total = event.data.contentLength ?? 0;
                if (event.event === 'Progress') {
                    downloaded += event.data.chunkLength;
                    setState({ status: 'downloading', version: update.version, progress: total ? Math.min(100, Math.round(downloaded / total * 100)) : null });
                }
            });
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
        } catch (error) {
            setState({ status: 'error', message: String(error) });
        }
    }, []);

    return { state, dismissed, dismiss: () => setDismissed(true), install };
}
