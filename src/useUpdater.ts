import { useCallback, useEffect, useRef, useState } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'current' }
    | { status: 'available'; version: string; notes: string }
    | { status: 'downloading'; version: string; progress: number | null }
    | { status: 'error'; message: string; action: 'check' | 'install' };

export function useUpdater() {
    const [state, setState] = useState<UpdaterState>({ status: 'idle' });
    const [dismissed, setDismissed] = useState(false);
    const updateRef = useRef<Update | null>(null);
    const checkPromiseRef = useRef<Promise<Update | null> | null>(null);

    const check = useCallback(async (manual = false) => {
        if (manual) {
            setDismissed(false);
            setState({ status: 'checking' });
        }
        let pendingCheck = checkPromiseRef.current;
        try {
            if (!pendingCheck) {
                pendingCheck = import('@tauri-apps/plugin-updater')
                    .then(({ check: checkForUpdate }) => checkForUpdate());
                checkPromiseRef.current = pendingCheck;
            }
            const update = await pendingCheck;
            if (update) {
                updateRef.current = update;
                setDismissed(false);
                setState(current => current.status === 'downloading'
                    ? current
                    : { status: 'available', version: update.version, notes: update.body ?? '' });
            } else if (manual) {
                updateRef.current = null;
                setState({ status: 'current' });
            }
        } catch (error) {
            if (manual) {
                setState({ status: 'error', message: String(error), action: 'check' });
            }
        } finally {
            if (pendingCheck && checkPromiseRef.current === pendingCheck) {
                checkPromiseRef.current = null;
            }
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
            setState({ status: 'error', message: String(error), action: 'install' });
        }
    }, []);

    return { state, dismissed, check, dismiss: () => setDismissed(true), install };
}
